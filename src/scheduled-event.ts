import { GuildScheduledEventStatus } from "discord.js";
import type { Logger } from "./logger.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ScheduledEventManagerOptions {
	startAt: number;
	endAt: number;
	status: GuildScheduledEventStatus;
	setStatus: (status: GuildScheduledEventStatus.Active | GuildScheduledEventStatus.Completed) => Promise<void>;
	logger: Logger;
	now?: () => number;
}

/** Applies due scheduled-event status changes and keeps timers for future transitions. */
export async function manageScheduledEvent(options: ScheduledEventManagerOptions): Promise<() => void> {
	const { startAt, endAt, logger } = options;
	if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt) {
		logger.warn("Scheduled event has invalid start or end times");
		return () => {};
	}

	const now = options.now ?? Date.now;
	let status = options.status;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const stop = (): void => {
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const setStatus = async (nextStatus: GuildScheduledEventStatus.Active | GuildScheduledEventStatus.Completed) => {
		if (status === nextStatus) return;
		await options.setStatus(nextStatus);
		status = nextStatus;
		logger.info(`Scheduled event status changed to ${nextStatus === GuildScheduledEventStatus.Active ? "active" : "completed"}`);
	};

	const reconcile = async (): Promise<void> => {
		if (stopped || status === GuildScheduledEventStatus.Canceled || status === GuildScheduledEventStatus.Completed) return;
		const currentTime = now();
		if (status === GuildScheduledEventStatus.Scheduled && currentTime >= startAt) {
			await setStatus(GuildScheduledEventStatus.Active);
		}
		if (status === GuildScheduledEventStatus.Active && currentTime >= endAt) {
			await setStatus(GuildScheduledEventStatus.Completed);
		}

		if (status !== GuildScheduledEventStatus.Scheduled && status !== GuildScheduledEventStatus.Active) return;
		const nextAt = status === GuildScheduledEventStatus.Scheduled ? startAt : endAt;
		const delay = Math.min(Math.max(0, nextAt - now()), MAX_TIMEOUT_MS);
		timer = setTimeout(() => {
			timer = undefined;
			void reconcile().catch((error: unknown) => {
				logger.error(`Unable to update scheduled event status: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, delay);
	};

	await reconcile();
	return stop;
}
