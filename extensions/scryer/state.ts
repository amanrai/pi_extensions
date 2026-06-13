import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { STATE_DIR } from "./config.ts";
import type { RecorderState } from "./types.ts";

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function displayPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function scryerSessionKey(ctx: ExtensionContext): string {
	const file = ctx.sessionManager.getSessionFile?.();
	if (file) return createHash("sha1").update(file).digest("hex");
	return createHash("sha1").update(`${ctx.cwd}:${Date.now()}`).digest("hex");
}

function isUglySessionName(name: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(name) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(name);
}

function generatedSessionName(ctx: ExtensionContext): string {
	const cwdName = basename(ctx.cwd || process.cwd()) || "pi-session";
	const stamp = new Date().toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	return `${cwdName} — ${stamp}`;
}

function sessionName(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const current = pi.getSessionName?.();
	if (current && !isUglySessionName(current)) return current;
	const generated = generatedSessionName(ctx);
	pi.setSessionName?.(generated);
	return generated;
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function getScryerStatePath(ctx: ExtensionContext): string {
	return join(STATE_DIR, `${scryerSessionKey(ctx)}.json`);
}

export async function readScryerState(ctx: ExtensionContext): Promise<RecorderState | undefined> {
	return readJson<RecorderState>(getScryerStatePath(ctx));
}

export async function loadState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RecorderState> {
	const key = scryerSessionKey(ctx);
	const name = sessionName(pi, ctx);
	const existing = await readJson<RecorderState>(getScryerStatePath(ctx));
	if (existing) {
		if (!existing.sessionName || isUglySessionName(existing.sessionName)) existing.sessionName = name;
		return existing;
	}
	const cwd = ctx.cwd || process.cwd();
	return {
		sessionKey: key,
		sessionName: name,
		cwd,
		cwdTag: `cwd:${displayPath(cwd)}`,
		outputTokensSinceSummary: 0,
		summary: "",
	};
}

export async function saveState(state?: RecorderState) {
	if (!state) return;
	await mkdir(STATE_DIR, { recursive: true });
	await writeFile(join(STATE_DIR, `${state.sessionKey}.json`), JSON.stringify(state, null, 2));
}
