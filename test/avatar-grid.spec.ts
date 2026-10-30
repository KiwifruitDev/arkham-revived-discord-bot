import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { composeAvatarGrid, gridLayout, gridSize } from "../src/avatar-grid.ts";

async function solidPng(color: { r: number; g: number; b: number }, size = 64): Promise<Buffer> {
	return sharp({ create: { width: size, height: size, channels: 4, background: { ...color, alpha: 1 } } })
		.png()
		.toBuffer();
}

describe("avatar grid", () => {
	it("picks an automatic grid size", () => {
		expect(gridLayout(0)).toEqual({ columns: 0, rows: 0 });
		expect(gridLayout(1)).toEqual({ columns: 1, rows: 1 });
		expect(gridLayout(2)).toEqual({ columns: 2, rows: 1 });
		expect(gridLayout(3)).toEqual({ columns: 2, rows: 2 });
		expect(gridLayout(4)).toEqual({ columns: 2, rows: 2 });
		expect(gridLayout(5)).toEqual({ columns: 3, rows: 2 });
		expect(gridLayout(9)).toEqual({ columns: 3, rows: 3 });
		expect(gridLayout(10)).toEqual({ columns: 4, rows: 3 });
	});

	it("computes the matching canvas size", () => {
		expect(gridSize(4, 100, 5)).toEqual({ width: 2 * 100 + 3 * 5, height: 2 * 100 + 3 * 5 });
		expect(gridSize(2, 100, 5)).toEqual({ width: 2 * 100 + 3 * 5, height: 100 + 2 * 5 });
	});

	it("composes a png grid for four players", async () => {
		const avatars = await Promise.all([
			solidPng({ r: 200, g: 30, b: 30 }),
			solidPng({ r: 30, g: 200, b: 30 }),
			solidPng({ r: 30, g: 30, b: 200 }),
			solidPng({ r: 200, g: 200, b: 30 })
		]);
		const png = await composeAvatarGrid(avatars, { cellSize: 96, gap: 6 });

		expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const metadata = await sharp(png).metadata();
		expect(metadata.width).toBe(2 * 96 + 3 * 6);
		expect(metadata.height).toBe(2 * 96 + 3 * 6);
	});

	it("renders a two player grid as a single row", async () => {
		const avatars = [await solidPng({ r: 10, g: 10, b: 10 }), await solidPng({ r: 220, g: 220, b: 220 })];
		const png = await composeAvatarGrid(avatars, { cellSize: 80, gap: 4 });
		const metadata = await sharp(png).metadata();
		expect(metadata.width).toBe(2 * 80 + 3 * 4);
		expect(metadata.height).toBe(80 + 2 * 4);
	});

	it("falls back to a placeholder for missing or broken avatars", async () => {
		const png = await composeAvatarGrid([null, Buffer.from("not an image")], { cellSize: 64, gap: 2 });
		const metadata = await sharp(png).metadata();
		expect(metadata.width).toBe(2 * 64 + 3 * 2);
		expect(metadata.height).toBe(64 + 2 * 2);
	});

	it("keeps the grid size to the avatars only", async () => {
		const png = await composeAvatarGrid([await solidPng({ r: 1, g: 2, b: 3 })], { cellSize: 64 });
		const metadata = await sharp(png).metadata();
		expect(metadata.width).toBe(64 + 2 * 6);
		expect(metadata.height).toBe(64 + 2 * 6);
	});
});
