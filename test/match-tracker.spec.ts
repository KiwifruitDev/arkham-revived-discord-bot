import { describe, expect, it, vi } from "vitest";
import { MatchTracker } from "../src/match-tracker.ts";
import type { MatchResult } from "../src/types.ts";

const baseEvent = {
	platform: "ps3",
	xp: 100,
	levels: 1,
	heroKills: 0,
	gangKills: 0,
	prestige: 0
};

function tracker(options: { onMatch?: (match: MatchResult) => void; start?: number } = {}) {
	let now = options.start ?? 1_000_000;
	return {
		advance(ms: number) {
			now += ms;
			return now;
		},
		get now() {
			return now;
		},
		instance: new MatchTracker({
			windowMs: 10_000,
			quietMs: 3_000,
			minPlayers: 2,
			onMatch: options.onMatch ?? (() => {}),
			now: () => now
		})
	};
}

function statEvent(username: string, timestamp: number, xp = baseEvent.xp) {
	return {
		username,
		uuid: `ps3_${username}_11111111-1111-4111-8111-111111111111`,
		platform: "ps3",
		timestamp,
		deltas: { xp, levels: 1, heroKills: 1, gangKills: 1, prestige: 0 },
		stats: [
			{ path: "AccountXP", label: "Account XP", delta: xp, before: 1000, after: 1000 + xp },
			{ path: "AccountXPLevel", label: "Account Level", delta: 1, before: 28, after: 29 }
		]
	};
}

describe("match tracker", () => {
	it("detects a match when two players report XP within the window", async () => {
		const onMatch = vi.fn();
		const clock = tracker({ onMatch });
		clock.instance.record(statEvent("Another_Hermit", clock.now));
		clock.instance.record(statEvent("BATTLE-DONKEY", clock.advance(4_000)));

		expect(await clock.instance.tick(clock.now)).toBeNull();
		clock.advance(3_000);
		const match = await clock.instance.tick(clock.now);

		expect(match).not.toBeNull();
		expect(onMatch).toHaveBeenCalledTimes(1);
		expect(match?.players.map((player) => player.username).sort()).toEqual(["Another_Hermit", "BATTLE-DONKEY"]);
		expect(match?.total.xp).toBe(200);
		expect(clock.instance.pendingEvents).toBe(0);
	});

	it("ignores a single player writing on their own", async () => {
		const onMatch = vi.fn();
		const clock = tracker({ onMatch });
		clock.instance.record(statEvent("Another_Hermit", clock.now));
		clock.advance(15_000);

		expect(await clock.instance.tick(clock.now)).toBeNull();
		expect(onMatch).not.toHaveBeenCalled();
		expect(clock.instance.pendingEvents).toBe(0);
	});

	it("ignores writes that are more than 10 seconds apart", async () => {
		const onMatch = vi.fn();
		const clock = tracker({ onMatch });
		clock.instance.record(statEvent("Another_Hermit", clock.now));
		clock.instance.record(statEvent("BATTLE-DONKEY", clock.advance(12_000)));
		clock.advance(4_000);

		expect(await clock.instance.tick(clock.now)).toBeNull();
		expect(onMatch).not.toHaveBeenCalled();
	});

	it("waits for the quiet period before flushing", async () => {
		const onMatch = vi.fn();
		const clock = tracker({ onMatch });
		clock.instance.record(statEvent("Another_Hermit", clock.now));
		clock.instance.record(statEvent("BATTLE-DONKEY", clock.now));
		clock.advance(1_000);
		expect(await clock.instance.tick(clock.now)).toBeNull();
		clock.advance(2_500);
		expect(await clock.instance.tick(clock.now)).not.toBeNull();
		expect(onMatch).toHaveBeenCalledTimes(1);
	});

	it("accumulates several writes from the same player", async () => {
		const onMatch = vi.fn();
		const clock = tracker({ onMatch });
		clock.instance.record(statEvent("Another_Hermit", clock.now, 100));
		clock.instance.record(statEvent("Another_Hermit", clock.advance(2_000), 50));
		clock.instance.record(statEvent("BATTLE-DONKEY", clock.advance(1_000), 70));
		clock.advance(3_000);

		const match = await clock.instance.tick(clock.now);
		const hermit = match?.players.find((player) => player.username === "Another_Hermit");
		expect(hermit?.deltas.xp).toBe(150);
		expect(hermit?.events).toBe(2);
		expect(match?.total.xp).toBe(220);
		expect(hermit?.stats).toContainEqual({
			path: "AccountXP",
			label: "Account XP",
			delta: 150,
			before: 1000,
			after: 1050
		});
	});

	it("does not double flush the same group", async () => {
		const onMatch = vi.fn();
		const clock = tracker({ onMatch });
		clock.instance.record(statEvent("A", clock.now));
		clock.instance.record(statEvent("B", clock.now));
		clock.advance(4_000);
		await clock.instance.tick(clock.now);
		await clock.instance.tick(clock.now + 10_000);
		expect(onMatch).toHaveBeenCalledTimes(1);
	});
});
