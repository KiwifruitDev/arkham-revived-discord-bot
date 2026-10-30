import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActivityHandlers } from "../src/handlers.ts";
import { MatchTracker } from "../src/match-tracker.ts";
import { StateStore } from "../src/state.ts";
import { MemoryPublishQueueStore, PublishQueue } from "../src/publish-queue.ts";
import { createWebhookServer } from "../src/webhook-server.ts";
import type { WebhookServer } from "../src/webhook-server.ts";
import type { WebhookPayload } from "../src/types.ts";
import { FakeDiscord, FakePsn, FakeStats } from "./fakes.ts";
import {
	loginPayload,
	profileUpdatePayload,
	secondPlayerProfileUpdate,
	testConfig,
	testEnv
} from "./fixtures/payloads.ts";

async function solidPng(color: { r: number; g: number; b: number }): Promise<Buffer> {
	return sharp({ create: { width: 96, height: 96, channels: 4, background: { ...color, alpha: 1 } } })
		.png()
		.toBuffer();
}

interface Harness {
	server: WebhookServer;
	discord: FakeDiscord;
	psn: FakePsn;
	stats: FakeStats;
	state: StateStore;
	tracker: MatchTracker;
	post: (payload: WebhookPayload) => Promise<Response>;
	advance: (ms: number) => void;
	tick: () => Promise<void>;
	tempDir: string;
}

describe("cloudflare worker flow", () => {
	let harness: Harness;

	beforeEach(async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arkham-bot-"));
		const discord = new FakeDiscord();
		const psn = new FakePsn();
		const stats = new FakeStats();
		const state = new StateStore(path.join(tempDir, "state.json"));
		state.load();

		psn.avatars.set("Another_Hermit", await solidPng({ r: 200, g: 20, b: 20 }));
		psn.avatars.set("BATTLE-DONKEY", await solidPng({ r: 20, g: 20, b: 200 }));

		let clock = Date.parse(secondPlayerProfileUpdate.timestamp);
		const tracker = new MatchTracker({
			windowMs: testConfig.match_detection_window_ms,
			quietMs: testConfig.match_detection_quiet_ms,
			minPlayers: testConfig.match_min_players,
			now: () => clock,
			onMatch: (match) => handlers.handleMatch(match)
		});

		const publisher = new PublishQueue({
			publish: (channelId, messageId) => discord.publishMessage(channelId, messageId),
			store: new MemoryPublishQueueStore(),
			now: () => clock
		});

		const handlers = createActivityHandlers({
			config: testConfig,
			env: testEnv,
			discord: discord as never,
			psn: psn as never,
			state,
			tracker,
			stats: stats as never,
			publisher
		});

		const server = createWebhookServer({
			port: 0,
			webhookPath: testConfig.webhook_path,
			secret: testEnv.webhookSecret,
			onPayload: handlers.onPayload
		});
		await server.listen();

		harness = {
			server,
			discord,
			psn,
			stats,
			state,
			tracker,
			tempDir,
			post: (payload) =>
				fetch(server.url, {
					method: "POST",
					headers: { "content-type": "application/json", "x-webhook-secret": testEnv.webhookSecret },
					body: JSON.stringify(payload)
				}),
			advance: (ms) => {
				clock += ms;
			},
			tick: async () => {
				await tracker.tick(clock);
			}
		};
	});

	afterEach(async () => {
		await harness.server.close();
		fs.rmSync(harness.tempDir, { recursive: true, force: true });
	});

	it("announces logins with the PSN display name, avatar and a published message", async () => {
		const response = await harness.post(loginPayload);
		expect(response.status).toBe(202);

		expect(harness.discord.webhookMessages).toHaveLength(1);
		const message = harness.discord.webhookMessages[0];
		expect(message.username).toBe("Arkham: Revived: Redux - Another_Hermit (PS3)");
		expect(message.content).toBe("**Another_Hermit** (PS3) has logged in to Arkham: Revived Redux.");
		expect(message.avatarUrl).toContain("Another_Hermit");
		expect(message.webhookUrl).toBe(testEnv.discordWebhookUrl);
		expect(message.embeds ?? []).toHaveLength(0);

		expect(harness.discord.published).toEqual([
			{ channelId: testConfig.player_activity_channel_id, messageId: "webhook-message-1" }
		]);
		expect(harness.state.uniqueUsersInWindow).toBe(1);
		expect(harness.stats.refreshes).toBe(1);
	});

	it("does not count repeat logins as new unique users", async () => {
		await harness.post(loginPayload);
		await harness.post(loginPayload);

		expect(harness.state.uniqueUsersInWindow).toBe(1);
		expect(harness.stats.refreshes).toBe(1);
		expect(harness.discord.webhookMessages).toHaveLength(2);
	});

	it("posts a concise before/after diff for profile writes", async () => {
		const response = await harness.post(profileUpdatePayload);
		expect(response.status).toBe(202);

		const message = harness.discord.webhookMessages[0];
		expect(message.username).toBe("Arkham: Revived: Redux - Another_Hermit (PS3)");
		expect(message.content).toBeUndefined();
		const embed = message.embeds?.[0];
		expect(embed?.description).toContain("**Account XP**: 1,250 -> 1,480");
		expect(embed?.description).toContain("**Account XP Level**: 28 -> 29");
		expect(embed?.description).toContain("**Hero Kills On Elites**: 12 -> 15");
		expect(embed?.description).toContain("**Map Round Win Chemplant Hero**: No -> Yes");
		expect(embed?.thumbnail?.url).toContain("Another_Hermit");
		expect(harness.discord.published).toHaveLength(1);
	});

	it("turns two players reporting XP inside 10 seconds into a match embed with an avatar grid", async () => {
		await harness.post(profileUpdatePayload);
		await harness.post(secondPlayerProfileUpdate);
		expect(harness.tracker.pendingEvents).toBe(2);
		expect(harness.discord.channelMessages).toHaveLength(0);

		harness.advance(4_000);
		await harness.tick();

		expect(harness.discord.channelMessages).toHaveLength(1);
		const message = harness.discord.channelMessages[0];
		expect(message.channelId).toBe(testConfig.player_activity_channel_id);
		expect(message.embeds?.[0]?.title).toBe("Match Result");

		const fieldNames = (message.embeds?.[0]?.fields ?? []).map((field) => field.name);
		expect(fieldNames.sort()).toEqual(["Another_Hermit", "BATTLE-DONKEY"]);

		const hermitField = (message.embeds?.[0]?.fields ?? []).find((field) => field.name === "Another_Hermit");
		expect(hermitField?.value).toContain("**Account XP**: +230 (total 1,480)");
		expect(hermitField?.value).toContain("**Account Level**: +1 (total 29)");
		expect(hermitField?.value).toContain("**Hero Kills**: +3 (total 15)");
		expect(hermitField?.value).toContain("**Gang Kills**: +1 (total 4)");

		const donkeyField = (message.embeds?.[0]?.fields ?? []).find((field) => field.name === "BATTLE-DONKEY");
		expect(donkeyField?.value).toContain("**Account XP**: +110 (total 910)");
		expect(donkeyField?.value).toContain("**Bane Level**: +1 (total 13)");

		expect(message.embeds?.[0]?.image?.url).toBe("attachment://match-result.png");

		expect(message.files).toHaveLength(1);
		expect(message.files?.[0].name).toBe("match-result.png");
		expect(message.files?.[0].data.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		const metadata = await sharp(message.files?.[0].data).metadata();
		expect(metadata.width).toBe(2 * testConfig.avatar_grid_cell_size + 3 * 6);

		expect(harness.discord.published).toContainEqual({ channelId: testConfig.player_activity_channel_id, messageId: message.id });
		expect(harness.state.matchesInWindow).toBe(1);
		expect(harness.stats.refreshes).toBe(1);
	});

	it("only publishes the match once the quiet period passed", async () => {
		await harness.post(profileUpdatePayload);
		await harness.post(secondPlayerProfileUpdate);

		harness.advance(1_000);
		await harness.tick();
		expect(harness.discord.channelMessages).toHaveLength(0);

		harness.advance(2_500);
		await harness.tick();
		expect(harness.discord.channelMessages).toHaveLength(1);
	});

	it("does not treat a single player's writes as a match", async () => {
		await harness.post(profileUpdatePayload);
		await harness.post({ ...profileUpdatePayload, timestamp: "2026-10-30T08:05:08.000Z" });
		harness.advance(5_000);
		await harness.tick();

		expect(harness.discord.channelMessages).toHaveLength(0);
		expect(harness.state.matchesInWindow).toBe(0);
		expect(harness.discord.webhookMessages).toHaveLength(2);
	});

	it("ignores profile writes without stat changes when detecting matches", async () => {
		await harness.post({
			...profileUpdatePayload,
			changes: [{ path: "LastModified", before: "a", after: "b" }]
		});
		expect(harness.tracker.pendingEvents).toBe(0);
		expect(harness.discord.webhookMessages).toHaveLength(1);
	});

	it("uses locally hosted avatars when PUBLIC_BASE_URL is configured", async () => {
		const handlers = createActivityHandlers({
			config: testConfig,
			env: { ...testEnv, publicBaseUrl: "https://bot.example.com" },
			discord: harness.discord as never,
			psn: harness.psn as never,
			state: harness.state,
			tracker: harness.tracker,
			stats: harness.stats as never,
			publisher: { enqueue: async () => {} }
		});
		expect(await handlers.avatarUrlFor("Another_Hermit")).toBe("https://bot.example.com/avatars/Another_Hermit.img");
	});
});
