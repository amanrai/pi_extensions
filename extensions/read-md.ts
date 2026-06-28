import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve } from "node:path";

const MAX_FILE_BYTES = Number(process.env.READ_MD_MAX_BYTES ?? process.env.READ_TEXT_MAX_BYTES ?? 512_000);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", "vendor"]);
const TEXT_EXTENSIONS = new Set([
	".md", ".mdx", ".markdown", ".txt", ".text", ".log", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".env",
	".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
	".css", ".scss", ".sass", ".less", ".html", ".htm", ".xml", ".svg", ".sql", ".sh", ".bash", ".zsh", ".fish", ".ps1",
	".csv", ".tsv", ".gitignore", ".dockerignore", ".editorconfig",
]);
const TEXT_BASENAMES = new Set(["Dockerfile", "Makefile", "README", "LICENSE", "CHANGELOG", "CLAUDE", "AGENTS"]);
const RESET = "\x1b[0m";
const BG = "\x1b[48;2;0;0;0m";
const FG = "\x1b[38;2;255;255;255m";
const BOLD = "\x1b[1m";
const CONTENT_PAD = 2;
const MODAL_OVERLAY_OPTIONS = { anchor: "center" as const, offsetY: 0, width: "90%", maxHeight: "80%" };

function padAnsi(s: string, width: number): string {
	const v = visibleWidth(s);
	return v >= width ? truncateToWidth(s, width) : s + " ".repeat(width - v);
}

function insetLine(s: string, width: number): string {
	const pad = " ".repeat(Math.min(CONTENT_PAD, Math.floor(width / 4)));
	const innerWidth = Math.max(1, width - visibleWidth(pad) * 2);
	return pad + padAnsi(truncateToWidth(s, innerWidth), innerWidth) + pad;
}

const overlayStyle = {
	line(s: string, width: number) { return BG + FG + insetLine(s, width) + RESET; },
	muted(s: string, width?: number) { return width ? BG + FG + insetLine(s, width) + RESET : BG + FG + s + RESET; },
	title(s: string, width?: number) { return width ? BG + BOLD + FG + insetLine(s, width) + RESET : `${BG}${BOLD}${FG}${s}${RESET}`; },
	border(width: number) { return BG + FG + "─".repeat(Math.max(1, width)) + RESET; },
};

function expandPath(input: string, cwd: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
	return resolve(cwd, trimmed);
}

function isTextFileName(path: string): boolean {
	const name = basename(path);
	if (TEXT_BASENAMES.has(name)) return true;
	if (name.startsWith(".env")) return true;
	const lower = name.toLowerCase();
	for (const ext of TEXT_EXTENSIONS) {
		if (lower === ext || lower.endsWith(ext)) return true;
	}
	return false;
}

function looksBinary(buf: Buffer): boolean {
	if (buf.includes(0)) return true;
	if (!buf.length) return false;
	let suspicious = 0;
	const sample = buf.subarray(0, Math.min(buf.length, 4096));
	for (const byte of sample) {
		if (byte === 9 || byte === 10 || byte === 13) continue;
		if (byte >= 32 && byte !== 127) continue;
		suspicious++;
	}
	return suspicious / sample.length > 0.08;
}

async function listTextFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string) {
		let entries: any[];
		try { entries = await readdir(dir, { withFileTypes: true }); }
		catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIRS.has(entry.name)) await walk(resolve(dir, entry.name));
			} else if (entry.isFile()) {
				const full = resolve(dir, entry.name);
				if (isTextFileName(full)) out.push(full);
			}
		}
	}
	await walk(root);
	return out;
}

async function pickTextFile(ctx: ExtensionContext): Promise<string | undefined> {
	const files = await listTextFiles(ctx.cwd);
	if (!files.length) {
		if (ctx.hasUI) ctx.ui.notify("No text files found below current folder", "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Read file"))));
		container.addChild(new Text(theme.fg("dim", "Select a text file")));
		const items: SelectItem[] = files.map((file) => ({
			value: file,
			label: relative(ctx.cwd, file),
			description: file,
		}));
		const list = new SelectList(items, Math.min(16, Math.max(5, items.length)), {
			selectedPrefix: (s) => theme.fg("accent", s),
			selectedText: (s) => theme.fg("accent", s),
			description: (s) => theme.fg("muted", s),
			scrollInfo: (s) => theme.fg("dim", s),
			noMatch: (s) => theme.fg("warning", s),
		});
		list.onSelect = (item) => done(String(item.value));
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to filter • enter open • esc close")));
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
		};
	});
}

function splitLines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

const ANSI_WHITE = "\x1b[38;2;255;255;255m";
const ANSI_COMMENT = "\x1b[38;2;128;128;128m";
const ANSI_STRING = "\x1b[38;2;152;195;121m";
const ANSI_KEYWORD = "\x1b[38;2;198;120;221m";
const ANSI_NUMBER = "\x1b[38;2;209;154;102m";
const ANSI_FUNCTION = "\x1b[38;2;97;175;239m";
const ANSI_TYPE = "\x1b[38;2;86;182;194m";

function color(s: string, ansi: string): string {
	return `${ansi}${s}${ANSI_WHITE}`;
}

function extnameLower(path: string): string {
	const name = basename(path).toLowerCase();
	const idx = name.lastIndexOf(".");
	return idx >= 0 ? name.slice(idx) : name;
}

function highlightCommon(code: string): string {
	return code
		.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => color(m, ANSI_STRING))
		.replace(/\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g, (m) => color(m, ANSI_NUMBER))
		.replace(/\b(function|const|let|var|return|if|else|for|while|switch|case|break|continue|class|extends|new|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|interface|type|enum|public|private|protected|static|readonly|def|lambda|yield|with|as|pass|raise|self|True|False|None|true|false|null|undefined)\b/g, (m) => color(m, ANSI_KEYWORD))
		.replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, (m) => color(m, ANSI_FUNCTION));
}

function highlightJsonYaml(line: string): string {
	return line
		.replace(/("(?:\\.|[^"])*")\s*:/g, (_m, key) => `${color(key, ANSI_TYPE)}:`)
		.replace(/:\s*("(?:\\.|[^"])*")/g, (_m, value) => `: ${color(value, ANSI_STRING)}`)
		.replace(/\b(true|false|null|yes|no)\b/gi, (m) => color(m, ANSI_KEYWORD))
		.replace(/\b-?\d+(?:\.\d+)?\b/g, (m) => color(m, ANSI_NUMBER));
}

function highlightMarkup(line: string): string {
	if (/^\s*<!--/.test(line)) return color(line, ANSI_COMMENT);
	return line
		.replace(/<!--.*?-->/g, (m) => color(m, ANSI_COMMENT))
		.replace(/(<\/?[A-Za-z][^\s>/]*)/g, (m) => color(m, ANSI_TYPE))
		.replace(/\b([A-Za-z_:][-A-Za-z0-9_:.]*)(=)/g, (_m, attr, eq) => `${color(attr, ANSI_FUNCTION)}${eq}`)
		.replace(/(["'])(.*?)\1/g, (m) => color(m, ANSI_STRING));
}

function highlightTextLine(path: string, line: string): string {
	const ext = extnameLower(path);
	const trimmed = line.trimStart();
	if (!trimmed) return line;
	if (/^(\/\/|\/\*|\*|#|--)/.test(trimmed) && !/^#\!/.test(trimmed)) return color(line, ANSI_COMMENT);
	if ([".json", ".jsonl", ".yaml", ".yml", ".toml"].includes(ext)) return highlightJsonYaml(line);
	if ([".html", ".htm", ".xml", ".svg", ".jsx", ".tsx"].includes(ext)) return highlightMarkup(highlightCommon(line));
	if ([".md", ".mdx", ".markdown"].includes(ext)) {
		if (/^#{1,6}\s+/.test(line)) return color(line, ANSI_TYPE);
		if (/^\s*[-*+]\s+/.test(line)) return line.replace(/^\s*([-*+])/, color("$1", ANSI_FUNCTION));
		return line;
	}
	const commentMatch = line.match(/(^|\s)(\/\/|#|--).*/);
	if (commentMatch?.index !== undefined && commentMatch.index > 0) {
		const before = line.slice(0, commentMatch.index);
		const after = line.slice(commentMatch.index);
		return highlightCommon(before) + color(after, ANSI_COMMENT);
	}
	return highlightCommon(line);
}

async function readTextFile(path: string): Promise<{ path: string; text: string; truncated: boolean }> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`Not a file: ${path}`);
	const buf = await readFile(path);
	if (!isTextFileName(path) && looksBinary(buf)) throw new Error(`Looks like a binary file: ${path}`);
	const truncated = buf.byteLength > MAX_FILE_BYTES;
	const text = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
	return { path, text, truncated };
}

async function showTextFile(ctx: ExtensionContext, file: string) {
	const doc = await readTextFile(file);
	const lines = splitLines(doc.text);
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let top = 0;
		function pageSize() {
			const terminalHeight = Math.floor((tui as any).height ?? 22);
			const chromeRows = 4 + (doc.truncated ? 1 : 0);
			return Math.max(8, Math.floor(terminalHeight * 0.8) - chromeRows);
		}
		function clamp() { top = Math.max(0, Math.min(top, Math.max(0, lines.length - pageSize()))); }
		return {
			render: (width: number) => {
				clamp();
				const bodyWidth = Math.max(20, width - 2);
				const rendered: string[] = [];
				rendered.push(overlayStyle.border(bodyWidth));
				rendered.push(overlayStyle.title(`${basename(doc.path)}  ${relative(ctx.cwd, doc.path)}`, bodyWidth));
				if (doc.truncated) rendered.push(overlayStyle.muted(`truncated at ${Math.round(MAX_FILE_BYTES / 1024)}KB`, bodyWidth));
				const size = pageSize();
				const visible = lines.slice(top, top + size);
				for (const line of visible) {
					rendered.push(overlayStyle.line(truncateToWidth(highlightTextLine(doc.path, line || " "), bodyWidth), bodyWidth));
				}
				for (let i = visible.length; i < size; i++) rendered.push(overlayStyle.line("", bodyWidth));
				rendered.push(overlayStyle.muted(`${top + 1}-${Math.min(lines.length, top + size)} / ${lines.length}  ↑↓ scroll • pageUp/pageDown • esc close`, bodyWidth));
				rendered.push(overlayStyle.border(bodyWidth));
				return rendered;
			},
			invalidate: () => {},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(undefined);
				if (matchesKey(data, Key.up)) top -= 1;
				else if (matchesKey(data, Key.down)) top += 1;
				else if (matchesKey(data, Key.pageUp)) top -= pageSize();
				else if (matchesKey(data, Key.pageDown)) top += pageSize();
				else if (matchesKey(data, Key.home)) top = 0;
				else if (matchesKey(data, Key.end)) top = lines.length;
				clamp();
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: MODAL_OVERLAY_OPTIONS });
}

async function openRead(ctx: ExtensionContext, args = "") {
	if (!ctx.hasUI) return;
	const target = args.trim() ? expandPath(args, ctx.cwd) : await pickTextFile(ctx);
	if (!target) return;
	await showTextFile(ctx, target);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("read", {
		description: "Read a text file in a modal viewer. Usage: /read [path]",
		handler: async (args, ctx) => {
			try { await openRead(ctx, args); }
			catch (err: any) { if (ctx.hasUI) ctx.ui.notify(`read failed: ${err?.message ?? err}`, "error"); }
		},
	});

	pi.registerShortcut("ctrl+shift+k", {
		description: "Open text-file reader",
		handler: async (ctx) => {
			try { await openRead(ctx); }
			catch (err: any) { if (ctx.hasUI) ctx.ui.notify(`read failed: ${err?.message ?? err}`, "error"); }
		},
	});
}
