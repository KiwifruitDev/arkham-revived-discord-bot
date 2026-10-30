import type { LogLevel } from "./types.ts";

export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	child(scope: string): Logger;
}

const levels: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: 100
};

export function createLogger(level: LogLevel = "info", scope?: string): Logger {
	const threshold = levels[level] ?? levels.info;
	const prefix = (name: string): string => (scope ? `[${name}] [${scope}]` : `[${name}]`);

	const write = (name: LogLevel, sink: (...data: unknown[]) => void, message: string, args: unknown[]): void => {
		if (levels[name] < threshold) return;
		sink(`${new Date().toISOString()} ${prefix(name.toUpperCase())} ${message}`, ...args);
	};

	return {
		debug: (message, ...args) => write("debug", console.debug, message, args),
		info: (message, ...args) => write("info", console.info, message, args),
		warn: (message, ...args) => write("warn", console.warn, message, args),
		error: (message, ...args) => write("error", console.error, message, args),
		child: (childScope: string) => createLogger(level, scope ? `${scope}:${childScope}` : childScope)
	};
}

export const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger
};
