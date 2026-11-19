import fs from "node:fs";
import path from "node:path";
import type { DiscordStrings } from "./types.ts";

const stringKeys: Array<keyof Omit<DiscordStrings, "delta_labels" | "stat_labels">> = [
	"webhook_display_name",
	"login_message",
	"profile_update_author",
	"profile_update_footer",
	"match_title",
	"match_summary_separator",
	"match_players_summary",
	"match_xp_summary",
	"match_levels_summary",
	"match_more_players_name",
	"match_more_players_value",
	"match_footer",
	"change_line",
	"more_changes",
	"unset_value",
	"empty_value",
	"boolean_true",
	"boolean_false",
	"no_stat_changes",
	"player_delta_line",
	"player_stat_line",
	"total_ps3_users_channel_name",
	"matches_played_today_channel_name",
	"unique_users_today_channel_name",
	"bot_status_activity",
	"kv_usage_paid_channel_name",
	"kv_usage_unknown_channel_name",
	"kv_usage_limited_channel_name",
	"kv_warning_status",
	"kv_unavailable_status",
	"kv_reset_message",
	"kv_warning_message",
	"kv_exhausted_message",
	"kv_limit_reached_message",
	"channel_rename_reason"
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Loads and validates every user-visible Discord string for the selected language. */
export function loadDiscordStrings(root: string, language: string): DiscordStrings {
	if (!/^[A-Za-z0-9-]+$/.test(language)) {
		throw new Error(`Invalid language identifier "${language}"`);
	}
	const file = path.join(root, "lang", `${language}.json`);
	if (!fs.existsSync(file)) throw new Error(`Language file not found: ${file}`);

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`Unable to parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error(`Invalid language file: ${file}`);
	for (const key of stringKeys) {
		if (typeof parsed[key] !== "string") throw new Error(`Language file ${file} is missing the "${key}" string`);
	}

	const deltaLabels = parsed.delta_labels;
	if (!isRecord(deltaLabels) || ["xp", "levels", "prestige", "hero_kills", "gang_kills"].some((key) => typeof deltaLabels[key] !== "string")) {
		throw new Error(`Language file ${file} is missing one or more delta labels`);
	}
	const statLabels = parsed.stat_labels;
	if (!isRecord(statLabels) || Object.values(statLabels).some((value) => typeof value !== "string")) {
		throw new Error(`Language file ${file} has invalid stat labels`);
	}
	return parsed as unknown as DiscordStrings;
}

export function formatLocalized(template: string, values: Record<string, string | number>): string {
	return template.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, key: string) =>
		Object.hasOwn(values, key) ? String(values[key]) : placeholder
	);
}
