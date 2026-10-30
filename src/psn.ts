import fs from "node:fs";
import path from "node:path";
import {
	exchangeAccessCodeForAuthTokens,
	exchangeNpssoForAccessCode,
	exchangeRefreshTokenForAuthTokens,
	getProfileFromUserName
} from "psn-api";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";

interface StoredTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

export interface AvatarEntry {
	url: string | null;
	file: string | null;
	fetchedAt: number;
}

export interface PsnProfileSource {
	/** Resolves a PSN online id into the largest available avatar URL. */
	fetchAvatarUrl(username: string): Promise<string | null>;
	/** Downloads avatar bytes. */
	download(url: string): Promise<Buffer | null>;
}

export interface PsnServiceOptions {
	npsso: string;
	cacheDir: string;
	ttlMs: number;
	logger?: Logger;
	source?: PsnProfileSource;
	now?: () => number;
}

export function safeFileName(username: string): string {
	const cleaned = username.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 64) : "player";
}

const sizeRank: Record<string, number> = { s: 1, m: 2, l: 3, xl: 4 };

function pickLargestAvatar(avatarUrls: Array<{ size: string; avatarUrl: string }> | undefined): string | null {
	if (!avatarUrls || avatarUrls.length === 0) return null;
	const best = [...avatarUrls].sort((left, right) => (sizeRank[left.size] ?? 0) - (sizeRank[right.size] ?? 0)).pop();
	if (!best) return null;
	return best.avatarUrl.replace(/^http:\/\//i, "https://");
}

/** Creates the default psn-api backed source, sharing a cached access token between lookups. */
export function createPsnApiSource(options: {
	npsso: string;
	tokenFile: string;
	logger: Logger;
	now?: () => number;
}): PsnProfileSource {
	const now = options.now ?? Date.now;
	let tokens: StoredTokens | null = null;

	const loadTokens = (): StoredTokens | null => {
		if (tokens) return tokens;
		try {
			if (fs.existsSync(options.tokenFile)) {
				tokens = JSON.parse(fs.readFileSync(options.tokenFile, "utf8")) as StoredTokens;
			}
		} catch {
			tokens = null;
		}
		return tokens;
	};

	const saveTokens = (next: StoredTokens): void => {
		tokens = next;
		try {
			fs.mkdirSync(path.dirname(options.tokenFile), { recursive: true });
			fs.writeFileSync(options.tokenFile, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
		} catch (error) {
			options.logger.warn(`Unable to cache PSN tokens: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const storeResponse = (response: { accessToken: string; refreshToken: string; expiresIn: number }): StoredTokens => {
		const stored: StoredTokens = {
			accessToken: response.accessToken,
			refreshToken: response.refreshToken,
			expiresAt: now() + Math.max(0, response.expiresIn - 60) * 1000
		};
		saveTokens(stored);
		return stored;
	};

	const getAccessToken = async (force = false): Promise<string> => {
		const cached = force ? null : loadTokens();
		if (cached && cached.expiresAt > now()) return cached.accessToken;

		if (cached?.refreshToken) {
			try {
				return storeResponse(await exchangeRefreshTokenForAuthTokens(cached.refreshToken)).accessToken;
			} catch (error) {
				options.logger.warn(`PSN refresh token rejected: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const accessCode = await exchangeNpssoForAccessCode(options.npsso);
		return storeResponse(await exchangeAccessCodeForAuthTokens(accessCode)).accessToken;
	};

	return {
		async fetchAvatarUrl(username: string): Promise<string | null> {
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const accessToken = await getAccessToken(attempt > 0);
				try {
					const response = await getProfileFromUserName({ accessToken }, username);
					return pickLargestAvatar(response?.profile?.avatarUrls);
				} catch (error) {
					if (attempt === 0) continue;
					throw error;
				}
			}
			return null;
		},
		async download(url: string): Promise<Buffer | null> {
			const response = await fetch(url);
			if (!response.ok) return null;
			return Buffer.from(await response.arrayBuffer());
		}
	};
}

/**
 * Resolves PSN usernames to avatars and keeps the image bytes on disk.
 * Lookups are cached for `ttlMs`; failures are cached briefly so a bad username cannot hammer the PSN API.
 */
export class PsnService {
	private readonly cacheDir: string;
	private readonly ttlMs: number;
	private readonly logger: Logger;
	private readonly source: PsnProfileSource;
	private readonly now: () => number;
	private readonly indexFile: string;
	private readonly inflight = new Map<string, Promise<AvatarEntry>>();
	private index: Record<string, AvatarEntry> | null = null;

	constructor(options: PsnServiceOptions) {
		this.cacheDir = options.cacheDir;
		this.ttlMs = options.ttlMs;
		this.logger = options.logger ?? silentLogger;
		this.now = options.now ?? Date.now;
		this.indexFile = path.join(options.cacheDir, "index.json");
		this.source = options.source ?? createPsnApiSource({
			npsso: options.npsso,
			tokenFile: path.join(options.cacheDir, "psn-tokens.json"),
			logger: this.logger,
			now: this.now
		});
	}

	private loadIndex(): Record<string, AvatarEntry> {
		if (this.index) return this.index;
		try {
			this.index = fs.existsSync(this.indexFile)
				? (JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as Record<string, AvatarEntry>)
				: {};
		} catch (error) {
			this.logger.warn(`Unable to read avatar cache index: ${error instanceof Error ? error.message : String(error)}`);
			this.index = {};
		}
		return this.index;
	}

	private saveIndex(): void {
		try {
			fs.mkdirSync(this.cacheDir, { recursive: true });
			fs.writeFileSync(this.indexFile, JSON.stringify(this.loadIndex(), null, 2), "utf8");
		} catch (error) {
			this.logger.warn(`Unable to save avatar cache index: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async getEntry(username: string): Promise<AvatarEntry> {
		const key = safeFileName(username);
		const cached = this.loadIndex()[key];
		if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached;

		const pending = this.inflight.get(key);
		if (pending) return pending;

		const task = this.refresh(username, key).finally(() => this.inflight.delete(key));
		this.inflight.set(key, task);
		return task;
	}

	private async refresh(username: string, key: string): Promise<AvatarEntry> {
		let url: string | null = null;
		try {
			url = await this.source.fetchAvatarUrl(username);
		} catch (error) {
			this.logger.warn(`PSN lookup failed for ${username}: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (!url) {
			const entry: AvatarEntry = { url: null, file: null, fetchedAt: this.now() - this.ttlMs + Math.min(this.ttlMs, 600_000) };
			this.loadIndex()[key] = entry;
			this.saveIndex();
			return entry;
		}

		let file: string | null = null;
		try {
			const bytes = await this.source.download(url);
			if (bytes && bytes.length > 0) {
				fs.mkdirSync(this.cacheDir, { recursive: true });
				const fileName = `${key}.img`;
				fs.writeFileSync(path.join(this.cacheDir, fileName), bytes);
				file = fileName;
			}
		} catch (error) {
			this.logger.warn(`Avatar download failed for ${username}: ${error instanceof Error ? error.message : String(error)}`);
		}

		const entry: AvatarEntry = { url, file, fetchedAt: this.now() };
		this.loadIndex()[key] = entry;
		this.saveIndex();
		return entry;
	}

	async getAvatarUrl(username: string): Promise<string | null> {
		return (await this.getEntry(username)).url;
	}

	async getAvatarFile(username: string): Promise<string | null> {
		const entry = await this.getEntry(username);
		if (!entry.file) return null;
		const full = path.join(this.cacheDir, entry.file);
		return fs.existsSync(full) ? full : null;
	}

	async getAvatarBuffer(username: string): Promise<Buffer | null> {
		const file = await this.getAvatarFile(username);
		if (!file) return null;
		try {
			return fs.readFileSync(file);
		} catch {
			return null;
		}
	}
}
