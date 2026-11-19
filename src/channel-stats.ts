import type { CloudflareKvClient, KvDailyWriteUsage } from "./cloudflare.ts";
import type { DiscordService } from "./discord-service.ts";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { StateStore } from "./state.ts";
import type { BotConfig } from "./types.ts";
import type { PublishQueue } from "./publish-queue.ts";
import { formatLocalized } from "./localization.ts";

export interface ChannelStatsOptions {
	config: BotConfig;
	discord: DiscordService;
	state: StateStore;
	kv: CloudflareKvClient;
	publisher?: Pick<PublishQueue, "enqueue">;
	logger?: Logger;
	now?: () => number;
}

export function formatChannelName(template: string, count: number, language = "en-US"): string {
	return formatLocalized(template, { count: count.toLocaleString(language) }).slice(0, 100);
}

/** Keeps the two statistics voice channels named after live numbers (Discord allows 2 renames per 10 minutes). */
export class ChannelStatsService {
	private readonly config: BotConfig;
	private readonly discord: DiscordService;
	private readonly state: StateStore;
	private readonly kv: CloudflareKvClient;
	private readonly publisher?: Pick<PublishQueue, "enqueue">;
	private readonly logger: Logger;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private expiryTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPresence: { text: string; type: string; status: "online" | "idle" | "dnd" } | null = null;
	private running = false;

	constructor(options: ChannelStatsOptions) {
		this.config = options.config;
		this.discord = options.discord;
		this.state = options.state;
		this.kv = options.kv;
		this.publisher = options.publisher;
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
				this.config.strings.matches_played_today_channel_name,
				matchesInWindow,
				options.force === true
			);
			await this.updateChannel(
				this.config.unique_users_today_channel_id,
				this.config.strings.unique_users_today_channel_name,
				uniqueUsers,
				options.force === true
			);

			let totalPs3Users: number | null = null;
			if (this.kv.enabled) {
				totalPs3Users = await this.kv.countPs3Profiles();
				if (totalPs3Users !== null) {
					await this.updateChannel(
						this.config.total_ps3_users_channel_id,
						this.config.strings.total_ps3_users_channel_name,
						totalPs3Users,
						options.force === true
					);
				}
			}

			await this.refreshUsage();
			await this.updatePresence(totalPs3Users, matchesInWindow, uniqueUsers);
			this.scheduleExpiryRefresh();
		} finally {
			this.running = false;
		}
	}

	/** Shows live numbers as the bot's own status while it is online. */
	private async updatePresence(totalPs3Users: number | null, matchesInWindow: number, uniqueUsers: number): Promise<void> {
		const usage = this.state.kvUsageState;
		if (usage?.limitReached) {
			await this.setPresence(this.config.strings.kv_unavailable_status, "dnd");
			return;
		}
		if (usage?.warningActive) {
			await this.setPresence(
				formatLocalized(this.config.strings.kv_warning_status, { remaining: usage.remainingPercent }),
				"idle"
			);
			return;
		}

		const template = this.config.strings.bot_status_activity;
		if (!template) return;
		const text = formatLocalized(template, {
			players: totalPs3Users === null ? "?" : totalPs3Users.toLocaleString(this.config.language),
			matches: matchesInWindow.toLocaleString(this.config.language),
			unique: uniqueUsers.toLocaleString(this.config.language),
			unique_users: uniqueUsers.toLocaleString(this.config.language)
		});
		await this.setPresence(text, "online");
	}

	private async setPresence(text: string, status: "online" | "idle" | "dnd"): Promise<void> {
		const type = this.config.bot_status_type;
		if (this.lastPresence?.text === text && this.lastPresence.type === type && this.lastPresence.status === status) return;
		const updated = await this.discord.updatePresence(text, type, status);
		if (updated) this.lastPresence = { text, type, status };
	}

	/** Refreshes account-wide write analytics and applies daily warning/recovery transitions. */
	async refreshUsage(): Promise<void> {
		if (!this.config.kv_usage_channel_id || !this.kv.enabled) return;
		let usage: KvDailyWriteUsage | null;
		try {
			usage = await this.kv.getDailyWriteUsage();
		} catch (error) {
			this.logger.warn(`Cloudflare KV usage refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (!usage) return;
		await this.applyUsage(usage);
	}

	private async applyUsage(usage: KvDailyWriteUsage): Promise<void> {
		const previous = this.state.kvUsageState;
		const dateChanged = previous !== null && previous.date !== usage.date;
		let warningActive = !dateChanged && previous?.warningActive === true;
		let warningSent = !dateChanged && previous?.warningSent === true;
		let limitReached = !dateChanged && previous?.limitReached === true;
		let limitNoticeSent = !dateChanged && previous?.limitNoticeSent === true;
		let remainingPercent = !dateChanged && previous ? previous.remainingPercent : 100;
		let resetNoticePending = dateChanged ? previous?.limitReached === true : previous?.resetNoticePending === true;

		if (resetNoticePending) {
			const messageId = await this.discord.sendChannelMessage({
				channelId: this.config.player_activity_channel_id,
				content: this.config.strings.kv_reset_message
			});
			if (messageId) {
				resetNoticePending = false;
				if (this.publisher) {
					await this.publisher.enqueue(this.config.player_activity_channel_id, messageId, "player_activity");
				}
			}
		}

		if (usage.plan === "paid") {
			warningActive = false;
			warningSent = false;
			limitReached = false;
			limitNoticeSent = false;
			remainingPercent = 100;
		} else if (usage.dailyLimit !== null && usage.dailyLimit > 0) {
			const percent = Math.floor((usage.writes / usage.dailyLimit) * 100);
			const displayPercent = Math.min(100, percent);
			remainingPercent = Math.min(remainingPercent, Math.max(0, 100 - displayPercent));
			warningActive = warningActive || percent >= 50;
			limitReached = limitReached || percent >= 100;

			if (percent >= 50 && !warningSent) {
				const messageId = await this.discord.sendChannelMessage({
					channelId: this.config.player_activity_channel_id,
					content:
						percent >= 100
								? this.config.strings.kv_exhausted_message
								: formatLocalized(this.config.strings.kv_warning_message, {
										percent: displayPercent,
										remaining: remainingPercent
									})
				});
				if (messageId) {
					warningSent = true;
					if (this.publisher) {
						await this.publisher.enqueue(this.config.player_activity_channel_id, messageId, "player_activity");
					}
				}
			}

			if (percent >= 100 && !limitNoticeSent) {
				const messageId = await this.discord.sendChannelMessage({
					channelId: this.config.player_activity_channel_id,
					content: this.config.strings.kv_limit_reached_message
				});
				if (messageId) {
					limitNoticeSent = true;
					if (this.publisher) {
						await this.publisher.enqueue(this.config.player_activity_channel_id, messageId, "player_activity");
					}
				}
			}
		}

		this.state.setKvUsageState({
			date: usage.date,
			warningActive,
			warningSent,
			limitReached,
			limitNoticeSent,
			remainingPercent,
			resetNoticePending
		});

		if (limitReached) {
			await this.setPresence(this.config.strings.kv_unavailable_status, "dnd");
		} else if (warningActive) {
			await this.setPresence(
				formatLocalized(this.config.strings.kv_warning_status, { remaining: remainingPercent }),
				"idle"
			);
		} else if ((previous?.warningActive || previous?.limitReached) && !this.running) {
			void this.refresh();
		}

		await this.updateChannel(
			this.config.kv_usage_channel_id,
			formatKvUsageChannelName(usage, this.config.strings, this.config.language),
			usage.writes,
			false
		);
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
		const next = formatChannelName(template, count, this.config.language);
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

		const renamed = await this.discord.renameChannel(channelId, next, this.config.strings.channel_rename_reason);
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

export function formatKvUsageChannelName(
	usage: KvDailyWriteUsage,
	strings: BotConfig["strings"],
	language = "en-US"
): string {
	if (usage.dailyLimit === null || usage.dailyLimit <= 0) {
		const template = usage.plan === "paid" ? strings.kv_usage_paid_channel_name : strings.kv_usage_unknown_channel_name;
		return formatLocalized(template, { count: usage.writes.toLocaleString(language) }).slice(0, 100);
	}
	const percent = Math.min(100, Math.floor((usage.writes / usage.dailyLimit) * 100));
	const filled = Math.floor(percent / 5);
	return formatLocalized(strings.kv_usage_limited_channel_name, {
		percent,
		bar: `${"#".repeat(filled)}${".".repeat(20 - filled)}`
	}).slice(0, 100);
}
