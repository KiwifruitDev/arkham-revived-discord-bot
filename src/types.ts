export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface DiscordStrings {
	webhook_display_name: string;
	login_message: string;
	profile_update_author: string;
	profile_update_footer: string;
	match_title: string;
	match_summary_separator: string;
	match_players_summary: string;
	match_xp_summary: string;
	match_levels_summary: string;
	match_more_players_name: string;
	match_more_players_value: string;
	match_footer: string;
	change_line: string;
	more_changes: string;
	unset_value: string;
	empty_value: string;
	boolean_true: string;
	boolean_false: string;
	no_stat_changes: string;
	player_delta_line: string;
	player_stat_line: string;
	delta_labels: {
		xp: string;
		levels: string;
		prestige: string;
		hero_kills: string;
		gang_kills: string;
	};
	stat_labels: Record<string, string>;
	total_ps3_users_channel_name: string;
	matches_played_today_channel_name: string;
	unique_users_today_channel_name: string;
	bot_status_activity: string;
	kv_usage_paid_channel_name: string;
	kv_usage_unknown_channel_name: string;
	kv_usage_limited_channel_name: string;
	kv_warning_status: string;
	kv_unavailable_status: string;
	kv_reset_message: string;
	kv_warning_message: string;
	kv_exhausted_message: string;
	kv_limit_reached_message: string;
	channel_rename_reason: string;
}

export interface BotConfig {
	language: string;
	strings: DiscordStrings;
	webhook_port: number;
	webhook_path: string;
	publish_player_activity: boolean;
	send_player_logins: boolean;
	send_profile_updates: boolean;
	publish_player_logins: boolean;
	publish_profile_updates: boolean;
	player_activity_channel_id: string;
	total_ps3_users_channel_id: string;
	matches_played_today_channel_id: string;
	unique_users_today_channel_id: string;
	kv_usage_channel_id: string;
	/** Rolling window used by the "today" counters. */
	stats_window_ms: number;
	channel_stats_update_interval_ms: number;
	channel_name_update_cooldown_ms: number;
	discord_server_id: string;
	psn_npsso_owner_name: string;
	match_detection_window_ms: number;
	match_detection_quiet_ms: number;
	match_min_players: number;
	avatar_grid_cell_size: number;
	avatar_cache_ttl_ms: number;
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

export interface ProfileWritePayload {
	type: "profile_write";
	platform: string;
	username: string;
	uuid: string;
	timestamp?: string;
}

export type WebhookPayload = PlayerLoginPayload | ProfileUpdatePayload | ProfileWritePayload;

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
