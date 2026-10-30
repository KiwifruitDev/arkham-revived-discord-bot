export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface BotConfig {
	webhook_port: number;
	webhook_path: string;
	publish_player_activity: boolean;
	player_activity_channel_id: string;
	total_ps3_users_channel_id: string;
	matches_played_today_channel_id: string;
	unique_users_today_channel_id: string;
	total_ps3_users_channel_name: string;
	matches_played_today_channel_name: string;
	unique_users_today_channel_name: string;
	/** Rolling window used by the "today" counters. */
	stats_window_ms: number;
	channel_stats_update_interval_ms: number;
	channel_name_update_cooldown_ms: number;
	discord_server_id: string;
	psn_npsso_owner_name: string;
	webhook_display_name: string;
	match_detection_window_ms: number;
	match_detection_quiet_ms: number;
	match_min_players: number;
	avatar_grid_cell_size: number;
	avatar_cache_ttl_ms: number;
	bot_status_activity: string;
	bot_status_type: string;
	publish_max_per_hour: number;
	publish_window_ms: number;
	publish_queue_max_age_ms: number;
	cloudflare_account_id: string;
	cloudflare_profiles_namespace_id: string;
	state_directory: string;
	cache_directory: string;
	log_level: LogLevel;
}

export interface BotEnv {
	discordBotToken: string;
	psnNpsso: string;
	discordWebhookUrl: string;
	webhookSecret: string;
	cloudflareApiToken: string;
	cloudflareAccountId: string;
	cloudflareProfilesNamespaceId: string;
	publicBaseUrl: string;
}

export type ChangeValue = string | number | boolean | null;

export interface ProfileChange {
	path: string;
	before: ChangeValue;
	after: ChangeValue;
}

export interface PlayerLoginPayload {
	type: "player_login";
	platform: string;
	username: string;
	uuid: string;
	timestamp?: string;
}

export interface ProfileUpdatePayload {
	type: "profile_update";
	platform: string;
	username: string;
	uuid: string;
	timestamp?: string;
	changes: ProfileChange[];
}

export type WebhookPayload = PlayerLoginPayload | ProfileUpdatePayload;

export interface StatDeltas {
	xp: number;
	levels: number;
	heroKills: number;
	gangKills: number;
	prestige: number;
}

/** One stat field that moved during a match, including the player's new total. */
export interface StatChange {
	path: string;
	label: string;
	delta: number;
	before: number;
	after: number;
}

export interface MatchPlayer {
	username: string;
	uuid: string;
	platform: string;
	deltas: StatDeltas;
	stats: StatChange[];
	events: number;
	firstSeen: number;
	lastSeen: number;
}

export interface MatchResult {
	players: MatchPlayer[];
	startedAt: number;
	endedAt: number;
	total: StatDeltas;
}
