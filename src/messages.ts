import type { APIEmbed } from "discord.js";
import { describeChanges, describePlayerDeltas, describePlayerStats, formatDelta } from "./profile-diff.ts";
import type { BotConfig, MatchResult, ProfileUpdatePayload } from "./types.ts";

export const embedColor = 0xb31217;

export function formatWebhookDisplayName(config: BotConfig, username: string, platform: string): string {
	return config.webhook_display_name
		.replace(/\{username\}/g, username)
		.replace(/\{platform\}/g, platform.toUpperCase())
		.slice(0, 80);
}

export function buildLoginContent(username: string, platform = "ps3"): string {
	return `**${username}** (${platform.toUpperCase()}) has logged in to Arkham: Revived Redux.`;
}

/** Compact embed listing what changed on a profile, before and after. */
export function buildProfileUpdateEmbed(payload: ProfileUpdatePayload, options: { avatarUrl?: string | null; limit?: number } = {}): APIEmbed {
	const embed: APIEmbed = {
		color: embedColor,
		author: { name: `${payload.username} • ${payload.platform.toUpperCase()} profile updated` },
		description: describeChanges(payload.changes, options.limit ?? 12),
		footer: { text: "Arkham: Revived profile activity" },
		timestamp: payload.timestamp ?? new Date().toISOString()
	};
	if (options.avatarUrl) embed.thumbnail = { url: options.avatarUrl };
	return embed;
}

/** Match summary posted by the bot (not the webhook) with the avatar grid attached. */
export function buildMatchEmbed(
	match: MatchResult,
	options: { matchesPlayedToday: number; imageName?: string; endedAt?: number } = { matchesPlayedToday: 0 }
): APIEmbed {
	const players = match.players.slice(0, 24);
	const fields = players.map((player) => ({
		name: player.username,
		value: (player.stats.length > 0 ? describePlayerStats(player.stats) : describePlayerDeltas(player.deltas)).slice(0, 1024),
		inline: true
	}));
	if (match.players.length > players.length) {
		fields.push({ name: `${match.players.length - players.length} more players`, value: "*not shown*", inline: true });
	}

	const parts = [`**${match.players.length}** players`];
	if (match.total.xp > 0) parts.push(`${formatDelta(match.total.xp)} XP`);
	if (match.total.levels > 0) parts.push(`${formatDelta(match.total.levels)} levels`);
	const embed: APIEmbed = {
		color: embedColor,
		title: "Match Result",
		description: parts.join(" · "),
		fields,
		footer: { text: `Matches played today: ${options.matchesPlayedToday}` },
		timestamp: new Date(options.endedAt ?? match.endedAt).toISOString()
	};
	if (options.imageName) embed.image = { url: `attachment://${options.imageName}` };
	return embed;
}
