import { complete } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const PM_URL = process.env.SCRYER_PM_URL ?? "http://127.0.0.1:43210";
const DAILIES_SLUG = process.env.SCRYER_DAILIES_SLUG ?? "dailies";
const OUTPUT_TOKEN_THRESHOLD = Number(process.env.SCRYER_RECORDER_OUTPUT_TOKEN_THRESHOLD ?? 50_000);
const IDLE_MS = Number(process.env.SCRYER_RECORDER_IDLE_MS ?? 10 * 60 * 1000);
const NEW_DAILY_HOURS = Number(process.env.SCRYER_RECORDER_NEW_DAILY_HOURS ?? 3);
const RECORDER_DIR = join(homedir(), ".pi", "agent", "scryer-recorder");
const STATE_DIR = join(RECORDER_DIR, "state");
const OUTBOX_DIR = join(RECORDER_DIR, "outbox");

type RecorderState = {
	sessionKey: string;
	sessionName: string;
	cwd: string;
	cwdTag: string;
	currentDate?: string;
	ticketId?: string;
	lastSummaryAt?: number;
	lastActivityAt?: number;
	lastPmPromptAt?: number;
	outputTokensSinceSummary: number;
	summary: string;
	finalized?: boolean;
};

type ToolEvent = {
	name: string;
	input?: unknown;
	ok?: boolean;
	error?: string;
};

let state: RecorderState | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let activeCtx: ExtensionContext | undefined;
let recentTools: ToolEvent[] = [];
let recentUserPrompts: string[] = [];

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function displayPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function sessionKey(ctx: ExtensionContext): string {
	const file = ctx.sessionManager.getSessionFile?.();
	if (file) return createHash("sha1").update(file).digest("hex");
	return createHash("sha1").update(`${ctx.cwd}:${Date.now()}`).digest("hex");
}

function sessionName(ctx: ExtensionContext): string {
	const file = ctx.sessionManager.getSessionFile?.();
	if (file) return basename(file).replace(/\.[^.]+$/, "");
	return basename(ctx.cwd || process.cwd()) || "pi-session";
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJson(path: string, value: unknown) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2));
}

function statePath(key: string): string {
	return join(STATE_DIR, `${key}.json`);
}

async function loadState(ctx: ExtensionContext): Promise<RecorderState> {
	const key = sessionKey(ctx);
	const existing = await readJson<RecorderState>(statePath(key));
	if (existing) return existing;
	const cwd = ctx.cwd || process.cwd();
	return {
		sessionKey: key,
		sessionName: sessionName(ctx),
		cwd,
		cwdTag: `cwd:${displayPath(cwd)}`,
		outputTokensSinceSummary: 0,
		summary: "",
	};
}

async function saveState() {
	if (!state) return;
	await mkdir(STATE_DIR, { recursive: true });
	await writeFile(statePath(state.sessionKey), JSON.stringify(state, null, 2));
}

async function api(path: string, init?: RequestInit): Promise<any> {
	const res = await fetch(`${PM_URL}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`PM API ${res.status}: ${text}`);
	return text ? JSON.parse(text) : undefined;
}

async function pmReachable(): Promise<boolean> {
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

async function ensurePm(ctx: ExtensionContext): Promise<boolean> {
	if (await pmReachable()) return true;
	if (!state) return false;
	const now = Date.now();
	if ((state.lastPmPromptAt ?? 0) + 60 * 60 * 1000 > now) return false;
	state.lastPmPromptAt = now;
	await saveState();
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

async function findDailiesProject(): Promise<any> {
	const projects = await api("/api/projects");
	const found = projects.find((p: any) => p.slug === DAILIES_SLUG || String(p.name).toLowerCase() === DAILIES_SLUG);
	if (!found) throw new Error(`Dailies project not found: ${DAILIES_SLUG}`);
	return found;
}

async function findWorkTaskType(projectId: string): Promise<string> {
	const types = await api(`/api/task-types?project_id=${encodeURIComponent(projectId)}`);
	return (types.find((t: any) => t.key === "work") ?? types[0]).id;
}

async function ensureTicket(finalizePrevious = true): Promise<string> {
	if (!state) throw new Error("recorder state missing");
	const nowDate = today();
	const now = Date.now();
	const dateChanged = state.currentDate && state.currentDate !== nowDate;
	const staleEnough = !state.lastActivityAt || now - state.lastActivityAt >= NEW_DAILY_HOURS * 60 * 60 * 1000;
	if (state.ticketId && (!dateChanged || !staleEnough)) return state.ticketId;
	if (state.ticketId && finalizePrevious) {
		await api(`/api/tasks/${state.ticketId}`, {
			method: "PATCH",
			body: JSON.stringify({ status: "human_reviewed_and_closed" }),
		});
	}
	const project = await findDailiesProject();
	const taskTypeId = await findWorkTaskType(project.id);
	const task = await api("/api/tasks", {
		method: "POST",
		body: JSON.stringify({
			title: `Pi Daily — ${nowDate} — ${state.sessionName}`,
			project_id: project.id,
			task_type_id: taskTypeId,
			status: "in_execution",
			description_md: state.summary || "# Pi Daily\n\nSummary pending.",
			tag_names: [state.cwdTag],
			created_by_role: "pi",
			created_by_instance_key: "scryer-recorder",
		}),
	});
	state.ticketId = task.id;
	state.currentDate = nowDate;
	state.finalized = false;
	await saveState();
	return task.id;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => part?.text ?? "").filter(Boolean).join("\n");
}

function buildConversationText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	const sections: string[] = [];
	for (const entry of entries.slice(-80) as any[]) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		if (!["user", "assistant", "toolResult"].includes(entry.message.role)) continue;
		const text = contentText(entry.message.content).trim();
		if (text) sections.push(`${entry.message.role.toUpperCase()}:\n${text}`);
	}
	return sections.join("\n\n");
}

function summaryPrompt(ctx: ExtensionContext, reason: string, endSession: boolean): string {
	const toolLines = recentTools.slice(-40).map((t) => `- ${t.name}: ${t.ok === false ? "failed" : "used"}${t.error ? ` (${t.error})` : ""}`);
	return [
		"Update the rolling work summary for this Pi coding session.",
		"Be concise but include narrative plus tool details, files touched, commands run, decisions, current state, and next steps.",
		endSession ? "This is an end-of-session summary. Capture final state clearly." : "This is a rolling summary update.",
		`Reason: ${reason}`,
		`CWD: ${state?.cwd ?? ctx.cwd}`,
		"",
		"Existing summary:",
		state?.summary || "(none)",
		"",
		"Recent user prompts:",
		...recentUserPrompts.slice(-12).map((p) => `- ${p.replace(/\s+/g, " ").slice(0, 300)}`),
		"",
		"Recent tool activity:",
		...(toolLines.length ? toolLines : ["- none recorded"]),
		"",
		"Recent conversation:",
		buildConversationText(ctx),
	].join("\n");
}

async function generateSummary(ctx: ExtensionContext, reason: string, endSession: boolean): Promise<string> {
	if (!ctx.model) throw new Error("No active model");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
	const response = await complete(
		ctx.model,
		{ messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt(ctx, reason, endSession) }], timestamp: Date.now() }] },
		{ apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "medium" },
	);
	return response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
}

async function writeOutbox(reason: string, summary: string, endSession: boolean) {
	await mkdir(OUTBOX_DIR, { recursive: true });
	const file = join(OUTBOX_DIR, `${Date.now()}-${reason}.json`);
	await writeFile(file, JSON.stringify({ reason, endSession, state, summary, pmUrl: PM_URL }, null, 2));
}

async function summarizeAndPersist(reason: string, ctx: ExtensionContext, endSession = false) {
	activeCtx = ctx;
	state ??= await loadState(ctx);
	const summary = await generateSummary(ctx, reason, endSession);

	if (await ensurePm(ctx)) {
		const ticketId = await ensureTicket(!endSession);
		await api(`/api/tasks/${ticketId}`, {
			method: "PATCH",
			body: JSON.stringify({
				description_md: summary,
				status: endSession ? "human_reviewed_and_closed" : "in_execution",
				tag_names: [state.cwdTag],
			}),
		});
		if (endSession) state.finalized = true;
	} else {
		await writeOutbox(reason, summary, endSession);
	}
	state.summary = summary;
	state.lastSummaryAt = Date.now();
	state.lastActivityAt = Date.now();
	state.outputTokensSinceSummary = 0;
	await saveState();
	if (ctx.hasUI) ctx.ui.notify(`Scryer recorder saved summary (${reason})`, "info");
}

function scheduleIdle(ctx: ExtensionContext) {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		if (activeCtx) summarizeAndPersist("idle", activeCtx, true).catch(() => undefined);
	}, IDLE_MS);
}

function outputTokens(message: AssistantMessage): number {
	const usage: any = message.usage ?? {};
	return Number(usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		state = await loadState(ctx);
		state.lastActivityAt = Date.now();
		await saveState();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		activeCtx = ctx;
		state ??= await loadState(ctx);
		state.lastActivityAt = Date.now();
		recentUserPrompts.push(event.prompt ?? "");
		if (recentUserPrompts.length > 30) recentUserPrompts = recentUserPrompts.slice(-30);
		if (idleTimer) clearTimeout(idleTimer);
		await saveState();
	});

	pi.on("tool_call", async (event) => {
		recentTools.push({ name: event.toolName, input: event.input });
		if (recentTools.length > 100) recentTools = recentTools.slice(-100);
	});

	pi.on("tool_result", async (event: any) => {
		const last = [...recentTools].reverse().find((t) => t.name === event.toolName && t.ok === undefined);
		if (last) {
			last.ok = !event.result?.isError;
			last.error = event.result?.isError ? contentText(event.result?.content).slice(0, 200) : undefined;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		state ??= await loadState(ctx);
		state.outputTokensSinceSummary += outputTokens(event.message as AssistantMessage);
		state.lastActivityAt = Date.now();
		await saveState();
		if (state.outputTokensSinceSummary >= OUTPUT_TOKEN_THRESHOLD) {
			await summarizeAndPersist("output-token-threshold", ctx, false);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeCtx = ctx;
		state ??= await loadState(ctx);
		state.lastActivityAt = Date.now();
		await saveState();
		scheduleIdle(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (idleTimer) clearTimeout(idleTimer);
		await saveState();
	});

	pi.registerCommand("save", {
		description: "Save a Scryer recorder summary to the Dailies PM ticket",
		handler: async (_args, ctx) => {
			try {
				await summarizeAndPersist("manual-save", ctx, false);
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Scryer recorder save failed: ${err?.message ?? err}`, "error");
			}
		},
	});
}
