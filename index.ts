import path from "node:path";
import { assertRequiredEnv, loadConfig } from "./src/config.ts";
import { ChannelStatsService } from "./src/channel-stats.ts";
import { CloudflareKvClient } from "./src/cloudflare.ts";
import { DiscordService } from "./src/discord-service.ts";
import { createActivityHandlers } from "./src/handlers.ts";
import { createLogger } from "./src/logger.ts";
import { MatchTracker } from "./src/match-tracker.ts";
import { PsnService } from "./src/psn.ts";
import { JsonPublishQueueStore, PublishQueue } from "./src/publish-queue.ts";
import { StateStore } from "./src/state.ts";
import { createWebhookServer } from "./src/webhook-server.ts";

async function main(): Promise<void> {
	const { config, env, paths } = loadConfig();
	assertRequiredEnv(env);

	const logger = createLogger(config.log_level);
	logger.info("Starting Arkham: Revived Redux Discord bot");

	const discord = new DiscordService({ token: env.discordBotToken, logger: logger.child("discord") });
	await discord.login();

	const psn = new PsnService({
		npsso: env.psnNpsso,
		cacheDir: paths.avatars,
		ttlMs: config.avatar_cache_ttl_ms,
		logger: logger.child("psn")
	});

	const state = new StateStore(path.join(paths.state, "state.json"), {
		windowMs: config.stats_window_ms,
		logger: logger.child("state")
	});
	state.load();

	const kv = new CloudflareKvClient({
		apiToken: env.cloudflareApiToken,
		accountId: env.cloudflareAccountId,
		namespaceId: env.cloudflareProfilesNamespaceId,
		logger: logger.child("cloudflare")
	});
	if (!kv.enabled) logger.warn("Cloudflare API token is missing, the total PS3 users channel will not update");

	const stats = new ChannelStatsService({
		config,
		discord,
		state,
		kv,
		logger: logger.child("channels")
	});

	const tracker = new MatchTracker({
		windowMs: config.match_detection_window_ms,
		quietMs: config.match_detection_quiet_ms,
		minPlayers: config.match_min_players,
		logger: logger.child("matches"),
		onMatch: (match) => handlers.handleMatch(match)
	});

	const publisher = new PublishQueue({
		publish: (channelId, messageId) => discord.publishMessage(channelId, messageId),
		maxPerWindow: config.publish_max_per_hour,
		windowMs: config.publish_window_ms,
		maxAgeMs: config.publish_queue_max_age_ms,
		store: new JsonPublishQueueStore(path.join(paths.state, "publish-queue.json"), {
			logger: logger.child("publish")
		}),
		logger: logger.child("publish")
	});

	const handlers = createActivityHandlers({
		config,
		env,
		discord,
		psn,
		state,
		tracker,
		stats,
		publisher,
		logger: logger.child("activity")
	});

	const server = createWebhookServer({
		port: config.webhook_port,
		webhookPath: config.webhook_path,
		secret: env.webhookSecret,
		avatarDirectory: paths.avatars,
		logger: logger.child("webhook"),
		onPayload: handlers.onPayload
	});
	await server.listen();

	tracker.start();
	stats.start();
	publisher.start();
	void stats.refresh();

	const shutdown = async (signal: string): Promise<void> => {
		logger.info(`Received ${signal}, shutting down`);
		tracker.stop();
		stats.stop();
		publisher.stop();
		await server.close();
		await discord.destroy();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	logger.info("Ready: waiting for Cloudflare Worker webhooks");
}

main().catch((error: unknown) => {
	console.error("Fatal error while starting the bot:", error);
	process.exit(1);
});