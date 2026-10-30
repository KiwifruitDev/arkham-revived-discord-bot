import type { AttachmentFile, ChannelMessageOptions, WebhookMessageOptions } from "../src/discord-service.ts";
import type { Logger } from "../src/logger.ts";
import type { AvatarEntry } from "../src/psn.ts";
import type { PublishResult } from "../src/publish-queue.ts";

export interface RecordedWebhookMessage extends WebhookMessageOptions {
	webhookUrl: string;
}

export interface RecordedChannelMessage extends ChannelMessageOptions {
	id: string;
}

export class FakeDiscord {
	readonly webhookMessages: RecordedWebhookMessage[] = [];
	readonly channelMessages: RecordedChannelMessage[] = [];
	readonly published: Array<{ channelId: string; messageId: string }> = [];
	readonly renames: Array<{ channelId: string; name: string }> = [];
	readonly presences: Array<{ text: string; type: string }> = [];
	/** Results returned by publishMessage, consumed in order; defaults to success. */
	readonly publishResults: PublishResult[] = [];
	channelNames = new Map<string, string>();
	failRenames = false;
	private nextId = 1;

	async setPresence(text: string, type = "watching"): Promise<boolean> {
		this.presences.push({ text, type });
		return true;
	}

	async sendWebhookMessage(webhookUrl: string, options: WebhookMessageOptions): Promise<string | null> {
		this.webhookMessages.push({ ...options, webhookUrl });
		return `webhook-message-${this.nextId++}`;
	}

	async publishMessage(channelId: string, messageId: string): Promise<PublishResult> {
		const next = this.publishResults.shift();
		if (next?.ok === false) return next;
		this.published.push({ channelId, messageId });
		return next ?? { ok: true };
	}

	async sendChannelMessage(options: ChannelMessageOptions): Promise<string | null> {
		const id = `channel-message-${this.nextId++}`;
		this.channelMessages.push({ ...options, id });
		return id;
	}

	async getChannelName(channelId: string): Promise<string | null> {
		return this.channelNames.get(channelId) ?? null;
	}

	async renameChannel(channelId: string, name: string): Promise<boolean> {
		if (this.failRenames) return false;
		this.renames.push({ channelId, name });
		this.channelNames.set(channelId, name);
		return true;
	}
}

export class FakeKv {
	enabled = true;
	ps3Users = 103;
	failures = 0;

	async countPs3Profiles(): Promise<number | null> {
		if (this.failures > 0) return null;
		return this.enabled ? this.ps3Users : null;
	}
}

export class FakePsn {
	readonly lookups: string[] = [];
	entries = new Map<string, AvatarEntry>();
	avatars = new Map<string, Buffer>();
	failures = new Set<string>();

	async getEntry(username: string): Promise<AvatarEntry> {
		this.lookups.push(username);
		const existing = this.entries.get(username);
		if (existing) return existing;
		const failed = this.failures.has(username);
		const entry: AvatarEntry = {
			url: failed ? null : `https://static-resource.np.community.playstation.net/avatar/3RD/${username}.png`,
			file: failed ? null : `${username}.img`,
			fetchedAt: Date.now()
		};
		this.entries.set(username, entry);
		return entry;
	}

	async getAvatarBuffer(username: string): Promise<Buffer | null> {
		return this.avatars.get(username) ?? null;
	}
}

export class FakeStats {
	refreshes = 0;

	async refresh(): Promise<void> {
		this.refreshes += 1;
	}
}

export function fileNames(files: AttachmentFile[] | undefined): string[] {
	return (files ?? []).map((file) => file.name);
}

export const silentTestLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentTestLogger
};
