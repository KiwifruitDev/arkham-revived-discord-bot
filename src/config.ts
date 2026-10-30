import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { BotConfig, BotEnv, LogLevel } from "./types.ts";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ResolvedPaths {
	root: string;
	state: string;
	cache: string;
	avatars: string;
}

export interface LoadedConfig {
	config: BotConfig;
	env: BotEnv;
	paths: ResolvedPaths;
}

const fallbackConfig: BotConfig = {
	webhook_port: 4321,
	webhook_path: "/webhook",
	publish_player_activity: true,
	player_activity_channel_id: "",
	total_ps3_users_channel_id: "",
	matches_played_today_channel_id: "",
	unique_users_today_channel_id: "",
	total_ps3_users_channel_name: "Total PS3 Users: {count}",
	matches_played_today_channel_name: "Matches Played Today: {count}",
	unique_users_today_channel_name: "Users Authed Today: {count}",
	stats_window_ms: 86_400_000,
	channel_stats_update_interval_ms: 600_000,
	channel_name_update_cooldown_ms: 610_000,
	discord_server_id: "",
	psn_npsso_owner_name: "",
	webhook_display_name: "Arkham: Revived: Redux - {username} ({platform})",
	match_detection_window_ms: 10_000,
	match_detection_quiet_ms: 3_000,
	match_min_players: 2,
	avatar_grid_cell_size: 160,
	avatar_cache_ttl_ms: 604_800_000,
	bot_status_activity: "Tracking {players} PS3 players...",
	bot_status_type: "watching",
	publish_max_per_hour: 10,
	publish_window_ms: 3_600_000,
	publish_queue_max_age_ms: 7_200_000,
	cloudflare_account_id: "",
	cloudflare_profiles_namespace_id: "",
	state_directory: "data",
	cache_directory: "cache",
	log_level: "info"
};

function readJsonFile<T>(file: string): Partial<T> {
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<T>;
	} catch (error) {
		throw new Error(`Unable to parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function asString(value: unknown, fallback = ""): string {
	if (value === undefined || value === null) return fallback;
	return String(value).trim();
}

function asNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return fallback;
}

/**
 * Merges `default-config.json` and `config.json`, then layers environment overrides on top.
 * Channel IDs are stored as strings because Discord snowflakes exceed Number.MAX_SAFE_INTEGER.
 */
export function loadConfig(options: { root?: string; envFile?: string } = {}): LoadedConfig {
	const root = options.root ?? projectRoot;
	const defaults = { ...fallbackConfig, ...readJsonFile<BotConfig>(path.join(root, "default-config.json")) };
	const local = readJsonFile<Record<string, unknown>>(path.join(root, "config.json"));
	const merged: Record<string, unknown> = { ...defaults, ...local };

	// Legacy config keys used a "_text_channel_id" suffix even though the channels are voice channels.
	merged.player_activity_channel_id ??= local.player_activity_text_channel_id;
	merged.total_ps3_users_channel_id ??= local.total_ps3_users_text_channel_id;
	merged.matches_played_today_channel_id ??= local.matches_played_today_text_channel_id;

	dotenv.config({ path: options.envFile ?? path.join(root, ".env"), quiet: true });

	const config: BotConfig = {
		webhook_port: asNumber(process.env.WEBHOOK_PORT ?? merged.webhook_port, 4321),
		webhook_path: asString(merged.webhook_path, "/webhook") || "/webhook",
		publish_player_activity: asBoolean(merged.publish_player_activity, true),
		player_activity_channel_id: asString(merged.player_activity_channel_id),
		total_ps3_users_channel_id: asString(merged.total_ps3_users_channel_id),
		matches_played_today_channel_id: asString(merged.matches_played_today_channel_id),
		unique_users_today_channel_id: asString(merged.unique_users_today_channel_id),
		total_ps3_users_channel_name: asString(merged.total_ps3_users_channel_name, "Total PS3 Users: {count}"),
		matches_played_today_channel_name: asString(merged.matches_played_today_channel_name, "Matches Played Today: {count}"),
		unique_users_today_channel_name: asString(merged.unique_users_today_channel_name, "Users Authed Today: {count}"),
		stats_window_ms: Math.max(60_000, asNumber(merged.stats_window_ms, 86_400_000)),
		channel_stats_update_interval_ms: asNumber(merged.channel_stats_update_interval_ms, 600_000),
		channel_name_update_cooldown_ms: asNumber(merged.channel_name_update_cooldown_ms, 610_000),
		discord_server_id: asString(merged.discord_server_id),
		psn_npsso_owner_name: asString(merged.psn_npsso_owner_name),
		webhook_display_name: asString(merged.webhook_display_name, "Arkham: Revived: Redux - {username} ({platform})"),
		match_detection_window_ms: asNumber(merged.match_detection_window_ms, 10_000),
		match_detection_quiet_ms: asNumber(merged.match_detection_quiet_ms, 3_000),
		match_min_players: Math.max(2, asNumber(merged.match_min_players, 2)),
		avatar_grid_cell_size: Math.max(32, asNumber(merged.avatar_grid_cell_size, 160)),
		avatar_cache_ttl_ms: asNumber(merged.avatar_cache_ttl_ms, 604_800_000),
		bot_status_activity: asString(
			merged.bot_status_activity,
			"Tracking {players} PS3 players..."
		),
		bot_status_type: asString(merged.bot_status_type, "watching").toLowerCase(),
		publish_max_per_hour: Math.max(1, asNumber(merged.publish_max_per_hour, 10)),
		publish_window_ms: Math.max(60_000, asNumber(merged.publish_window_ms, 3_600_000)),
		publish_queue_max_age_ms: Math.max(0, asNumber(merged.publish_queue_max_age_ms, 7_200_000)),
		cloudflare_account_id: asString(process.env.CLOUDFLARE_ACCOUNT_ID ?? merged.cloudflare_account_id),
		cloudflare_profiles_namespace_id: asString(
			process.env.CLOUDFLARE_PROFILES_NAMESPACE_ID ?? merged.cloudflare_profiles_namespace_id
		),
		state_directory: asString(merged.state_directory, "data"),
		cache_directory: asString(merged.cache_directory, "cache"),
		log_level: asString(merged.log_level, "info").toLowerCase() as LogLevel
	};

	const env: BotEnv = {
		discordBotToken: asString(process.env.DISCORD_BOT_TOKEN),
		psnNpsso: asString(process.env.PSN_NPSSO),
		discordWebhookUrl: asString(process.env.DISCORD_WEBHOOK_URL),
		webhookSecret: asString(process.env.WEBHOOK_SECRET),
		cloudflareApiToken: asString(process.env.CLOUDFLARE_API_TOKEN),
		cloudflareAccountId: config.cloudflare_account_id,
		cloudflareProfilesNamespaceId: config.cloudflare_profiles_namespace_id,
		publicBaseUrl: asString(process.env.PUBLIC_BASE_URL).replace(/\/+$/, "")
	};

	const paths: ResolvedPaths = {
		root,
		state: path.resolve(root, config.state_directory),
		cache: path.resolve(root, config.cache_directory),
		avatars: path.resolve(root, config.cache_directory, "avatars")
	};

	return { config, env, paths };
}

export function assertRequiredEnv(env: BotEnv): void {
	const required: Array<[string, string]> = [
		["DISCORD_BOT_TOKEN", env.discordBotToken],
		["PSN_NPSSO", env.psnNpsso],
		["DISCORD_WEBHOOK_URL", env.discordWebhookUrl],
		["WEBHOOK_SECRET", env.webhookSecret]
	];
	const missing = required.filter(([, value]) => !value).map(([name]) => name);
	if (missing.length > 0) {
		throw new Error(`Missing required environment variables: ${missing.join(", ")} (see example.env)`);
	}
}
