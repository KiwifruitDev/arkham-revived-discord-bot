import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, projectRoot } from "../src/config.ts";
import { formatLocalized, loadDiscordStrings } from "../src/localization.ts";

describe("Discord localization", () => {
	it("loads the language selected in config.json", () => {
		const { config } = loadConfig({
			root: projectRoot,
			envFile: path.join(os.tmpdir(), "arkham-revived-missing-test-env")
		});

		expect(config.language).toBe("en-US");
		expect(config.strings.login_message).toContain("{username}");
	});

	it("rejects unsafe locale identifiers and formats localized placeholders", () => {
		expect(() => loadDiscordStrings(projectRoot, "../config")).toThrow("Invalid language identifier");
		expect(formatLocalized("Usage: {count} writes", { count: 1000 })).toBe("Usage: 1000 writes");
	});
});
