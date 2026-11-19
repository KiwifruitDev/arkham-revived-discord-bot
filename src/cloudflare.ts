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

export interface KvDailyWriteUsage {
	date: string;
	writes: number;
	dailyLimit: number | null;
	plan: "free" | "paid" | "unknown";
}

interface KvUsageGraphqlResponse {
	data?: {
		viewer?: {
			accounts?: Array<{
				kvOperationsAdaptiveGroups?: Array<{
					sum?: { requests?: number };
				}>;
			}>;
		};
	};
	errors?: Array<{ message?: string }>;
}

interface AccountSubscription {
	state?: string;
	rate_plan?: {
		id?: string;
		public_name?: string;
		scope?: string;
		sets?: string[];
	};
}

interface SubscriptionResponse {
	result?: AccountSubscription[];
	success?: boolean;
}

type WorkersPlan = "free" | "paid" | "unknown";

const KV_DAILY_USAGE_QUERY = `query KvDailyWriteUsage($accountTag: string!, $start: Date!, $end: Date!) {
	viewer {
		accounts(filter: { accountTag: $accountTag }) {
			kvOperationsAdaptiveGroups(
				filter: { date_geq: $start, date_leq: $end, actionType: "write" }
				limit: 10000
			) {
				sum { requests }
			}
		}
	}
}`;

/** Thin REST client for the PROFILES KV namespace, used to count known PS3 players. */
export class CloudflareKvClient {
	private readonly apiToken: string;
	private readonly namespaceId: string;
	private readonly logger: Logger;
	private readonly fetchImpl: typeof fetch;
	private readonly apiBase: string;
	private accountId: string | null;
	private cachedPlan: { plan: WorkersPlan; expiresAt: number } | null = null;
	private planLookup: Promise<WorkersPlan> | null = null;

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

	/** Retrieves account-wide KV write usage for the current UTC day and the account's plan allowance. */
	async getDailyWriteUsage(now = new Date()): Promise<KvDailyWriteUsage | null> {
		if (!this.enabled) return null;
		const accountId = await this.resolveAccountId();
		if (!accountId) return null;
		const date = now.toISOString().slice(0, 10);

		const [usageResponse, plan] = await Promise.all([
			this.fetchImpl(`${this.apiBase}/graphql`, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({
					query: KV_DAILY_USAGE_QUERY,
					variables: { accountTag: accountId, start: date, end: date }
				})
			}),
			this.getWorkersPlan(accountId)
		]);

		if (!usageResponse.ok) {
			this.logger.warn(`Cloudflare KV analytics failed with ${usageResponse.status}`);
			return null;
		}

		const usageBody = (await usageResponse.json()) as KvUsageGraphqlResponse;
		if (usageBody.errors?.length) {
			this.logger.warn(`Cloudflare KV analytics query failed: ${usageBody.errors.map((error) => error.message ?? "unknown error").join("; ")}`);
			return null;
		}
		const accounts = usageBody.data?.viewer?.accounts;
		if (!accounts?.length) {
			this.logger.warn("Cloudflare KV analytics returned no account data");
			return null;
		}
		let writes = 0;
		for (const group of accounts[0].kvOperationsAdaptiveGroups ?? []) {
			const requests = group.sum?.requests;
			if (typeof requests !== "number" || !Number.isFinite(requests) || requests < 0) {
				this.logger.warn("Cloudflare KV analytics returned an invalid write count");
				return null;
			}
			writes += requests;
		}

		return { date, writes, dailyLimit: plan === "free" ? 1_000 : null, plan };
	}

	private async getWorkersPlan(accountId: string): Promise<WorkersPlan> {
		if (this.cachedPlan && this.cachedPlan.expiresAt > Date.now()) return this.cachedPlan.plan;
		if (this.planLookup) return this.planLookup;

		this.planLookup = (async () => {
			let response: Response;
			try {
				response = await this.fetchImpl(`${this.apiBase}/accounts/${accountId}/subscriptions`, {
					headers: this.headers()
				});
			} catch (error) {
				this.logger.warn(
					`Cloudflare account subscription lookup failed: ${error instanceof Error ? error.message : String(error)}; KV limit is unknown`
				);
				return "unknown";
			}
			if (!response.ok) {
				this.logger.warn(`Cloudflare account subscription lookup failed with ${response.status}; KV limit is unknown`);
				return "unknown";
			}
			let body: SubscriptionResponse;
			try {
				body = (await response.json()) as SubscriptionResponse;
			} catch (error) {
				this.logger.warn(
					`Cloudflare account subscription response could not be parsed: ${error instanceof Error ? error.message : String(error)}; KV limit is unknown`
				);
				return "unknown";
			}
			if (body.success === false || !Array.isArray(body.result)) {
				this.logger.warn("Cloudflare account subscription lookup returned an invalid response; KV limit is unknown");
				return "unknown";
			}

			const workerSubscriptions = body.result.filter((subscription) => {
				const plan = subscription.rate_plan;
				const labels = [plan?.scope, plan?.public_name, ...(plan?.sets ?? [])].filter(Boolean).join(" ");
				return (
					/worker/i.test(labels) &&
					["Paid", "Provisioned", "Trial"].includes(subscription.state ?? "")
				);
			});
			const isFree = (subscription: AccountSubscription): boolean => {
				const plan = subscription.rate_plan;
				return plan?.id?.toLowerCase() === "free" || /workers?\s+free/i.test(plan?.public_name ?? "");
			};
			const hasPaidPlan = workerSubscriptions.some((subscription) => !isFree(subscription));

			if (workerSubscriptions.length === 0) {
				// Workers Free is the default; a paid Workers plan appears as an account subscription.
				return "free";
			}
			return hasPaidPlan ? "paid" : "free";
		})();

		try {
			const plan = await this.planLookup;
			this.cachedPlan = { plan, expiresAt: Date.now() + 10 * 60_000 };
			return plan;
		} finally {
			this.planLookup = null;
		}
	}
}
