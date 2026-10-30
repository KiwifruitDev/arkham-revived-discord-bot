import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelStatsService, formatChannelName } from "../src/channel-stats.ts";
import { StateStore } from "../src/state.ts";
import { FakeDiscord, FakeKv } from "./fakes.ts";
import { testConfig } from "./fixtures/payloads.ts";

const HOUR = 3_600_000;

function setup(options: { now?: number } = {}) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arkham-stats-"));
	let now = options.now ?? 1_000_000_000;
	const discord = new FakeDiscord();
	const kv = new FakeKv();
	const state = new StateStore(path.join(tempDir, "state.json"), { now: () => now });
	state.load();
	const service = new ChannelStatsService({
		config: testConfig,
		discord: discord as never,
		state,
		kv: kv as never,
		now: () => now
	});
	return {
		discord,
		kv,
		state,
		service,
		tempDir,
		advance(ms: number) {
			now += ms;
		},
		cleanup() {
			service.stop();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	};
}

describe("channel statistics", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("formats channel names from templates", () => {
		expect(formatChannelName("Total PS3 Users: {count}", 1234)).toBe("Total PS3 Users: 1,234");
		expect(formatChannelName("Users Authed Today: {count}", 0)).toBe("Users Authed Today: 0");
	});

	it("renames every statistics channel and sets the bot status", async () => {
		const ctx = setup();
		try {
			await ctx.service.refresh();

			expect(ctx.discord.renames).toEqual([
				{ channelId: testConfig.matches_played_today_channel_id, name: "Matches Played Today: 0" },
				{ channelId: testConfig.unique_users_today_channel_id, name: "Users Authed Today: 0" },
				{ channelId: testConfig.total_ps3_users_channel_id, name: "Total PS3 Users: 103" }
			]);
			expect(ctx.discord.presences).toEqual([
				{ text: "103 PS3 players · 0 matches today · 0 unique users", type: "watching" }
			]);
		} finally {
			ctx.cleanup();
		}
	});

	it("counts matches and unique authentications inside the rolling window", async () => {
		const ctx = setup();
		try {
			ctx.state.recordMatch();
			ctx.state.recordAuthentication("Another_Hermit");
			ctx.state.recordAuthentication("BATTLE-DONKEY");
			ctx.state.recordAuthentication("Another_Hermit");

			await ctx.service.refresh();
			const names = ctx.discord.renames.map((rename) => rename.name);
			expect(names).toContain("Matches Played Today: 1");
			expect(names).toContain("Users Authed Today: 2");
			expect(ctx.discord.presences.at(-1)?.text).toBe("103 PS3 players · 1 matches today · 2 unique users");
		} finally {
			ctx.cleanup();
		}
	});

	it("skips unchanged names and respects the rename cooldown", async () => {
		const ctx = setup();
		try {
			await ctx.service.refresh();
			await ctx.service.refresh();
			expect(ctx.discord.renames).toHaveLength(3);

			ctx.state.recordMatch();
			ctx.advance(60_000);
			await ctx.service.refresh();
			expect(ctx.discord.renames).toHaveLength(3);

			ctx.advance(testConfig.channel_name_update_cooldown_ms);
			await ctx.service.refresh();
			expect(ctx.discord.renames.map((rename) => rename.name)).toContain("Matches Played Today: 1");
		} finally {
			ctx.cleanup();
		}
	});

	it("edits the channel as soon as the oldest entry leaves the 24 hour window", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.state.recordMatch();
			ctx.state.recordAuthentication("Another_Hermit");
			await ctx.service.refresh();
			expect(ctx.discord.renames.map((rename) => rename.name)).toEqual([
				"Matches Played Today: 1",
				"Users Authed Today: 1",
				"Total PS3 Users: 103"
			]);

			ctx.advance(24 * HOUR);
			await vi.advanceTimersByTimeAsync(24 * HOUR + 1_000);

			expect(ctx.discord.renames.map((rename) => rename.name)).toEqual([
				"Matches Played Today: 1",
				"Users Authed Today: 1",
				"Total PS3 Users: 103",
				"Matches Played Today: 0",
				"Users Authed Today: 0"
			]);
			expect(ctx.state.matchesInWindow).toBe(0);
			expect(ctx.state.uniqueUsersInWindow).toBe(0);
		} finally {
			ctx.cleanup();
		}
	});

	it("retries a cooldown-skipped rename once the window opens", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			await ctx.service.refresh();
			ctx.state.recordMatch();
			ctx.advance(60_000);
			await ctx.service.refresh();
			expect(ctx.discord.renames).toHaveLength(3);

			ctx.advance(testConfig.channel_name_update_cooldown_ms);
			await vi.advanceTimersByTimeAsync(testConfig.channel_name_update_cooldown_ms);
			expect(ctx.discord.renames.map((rename) => rename.name)).toContain("Matches Played Today: 1");
		} finally {
			ctx.cleanup();
		}
	});

	it("keeps the status meaningful when the player count is unavailable", async () => {
		const ctx = setup();
		try {
			ctx.kv.enabled = false;
			ctx.state.recordMatch();
			await ctx.service.refresh();

			expect(ctx.discord.presences).toEqual([{ text: "? PS3 players · 1 matches today · 0 unique users", type: "watching" }]);
			expect(ctx.discord.renames).toHaveLength(2);
		} finally {
			ctx.cleanup();
		}
	});
});