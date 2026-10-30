import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWebhookServer } from "../src/webhook-server.ts";
import type { WebhookServer } from "../src/webhook-server.ts";
import type { WebhookPayload } from "../src/types.ts";
import { loginPayload } from "./fixtures/payloads.ts";

const secret = "unit-test-secret";

describe("webhook server", () => {
	let server: WebhookServer;
	let avatarDir: string;
	const onPayload = vi.fn(async (_payload: WebhookPayload) => {});
	let failNext = false;

	beforeAll(async () => {
		avatarDir = fs.mkdtempSync(path.join(os.tmpdir(), "arkham-avatars-"));
		fs.writeFileSync(path.join(avatarDir, "Another_Hermit.img"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
		server = createWebhookServer({
			port: 0,
			webhookPath: "/webhook",
			secret,
			avatarDirectory: avatarDir,
			onPayload: async (payload) => {
				if (failNext) throw new Error("boom");
				await onPayload(payload);
			}
		});
		await server.listen();
	});

	afterAll(async () => {
		await server.close();
		fs.rmSync(avatarDir, { recursive: true, force: true });
	});

	const post = (body: string, headers: Record<string, string> = {}) =>
		fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

	it("accepts a signed payload and forwards it", async () => {
		onPayload.mockClear();
		const response = await post(JSON.stringify(loginPayload), { "x-webhook-secret": secret });
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ ok: true });
		expect(onPayload).toHaveBeenCalledWith(loginPayload);
	});

	it("accepts the secret as a bearer token", async () => {
		onPayload.mockClear();
		const response = await post(JSON.stringify(loginPayload), { authorization: `Bearer ${secret}` });
		expect(response.status).toBe(202);
		expect(onPayload).toHaveBeenCalledTimes(1);
	});

	it("rejects a missing or wrong secret", async () => {
		onPayload.mockClear();
		expect((await post(JSON.stringify(loginPayload))).status).toBe(401);
		expect((await post(JSON.stringify(loginPayload), { "x-webhook-secret": "nope" })).status).toBe(401);
		expect(onPayload).not.toHaveBeenCalled();
	});

	it("rejects malformed json", async () => {
		const response = await post("{not json", { "x-webhook-secret": secret });
		expect(response.status).toBe(400);
	});

	it("rejects payloads without a type", async () => {
		const response = await post(JSON.stringify({ hello: "world" }), { "x-webhook-secret": secret });
		expect(response.status).toBe(400);
	});

	it("reports handler failures", async () => {
		failNext = true;
		const response = await post(JSON.stringify(loginPayload), { "x-webhook-secret": secret });
		failNext = false;
		expect(response.status).toBe(500);
	});

	it("serves health checks", async () => {
		const response = await fetch(`http://127.0.0.1:${server.port}/health`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string };
		expect(body.status).toBe("ok");
	});

	it("serves cached avatars for Discord", async () => {
		const response = await fetch(`http://127.0.0.1:${server.port}/avatars/Another_Hermit.img`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect((await fetch(`http://127.0.0.1:${server.port}/avatars/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
	});

	it("rejects unknown routes and methods", async () => {
		expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404);
		expect((await fetch(server.url)).status).toBe(405);
	});
});
