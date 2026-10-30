import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonPublishQueueStore, MemoryPublishQueueStore, PublishQueue } from "../src/publish-queue.ts";
import type { PublishResult } from "../src/publish-queue.ts";

const CHANNEL = "1565605731288354857";

function harness(options: { maxPerWindow?: number; results?: PublishResult[]; start?: number } = {}) {
	let now = options.start ?? 1_000_000_000;
	const published: Array<{ channelId: string; messageId: string }> = [];
	const results = [...(options.results ?? [])];
	const store = new MemoryPublishQueueStore();

	const queue = new PublishQueue({
		publish: async (channelId, messageId) => {
			published.push({ channelId, messageId });
			return results.shift() ?? { ok: true };
		},
		maxPerWindow: options.maxPerWindow ?? 10,
		windowMs: 3_600_000,
		maxAgeMs: 7_200_000,
		store,
		now: () => now
	});

	return {
		queue,
		published,
		results,
		store,
		advance(ms: number) {
			now += ms;
		},
		get now() {
			return now;
		}
	};
}

describe("publish queue", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("publishes immediately while under the limit", async () => {
		const ctx = harness();
		await ctx.queue.enqueue(CHANNEL, "message-1");
		await ctx.queue.enqueue(CHANNEL, "message-2");

		expect(ctx.published).toEqual([
			{ channelId: CHANNEL, messageId: "message-1" },
			{ channelId: CHANNEL, messageId: "message-2" }
		]);
		expect(ctx.queue.pendingCount).toBe(0);
		expect(ctx.queue.remaining(CHANNEL)).toBe(8);
	});

	it("queues messages once the 10 per hour limit is reached", async () => {
		const ctx = harness();
		for (let index = 1; index <= 12; index += 1) {
			await ctx.queue.enqueue(CHANNEL, `message-${index}`);
		}

		expect(ctx.published).toHaveLength(10);
		expect(ctx.queue.pendingCount).toBe(2);
		expect(ctx.queue.remaining(CHANNEL)).toBe(0);
		expect(ctx.queue.queued.map((item) => item.messageId)).toEqual(["message-11", "message-12"]);
	});

	it("publishes the queue once the window slides", async () => {
		const ctx = harness();
		for (let index = 1; index <= 12; index += 1) {
			await ctx.queue.enqueue(CHANNEL, `message-${index}`);
		}

		ctx.advance(1_800_000);
		await ctx.queue.flush();
		expect(ctx.published).toHaveLength(10);

		ctx.advance(1_800_001);
		await ctx.queue.flush();
		expect(ctx.published).toHaveLength(12);
		expect(ctx.published.at(-1)?.messageId).toBe("message-12");
		expect(ctx.queue.pendingCount).toBe(0);
	});

	it("retries a rate limited publish after the retry delay", async () => {
		const ctx = harness({ results: [{ ok: false, retryAfterMs: 120_000 }] });
		await ctx.queue.enqueue(CHANNEL, "message-1");

		expect(ctx.published).toHaveLength(1);
		expect(ctx.queue.pendingCount).toBe(1);

		ctx.advance(60_000);
		await ctx.queue.flush();
		expect(ctx.published).toHaveLength(1);

		ctx.advance(61_000);
		await ctx.queue.flush();
		expect(ctx.published).toHaveLength(2);
		expect(ctx.queue.pendingCount).toBe(0);
	});

	it("drops messages that can never be crossposted", async () => {
		const ctx = harness({ results: [{ ok: false, permanent: true }] });
		await ctx.queue.enqueue(CHANNEL, "message-1");

		expect(ctx.published).toHaveLength(1);
		expect(ctx.queue.pendingCount).toBe(0);
	});

	it("drops queued messages that became too old", async () => {
		const ctx = harness({ maxPerWindow: 1 });
		await ctx.queue.enqueue(CHANNEL, "message-1");
		await ctx.queue.enqueue(CHANNEL, "message-2");
		expect(ctx.queue.pendingCount).toBe(1);

		ctx.advance(7_200_001);
		await ctx.queue.flush();
		expect(ctx.queue.pendingCount).toBe(0);
		expect(ctx.published).toHaveLength(1);
	});

	it("stores pending messages and history so a restart keeps the queue", async () => {
		const ctx = harness({ maxPerWindow: 1 });
		await ctx.queue.enqueue(CHANNEL, "message-1");
		await ctx.queue.enqueue(CHANNEL, "message-2");

		const restored = new PublishQueue({
			publish: async () => ({ ok: true }),
			maxPerWindow: 1,
			store: ctx.store,
			now: () => ctx.now
		});
		expect(restored.pendingCount).toBe(1);
		expect(restored.remaining(CHANNEL)).toBe(0);
	});

	it("keeps the queue per channel", async () => {
		const ctx = harness({ maxPerWindow: 1 });
		await ctx.queue.enqueue(CHANNEL, "message-1");
		await ctx.queue.enqueue("999999999999999999", "message-2");

		expect(ctx.published).toHaveLength(2);
		expect(ctx.queue.pendingCount).toBe(0);
	});

	it("persists the queue to json on disk", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arkham-publish-"));
		try {
			const file = path.join(dir, "publish-queue.json");
			const first = new PublishQueue({
				publish: async () => ({ ok: true }),
				maxPerWindow: 1,
				store: new JsonPublishQueueStore(file),
				now: () => 1_000_000
			});
			await first.enqueue(CHANNEL, "message-1");
			await first.enqueue(CHANNEL, "message-2");

			const second = new PublishQueue({
				publish: async () => ({ ok: true }),
				maxPerWindow: 1,
				store: new JsonPublishQueueStore(file),
				now: () => 1_000_000
			});
			expect(second.pendingCount).toBe(1);
			expect(second.queued[0].messageId).toBe("message-2");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
