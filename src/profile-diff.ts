import type { ChangeValue, ProfileChange, StatChange, StatDeltas } from "./types.ts";

export type StatKey = keyof StatDeltas;

export const emptyDeltas = (): StatDeltas => ({ xp: 0, levels: 0, heroKills: 0, gangKills: 0, prestige: 0 });

/**
 * Maps a profile field onto the stat bucket used for match detection.
 * Only XP, level and kill counters participate; upgrade thresholds and prestige weapons do not.
 */
export function classifyStat(path: string): StatKey | null {
	const key = path.split(".").pop() ?? "";
	if (key === "HeroKillsOnElites") return "heroKills";
	if (key === "EliteKillsOnHeroes") return "gangKills";
	if (key === "PrestigeLevel") return "prestige";
	if (key === "PrestigeWeapon") return null;
	if (/XP$/.test(key)) return "xp";
	if (/Level$/.test(key)) return "levels";
	return null;
}

const statLabels: Record<string, string> = {
	AccountXP: "Account XP",
	jokerXP: "Joker XP",
	baneXP: "Bane XP",
	AccountXPLevel: "Account Level",
	jokerXPLevel: "Joker Level",
	baneXPLevel: "Bane Level",
	PrestigeLevel: "Prestige",
	HeroKillsOnElites: "Hero Kills",
	EliteKillsOnHeroes: "Gang Kills"
};

const statOrder: Record<StatKey, number> = { xp: 0, levels: 1, prestige: 2, heroKills: 3, gangKills: 4 };

/** Short, player friendly label for a stat field ("HeroKillsOnElites" -> "Hero Kills"). */
export function statLabel(path: string): string {
	const key = path.split(".").pop() ?? path;
	return statLabels[key] ?? humanizeKey(path);
}

/** Every XP/level/kill field that moved, with its delta and the player's resulting total. */
export function deriveStatChanges(changes: ProfileChange[]): StatChange[] {
	const stats = new Map<string, StatChange>();
	for (const change of changes) {
		const kind = classifyStat(change.path);
		if (!kind) continue;
		if (typeof change.before !== "number" || typeof change.after !== "number") continue;
		const delta = change.after - change.before;
		if (!Number.isFinite(delta) || delta === 0) continue;

		const existing = stats.get(change.path);
		if (existing) {
			existing.delta += delta;
			existing.after = change.after;
			continue;
		}
		stats.set(change.path, {
			path: change.path,
			label: statLabel(change.path),
			delta,
			before: change.before,
			after: change.after
		});
	}
	return [...stats.values()].sort((left, right) => {
		const leftKind = classifyStat(left.path);
		const rightKind = classifyStat(right.path);
		return (leftKind ? statOrder[leftKind] : 99) - (rightKind ? statOrder[rightKind] : 99);
	});
}

/** Folds stat changes from several profile writes of the same player into one row per field. */
export function mergeStatChanges(base: StatChange[], incoming: StatChange[]): StatChange[] {
	for (const change of incoming) {
		const existing = base.find((item) => item.path === change.path);
		if (existing) {
			existing.delta += change.delta;
			existing.after = change.after;
			continue;
		}
		base.push({ ...change });
	}
	return base;
}

/** Sums every positive stat change reported by the worker into a per-player delta. */
export function deriveStatDeltas(changes: ProfileChange[]): StatDeltas {
	return sumStatDeltas(deriveStatChanges(changes));
}

export function sumStatDeltas(stats: StatChange[]): StatDeltas {
	const deltas = emptyDeltas();
	for (const stat of stats) {
		const kind = classifyStat(stat.path);
		if (!kind) continue;
		if (!Number.isFinite(stat.delta) || stat.delta <= 0) continue;
		deltas[kind] += stat.delta;
	}
	return deltas;
}

export function hasStatIncrease(deltas: StatDeltas): boolean {
	return deltas.xp > 0 || deltas.levels > 0 || deltas.heroKills > 0 || deltas.gangKills > 0 || deltas.prestige > 0;
}

export function addDeltas(target: StatDeltas, source: StatDeltas): StatDeltas {
	target.xp += source.xp;
	target.levels += source.levels;
	target.heroKills += source.heroKills;
	target.gangKills += source.gangKills;
	target.prestige += source.prestige;
	return target;
}

export function sumDeltas(players: Array<{ deltas: StatDeltas }>): StatDeltas {
	const total = emptyDeltas();
	for (const player of players) addDeltas(total, player.deltas);
	return total;
}

/** "AccountXPLevel" -> "Account XP Level", "jokerXP" -> "Joker XP", "HeroKillsOnElites" -> "Hero Kills On Elites". */
export function humanizeKey(path: string): string {
	const key = path.split(".").pop() ?? path;
	const spaced = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/_/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!spaced) return path;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatValue(value: ChangeValue): string {
	if (value === null || value === undefined) return "*unset*";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (typeof value === "number") return value.toLocaleString("en-US");
	const text = String(value).replace(/[\r\n\t]+/g, " ").trim();
	if (!text) return "*empty*";
	const clipped = text.length > 60 ? `${text.slice(0, 57)}...` : text;
	return `\`${clipped.replace(/`/g, "'")}\``;
}

export function formatDelta(value: number, prefix = "+"): string {
	return `${prefix}${value.toLocaleString("en-US")}`;
}

/**
 * Builds a short "before -> after" list for the player activity embed.
 * Stat changes are listed first so the interesting lines survive the truncation.
 */
export function describeChanges(changes: ProfileChange[], limit = 12): string {
	const ordered = [...changes].sort((left, right) => {
		const leftStat = classifyStat(left.path) ? 0 : 1;
		const rightStat = classifyStat(right.path) ? 0 : 1;
		return leftStat - rightStat;
	});
	const shown = ordered.slice(0, limit);
	const lines = shown.map(
		(change) => `**${humanizeKey(change.path)}**: ${formatValue(change.before)} -> ${formatValue(change.after)}`
	);
	if (ordered.length > shown.length) {
		lines.push(`*+${ordered.length - shown.length} more changes*`);
	}
	return lines.join("\n");
}

/** Describes a player's match contribution, e.g. "**XP**: +120 · **Levels**: +1". */
export function describePlayerDeltas(deltas: StatDeltas): string {
	const parts: string[] = [];
	if (deltas.xp > 0) parts.push(`**XP**: ${formatDelta(deltas.xp)}`);
	if (deltas.levels > 0) parts.push(`**Levels**: ${formatDelta(deltas.levels)}`);
	if (deltas.prestige > 0) parts.push(`**Prestige**: ${formatDelta(deltas.prestige)}`);
	if (deltas.heroKills > 0) parts.push(`**Hero kills**: ${formatDelta(deltas.heroKills)}`);
	if (deltas.gangKills > 0) parts.push(`**Gang kills**: ${formatDelta(deltas.gangKills)}`);
	return parts.length > 0 ? parts.join("\n") : "*No stat changes*";
}

/**
 * Describes a player's match stat lines with both the gain and their resulting total:
 * "**Account XP**: +230 (total 1,480)".
 */
export function describePlayerStats(stats: StatChange[]): string {
	if (stats.length === 0) return "*No stat changes*";
	return stats
		.map((stat) => `**${stat.label}**: ${formatDelta(stat.delta)} (total ${formatValue(stat.after)})`)
		.join("\n");
}

export function isProfileUpdatePayload(value: unknown): value is { changes: ProfileChange[] } {
	if (!value || typeof value !== "object") return false;
	const changes = (value as { changes?: unknown }).changes;
	if (!Array.isArray(changes)) return false;
	return changes.every((change) => {
		if (!change || typeof change !== "object") return false;
		const candidate = change as Partial<ProfileChange>;
		return typeof candidate.path === "string" && "before" in candidate && "after" in candidate;
	});
}
