import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import { addDeltas, emptyDeltas, mergeStatChanges, sumDeltas } from "./profile-diff.ts";
import type { MatchPlayer, MatchResult, StatChange, StatDeltas } from "./types.ts";

export interface MatchEvent {
	username: string;
	uuid: string;
	platform: string;
	timestamp: number;
	deltas: StatDeltas;
	/** Field level stats (delta + resulting total) for the match embed. */
	stats?: StatChange[];
}

export interface MatchTrackerOptions {
	windowMs: number;
	quietMs: number;
	minPlayers: number;
	onMatch: (match: MatchResult) => void | Promise<void>;
	now?: () => number;
	logger?: Logger;
	tickMs?: number;
	maxBufferedEvents?: number;
}

/**
 * Detects "a match just ended" by watching for profile writes that raised XP or levels.
 * When `minPlayers` distinct players report an increase inside `windowMs`, and no new write
 * arrives for `quietMs`, the buffered deltas are flushed as one match result.
 */
export class MatchTracker {
	private events: MatchEvent[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	private readonly windowMs: number;
	private readonly quietMs: number;
	private readonly minPlayers: number;
	private readonly onMatch: (match: MatchResult) => void | Promise<void>;
	private readonly now: () => number;
	private readonly logger: Logger;
	private readonly tickMs: number;
	private readonly maxBufferedEvents: number;

	constructor(options: MatchTrackerOptions) {
		this.windowMs = options.windowMs;
		this.quietMs = options.quietMs;
		this.minPlayers = options.minPlayers;
		this.onMatch = options.onMatch;
		this.now = options.now ?? Date.now;
		this.logger = options.logger ?? silentLogger;
		this.tickMs = options.tickMs ?? 1_000;
		this.maxBufferedEvents = options.maxBufferedEvents ?? 200;
	}

	get pendingEvents(): number {
		return this.events.length;
	}

	record(event: MatchEvent): void {
		this.events.push(event);
		if (this.events.length > this.maxBufferedEvents) {
			this.events.splice(0, this.events.length - this.maxBufferedEvents);
		}
		this.logger.debug(`Buffered stat increase for ${event.username} (${this.events.length} pending)`);
	}

	/** Prunes stale events and flushes a match when the quiet period elapsed. Safe to call repeatedly. */
	async tick(now = this.now()): Promise<MatchResult | null> {
		if (this.events.length === 0) return null;

		const latest = this.events.reduce((max, event) => Math.max(max, event.timestamp), 0);
		const cutoff = latest - this.windowMs;
		this.events = this.events.filter((event) => event.timestamp >= cutoff);

		const players = this.collectPlayers(this.events);
		if (players.length < this.minPlayers) {
			if (now - latest >= this.windowMs) this.events = [];
			return null;
		}

		if (now - latest < this.quietMs) return null;

		const buffered = this.events;
		this.events = [];
		const match: MatchResult = {
			players,
			startedAt: Math.min(...buffered.map((event) => event.timestamp)),
			endedAt: latest,
			total: sumDeltas(players)
		};
		this.logger.info(
			`Match detected with ${players.length} players (${buffered.length} profile updates, ${match.endedAt - match.startedAt}ms span)`
		);

		try {
			await this.onMatch(match);
		} catch (error) {
			this.logger.error(`Match handler failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return match;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.tickMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private collectPlayers(events: MatchEvent[]): MatchPlayer[] {
		const players = new Map<string, MatchPlayer>();
		for (const event of events) {
			const existing = players.get(event.username);
			if (existing) {
				addDeltas(existing.deltas, event.deltas);
				mergeStatChanges(existing.stats, event.stats ?? []);
				existing.events += 1;
				existing.lastSeen = Math.max(existing.lastSeen, event.timestamp);
				existing.firstSeen = Math.min(existing.firstSeen, event.timestamp);
				continue;
			}
			players.set(event.username, {
				username: event.username,
				uuid: event.uuid,
				platform: event.platform,
				deltas: addDeltas(emptyDeltas(), event.deltas),
				stats: mergeStatChanges([], event.stats ?? []),
				events: 1,
				firstSeen: event.timestamp,
				lastSeen: event.timestamp
			});
		}
		return [...players.values()].sort((left, right) => right.deltas.xp - left.deltas.xp);
	}
}
