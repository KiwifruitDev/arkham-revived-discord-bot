import type { APIEmbed } from "discord.js";
import { describeChanges, describePlayerDeltas, describePlayerStats, formatDelta } from "./profile-diff.ts";
import { formatLocalized } from "./localization.ts";
import type { BotConfig, DiscordStrings, MatchResult, ProfileUpdatePayload } from "./types.ts";

export const embedColor = 0xb31217;

export function formatWebhookDisplayName(config: BotConfig, username: string, platform: string): string {
	return formatLocalized(config.strings.webhook_display_name, {
		username,
		platform: platform.toUpperCase()
	})
		.slice(0, 80);
}

export function buildLoginContent(username: string, strings: DiscordStrings, platform = "ps3"): string {
	return formatLocalized(strings.login_message, { username, platform: platform.toUpperCase() });
}

/** Compact embed listing what changed on a profile, before and after. */
export function buildProfileUpdateEmbed(
	payload: ProfileUpdatePayload,
	strings: DiscordStrings,
	language: string,
	options: { avatarUrl?: string | null; limit?: number } = {}
): APIEmbed {
	const embed: APIEmbed = {
		color: embedColor,
		author: {
			name: formatLocalized(strings.profile_update_author, {
				username: payload.username,
				platform: payload.platform.toUpperCase()
			})
		},
		description: describeChanges(payload.changes, strings, language, options.limit ?? 12),
		footer: { text: strings.profile_update_footer },
		timestamp: payload.timestamp ?? new Date().toISOString()
	};
	if (options.avatarUrl) embed.thumbnail = { url: options.avatarUrl };
	return embed;
}

/** Match summary posted by the bot (not the webhook) with the avatar grid attached. */
export function buildMatchEmbed(
	match: MatchResult,
	strings: DiscordStrings,
	language: string,
	options: { matchesPlayedToday: number; imageName?: string; endedAt?: number } = { matchesPlayedToday: 0 }
): APIEmbed {
	const players = match.players.slice(0, 24);
	const fields = players.map((player) => ({
		name: player.username,
		value: (
			player.stats.length > 0
				? describePlayerStats(player.stats, strings, language)
				: describePlayerDeltas(player.deltas, strings, language)
		).slice(0, 1024),
		inline: true
	}));
	if (match.players.length > players.length) {
		fields.push({
			name: formatLocalized(strings.match_more_players_name, { count: match.players.length - players.length }),
			value: strings.match_more_players_value,
			inline: true
		});
	}

	const parts = [formatLocalized(strings.match_players_summary, { count: match.players.length })];
	if (match.total.xp > 0) {
		parts.push(formatLocalized(strings.match_xp_summary, { value: formatDelta(match.total.xp, language) }));
	}
	if (match.total.levels > 0) {
		parts.push(formatLocalized(strings.match_levels_summary, { value: formatDelta(match.total.levels, language) }));
	}
	const embed: APIEmbed = {
		color: embedColor,
		title: strings.match_title,
		description: parts.join(strings.match_summary_separator),
		fields,
		footer: { text: formatLocalized(strings.match_footer, { count: options.matchesPlayedToday }) },
		timestamp: new Date(options.endedAt ?? match.endedAt).toISOString()
	};
	if (options.imageName) embed.thumbnail = { url: `attachment://${options.imageName}` };
	return embed;
}
