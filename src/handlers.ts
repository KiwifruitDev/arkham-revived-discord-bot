import { composeAvatarGrid } from "./avatar-grid.ts";
import type { ChannelStatsService } from "./channel-stats.ts";
import type { DiscordService } from "./discord-service.ts";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { MatchTracker } from "./match-tracker.ts";
import { buildLoginContent, buildMatchEmbed, buildProfileUpdateEmbed, formatWebhookDisplayName } from "./messages.ts";
import { deriveStatChanges, hasStatIncrease, sumStatDeltas } from "./profile-diff.ts";
import type { PublishQueue } from "./publish-queue.ts";
import type { PsnService } from "./psn.ts";
import type { StateStore } from "./state.ts";
import type { BotConfig, BotEnv, MatchResult, ProfileUpdatePayload, PlayerLoginPayload, WebhookPayload } from "./types.ts";

export interface ActivityHandlerOptions {
	config: BotConfig;
	env: BotEnv;
	discord: DiscordService;
	psn: PsnService;
	state: StateStore;
	tracker: MatchTracker;
	stats: ChannelStatsService;
	/** Rate limited crosspost queue (Discord allows 10 publishes per hour per announcement channel). */
	publisher: Pick<PublishQueue, "enqueue">;
	logger?: Logger;
}

export interface ActivityHandlers {
	onPayload: (payload: WebhookPayload) => Promise<void>;
	handleMatch: (match: MatchResult) => Promise<void>;
	/** Webhook avatar URL: a locally hosted cached avatar when PUBLIC_BASE_URL is set, otherwise the PSN CDN. */
	avatarUrlFor: (username: string) => Promise<string | null>;
}

export function createActivityHandlers(options: ActivityHandlerOptions): ActivityHandlers {
	const { config, env, discord, psn, state, tracker, stats } = options;
	const logger = options.logger ?? silentLogger;

	async function avatarUrlFor(username: string): Promise<string | null> {
		const entry = await psn.getEntry(username);
		if (env.publicBaseUrl && entry.file) {
			return `${env.publicBaseUrl}/avatars/${encodeURIComponent(entry.file)}`;
		}
		return entry.url;
	}

	async function publishActivity(messageId: string | null): Promise<void> {
		if (!messageId || !config.publish_player_activity || !config.player_activity_channel_id) return;
		await options.publisher.enqueue(config.player_activity_channel_id, messageId, "player_activity");
	}

	async function announceLogin(payload: PlayerLoginPayload): Promise<void> {
		const auth = state.recordAuthentication(payload.username);
		if (auth.counted) {
			logger.info(`New authentication for ${payload.username} (${auth.uniqueUsers} unique users in the last 24h)`);
		}

		const avatarUrl = await avatarUrlFor(payload.username);
		const messageId = await discord.sendWebhookMessage(env.discordWebhookUrl, {
			username: formatWebhookDisplayName(config, payload.username, payload.platform),
			avatarUrl,
			content: buildLoginContent(payload.username, payload.platform)
		});
		//await publishActivity(messageId);
		logger.info(`Announced login for ${payload.username}`);

		// Keep the unique user channel (and the bot status) in sync with the new authentication.
		if (auth.counted) await stats.refresh();
	}

	async function announceProfileUpdate(payload: ProfileUpdatePayload): Promise<void> {
		const statChanges = deriveStatChanges(payload.changes);
		const deltas = sumStatDeltas(statChanges);
		if (hasStatIncrease(deltas)) {
			const parsed = payload.timestamp ? Date.parse(payload.timestamp) : Number.NaN;
			tracker.record({
				username: payload.username,
				uuid: payload.uuid,
				platform: payload.platform,
				timestamp: Number.isFinite(parsed) ? parsed : Date.now(),
				deltas,
				stats: statChanges
			});
		}

		const avatarUrl = await avatarUrlFor(payload.username);
		const messageId = await discord.sendWebhookMessage(env.discordWebhookUrl, {
			username: formatWebhookDisplayName(config, payload.username, payload.platform),
			avatarUrl,
			embeds: [buildProfileUpdateEmbed(payload, { avatarUrl })]
		});
		//await publishActivity(messageId);
		logger.info(`Announced profile update for ${payload.username} (${payload.changes.length} changes)`);
	}

	async function handleMatch(match: MatchResult): Promise<void> {
		const avatars = await Promise.all(match.players.map((player) => psn.getAvatarBuffer(player.username)));
		const image = await composeAvatarGrid(avatars, { cellSize: config.avatar_grid_cell_size });
		const matchesInWindow = state.recordMatch();
		const embed = buildMatchEmbed(match, { matchesPlayedToday: matchesInWindow, imageName: "match-result.png" });

		const messageId = await discord.sendChannelMessage({
			channelId: config.player_activity_channel_id,
			embeds: [embed],
			files: [{ name: "match-result.png", data: image }]
		});
		if (messageId && config.publish_player_activity) {
			await options.publisher.enqueue(config.player_activity_channel_id, messageId, "match_result");
		}
		logger.info(`Posted match result for ${match.players.length} players (message ${messageId ?? "unavailable"})`);

		await stats.refresh();
	}

	async function onPayload(payload: WebhookPayload): Promise<void> {
		switch (payload.type) {
			case "player_login":
				await announceLogin(payload);
				return;
			case "profile_update":
				await announceProfileUpdate(payload);
				return;
			default:
				logger.warn(`Ignoring unknown webhook payload type "${(payload as { type?: string }).type}"`);
		}
	}

	return { onPayload, handleMatch, avatarUrlFor };
}
