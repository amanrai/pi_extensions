import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { PM_URL, DAILIES_SLUG } from "./config.ts";
import type { RecorderState } from "./types.ts";

export async function api(path: string, init?: RequestInit): Promise<any> {
	const res = await fetch(`${PM_URL}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`PM API ${res.status}: ${text}`);
	return text ? JSON.parse(text) : undefined;
}

export async function pmReachable(): Promise<boolean> {
	try {
		await api("/healthz");
		return true;
	} catch {
		return false;
	}
}

function runScryerUp(): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("scryer", ["up", "--no-open"], (error) => error ? reject(error) : resolve());
	});
}

export async function ensurePmReachable(
	ctx: ExtensionContext,
	state: RecorderState | undefined,
	saveState: (state?: RecorderState) => Promise<void>,
): Promise<boolean> {
	if (await pmReachable()) return true;
	if (!state) return false;
	const now = Date.now();
	if ((state.lastPmPromptAt ?? 0) + 60 * 60 * 1000 > now) return false;
	state.lastPmPromptAt = now;
	await saveState(state);
	if (!ctx.hasUI) return false;
	const ok = await ctx.ui.confirm("PM system is not reachable", "Start Scryer with `scryer up --no-open`?");
	if (!ok) return false;
	try {
		await runScryerUp();
		return await pmReachable();
	} catch (err: any) {
		ctx.ui.notify(`Could not start Scryer: ${err?.message ?? err}`, "warning");
		return false;
	}
}

export async function findDailiesProject(): Promise<any> {
	const projects = await api("/api/projects");
	const found = projects.find((p: any) => p.slug === DAILIES_SLUG || String(p.name).toLowerCase() === DAILIES_SLUG);
	if (!found) throw new Error(`Dailies project not found: ${DAILIES_SLUG}`);
	return found;
}

export async function findWorkTaskType(projectId: string): Promise<string> {
	const types = await api(`/api/task-types?project_id=${encodeURIComponent(projectId)}`);
	return (types.find((t: any) => t.key === "work") ?? types[0]).id;
}

export async function getTicket(ticketId: string): Promise<any | undefined> {
	try {
		return await api(`/api/tasks/${ticketId}`);
	} catch (err: any) {
		if (String(err?.message ?? err).includes("404")) return undefined;
		throw err;
	}
}
