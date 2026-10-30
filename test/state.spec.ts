import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.ts";

const HOUR = 3_600_000;

function setup(options: { now?: number } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arkham-state-"));
	let now = options.now ?? 1_000_000_000;
	const file = path.join(dir, "state.json");
	const store = new StateStore(file, { now: () => now });
	store.load();
	return {
		store,
		file,
		dir,
		advance(ms: number) {
			now += ms;
		},
		reload() {
			const next = new StateStore(file, { now: () => now });
			next.load();
			return next;
		},
		cleanup() {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
}

describe("state store", () => {
	it("counts matches inside a rolling 24 hour window", () => {
		const ctx = setup();
		try {
			ctx.store.recordMatch();
			ctx.advance(HOUR);
			ctx.store.recordMatch();
			expect(ctx.store.matchesInWindow).toBe(2);

			ctx.advance(23 * HOUR + 1);
			expect(ctx.store.matchesInWindow).toBe(1);

			ctx.advance(HOUR);
			expect(ctx.store.matchesInWindow).toBe(0);
		} finally {
			ctx.cleanup();
		}
	});

	it("counts unique authentications only once per window", () => {
		const ctx = setup();
		try {
			expect(ctx.store.recordAuthentication("Another_Hermit")).toEqual({ counted: true, uniqueUsers: 1 });
			expect(ctx.store.recordAuthentication("Another_Hermit")).toEqual({ counted: false, uniqueUsers: 1 });
			expect(ctx.store.recordAuthentication("BATTLE-DONKEY")).toEqual({ counted: true, uniqueUsers: 2 });
			expect(ctx.store.uniqueUsersInWindow).toBe(2);

			ctx.advance(24 * HOUR + 1);
			expect(ctx.store.uniqueUsersInWindow).toBe(0);
			expect(ctx.store.recordAuthentication("Another_Hermit")).toEqual({ counted: true, uniqueUsers: 1 });
		} finally {
			ctx.cleanup();
		}
	});

	it("reports when the next entry expires", () => {
		const ctx = setup();
		try {
			expect(ctx.store.nextExpiry()).toBeNull();
			ctx.store.recordMatch();
			ctx.advance(HOUR);
			ctx.store.recordAuthentication("Another_Hermit");
			expect(ctx.store.nextExpiry()).toBe(1_000_000_000 + 24 * HOUR);

			ctx.advance(24 * HOUR - 1);
			expect(ctx.store.nextExpiry()).toBe(1_000_000_000 + 25 * HOUR);
		} finally {
			ctx.cleanup();
		}
	});

	it("survives a restart", () => {
		const ctx = setup();
		try {
			ctx.store.recordMatch();
			ctx.store.recordAuthentication("Another_Hermit");
			ctx.store.markUpdate("channel", 1_234);

			const reloaded = ctx.reload();
			expect(reloaded.matchesInWindow).toBe(1);
			expect(reloaded.uniqueUsersInWindow).toBe(1);
			expect(reloaded.lastUpdate("channel")).toBe(1_234);
		} finally {
			ctx.cleanup();
		}
	});

	it("migrates the old per-day match counter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arkham-legacy-"));
		try {
			const file = path.join(dir, "state.json");
			fs.writeFileSync(
				file,
				JSON.stringify({ day: "2026-10-30", matchesPlayedToday: 3, lastChannelUpdate: { abc: 42 } })
			);
			const store = new StateStore(file, { now: () => 1_000_000_000 });
			store.load();

			expect(store.matchesInWindow).toBe(3);
			expect(store.uniqueUsersInWindow).toBe(0);
			expect(store.lastUpdate("abc")).toBe(42);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
