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
const SUMMARIES_DIR = join(RECORDER_DIR, "summaries");

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
	activeProjectId?: string;
	activeProjectName?: string;
	activeTaskId?: string;
	activeTaskTitle?: string;
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
let activePi: ExtensionAPI | undefined;
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

async function writeJson(path: string, value: unknown) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2));
}

function statePath(key: string): string {
	return join(STATE_DIR, `${key}.json`);
}

async function loadState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RecorderState> {
	const key = sessionKey(ctx);
	const name = sessionName(pi, ctx);
	const existing = await readJson<RecorderState>(statePath(key));
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

async function pickActiveProject(ctx: ExtensionContext): Promise<boolean> {
	if (!state || !ctx.hasUI) return false;
	const projects = await api("/api/projects");
	const visible = projects.filter((p: any) => p.slug !== DAILIES_SLUG && !String(p.name).startsWith("~"));
	const labels = ["No active project / greenfield", ...visible.map((p: any) => `${p.name} (${p.slug})`)];
	const projectChoice = await ctx.ui.select("Which project does this Pi session apply to?", labels);
	if (!projectChoice || projectChoice === labels[0]) return false;
	const project = visible[labels.indexOf(projectChoice) - 1];
	if (!project) return false;
	state.activeProjectId = project.id;
	state.activeProjectName = project.name;
	state.activeTaskId = undefined;
	state.activeTaskTitle = undefined;
	await saveState();
	ctx.ui.notify(`Scryer recorder project: ${project.name}`, "info");
	return true;
}

async function pickActiveTicket(ctx: ExtensionContext): Promise<boolean> {
	if (!state || !ctx.hasUI) return false;
	if (!state.activeProjectId) {
		ctx.ui.notify("Pick a project first with /pp or /pick-project", "warning");
		return false;
	}
	const tasks = await api(`/api/tasks?project_id=${encodeURIComponent(state.activeProjectId)}`);
	const taskLabels = ["Create a new ticket", ...tasks.map((t: any) => `${t.title} [${t.status}]`)];
	const taskChoice = await ctx.ui.select(`Which ticket in ${state.activeProjectName ?? "project"}?`, taskLabels);
	if (!taskChoice) return false;
	if (taskChoice === taskLabels[0]) {
		const title = await ctx.ui.input("New ticket title", `Pi work — ${state.sessionName}`);
		if (!title) return false;
		const taskTypeId = await findWorkTaskType(state.activeProjectId);
		const task = await api("/api/tasks", {
			method: "POST",
			body: JSON.stringify({
				title,
				project_id: state.activeProjectId,
				task_type_id: taskTypeId,
				status: "in_execution",
				description_md: "# Pi work\n\nRecorder summary pending.",
				tag_names: [state.cwdTag],
				created_by_role: "pi",
				created_by_instance_key: "scryer-recorder",
			}),
		});
		state.activeTaskId = task.id;
		state.activeTaskTitle = task.title;
	} else {
		const task = tasks[taskLabels.indexOf(taskChoice) - 1];
		if (!task) return false;
		state.activeTaskId = task.id;
		state.activeTaskTitle = task.title;
	}
	await saveState();
	ctx.ui.notify(`Scryer recorder ticket: ${state.activeTaskTitle}`, "info");
	return true;
}

async function chooseActiveProjectAndTask(ctx: ExtensionContext) {
	if (!state || state.activeProjectId || !ctx.hasUI) return;
	if (await pickActiveProject(ctx)) await pickActiveTicket(ctx);
}

async function ticketExists(ticketId: string): Promise<boolean> {
	try {
		await api(`/api/tasks/${ticketId}`);
		return true;
	} catch (err: any) {
		if (String(err?.message ?? err).includes("404")) return false;
		throw err;
	}
}

async function ensureTicket(finalizePrevious = true): Promise<string> {
	if (!state) throw new Error("recorder state missing");
	const nowDate = today();
	const now = Date.now();
	const dateChanged = state.currentDate && state.currentDate !== nowDate;
	const staleEnough = !state.lastActivityAt || now - state.lastActivityAt >= NEW_DAILY_HOURS * 60 * 60 * 1000;
	if (state.ticketId && (!dateChanged || !staleEnough)) {
		if (await ticketExists(state.ticketId)) return state.ticketId;
		state.ticketId = undefined;
		state.currentDate = undefined;
	}
	if (state.ticketId && finalizePrevious) {
		try {
			await api(`/api/tasks/${state.ticketId}`, {
				method: "PATCH",
				body: JSON.stringify({ status: "human_reviewed_and_closed" }),
			});
		} catch (err: any) {
			if (!String(err?.message ?? err).includes("404")) throw err;
		}
	}
	const project = await findDailiesProject();
	const taskTypeId = await findWorkTaskType(project.id);
	const title = `Pi Daily — ${nowDate} — ${state.sessionName}`;
	const task = await api("/api/tasks", {
		method: "POST",
		body: JSON.stringify({
			title,
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

async function writeLocalSummary(reason: string, summary: string, endSession: boolean) {
	await mkdir(SUMMARIES_DIR, { recursive: true });
	const safeSession = (state?.sessionName ?? "session").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
	const file = join(SUMMARIES_DIR, `${today()}-${safeSession}.md`);
	await writeFile(file, [
		`# ${state?.sessionName ?? "Pi session"}`,
		"",
		`- Reason: ${reason}`,
		`- End session: ${endSession ? "yes" : "no"}`,
		`- Ticket: ${state?.ticketId ?? "none"}`,
		`- CWD: ${state?.cwd ?? "unknown"}`,
		"",
		summary,
	].join("\n"));
}

async function patchTicket(ticketId: string, summary: string, endSession: boolean) {
	if (!state) throw new Error("recorder state missing");
	return api(`/api/tasks/${ticketId}`, {
		method: "PATCH",
		body: JSON.stringify({
			title: `Pi Daily — ${state.currentDate ?? today()} — ${state.sessionName}`,
			description_md: summary,
			status: endSession ? "human_reviewed_and_closed" : "in_execution",
			tag_names: [state.cwdTag],
		}),
	});
}

async function patchActiveTask(summary: string) {
	if (!state?.activeTaskId) return;
	try {
		await api(`/api/tasks/${state.activeTaskId}`, {
			method: "PATCH",
			body: JSON.stringify({
				description_md: summary,
				status: "in_execution",
				tag_names: [state.cwdTag],
			}),
		});
	} catch (err: any) {
		if (!String(err?.message ?? err).includes("404")) throw err;
		state.activeTaskId = undefined;
		state.activeTaskTitle = undefined;
	}
}

async function commentOnActiveTask(summary: string) {
	if (!state?.activeTaskId) return;
	try {
		await api("/api/comments", {
			method: "POST",
			body: JSON.stringify({
				task_id: state.activeTaskId,
				author_role: "pi",
				author_instance_key: "scryer-recorder",
				body_md: summary,
				body_format: "markdown",
			}),
		});
	} catch (err: any) {
		if (!String(err?.message ?? err).includes("404")) throw err;
		state.activeTaskId = undefined;
		state.activeTaskTitle = undefined;
	}
}

async function ensureActiveTicketSelected(ctx: ExtensionContext): Promise<boolean> {
	if (!state) return false;
	if (!state.activeProjectId) {
		if (ctx.hasUI) ctx.ui.notify("Pick a project and ticket first with /pp then /pt", "warning");
		return false;
	}
	if (!state.activeTaskId) {
		if (ctx.hasUI) ctx.ui.notify("Pick a ticket first with /pt or /pick-ticket", "warning");
		return false;
	}
	return true;
}

async function updateActiveTaskDescription(ctx: ExtensionContext) {
	if (!state || !(await ensureActiveTicketSelected(ctx))) return;
	setRecorderProgress(ctx, "summarizing for active ticket description…");
	const summary = await generateSummary(ctx, "update-ticket", false);
	await writeLocalSummary("update-ticket", summary, false);
	setRecorderProgress(ctx, "updating active ticket description…");
	await patchActiveTask(summary);
	state.summary = summary;
	state.lastSummaryAt = Date.now();
	await saveState();
	if (ctx.hasUI) ctx.ui.notify(`Updated ticket: ${state.activeTaskTitle}`, "info");
}

async function addActiveTaskComment(ctx: ExtensionContext) {
	if (!state || !(await ensureActiveTicketSelected(ctx))) return;
	setRecorderProgress(ctx, "summarizing for active ticket comment…");
	const summary = await generateSummary(ctx, "add-comments", false);
	await writeLocalSummary("add-comments", summary, false);
	setRecorderProgress(ctx, "adding active ticket comment…");
	await commentOnActiveTask(summary);
	state.summary = summary;
	state.lastSummaryAt = Date.now();
	await saveState();
	if (ctx.hasUI) ctx.ui.notify(`Added comment to ticket: ${state.activeTaskTitle}`, "info");
}

function setRecorderProgress(ctx: ExtensionContext, line?: string) {
	if (!ctx.hasUI) return;
	if (!line) {
		ctx.ui.setStatus("scryer-recorder", undefined);
		ctx.ui.setWidget("scryer-recorder", undefined);
		return;
	}
	ctx.ui.setStatus("scryer-recorder", line);
	ctx.ui.setWidget("scryer-recorder", [`▸ Scryer recorder: ${line}`], { placement: "belowEditor" });
}

async function summarizeAndPersist(reason: string, ctx: ExtensionContext, endSession = false) {
	activeCtx = ctx;
	try {
		setRecorderProgress(ctx, `saving (${reason})…`);
		if (!activePi) throw new Error("recorder pi api missing");
		state ??= await loadState(activePi, ctx);

		setRecorderProgress(ctx, "summarizing with active model…");
		const summary = await generateSummary(ctx, reason, endSession);

		setRecorderProgress(ctx, "writing local summary…");
		await writeLocalSummary(reason, summary, endSession);

		setRecorderProgress(ctx, "checking PM system…");
		if (await ensurePm(ctx)) {
			await chooseActiveProjectAndTask(ctx);
			setRecorderProgress(ctx, "creating/updating Dailies ticket…");
			let ticketId = await ensureTicket(!endSession);
			try {
				await patchTicket(ticketId, summary, endSession);
			} catch (err: any) {
				if (!String(err?.message ?? err).includes("404")) throw err;
				setRecorderProgress(ctx, "ticket missing; creating a fresh one…");
				state.ticketId = undefined;
				state.currentDate = undefined;
				ticketId = await ensureTicket(false);
				await patchTicket(ticketId, summary, endSession);
			}
			if (state.activeTaskId) {
				setRecorderProgress(ctx, "updating active project ticket…");
				await patchActiveTask(summary);
			}
			if (endSession) state.finalized = true;
		} else {
			setRecorderProgress(ctx, "PM unavailable; writing outbox entry…");
			await writeOutbox(reason, summary, endSession);
		}
		state.summary = summary;
		state.lastSummaryAt = Date.now();
		state.lastActivityAt = Date.now();
		state.outputTokensSinceSummary = 0;
		await saveState();
		if (ctx.hasUI) ctx.ui.notify(`Scryer recorder saved summary (${reason})`, "info");
	} finally {
		setRecorderProgress(ctx, undefined);
	}
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
	activePi = pi;
	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		state = await loadState(pi, ctx);
		state.lastActivityAt = Date.now();
		await saveState();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		activeCtx = ctx;
		state ??= await loadState(pi, ctx);
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
		state ??= await loadState(pi, ctx);
		state.outputTokensSinceSummary += outputTokens(event.message as AssistantMessage);
		state.lastActivityAt = Date.now();
		await saveState();
		if (state.outputTokensSinceSummary >= OUTPUT_TOKEN_THRESHOLD) {
			await summarizeAndPersist("output-token-threshold", ctx, false);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeCtx = ctx;
		state ??= await loadState(pi, ctx);
		state.lastActivityAt = Date.now();
		await saveState();
		scheduleIdle(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (idleTimer) clearTimeout(idleTimer);
		await saveState();
	});

	const register = (name: string, description: string, handler: (ctx: ExtensionContext) => Promise<void>) => {
		pi.registerCommand(name, {
			description,
			handler: async (_args, ctx) => {
				try {
					activeCtx = ctx;
					state ??= await loadState(pi, ctx);
					if (!(await ensurePm(ctx))) return;
					await handler(ctx);
				} catch (err: any) {
					if (ctx.hasUI) ctx.ui.notify(`Scryer recorder ${name} failed: ${err?.message ?? err}`, "error");
				} finally {
					setRecorderProgress(ctx, undefined);
				}
			},
		});
	};

	register("pp", "Pick active PM project for Scryer recorder", async (ctx) => { await pickActiveProject(ctx); });
	register("pick-project", "Pick active PM project for Scryer recorder", async (ctx) => { await pickActiveProject(ctx); });
	register("pt", "Pick active PM ticket for Scryer recorder", async (ctx) => { await pickActiveTicket(ctx); });
	register("pick-ticket", "Pick active PM ticket for Scryer recorder", async (ctx) => { await pickActiveTicket(ctx); });
	register("ut", "Update selected ticket description from recorder summary", updateActiveTaskDescription);
	register("update-ticket", "Update selected ticket description from recorder summary", updateActiveTaskDescription);
	register("ac", "Add recorder summary as a comment on selected ticket", addActiveTaskComment);
	register("add-comments", "Add recorder summary as a comment on selected ticket", addActiveTaskComment);

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
