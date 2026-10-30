import type { BotConfig } from "../../src/types.ts";

export const testConfig: BotConfig = {
	webhook_port: 0,
	webhook_path: "/webhook",
	publish_player_activity: true,
	player_activity_channel_id: "1565605731288354857",
	total_ps3_users_channel_id: "1565613045969850368",
	matches_played_today_channel_id: "1565621597551988786",
	unique_users_today_channel_id: "1565647820600508468",
	total_ps3_users_channel_name: "Total PS3 Users: {count}",
	matches_played_today_channel_name: "Matches Played Today: {count}",
	unique_users_today_channel_name: "Users Authed Today: {count}",
	stats_window_ms: 86_400_000,
	channel_stats_update_interval_ms: 600_000,
	channel_name_update_cooldown_ms: 610_000,
	discord_server_id: "1444360529421406384",
	psn_npsso_owner_name: "KiwifruitDev",
	webhook_display_name: "Arkham: Revived: Redux - {username} ({platform})",
	match_detection_window_ms: 10_000,
	match_detection_quiet_ms: 3_000,
	match_min_players: 2,
	avatar_grid_cell_size: 96,
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
	log_level: "silent"
};

export const testEnv = {
	discordBotToken: "test-token",
	psnNpsso: "test-npsso",
	discordWebhookUrl: "https://discord.com/api/webhooks/1/test-webhook-token",
	webhookSecret: "test-secret",
	cloudflareApiToken: "",
	cloudflareAccountId: "",
	cloudflareProfilesNamespaceId: "",
	publicBaseUrl: ""
};

/**
 * Exactly what the Cloudflare Worker sends after a PS3 login (see /auth/token in the worker).
 */
export const loginPayload = {
	type: "player_login" as const,
	platform: "ps3",
	username: "Another_Hermit",
	uuid: "ps3_Another_Hermit_e929e446-b66e-4255-8ca4-c3f0bd3711aa",
	timestamp: "2026-10-30T08:00:00.000Z"
};

/**
 * Exactly what the Cloudflare Worker sends after a profile write: a leaf diff, no full profile.
 */
export const profileUpdatePayload = {
	type: "profile_update" as const,
	platform: "ps3",
	username: "Another_Hermit",
	uuid: "ps3_Another_Hermit_e929e446-b66e-4255-8ca4-c3f0bd3711aa",
	timestamp: "2026-10-30T08:05:00.000Z",
	changes: [
		{ path: "AccountXP", before: 1250, after: 1480 },
		{ path: "AccountXPLevel", before: 28, after: 29 },
		{ path: "jokerXP", before: 400, after: 500 },
		{ path: "HeroKillsOnElites", before: 12, after: 15 },
		{ path: "EliteKillsOnHeroes", before: 3, after: 4 },
		{ path: "LastModified", before: "2030.08.07-20.35.13", after: "2030.08.07-20.58.02" },
		{ path: "MapRoundWin_Chemplant_Hero", before: false, after: true }
	]
};

export const secondPlayerProfileUpdate = {
	type: "profile_update" as const,
	platform: "ps3",
	username: "BATTLE-DONKEY",
	uuid: "ps3_BATTLE-DONKEY_ee4e70e6-6024-4b9e-bc9b-8b5c6fbe76f2",
	timestamp: "2026-10-30T08:05:04.000Z",
	changes: [
		{ path: "AccountXP", before: 800, after: 910 },
		{ path: "baneXPLevel", before: 12, after: 13 }
	]
};
