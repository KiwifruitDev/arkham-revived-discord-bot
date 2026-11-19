import { describe, expect, it } from "vitest";
import { CloudflareKvClient } from "../src/cloudflare.ts";

function createClient(options: {
	subscription: unknown;
	usage?: unknown;
}): { client: CloudflareKvClient; requests: Array<{ url: string; init?: RequestInit }> } {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		if (url.endsWith("/graphql")) {
			return Response.json(
				options.usage ?? {
					data: {
						viewer: {
							accounts: [
								{
									kvOperationsAdaptiveGroups: [{ sum: { requests: 820 } }]
								}
							]
						}
					}
				}
			);
		}
		return Response.json({ success: true, result: options.subscription });
	};

	return {
		requests,
		client: new CloudflareKvClient({
			apiToken: "test-token",
			accountId: "account-1",
			namespaceId: "profiles",
			fetchImpl
		})
	};
}

describe("Cloudflare KV daily write usage", () => {
	it("reads account-wide writes and uses the free account's daily allowance", async () => {
		const { client, requests } = createClient({
			subscription: [
				{
					state: "Paid",
					rate_plan: { id: "free", public_name: "Workers Free", scope: "workers", sets: ["workers"] }
				}
			]
		});

		await expect(client.getDailyWriteUsage(new Date("2026-11-20T01:00:00-08:00"))).resolves.toEqual({
			date: "2026-11-20",
			writes: 820,
			dailyLimit: 1_000,
			plan: "free"
		});
		const analyticsRequest = requests.find((request) => request.url.endsWith("/graphql"));
		expect(analyticsRequest?.init?.method).toBe("POST");
		expect(JSON.parse(String(analyticsRequest?.init?.body))).toMatchObject({
			variables: { accountTag: "account-1", start: "2026-11-20", end: "2026-11-20" }
		});
	});

	it("does not apply a free-tier cap to paid accounts", async () => {
		const { client } = createClient({
			subscription: [
				{
					state: "Paid",
					rate_plan: { id: "workers_paid", public_name: "Workers Paid", scope: "workers", sets: ["workers"] }
				}
			]
		});

		await expect(client.getDailyWriteUsage()).resolves.toMatchObject({
			writes: 820,
			dailyLimit: null,
			plan: "paid"
		});
	});

	it("uses the default Free plan when no Workers subscription exists", async () => {
		const { client } = createClient({ subscription: [] });

		await expect(client.getDailyWriteUsage()).resolves.toMatchObject({
			writes: 820,
			dailyLimit: 1_000,
			plan: "free"
		});
	});

	it("does not guess a limit if the subscription response cannot be read", async () => {
		const { client } = createClient({ subscription: null });

		await expect(client.getDailyWriteUsage()).resolves.toMatchObject({
			writes: 820,
			dailyLimit: null,
			plan: "unknown"
		});
	});

	it("rejects analytics errors instead of reporting a false zero", async () => {
		const { client } = createClient({
			subscription: [{ state: "Paid", rate_plan: { id: "free", scope: "workers" } }],
			usage: { errors: [{ message: "not authorized" }] }
		});

		await expect(client.getDailyWriteUsage()).resolves.toBeNull();
	});
});
