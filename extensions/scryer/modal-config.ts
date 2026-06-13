import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RECORDER_DIR } from "./config.ts";

export type ModalConfig = {
	width?: number;
	height?: number;
};

const CONFIG_PATH = join(RECORDER_DIR, "modal-config.json");
const MIN_WIDTH = 40;
const MIN_HEIGHT = 10;

function cleanNumber(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

export async function readModalConfig(): Promise<ModalConfig> {
	try {
		const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
		return {
			width: cleanNumber(raw.width),
			height: cleanNumber(raw.height),
		};
	} catch {
		return {};
	}
}

export async function writeModalConfig(config: ModalConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify({
		width: cleanNumber(config.width),
		height: cleanNumber(config.height),
	}, null, 2));
}

export async function resetModalConfig(): Promise<void> {
	await writeModalConfig({});
}

export function modalWidthOption(config: ModalConfig): number | string {
	return config.width ? Math.max(MIN_WIDTH, config.width) : "90%";
}

export function modalHeightOption(config: ModalConfig): number | string {
	return config.height ? Math.max(MIN_HEIGHT, config.height) : "80%";
}

export function modalBodyRows(config: ModalConfig, terminalHeight: number, chromeRows: number, fallbackPercent = 0.8): number {
	const totalRows = config.height
		? Math.max(MIN_HEIGHT, config.height)
		: Math.floor(terminalHeight * fallbackPercent);
	return Math.max(4, totalRows - chromeRows);
}

export function describeModalConfig(config: ModalConfig): string {
	return `width=${config.width ? `${config.width} cols` : "90%"}, height=${config.height ? `${config.height} rows` : "80%"}`;
}

export function parseModalConfigArgs(args: string, existing: ModalConfig): { config?: ModalConfig; message: string; showOnly?: boolean } {
	const trimmed = args.trim();
	if (!trimmed) return { config: existing, message: describeModalConfig(existing), showOnly: true };
	if (/^(reset|default|defaults)$/i.test(trimmed)) return { config: {}, message: "modal config reset to width=90%, height=80%" };

	const tokens = trimmed.split(/\s+/);
	let next: ModalConfig = { ...existing };
	let positional: number[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const assignment = token.match(/^(width|w|cols?|columns?|height|h|rows?)=(\d+)$/i);
		if (assignment) {
			const key = assignment[1].toLowerCase();
			const value = Number(assignment[2]);
			if (/^(width|w|col|cols|columns?)$/.test(key)) next.width = value;
			else next.height = value;
			continue;
		}
		if (/^(width|w|cols?|columns?|height|h|rows?)$/i.test(token) && tokens[i + 1]) {
			const value = Number(tokens[++i]);
			if (!Number.isFinite(value)) return { message: `invalid number: ${tokens[i]}` };
			if (/^(width|w|col|cols|columns?)$/i.test(token)) next.width = value;
			else next.height = value;
			continue;
		}
		const value = Number(token);
		if (Number.isFinite(value)) positional.push(value);
		else return { message: `usage: /modal-config [width <cols>] [height <rows>] | /modal-config <cols> <rows> | /modal-config reset` };
	}

	if (positional.length > 0) next.width = positional[0];
	if (positional.length > 1) next.height = positional[1];
	if (positional.length > 2) return { message: "too many positional values; use /modal-config <cols> <rows>" };

	next = { width: cleanNumber(next.width), height: cleanNumber(next.height) };
	return { config: next, message: `modal config set: ${describeModalConfig(next)}` };
}
