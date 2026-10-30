import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";

export interface CloudflareKvOptions {
	apiToken: string;
	accountId?: string;
	namespaceId: string;
	logger?: Logger;
	fetchImpl?: typeof fetch;
	apiBase?: string;
}

interface KvKeyPage {
	result?: Array<{ name: string }>;
	result_info?: { cursor?: string; count?: number };
	success?: boolean;
}

/** Thin REST client for the PROFILES KV namespace, used to count known PS3 players. */
export class CloudflareKvClient {
	private readonly apiToken: string;
	private readonly namespaceId: string;
	private readonly logger: Logger;
	private readonly fetchImpl: typeof fetch;
	private readonly apiBase: string;
	private accountId: string | null;

	constructor(options: CloudflareKvOptions) {
		this.apiToken = options.apiToken;
		this.namespaceId = options.namespaceId;
		this.logger = options.logger ?? silentLogger;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.apiBase = options.apiBase ?? "https://api.cloudflare.com/client/v4";
		this.accountId = options.accountId && options.accountId.length > 0 ? options.accountId : null;
	}

	get enabled(): boolean {
		return this.apiToken.length > 0 && this.namespaceId.length > 0;
	}

	private headers(): Record<string, string> {
		return { authorization: `Bearer ${this.apiToken}`, "content-type": "application/json" };
	}

	async resolveAccountId(): Promise<string | null> {
		if (this.accountId) return this.accountId;
		const response = await this.fetchImpl(`${this.apiBase}/accounts`, { headers: this.headers() });
		if (!response.ok) {
			this.logger.warn(`Cloudflare account lookup failed with ${response.status}`);
			return null;
		}
		const body = (await response.json()) as { result?: Array<{ id?: string }> };
		this.accountId = body.result?.[0]?.id ?? null;
		if (!this.accountId) this.logger.warn("Cloudflare token does not expose any account");
		return this.accountId;
	}

	/** Counts KV keys shaped like `ps3_<username>_<uuid>` (one per player profile). */
	async countPs3Profiles(): Promise<number | null> {
		if (!this.enabled) return null;
		const accountId = await this.resolveAccountId();
		if (!accountId) return null;

		let cursor: string | undefined;
		let total = 0;
		for (let page = 0; page < 50; page += 1) {
			const url = new URL(`${this.apiBase}/accounts/${accountId}/storage/kv/namespaces/${this.namespaceId}/keys`);
			url.searchParams.set("limit", "1000");
			if (cursor) url.searchParams.set("cursor", cursor);

			const response = await this.fetchImpl(url.toString(), { headers: this.headers() });
			if (!response.ok) {
				this.logger.warn(`Cloudflare KV listing failed with ${response.status}`);
				return null;
			}
			const body = (await response.json()) as KvKeyPage;
			for (const key of body.result ?? []) {
				if (key.name.startsWith("ps3_")) total += 1;
			}
			cursor = body.result_info?.cursor;
			if (!cursor) return total;
		}
		return total;
	}
}
