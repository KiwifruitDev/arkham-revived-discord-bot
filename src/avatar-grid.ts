import sharp from "sharp";

export interface AvatarGridOptions {
	cellSize?: number;
	gap?: number;
	placeholder?: Buffer | null;
	background?: { r: number; g: number; b: number; alpha: number };
}

export interface GridLayout {
	columns: number;
	rows: number;
}

const defaultCellSize = 160;
const defaultGap = 6;
const defaultBackground = { r: 30, g: 31, b: 34, alpha: 1 };

/** Picks the smallest square-ish grid that fits every avatar: 1 -> 1x1, 2 -> 2x1, 3-4 -> 2x2, 5-6 -> 3x2 ... */
export function gridLayout(count: number): GridLayout {
	if (count <= 0) return { columns: 0, rows: 0 };
	const columns = Math.ceil(Math.sqrt(count));
	const rows = Math.ceil(count / columns);
	return { columns, rows };
}

export function gridSize(count: number, cellSize = defaultCellSize, gap = defaultGap): { width: number; height: number } {
	const { columns, rows } = gridLayout(count);
	if (columns === 0) return { width: cellSize, height: cellSize };
	return {
		width: columns * cellSize + (columns + 1) * gap,
		height: rows * cellSize + (rows + 1) * gap
	};
}

async function placeholderTile(cellSize: number, background: { r: number; g: number; b: number; alpha: number }): Promise<Buffer> {
	return sharp({
		create: {
			width: cellSize,
			height: cellSize,
			channels: 4,
			background: {
				r: Math.min(255, background.r + 40),
				g: Math.min(255, background.g + 40),
				b: Math.min(255, background.b + 40),
				alpha: 1
			}
		}
	})
		.png()
		.toBuffer();
}

/**
 * Composites PSN avatars into a PNG grid whose size follows the player count.
 */
export async function composeAvatarGrid(avatars: Array<Buffer | null | undefined>, options: AvatarGridOptions = {}): Promise<Buffer> {
	const cellSize = options.cellSize ?? defaultCellSize;
	const gap = options.gap ?? defaultGap;
	const background = options.background ?? defaultBackground;
	const { columns } = gridLayout(avatars.length);
	const { width, height } = gridSize(avatars.length, cellSize, gap);

	const composites: Array<{ input: Buffer; left: number; top: number }> = [];
	const blank = options.placeholder ?? (await placeholderTile(cellSize, background));

	for (let index = 0; index < avatars.length; index += 1) {
		const column = columns > 0 ? index % columns : 0;
		const row = columns > 0 ? Math.floor(index / columns) : 0;
		const avatar = avatars[index];
		let tile = blank;
		if (avatar && avatar.length > 0) {
			try {
				tile = await sharp(avatar).resize(cellSize, cellSize, { fit: "cover", position: "centre" }).png().toBuffer();
			} catch {
				tile = blank;
			}
		}
		composites.push({ input: tile, left: gap + column * (cellSize + gap), top: gap + row * (cellSize + gap) });
	}

	return sharp({ create: { width, height, channels: 4, background } })
		.composite(composites)
		.png()
		.toBuffer();
}
