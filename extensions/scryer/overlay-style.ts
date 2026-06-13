import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const BG = "\x1b[48;2;255;255;255m";
const FG = "\x1b[38;2;0;0;0m";
const MUTED = "\x1b[38;2;0;0;0m";
const CYAN = "\x1b[38;2;8;145;178m";
const AMBER = "\x1b[38;2;180;83;9m";
const BOLD = "\x1b[1m";

function padAnsi(s: string, width: number): string {
	const v = visibleWidth(s);
	return v >= width ? truncateToWidth(s, width) : s + " ".repeat(width - v);
}

export const overlayStyle = {
	line(s: string, width: number) { return BG + FG + padAnsi(s, width) + RESET; },
	muted(s: string, width?: number) {
		const text = BG + MUTED + s + RESET;
		return width ? BG + MUTED + padAnsi(s, width) + RESET : text;
	},
	title(s: string, width?: number) {
		const raw = `${BOLD}${CYAN}${s}${RESET}`;
		return width ? BG + BOLD + CYAN + padAnsi(s, width) + RESET : raw;
	},
	accent(s: string) { return BG + AMBER + s + RESET; },
	border(width: number) { return BG + CYAN + "─".repeat(Math.max(1, width)) + RESET; },
	text(s: string) { return BG + FG + s + RESET; },
};
