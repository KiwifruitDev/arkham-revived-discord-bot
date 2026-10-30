import fs from "node:fs";
import path from "node:path";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";

export interface BotState {
	/** Timestamps of detected matches; entries older than the window are dropped. */
	matches: number[];
	/** First time each player authenticated inside the window. */
	authentications: Record<string, number>;
	lastChannelUpdate: Record<string, number>;
}

interface LegacyState extends Partial<BotState> {
	day?: string;
	matchesPlayedToday?: number;
}

export interface StateStoreOptions {
	now?: () => number;
	logger?: Logger;
	/** Rolling window for the "today" counters. */
	windowMs?: number;
}

export const defaultWindowMs = 24 * 60 * 60 * 1000;

/**
 * JSON-backed store for the rolling 24 hour counters.
 * Unlike a calendar day, every match and every first authentication expires exactly
 * `windowMs` after it was added, so the statistics channels can be updated when it drops out.
 */
export class StateStore {
	private readonly file: string;
	private readonly now: () => number;
	private readonly logger: Logger;
	private readonly windowMs: number;
	private data: BotState;

	constructor(file: string, options: StateStoreOptions = {}) {
		this.file = file;
		this.now = options.now ?? Date.now;
		this.logger = options.logger ?? silentLogger;
		this.windowMs = Math.max(1_000, options.windowMs ?? defaultWindowMs);
		this.data = { matches: [], authentications: {}, lastChannelUpdate: {} };
	}

	get window(): number {
		return this.windowMs;
	}

	load(): void {
		try {
			if (fs.existsSync(this.file)) {
				const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as LegacyState;
				this.data = {
					matches: Array.isArray(parsed.matches) ? parsed.matches.filter((value) => Number.isFinite(value)) : [],
					authentications:
						parsed.authentications && typeof parsed.authentications === "object" ? { ...parsed.authentications } : {},
					lastChannelUpdate: { ...(parsed.lastChannelUpdate ?? {}) }
				};

				// Older versions stored a per-day counter; keep its value inside the rolling window.
				const legacyCount = Number(parsed.matchesPlayedToday) || 0;
				if (!Array.isArray(parsed.matches) && legacyCount > 0) {
					const seededAt = this.now();
					this.data.matches = Array.from({ length: legacyCount }, () => seededAt);
					this.logger.info(`Migrated ${legacyCount} match(es) from the old daily counter`);
				}
			}
		} catch (error) {
			this.logger.warn(`Unable to read ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.prune();
	}

	private pruneInMemory(): boolean {
		const cutoff = this.now() - this.windowMs;
		const previousMatches = this.data.matches.length;
		this.data.matches = this.data.matches.filter((timestamp) => timestamp > cutoff);
		let changed = this.data.matches.length !== previousMatches;

		for (const [username, timestamp] of Object.entries(this.data.authentications)) {
			if (timestamp <= cutoff) {
				delete this.data.authentications[username];
				changed = true;
			}
		}
		return changed;
	}

	/** Drops expired entries and persists the change. Returns true when something expired. */
	prune(): boolean {
		const changed = this.pruneInMemory();
		if (changed) this.persist();
		return changed;
	}

	private persist(): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const temp = `${this.file}.tmp`;
			fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), "utf8");
			fs.renameSync(temp, this.file);
		} catch (error) {
			this.logger.error(`Unable to save ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	get matchesInWindow(): number {
		this.prune();
		return this.data.matches.length;
	}

	get uniqueUsersInWindow(): number {
		this.prune();
		return Object.keys(this.data.authentications).length;
	}

	recordMatch(timestamp = this.now()): number {
		this.prune();
		this.data.matches.push(timestamp);
		this.persist();
		return this.data.matches.length;
	}

	/** Registers a first authentication inside the window; repeat logins do not increase the count. */
	recordAuthentication(username: string, timestamp = this.now()): { counted: boolean; uniqueUsers: number } {
		this.pruneInMemory();
		const counted = this.data.authentications[username] === undefined;
		if (counted) this.data.authentications[username] = timestamp;
		this.persist();
		return { counted, uniqueUsers: Object.keys(this.data.authentications).length };
	}

	/** When the next tracked entry expires (ms since epoch); null when nothing is tracked. */
	nextExpiry(): number | null {
		const candidates = [
			...this.data.matches.map((timestamp) => timestamp + this.windowMs),
			...Object.values(this.data.authentications).map((timestamp) => timestamp + this.windowMs)
		].filter((expiry) => expiry > this.now());
		return candidates.length > 0 ? Math.min(...candidates) : null;
	}

	lastUpdate(channelId: string): number {
		return this.data.lastChannelUpdate[channelId] ?? 0;
	}

	markUpdate(channelId: string, timestamp = this.now()): void {
		this.data.lastChannelUpdate[channelId] = timestamp;
		this.persist();
	}
}