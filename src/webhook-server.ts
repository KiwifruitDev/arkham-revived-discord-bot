import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { WebhookPayload } from "./types.ts";

export interface WebhookServerOptions {
	port: number;
	host?: string;
	webhookPath: string;
	secret: string;
	onPayload: (payload: WebhookPayload) => Promise<void> | void;
	avatarDirectory?: string;
	logger?: Logger;
	maxBodyBytes?: number;
}

export interface WebhookServer {
	readonly port: number;
	readonly url: string;
	listen(): Promise<void>;
	close(): Promise<void>;
}

function secretsMatch(expected: string, received: string | null): boolean {
	if (!received) return false;
	const left = Buffer.from(expected);
	const right = Buffer.from(received);
	if (left.length !== right.length) return false;
	return crypto.timingSafeEqual(left, right);
}

function readSecret(request: http.IncomingMessage): string | null {
	const header = request.headers["x-webhook-secret"];
	if (typeof header === "string") return header;
	const authorization = request.headers.authorization;
	if (typeof authorization === "string") {
		const match = authorization.match(/^Bearer\s+(.+)$/i);
		if (match) return match[1];
	}
	return null;
}

function sniffImageType(buffer: Buffer): string {
	if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
	if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
	if (buffer.length > 6 && buffer.subarray(0, 4).toString("ascii") === "RIFF") return "image/webp";
	return "application/octet-stream";
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("payload_too_large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function respond(response: http.ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
	const payload = typeof body === "string" ? body : JSON.stringify(body);
	response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(payload) });
	response.end(payload);
}

/**
 * HTTP endpoint the Cloudflare Worker calls after a login or a profile write.
 * Requests must carry the shared secret in `x-webhook-secret` (or as a bearer token).
 */
export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
	const logger = options.logger ?? silentLogger;
	const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
	const startedAt = Date.now();

	const server = http.createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			const route = url.pathname;

			if (route === "/health" && request.method === "GET") {
				respond(response, 200, { status: "ok", uptime: Math.round((Date.now() - startedAt) / 1000) });
				return;
			}

			if (route.startsWith("/avatars/") && request.method === "GET") {
				const fileName = decodeURIComponent(route.slice("/avatars/".length));
				if (!/^[A-Za-z0-9._-]+$/.test(fileName) || !options.avatarDirectory) {
					respond(response, 404, { error: "not_found" });
					return;
				}
				const file = path.join(options.avatarDirectory, fileName);
				try {
					const bytes = fs.readFileSync(file);
					response.writeHead(200, { "content-type": sniffImageType(bytes), "content-length": bytes.length });
					response.end(bytes);
				} catch {
					respond(response, 404, { error: "not_found" });
				}
				return;
			}

			if (route !== options.webhookPath) {
				respond(response, 404, { error: "not_found" });
				return;
			}

			if (request.method !== "POST") {
				response.setHeader("allow", "POST");
				respond(response, 405, { error: "method_not_allowed" });
				return;
			}

			if (!secretsMatch(options.secret, readSecret(request))) {
				logger.warn(`Rejected webhook call from ${request.socket.remoteAddress ?? "unknown"} (bad secret)`);
				respond(response, 401, { error: "unauthorized" });
				return;
			}

			let payload: WebhookPayload;
			try {
				const body = await readBody(request, maxBodyBytes);
				payload = JSON.parse(body) as WebhookPayload;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				respond(response, message === "payload_too_large" ? 413 : 400, { error: "invalid_payload" });
				return;
			}

			if (!payload || typeof payload !== "object" || typeof (payload as { type?: unknown }).type !== "string") {
				respond(response, 400, { error: "invalid_payload" });
				return;
			}

			try {
				await options.onPayload(payload);
				respond(response, 202, { ok: true });
			} catch (error) {
				logger.error(`Webhook handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				respond(response, 500, { error: "handler_failed" });
			}
		})();
	});

	let boundPort = options.port;

	return {
		get port() {
			return boundPort;
		},
		get url() {
			const host = options.host === "0.0.0.0" || !options.host ? "localhost" : options.host;
			return `http://${host}:${boundPort}${options.webhookPath}`;
		},
		async listen(): Promise<void> {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(options.port, options.host ?? "0.0.0.0", () => {
					server.off("error", reject);
					const address = server.address();
					if (address && typeof address === "object") boundPort = address.port;
					resolve();
				});
			});
			logger.info(`Webhook server listening on ${this.url}`);
		},
		async close(): Promise<void> {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}
