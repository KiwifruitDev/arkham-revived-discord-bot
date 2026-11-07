import type { CloudflareKvClient } from "./cloudflare.ts";
import type { DiscordService } from "./discord-service.ts";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { StateStore } from "./state.ts";
import type { BotConfig } from "./types.ts";

export interface ChannelStatsOptions {
	config: BotConfig;
	discord: DiscordService;
	state: StateStore;
	kv: CloudflareKvClient;
	logger?: Logger;
	now?: () => number;
}

export function formatChannelName(template: string, count: number): string {
	return template.replace(/\{count\}/g, count.toLocaleString("en-US")).slice(0, 100);
}

/** Keeps the two statistics voice channels named after live numbers (Discord allows 2 renames per 10 minutes). */
export class ChannelStatsService {
	private readonly config: BotConfig;
	private readonly discord: DiscordService;
	private readonly state: StateStore;
	private readonly kv: CloudflareKvClient;
	private readonly logger: Logger;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private expiryTimer: ReturnType<typeof setTimeout> | null = null;
	private running = false;

	constructor(options: ChannelStatsOptions) {
		this.config = options.config;
		this.discord = options.discord;
		this.state = options.state;
		this.kv = options.kv;
		this.logger = options.logger ?? silentLogger;
		this.now = options.now ?? Date.now;
	}

	async refresh(options: { force?: boolean } = {}): Promise<void> {
		if (this.running) {
			this.logger.debug("Channel stats refresh already running, skipping");
			return;
		}
		this.running = true;
		try {
			const matchesInWindow = this.state.matchesInWindow;
			const uniqueUsers = this.state.uniqueUsersInWindow;

			await this.updateChannel(
				this.config.matches_played_today_channel_id,
				this.config.matches_played_today_channel_name,
				matchesInWindow,
				options.force === true
			);
			await this.updateChannel(
				this.config.unique_users_today_channel_id,
				this.config.unique_users_today_channel_name,
				uniqueUsers,
				options.force === true
			);

			let totalPs3Users: number | null = null;
			if (this.kv.enabled) {
				totalPs3Users = await this.kv.countPs3Profiles();
				if (totalPs3Users !== null) {
					await this.updateChannel(
						this.config.total_ps3_users_channel_id,
						this.config.total_ps3_users_channel_name,
						totalPs3Users,
						options.force === true
					);
				}
			}

			await this.updatePresence(totalPs3Users, matchesInWindow, uniqueUsers);
			this.scheduleExpiryRefresh();
		} finally {
			this.running = false;
		}
	}

	/** Shows live numbers as the bot's own status while it is online. */
	private async updatePresence(totalPs3Users: number | null, matchesInWindow: number, uniqueUsers: number): Promise<void> {
		const template = this.config.bot_status_activity;
		if (!template) return;
		const text = template
			.replace(/\{players\}/g, totalPs3Users === null ? "?" : totalPs3Users.toLocaleString("en-US"))
			.replace(/\{matches\}/g, matchesInWindow.toLocaleString("en-US"))
			.replace(/\{unique\}/g, uniqueUsers.toLocaleString("en-US"))
			.replace(/\{unique_users\}/g, uniqueUsers.toLocaleString("en-US"));
		await this.discord.setPresence(text, this.config.bot_status_type);
	}

	/**
	 * Wakes up exactly when the oldest tracked match/authentication leaves the 24 hour window so the
	 * affected channel is edited as soon as the entry is removed.
	 */
	private scheduleExpiryRefresh(): void {
		if (this.expiryTimer) {
			clearTimeout(this.expiryTimer);
			this.expiryTimer = null;
		}
		const nextExpiry = this.state.nextExpiry();
		if (nextExpiry === null) return;

		const delay = Math.max(1_000, nextExpiry - this.now() + 500);
		this.expiryTimer = setTimeout(() => {
			this.expiryTimer = null;
			void this.refresh();
		}, delay);
		this.expiryTimer.unref?.();
		this.logger.debug(`Next window expiry in ${Math.round(delay / 1000)}s`);
	}

	private async updateChannel(channelId: string, template: string, count: number, force: boolean): Promise<boolean> {
		if (!channelId) return false;
		const next = formatChannelName(template, count);
		const current = await this.discord.getChannelName(channelId);
		if (current === next) return false;

		const now = this.now();
		const last = this.state.lastUpdate(channelId);
		if (!force && last > 0 && now - last < this.config.channel_name_update_cooldown_ms) {
			const remaining = this.config.channel_name_update_cooldown_ms - (now - last);
			this.logger.debug(`Skipping rename of ${channelId} (cooldown, ${Math.round(remaining / 1000)}s left)`);
			this.scheduleRetry(remaining);
			return false;
		}

		const renamed = await this.discord.renameChannel(channelId, next);
		if (renamed) this.state.markUpdate(channelId, now);
		return renamed;
	}

	/** Discord allows 2 renames per 10 minutes, so a skipped update is retried once the window opens. */
	private scheduleRetry(delayMs: number): void {
		if (this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.refresh();
		}, Math.max(1_000, delayMs));
		this.retryTimer.unref?.();
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.refresh();
		}, this.config.channel_stats_update_interval_ms);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.expiryTimer) {
			clearTimeout(this.expiryTimer);
			this.expiryTimer = null;
		}
	}
}
