import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { TOUCHLOG_DIR } from "./config.ts";
import { scryerSessionKey } from "./state.ts";

export type TouchLogEntry = {
	sessionKey: string;
	repoRoot: string;
	repoName: string;
	hash: string;
	subject: string;
	timestamp: number;
};

export function touchlogPath(ctx: ExtensionContext): string {
	return join(TOUCHLOG_DIR, `${scryerSessionKey(ctx)}.touchlog`);
}

export async function readTouchlog(ctx: ExtensionContext): Promise<TouchLogEntry[]> {
	try {
		const raw = await readFile(touchlogPath(ctx), "utf8");
		return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TouchLogEntry);
	} catch {
		return [];
	}
}

export async function readLastTouchlogEntry(ctx: ExtensionContext): Promise<TouchLogEntry | undefined> {
	const entries = await readTouchlog(ctx);
	return entries.sort((a, b) => b.timestamp - a.timestamp)[0];
}

export async function appendTouchlogEntry(ctx: ExtensionContext, entry: Omit<TouchLogEntry, "sessionKey" | "repoName">) {
	await mkdir(TOUCHLOG_DIR, { recursive: true });
	const rows = await readTouchlog(ctx);
	if (rows.some((row) => row.hash === entry.hash && row.repoRoot === entry.repoRoot)) return;
	const full: TouchLogEntry = {
		...entry,
		sessionKey: scryerSessionKey(ctx),
		repoName: basename(entry.repoRoot),
	};
	await appendFile(touchlogPath(ctx), JSON.stringify(full) + "\n");
}
