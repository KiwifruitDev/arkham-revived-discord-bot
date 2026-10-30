import { ChannelType } from "discord.js";
import { ActivityType, Client, GatewayIntentBits } from "discord.js";
import type { APIEmbed, MessageCreateOptions } from "discord.js";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { PublishResult } from "./publish-queue.ts";

export interface AttachmentFile {
	name: string;
	data: Buffer;
}

export interface DiscordServiceOptions {
	token: string;
	logger?: Logger;
	client?: Client;
	sleep?: (ms: number) => Promise<void>;
}

export interface WebhookMessageOptions {
	username: string;
	avatarUrl?: string | null;
	content?: string;
	embeds?: APIEmbed[];
}

export interface ChannelMessageOptions {
	channelId: string;
	content?: string;
	embeds?: APIEmbed[];
	files?: AttachmentFile[];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Discord operations the bot needs: webhook posts, publishing, bot messages and voice channel renames. */
export class DiscordService {
	readonly client: Client;
	private readonly token: string;
	private readonly logger: Logger;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly ownClient: boolean;
	private readonly warnedChannels = new Set<string>();

	constructor(options: DiscordServiceOptions) {
		this.token = options.token;
		this.logger = options.logger ?? silentLogger;
		this.sleep = options.sleep ?? wait;
		this.ownClient = !options.client;
		this.client = options.client ?? new Client({ intents: [GatewayIntentBits.Guilds] });
	}

	get user() {
		return this.client.user;
	}

	async login(): Promise<void> {
		if (!this.ownClient) return;
		this.client.on("error", (error) => this.logger.error(`Discord client error: ${error.message}`));
		await this.client.login(this.token);
		this.logger.info(`Logged in as ${this.client.user?.tag ?? "unknown"}`);
	}

	async destroy(): Promise<void> {
		if (this.client.isReady()) await this.client.destroy();
	}

	private async postJson(url: string, body: unknown, attempts = 2): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
		for (let attempt = 0; ; attempt += 1) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const text = await response.text();
			let json: Record<string, unknown> | null = null;
			try {
				json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
			} catch {
				json = null;
			}
			if (response.status === 429 && attempt + 1 < attempts) {
				const retryAfter = Number((json as { retry_after?: number } | null)?.retry_after ?? 1);
				this.logger.warn(`Discord webhook rate limited, retrying in ${retryAfter}s`);
				await this.sleep(Math.min(retryAfter * 1000, 10_000));
				continue;
			}
			if (!response.ok) {
				this.logger.error(`Discord webhook failed with ${response.status}: ${text.slice(0, 300)}`);
			}
			return { ok: response.ok, status: response.status, json };
		}
	}

	/** Posts a message through the Discord webhook configured for the player activity channel. */
	async sendWebhookMessage(webhookUrl: string, options: WebhookMessageOptions): Promise<string | null> {
		const body: Record<string, unknown> = {
			username: options.username.slice(0, 80),
			allowed_mentions: { parse: [] }
		};
		if (options.avatarUrl) body.avatar_url = options.avatarUrl;
		if (options.content) body.content = options.content.slice(0, 2000);
		if (options.embeds && options.embeds.length > 0) body.embeds = options.embeds.slice(0, 10);

		const result = await this.postJson(`${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}wait=true`, body);
		if (!result.ok) return null;
		const id = result.json?.id;
		return typeof id === "string" ? id : null;
	}

	/** Crossposts a message so it shows up for every follower of the announcements channel. */
	async publishMessage(channelId: string, messageId: string): Promise<PublishResult> {
		try {
			const channel = await this.client.channels.fetch(channelId);
			if (!channel || channel.type !== ChannelType.GuildAnnouncement || !("messages" in channel)) {
				this.logger.debug(`Channel ${channelId} is not an announcement channel, cannot publish ${messageId}`);
				return { ok: false, permanent: true };
			}
			await channel.messages.crosspost(messageId);
			return { ok: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = Number((error as { status?: number }).status ?? 0);
			const rawRetryAfter = Number(
				(error as { rawError?: { retry_after?: number }; retryAfter?: number }).rawError?.retry_after ??
					(error as { retryAfter?: number }).retryAfter
			);
			if (status === 429) {
				const retryAfterMs = Number.isFinite(rawRetryAfter) ? rawRetryAfter * 1000 : 60_000;
				this.logger.warn(`Publish of ${messageId} was rate limited, retrying in ${Math.round(retryAfterMs / 1000)}s`);
				return { ok: false, retryAfterMs };
			}
			if (status === 404 || /already|unknown message|10008/i.test(message)) {
				this.logger.debug(`Message ${messageId} was already published or deleted`);
				return { ok: false, permanent: true };
			}
			return { ok: false, permanent: status === 403 };
		}
	}

	/** Sends a message as the bot itself (not via webhook) and optionally publishes it. */
	async sendChannelMessage(options: ChannelMessageOptions): Promise<string | null> {
		try {
			const channel = await this.client.channels.fetch(options.channelId);
			if (!channel || !("send" in channel)) {
				this.logger.warn(`Channel ${options.channelId} cannot receive messages`);
				return null;
			}
			const payload: MessageCreateOptions = {
				content: options.content,
				embeds: options.embeds,
				files: options.files?.map((file) => ({ attachment: file.data, name: file.name })),
				allowedMentions: { parse: [] }
			};
			const message = await channel.send(payload);
			return message.id;
		} catch (error) {
			this.logger.error(`Unable to send message to ${options.channelId}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	private static activityTypes: Record<string, ActivityType> = {
		playing: ActivityType.Playing,
		watching: ActivityType.Watching,
		listening: ActivityType.Listening,
		competing: ActivityType.Competing
	};

	/** Sets the bot's online status line, e.g. "Watching Tracking 103 PS3 players". */
	async setPresence(text: string, type = "watching"): Promise<boolean> {
		if (!this.client.user) {
			this.logger.debug("Presence skipped: bot user is not ready");
			return false;
		}
		const name = text.trim().slice(0, 128);
		if (!name) return false;
		const activityType = DiscordService.activityTypes[type.toLowerCase()] ?? ActivityType.Watching;
		try {
			this.client.user.setPresence({
				status: "online",
				activities: [{ name, type: activityType }]
			});
			this.logger.debug(`Presence set to ${activityType} "${name}"`);
			return true;
		} catch (error) {
			this.logger.warn(`Unable to set presence: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async getChannelName(channelId: string): Promise<string | null> {
		try {
			const channel = await this.client.channels.fetch(channelId);
			if (!channel) return null;
			return "name" in channel ? (channel.name ?? null) : null;
		} catch (error) {
			this.reportChannelAccessError(channelId, error);
			return null;
		}
	}

	async renameChannel(channelId: string, name: string): Promise<boolean> {
		try {
			const channel = await this.client.channels.fetch(channelId);
			if (!channel || !("setName" in channel) || typeof channel.setName !== "function") {
				this.logger.warn(`Channel ${channelId} cannot be renamed`);
				return false;
			}
			await channel.setName(name.slice(0, 100), "Arkham: Revived player statistics");
			this.logger.info(`Renamed channel ${channelId} to "${name}"`);
			return true;
		} catch (error) {
			this.reportChannelAccessError(channelId, error);
			return false;
		}
	}

	/** Missing Access on a voice channel almost always means the bot cannot connect to it. */
	private reportChannelAccessError(channelId: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (!/Missing Access|50001/i.test(message)) {
			this.logger.warn(`Unable to update channel ${channelId}: ${message}`);
			return;
		}
		if (this.warnedChannels.has(channelId)) return;
		this.warnedChannels.add(channelId);
		this.logger.warn(
			`Channel ${channelId} is not accessible to the bot. Discord hides voice channels it cannot join, so grant the ` +
				`bot role View Channel, Connect and Manage Channels on that channel (or remove the @everyone Connect deny).`
		);
	}
}
