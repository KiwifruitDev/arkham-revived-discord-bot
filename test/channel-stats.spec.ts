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
		expect(formatChannelName("Logins (24h): {count}", 0)).toBe("Logins (24h): 0");
	});

	it("renames every statistics channel and sets the bot status", async () => {
		const ctx = setup();
		try {
			await ctx.service.refresh();

			expect(ctx.discord.renames).toEqual([
				{ channelId: testConfig.matches_played_today_channel_id, name: "Matches (24h): 0" },
				{ channelId: testConfig.unique_users_today_channel_id, name: "Logins (24h): 0" },
				{ channelId: testConfig.total_ps3_users_channel_id, name: "Total PS3 Users: 103" }
			]);
			expect(ctx.discord.presences).toEqual([
				{ text: "Tracking 103 PS3 players...", type: "watching", status: "online" }
			]);
		} finally {
			ctx.cleanup();
		}
	});

	it("counts matches and unique authentications inside the rolling window", async () => {
		const ctx = setup();
		try {
			ctx.state.recordMatch();
			ctx.state.recordAuthentication("KiwifruitDev");
			ctx.state.recordAuthentication("BATTLE-DONKEY");
			ctx.state.recordAuthentication("KiwifruitDev");

			await ctx.service.refresh();
			const names = ctx.discord.renames.map((rename) => rename.name);
			expect(names).toContain("Matches (24h): 1");
			expect(names).toContain("Logins (24h): 2");
			expect(ctx.discord.presences.at(-1)).toEqual({
				text: "Tracking 103 PS3 players...",
				type: "watching",
				status: "online"
			});
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
			expect(ctx.discord.renames.map((rename) => rename.name)).toContain("Matches (24h): 1");
		} finally {
			ctx.cleanup();
		}
	});

	it("edits the channel as soon as the oldest entry leaves the 24 hour window", async () => {
		vi.useFakeTimers();
		const ctx = setup();
		try {
			ctx.state.recordMatch();
			ctx.state.recordAuthentication("KiwifruitDev");
			await ctx.service.refresh();
			expect(ctx.discord.renames.map((rename) => rename.name)).toEqual([
				"Matches (24h): 1",
				"Logins (24h): 1",
				"Total PS3 Users: 103"
			]);

			ctx.advance(24 * HOUR);
			await vi.advanceTimersByTimeAsync(24 * HOUR + 1_000);

			expect(ctx.discord.renames.map((rename) => rename.name)).toEqual([
				"Matches (24h): 1",
				"Logins (24h): 1",
				"Total PS3 Users: 103",
				"Matches (24h): 0",
				"Logins (24h): 0"
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
			expect(ctx.discord.renames.map((rename) => rename.name)).toContain("Matches (24h): 1");
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

			expect(ctx.discord.presences).toEqual([
				{ text: "Tracking ? PS3 players...", type: "watching", status: "online" }
			]);
			expect(ctx.discord.renames).toHaveLength(2);
		} finally {
			ctx.cleanup();
		}
	});

	it("warns at half of the account's free-tier daily writes", async () => {
		const ctx = setup();
		try {
			ctx.kv.dailyUsage = { date: "2026-11-19", writes: 500, dailyLimit: 1_000, plan: "free" };
			await ctx.service.refresh();

			expect(ctx.discord.renames).toContainEqual({
				channelId: testConfig.kv_usage_channel_id,
				name: "Usage: 50% [##########..........]"
			});
			expect(ctx.discord.channelMessages.map((message) => message.content)).toEqual([
				"Cloudflare KV has used 50% of today's daily write allowance, with 50% remaining. If usage reaches 100%, the server will be unavailable until the daily reset."
			]);
			expect(ctx.discord.presences.at(-1)).toEqual({
				text: "Warning: 50% daily usage remaining",
				type: "watching",
				status: "idle"
			});

			ctx.kv.dailyUsage = { date: "2026-11-20", writes: 0, dailyLimit: 1_000, plan: "free" };
			await ctx.service.refresh();
			expect(ctx.discord.channelMessages).toHaveLength(1);
			expect(ctx.discord.presences.at(-1)?.status).toBe("online");
		} finally {
			ctx.cleanup();
		}
	});

	it("marks the bot unavailable at the limit and announces only a later daily reset", async () => {
		const ctx = setup();
		try {
			ctx.kv.dailyUsage = { date: "2026-11-19", writes: 1_000, dailyLimit: 1_000, plan: "free" };
			await ctx.service.refresh();

			expect(ctx.discord.renames).toContainEqual({
				channelId: testConfig.kv_usage_channel_id,
				name: "Usage: 100% [####################]"
			});
			expect(ctx.discord.channelMessages.map((message) => message.content)).toEqual([
				"Cloudflare KV's daily write allowance has been exhausted. The server is unavailable until the daily reset.",
				"The server is unavailable because Cloudflare KV's daily write allowance has been reached. Service will resume after the daily reset."
			]);
			expect(ctx.discord.presences.at(-1)).toEqual({
				text: "Unavailable: daily usage limit reached",
				type: "watching",
				status: "dnd"
			});

			ctx.kv.dailyUsage = { date: "2026-11-20", writes: 0, dailyLimit: 1_000, plan: "free" };
			await ctx.service.refresh();

			expect(ctx.discord.channelMessages.map((message) => message.content).at(-1)).toBe(
				"Cloudflare KV's daily write allowance has reset. Profile saves are available again."
			);
			expect(ctx.discord.presences.at(-1)).toEqual({
				text: "Tracking 103 PS3 players...",
				type: "watching",
				status: "online"
			});
		} finally {
			ctx.cleanup();
		}
	});

	it("routes simulated threshold and reset notifications once without contacting Cloudflare", async () => {
		const ctx = setup();
		try {
			ctx.kv.dailyUsage = { date: "2026-11-19", writes: 499, dailyLimit: 1_000, plan: "free" };
			await ctx.service.refresh();
			expect(ctx.discord.channelMessages).toHaveLength(0);

			ctx.kv.dailyUsage = { date: "2026-11-19", writes: 500, dailyLimit: 1_000, plan: "free" };
			await ctx.service.refresh();
			expect(ctx.discord.channelMessages).toHaveLength(1);
			expect(ctx.discord.channelMessages[0]).toMatchObject({
				channelId: testConfig.player_activity_channel_id,
				content: testConfig.strings.kv_warning_message
					.replace("{percent}", "50")
					.replace("{remaining}", "50")
			});

			ctx.kv.dailyUsage = { date: "2026-11-19", writes: 1_000, dailyLimit: 1_000, plan: "free" };
			await ctx.service.refresh();
			await ctx.service.refresh();
			expect(ctx.discord.channelMessages).toHaveLength(2);
			expect(ctx.discord.channelMessages[1]).toMatchObject({
				channelId: testConfig.player_activity_channel_id,
				content: testConfig.strings.kv_limit_reached_message
			});

			ctx.kv.dailyUsage = { date: "2026-11-20", writes: 0, dailyLimit: 1_000, plan: "free" };
			await ctx.service.refresh();
			expect(ctx.discord.channelMessages).toHaveLength(3);
			expect(ctx.discord.channelMessages[2]).toMatchObject({
				channelId: testConfig.player_activity_channel_id,
				content: testConfig.strings.kv_reset_message
			});
		} finally {
			ctx.cleanup();
		}
	});

	it("does not warn for paid accounts with no daily cap", async () => {
		const ctx = setup();
		try {
			ctx.kv.dailyUsage = { date: "2026-11-19", writes: 5_000, dailyLimit: null, plan: "paid" };
			await ctx.service.refresh();

			expect(ctx.discord.renames).toContainEqual({
				channelId: testConfig.kv_usage_channel_id,
				name: "Usage: 5,000 writes (no daily cap)"
			});
			expect(ctx.discord.channelMessages).toHaveLength(0);
			expect(ctx.discord.presences.at(-1)?.status).toBe("online");
		} finally {
			ctx.cleanup();
		}
	});

	it("keeps the warning status active and retries a failed warning message", async () => {
		const ctx = setup();
		try {
			ctx.kv.dailyUsage = { date: "2026-11-19", writes: 500, dailyLimit: 1_000, plan: "free" };
			ctx.discord.failChannelMessages = true;
			await ctx.service.refresh();
			expect(ctx.discord.presences.at(-1)?.status).toBe("idle");

			ctx.discord.failChannelMessages = false;
			await ctx.service.refresh();
			expect(ctx.discord.channelMessages).toHaveLength(1);
		} finally {
			ctx.cleanup();
		}
	});
});