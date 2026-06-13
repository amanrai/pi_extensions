import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const BG = "\x1b[48;2;0;0;0m";
const FG = "\x1b[38;2;255;255;255m";
const MUTED = "\x1b[38;2;255;255;255m";
const CYAN = "\x1b[38;2;255;255;255m";
const AMBER = "\x1b[38;2;255;255;255m";
const BOLD = "\x1b[1m";
const CONTENT_PAD = 2;

function padAnsi(s: string, width: number): string {
	const v = visibleWidth(s);
	return v >= width ? truncateToWidth(s, width) : s + " ".repeat(width - v);
}

function insetLine(s: string, width: number): string {
	const pad = " ".repeat(Math.min(CONTENT_PAD, Math.floor(width / 4)));
	const innerWidth = Math.max(1, width - visibleWidth(pad) * 2);
	return pad + padAnsi(truncateToWidth(s, innerWidth), innerWidth) + pad;
}

export const overlayStyle = {
	line(s: string, width: number) { return BG + FG + insetLine(s, width) + RESET; },
	muted(s: string, width?: number) {
		const text = BG + MUTED + s + RESET;
		return width ? BG + MUTED + insetLine(s, width) + RESET : text;
	},
	title(s: string, width?: number) {
		const raw = `${BOLD}${CYAN}${s}${RESET}`;
		return width ? BG + BOLD + CYAN + insetLine(s, width) + RESET : raw;
	},
	accent(s: string) { return BG + AMBER + s + RESET; },
	border(width: number) { return BG + CYAN + "─".repeat(Math.max(1, width)) + RESET; },
	text(s: string) { return BG + FG + s + RESET; },
};
