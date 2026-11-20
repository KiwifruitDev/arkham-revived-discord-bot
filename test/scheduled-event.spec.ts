import { GuildScheduledEventStatus } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manageScheduledEvent } from "../src/scheduled-event.ts";
import { silentTestLogger } from "./fakes.ts";

const startAt = Date.parse("2026-11-20T00:00:00Z");
const endAt = Date.parse("2026-11-21T00:00:00Z");

afterEach(() => {
	vi.useRealTimers();
});

describe("scheduled event lifecycle", () => {
	it("starts and completes the event at the inclusive start and end times", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(startAt - 1);
		const setStatus = vi.fn(async (_status: GuildScheduledEventStatus.Active | GuildScheduledEventStatus.Completed) => {});
		const stop = await manageScheduledEvent({
			startAt,
			endAt,
			status: GuildScheduledEventStatus.Scheduled,
			setStatus,
			logger: silentTestLogger
		});

		await vi.advanceTimersByTimeAsync(1);
		expect(setStatus).toHaveBeenNthCalledWith(1, GuildScheduledEventStatus.Active);
		await vi.advanceTimersByTimeAsync(endAt - startAt);
		expect(setStatus).toHaveBeenNthCalledWith(2, GuildScheduledEventStatus.Completed);
		stop();
	});

	it("starts and then completes an event that has already ended", async () => {
		const setStatus = vi.fn(async (_status: GuildScheduledEventStatus.Active | GuildScheduledEventStatus.Completed) => {});
		await manageScheduledEvent({
			startAt,
			endAt,
			status: GuildScheduledEventStatus.Scheduled,
			setStatus,
			now: () => endAt,
			logger: silentTestLogger
		});

		expect(setStatus.mock.calls).toEqual([
			[GuildScheduledEventStatus.Active],
			[GuildScheduledEventStatus.Completed]
		]);
	});

	it("does not change canceled events", async () => {
		const setStatus = vi.fn(async (_status: GuildScheduledEventStatus.Active | GuildScheduledEventStatus.Completed) => {});
		await manageScheduledEvent({
			startAt,
			endAt,
			status: GuildScheduledEventStatus.Canceled,
			setStatus,
			now: () => startAt,
			logger: silentTestLogger
		});

		expect(setStatus).not.toHaveBeenCalled();
	});
});
