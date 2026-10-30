import fs from "node:fs";
import path from "node:path";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";

export interface PublishResult {
	ok: boolean;
	/** Milliseconds to wait before retrying (Discord rate limits). */
	retryAfterMs?: number;
	/** True when retrying can never succeed (already crossposted, channel is not an announcement channel, ...). */
	permanent?: boolean;
}

export type PublishFn = (channelId: string, messageId: string) => Promise<PublishResult>;

export interface PendingPublish {
	channelId: string;
	messageId: string;
	queuedAt: number;
	attempts: number;
	reason?: string;
}

export interface PublishQueueData {
	/** Successful publish timestamps per channel, used for the sliding window. */
	history: Record<string, number[]>;
	pending: PendingPublish[];
}

export interface PublishQueueStore {
	load(): PublishQueueData;
	save(data: PublishQueueData): void;
}

export class JsonPublishQueueStore implements PublishQueueStore {
	private readonly file: string;
	private readonly logger: Logger;

	constructor(file: string, options: { logger?: Logger } = {}) {
		this.file = file;
		this.logger = options.logger ?? silentLogger;
	}

	load(): PublishQueueData {
		try {
			if (!fs.existsSync(this.file)) return { history: {}, pending: [] };
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<PublishQueueData>;
			return {
				history: parsed.history && typeof parsed.history === "object" ? parsed.history : {},
				pending: Array.isArray(parsed.pending) ? parsed.pending : []
			};
		} catch (error) {
			this.logger.warn(`Unable to read ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
			return { history: {}, pending: [] };
		}
	}

	save(data: PublishQueueData): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const temp = `${this.file}.tmp`;
			fs.writeFileSync(temp, JSON.stringify(data), "utf8");
			fs.renameSync(temp, this.file);
		} catch (error) {
			this.logger.warn(`Unable to save ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export class MemoryPublishQueueStore implements PublishQueueStore {
	private data: PublishQueueData = { history: {}, pending: [] };

	load(): PublishQueueData {
		return { history: { ...this.data.history }, pending: [...this.data.pending] };
	}

	save(data: PublishQueueData): void {
		this.data = { history: { ...data.history }, pending: [...data.pending] };
	}
}

export interface PublishQueueOptions {
	publish: PublishFn;
	/** Discord allows 10 crossposts per hour per announcement channel. */
	maxPerWindow?: number;
	windowMs?: number;
	/** Messages older than this are dropped instead of being published late. */
	maxAgeMs?: number;
	maxPending?: number;
	maxAttempts?: number;
	now?: () => number;
	logger?: Logger;
	store?: PublishQueueStore;
}

/**
 * Serialises announcement channel crossposts and keeps them under Discord's 10-per-hour limit.
 * When the window is exhausted the message stays queued and a timer publishes it once a slot frees up.
 */
export class PublishQueue {
	private readonly publish: PublishFn;
	private readonly maxPerWindow: number;
	private readonly windowMs: number;
	private readonly maxAgeMs: number;
	private readonly maxPending: number;
	private readonly maxAttempts: number;
	private readonly now: () => number;
	private readonly logger: Logger;
	private readonly store: PublishQueueStore;

	private history: Record<string, number[]> = {};
	private pending: PendingPublish[] = [];
	private notBefore = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private flushPromise: Promise<void> | null = null;

	constructor(options: PublishQueueOptions) {
		this.publish = options.publish;
		this.maxPerWindow = Math.max(1, options.maxPerWindow ?? 10);
		this.windowMs = Math.max(1_000, options.windowMs ?? 3_600_000);
		this.maxAgeMs = Math.max(this.windowMs, options.maxAgeMs ?? this.windowMs * 2);
		this.maxPending = Math.max(1, options.maxPending ?? 500);
		this.maxAttempts = Math.max(1, options.maxAttempts ?? 10);
		this.now = options.now ?? Date.now;
		this.logger = options.logger ?? silentLogger;
		this.store = options.store ?? new MemoryPublishQueueStore();

		const restored = this.store.load();
		this.history = restored.history;
		this.pending = restored.pending;
		this.pruneHistory();
		if (this.pending.length > 0) {
			this.logger.info(`Restored ${this.pending.length} unpublished message(s) from the publish queue`);
		}
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	get queued(): PendingPublish[] {
		return [...this.pending];
	}

	/** Number of publishes that still fit in the current window for a channel. */
	remaining(channelId: string): number {
		return Math.max(0, this.maxPerWindow - this.historyFor(channelId).length);
	}

	/** Queues a message for crossposting. Returns once an attempt was made (or the queue is waiting for a slot). */
	enqueue(channelId: string, messageId: string, reason?: string): Promise<void> {
		if (!channelId || !messageId) return Promise.resolve();
		this.pending.push({ channelId, messageId, queuedAt: this.now(), attempts: 0, reason });
		if (this.pending.length > this.maxPending) {
			const dropped = this.pending.splice(0, this.pending.length - this.maxPending);
			this.logger.warn(`Publish queue overflow, dropped ${dropped.length} message(s)`);
		}
		this.persist();
		return this.flush();
	}

	flush(): Promise<void> {
		if (this.flushPromise) return this.flushPromise;
		this.flushPromise = this.run().finally(() => {
			this.flushPromise = null;
		});
		return this.flushPromise;
	}

	private async run(): Promise<void> {
		this.pruneHistory();
		this.dropStale();

		while (this.pending.length > 0) {
			const now = this.now();
			if (now < this.notBefore) {
				this.schedule();
				return;
			}

			const item = this.pending[0];
			if (this.historyFor(item.channelId).length >= this.maxPerWindow) {
				this.logger.debug(`Publish limit reached for ${item.channelId}, ${this.pending.length} message(s) queued`);
				this.schedule();
				return;
			}

			this.pending.shift();
			let result: PublishResult;
			try {
				result = await this.publish(item.channelId, item.messageId);
			} catch (error) {
				result = { ok: false, retryAfterMs: 60_000 };
				this.logger.warn(`Publish threw: ${error instanceof Error ? error.message : String(error)}`);
			}

			if (result.ok) {
				this.historyFor(item.channelId).push(this.now());
				this.logger.info(`Published message ${item.messageId} in ${item.channelId}`);
				continue;
			}

			if (result.permanent) {
				this.logger.debug(`Dropping message ${item.messageId}: no longer crosspostable`);
				continue;
			}

			item.attempts += 1;
			if (item.attempts >= this.maxAttempts) {
				this.logger.warn(`Dropping message ${item.messageId} after ${item.attempts} failed publish attempts`);
				continue;
			}

			const retryAfter = result.retryAfterMs ?? Math.min(this.windowMs, 60_000 * item.attempts);
			this.notBefore = this.now() + retryAfter;
			this.pending.unshift(item);
			this.logger.warn(`Publish rate limited, retrying in ${Math.round(retryAfter / 1000)}s`);
			this.persist();
			this.schedule();
			return;
		}

		this.persist();
	}

	private dropStale(): void {
		if (this.maxAgeMs <= 0) return;
		const cutoff = this.now() - this.maxAgeMs;
		const stale = this.pending.filter((item) => item.queuedAt < cutoff);
		if (stale.length === 0) return;
		this.pending = this.pending.filter((item) => item.queuedAt >= cutoff);
		this.logger.warn(`Dropped ${stale.length} queued publish(es) older than ${Math.round(this.maxAgeMs / 60_000)} minutes`);
	}

	private schedule(): void {
		if (this.timer || this.pending.length === 0) return;

		const now = this.now();
		let earliest = Math.max(now, this.notBefore);
		for (const channelId of new Set(this.pending.map((item) => item.channelId))) {
			const history = this.historyFor(channelId);
			if (history.length < this.maxPerWindow) continue;
			const expiring = history.length - this.maxPerWindow;
			earliest = Math.max(earliest, history[expiring] + this.windowMs);
		}

		// Small jitter so we never race Discord's window boundary.
		const delay = Math.max(1_000, earliest - now + 1_000);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, delay);
		this.timer.unref?.();
		this.logger.debug(`Next publish attempt in ${Math.round(delay / 1000)}s`);
	}

	private pruneHistory(): void {
		const cutoff = this.now() - this.windowMs;
		let changed = false;
		for (const [channelId, timestamps] of Object.entries(this.history)) {
			const kept = timestamps.filter((timestamp) => timestamp > cutoff);
			if (kept.length !== timestamps.length) changed = true;
			if (kept.length === 0) {
				delete this.history[channelId];
				changed = true;
			} else {
				this.history[channelId] = kept;
			}
		}
		if (changed) this.persist();
	}

	private historyFor(channelId: string): number[] {
		this.history[channelId] ??= [];
		return this.history[channelId];
	}

	private persist(): void {
		this.store.save({ history: this.history, pending: this.pending });
	}

	start(): void {
		const usage = Object.entries(this.history)
			.map(([channelId, timestamps]) => `${channelId}: ${timestamps.length}/${this.maxPerWindow}`)
			.join(", ");
		this.logger.info(`Publish queue ready (${this.pending.length} queued${usage ? `, window usage ${usage}` : ""})`);
		if (this.pending.length > 0) {
			void this.flush();
			this.schedule();
		}
	}

	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
