import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import { readdir, readFile, stat } from "node:fs/promises";
import { overlayStyle } from "./overlay-style.ts";
import { homedir } from "node:os";
import { basename, relative, resolve } from "node:path";

const MAX_FILE_BYTES = Number(process.env.READ_MD_MAX_BYTES ?? 512_000);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", "vendor"]);

function expandPath(input: string, cwd: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
	return resolve(cwd, trimmed);
}

function isMarkdown(path: string): boolean {
	return /\.(md|mdx|markdown)$/i.test(path);
}

async function listMarkdownFiles(root: string): Promise<string[]> {
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
				if (isMarkdown(full)) out.push(full);
			}
		}
	}
	await walk(root);
	return out;
}

async function pickMarkdownFile(ctx: ExtensionContext): Promise<string | undefined> {
	const files = await listMarkdownFiles(ctx.cwd);
	if (!files.length) {
		if (ctx.hasUI) ctx.ui.notify("No Markdown files found below current folder", "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Read Markdown"))));
		container.addChild(new Text(theme.fg("dim", "Select a Markdown file")));
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

async function readMarkdown(path: string): Promise<{ path: string; text: string; truncated: boolean }> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`Not a file: ${path}`);
	if (!isMarkdown(path)) throw new Error(`Not a Markdown file: ${path}`);
	const buf = await readFile(path);
	const truncated = buf.byteLength > MAX_FILE_BYTES;
	const text = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
	return { path, text, truncated };
}

function renderMarkdownLine(line: string, theme: any): string {
	if (/^#{1,6}\s+/.test(line)) return theme.fg("accent", theme.bold(line));
	if (/^\s*```/.test(line)) return theme.fg("muted", line);
	if (/^\s{4,}/.test(line)) return theme.fg("muted", line);
	if (/^\s*[-*+]\s+/.test(line)) return line.replace(/^\s*([-*+])/, theme.fg("accent", "$1"));
	return line;
}

async function showMarkdown(ctx: ExtensionContext, file: string) {
	const doc = await readMarkdown(file);
	const lines = splitLines(doc.text);
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let top = 0;
		function pageSize() { return Math.max(8, Math.min(28, Math.floor((tui as any).height ?? 22) - 6)); }
		function clamp() { top = Math.max(0, Math.min(top, Math.max(0, lines.length - pageSize()))); }
		return {
			render: (width: number) => {
				clamp();
				const bodyWidth = Math.max(20, width - 2);
				const c = new Container();
				c.addChild(new Text(overlayStyle.border(bodyWidth)));
				c.addChild(new Text(overlayStyle.title(`${basename(doc.path)}  ${relative(ctx.cwd, doc.path)}`, bodyWidth)));
				if (doc.truncated) c.addChild(new Text(overlayStyle.muted(`truncated at ${Math.round(MAX_FILE_BYTES / 1024)}KB`, bodyWidth)));
				const size = pageSize();
				const visible = lines.slice(top, top + size);
				for (const line of visible) {
					c.addChild(new Text(overlayStyle.line(truncateToWidth(renderMarkdownLine(line || " ", theme), bodyWidth), bodyWidth)));
				}
				for (let i = visible.length; i < size; i++) c.addChild(new Text(overlayStyle.line("", bodyWidth)));
				c.addChild(new Text(overlayStyle.muted(`${top + 1}-${Math.min(lines.length, top + size)} / ${lines.length}  ↑↓ scroll • pageUp/pageDown • esc close`, bodyWidth)));
				c.addChild(new Text(overlayStyle.border(bodyWidth)));
				return c.render(width);
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
	}, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } });
}

async function openReadMd(ctx: ExtensionContext, args = "") {
	if (!ctx.hasUI) return;
	const target = args.trim() ? expandPath(args, ctx.cwd) : await pickMarkdownFile(ctx);
	if (!target) return;
	await showMarkdown(ctx, target);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("read", {
		description: "Read a Markdown file in a modal viewer. Usage: /read [path]",
		handler: async (args, ctx) => {
			try { await openReadMd(ctx, args); }
			catch (err: any) { if (ctx.hasUI) ctx.ui.notify(`read failed: ${err?.message ?? err}`, "error"); }
		},
	});

	pi.registerShortcut("ctrl+k", {
		description: "Open Markdown reader",
		handler: async (ctx) => {
			try { await openReadMd(ctx); }
			catch (err: any) { if (ctx.hasUI) ctx.ui.notify(`read failed: ${err?.message ?? err}`, "error"); }
		},
	});
}
