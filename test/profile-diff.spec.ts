import { describe, expect, it } from "vitest";
import {
	classifyStat,
	deriveStatChanges,
	deriveStatDeltas,
	describeChanges,
	describePlayerDeltas,
	describePlayerStats,
	formatValue,
	hasStatIncrease,
	humanizeKey,
	isProfileUpdatePayload,
	mergeStatChanges,
	emptyDeltas
} from "../src/profile-diff.ts";
import { profileUpdatePayload, testConfig } from "./fixtures/payloads.ts";

const { strings, language } = testConfig;

describe("profile diff", () => {
	it("classifies XP, level and kill counters", () => {
		expect(classifyStat("AccountXP")).toBe("xp");
		expect(classifyStat("jokerXP")).toBe("xp");
		expect(classifyStat("AccountXPLevel")).toBe("levels");
		expect(classifyStat("PrestigeLevel")).toBe("prestige");
		expect(classifyStat("HeroKillsOnElites")).toBe("heroKills");
		expect(classifyStat("EliteKillsOnHeroes")).toBe("gangKills");
		expect(classifyStat("AccountXPForNextUpgrade")).toBeNull();
		expect(classifyStat("PrestigeWeapon")).toBeNull();
		expect(classifyStat("MapRoundWin_Chemplant_Hero")).toBeNull();
	});

	it("accumulates positive stat deltas from a worker payload", () => {
		const deltas = deriveStatDeltas(profileUpdatePayload.changes, strings);
		expect(deltas).toEqual({ xp: 330, levels: 1, heroKills: 3, gangKills: 1, prestige: 0 });
		expect(hasStatIncrease(deltas)).toBe(true);
	});

	it("ignores decreases and non numeric changes", () => {
		const deltas = deriveStatDeltas(
			[
				{ path: "AccountXP", before: 100, after: 40 },
				{ path: "AccountXPLevel", before: null, after: 3 }
			],
			strings
		);
		expect(deltas).toEqual(emptyDeltas());
		expect(hasStatIncrease(deltas)).toBe(false);
	});

	it("humanizes profile keys", () => {
		expect(humanizeKey("AccountXP")).toBe("Account XP");
		expect(humanizeKey("jokerXP")).toBe("Joker XP");
		expect(humanizeKey("HeroKillsOnElites")).toBe("Hero Kills On Elites");
		expect(humanizeKey("MapRoundWin_Chemplant_Hero")).toBe("Map Round Win Chemplant Hero");
	});

	it("formats before/after values", () => {
		expect(formatValue(1250, strings, language)).toBe("1,250");
		expect(formatValue(true, strings, language)).toBe("Yes");
		expect(formatValue(null, strings, language)).toBe("*unset*");
		expect(formatValue("M4A1", strings, language)).toBe("`M4A1`");
	});

	it("lists stats first and truncates long diffs", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({
			path: `Setting${index}`,
			before: index,
			after: index + 1
		}));
		const description = describeChanges([...many, { path: "AccountXP", before: 0, after: 10 }], strings, language, 5);
		const lines = description.split("\n");
		expect(lines[0]).toContain("Account XP");
		expect(lines[lines.length - 1]).toBe("*+16 more changes*");
	});

	it("reports stat changes with resulting totals", () => {
		const stats = deriveStatChanges(profileUpdatePayload.changes, strings);
		expect(stats).toEqual([
			{ path: "AccountXP", label: "Account XP", delta: 230, before: 1250, after: 1480 },
			{ path: "jokerXP", label: "Joker XP", delta: 100, before: 400, after: 500 },
			{ path: "AccountXPLevel", label: "Account Level", delta: 1, before: 28, after: 29 },
			{ path: "HeroKillsOnElites", label: "Hero Kills", delta: 3, before: 12, after: 15 },
			{ path: "EliteKillsOnHeroes", label: "Gang Kills", delta: 1, before: 3, after: 4 }
		]);
		expect(describePlayerStats(stats, strings, language)).toContain("**Account XP**: +230 (total 1,480)");
		expect(describePlayerStats(stats, strings, language)).toContain("**Account Level**: +1 (total 29)");
		expect(describePlayerStats(stats, strings, language)).toContain("**Gang Kills**: +1 (total 4)");
	});

	it("merges several writes from the same player into one row per field", () => {
		const first = deriveStatChanges([{ path: "AccountXP", before: 100, after: 150 }], strings);
		const merged = mergeStatChanges(first, deriveStatChanges([{ path: "AccountXP", before: 150, after: 260 }], strings));
		expect(merged).toEqual([{ path: "AccountXP", label: "Account XP", delta: 160, before: 100, after: 260 }]);
		expect(describePlayerStats(merged, strings, language)).toBe("**Account XP**: +160 (total 260)");
	});

	it("describes a player's match contribution without totals", () => {
		const text = describePlayerDeltas({ xp: 130, levels: 1, heroKills: 3, gangKills: 0, prestige: 0 }, strings, language);
		expect(text).toContain("**XP**: +130");
		expect(text).toContain("**Levels**: +1");
		expect(text).toContain("**Hero kills**: +3");
		expect(text).not.toContain("Gang kills");
	});

	it("validates worker payload shape", () => {
		expect(isProfileUpdatePayload(profileUpdatePayload)).toBe(true);
		expect(isProfileUpdatePayload({ changes: [{ path: "x" }] })).toBe(false);
		expect(isProfileUpdatePayload({ changes: "nope" })).toBe(false);
	});
});
