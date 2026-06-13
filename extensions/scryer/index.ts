import { complete } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { DAILIES_SLUG, IDLE_MS, OUTPUT_TOKEN_THRESHOLD, OUTBOX_DIR, SAVE_COOLDOWN_MS, SUMMARIES_DIR, NEW_DAILY_HOURS, PM_URL } from "./config.ts";
import type { RecorderState, ToolEvent } from "./types.ts";
import { api, ensurePmReachable, findDailiesProject, findWorkTaskType, getTicket } from "./api.ts";
import { displayPath, loadState, saveState, today } from "./state.ts";
import { projectLabel, projectScore, repoContext } from "./repo.ts";
import { contentText, summaryPrompt, updateTicketPrompt } from "./prompts.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

let state: RecorderState | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let activeCtx: ExtensionContext | undefined;
let activePi: ExtensionAPI | undefined;
let recentTools: ToolEvent[] = [];
let recentUserPrompts: string[] = [];
let scryerBusy: { label: string; startedAt: number } | undefined;
let queuedInputs: Array<{ text: string; images?: any[] }> = [];
let deetsTimer: NodeJS.Timeout | undefined;
let foregroundStepUpdate: ((line: string) => void) | undefined;

async function pickActiveProject(ctx: ExtensionContext): Promise<boolean> {
	if (!state || !ctx.hasUI) return false;
	const projects = await api("/api/projects");
	const visible = projects.filter((p: any) => p.slug !== DAILIES_SLUG && !String(p.name).startsWith("~"));
	const repo = await repoContext(ctx);
	const scored = visible
		.map((project: any) => ({ project, score: projectScore(project, repo) }))
		.sort((a: any, b: any) => b.score - a.score || String(a.project.name).localeCompare(String(b.project.name)));
	const obvious = scored.filter((x: any) => x.score > 0).slice(0, 8);
	const other = scored.filter((x: any) => !obvious.some((o: any) => o.project.id === x.project.id));
	const obviousLabels = obvious.map((x: any) => projectLabel(x.project, x.score));
	const choices = [
		...obviousLabels,
		"Other project…",
		"Continue without a project for this session",
	];
	const title = repo.remote
		? `Project for ${displayPath(repo.root)} (${repo.remote})`
		: `Project for ${displayPath(repo.root)}`;
	let choice = await ctx.ui.select(title, choices);
	if (!choice) return false;
	let project: any | undefined;
	if (choice === "Continue without a project for this session") {
		state.activeProjectId = undefined;
		state.activeProjectName = undefined;
		state.activeTaskId = undefined;
		state.activeTaskTitle = undefined;
		state.noProjectForSession = true;
		state.noTicketForSession = true;
		await saveState(state);
		ctx.ui.notify("Scryer recorder: continuing without a project for this session", "info");
		return false;
	}
	if (choice === "Other project…") {
		const otherLabels = other.map((x: any) => projectLabel(x.project));
		choice = await ctx.ui.select("Other Scryer project", ["Cancel", ...otherLabels]);
		if (!choice || choice === "Cancel") return false;
		project = other[otherLabels.indexOf(choice)]?.project;
	} else {
		project = obvious[obviousLabels.indexOf(choice)]?.project;
	}
	if (!project) return false;
	state.activeProjectId = project.id;
	state.activeProjectName = project.name;
	state.activeTaskId = undefined;
	state.activeTaskTitle = undefined;
	state.noProjectForSession = false;
	state.noTicketForSession = false;
	await saveState(state);
	ctx.ui.notify(`Scryer recorder project: ${project.name}`, "info");
	return true;
}

function taskRank(task: any): number {
	const status = String(task.status ?? "");
	if (status === "in_execution") return 0;
	if (status === "unopened") return 1;
	if (status === "ready_for_human_review") return 2;
	if (status === "human_reviewed_and_closed") return 9;
	return 4;
}

async function pickActiveTicket(ctx: ExtensionContext): Promise<boolean> {
	if (!state || !ctx.hasUI) return false;
	if (!state.activeProjectId) {
		ctx.ui.notify("Pick a project first with /pp or /project-picker", "warning");
		return false;
	}
	const tasks = (await api(`/api/tasks?project_id=${encodeURIComponent(state.activeProjectId)}`))
		.sort((a: any, b: any) => taskRank(a) - taskRank(b) || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
	const openTasks = tasks.filter((t: any) => t.status !== "human_reviewed_and_closed");
	const closedTasks = tasks.filter((t: any) => t.status === "human_reviewed_and_closed");
	const shown = openTasks.slice(0, 30);
	const taskLabels = shown.map((t: any) => `${t.title} [${t.status}]`);
	const taskChoice = await ctx.ui.select(`Ticket in ${state.activeProjectName ?? "project"}?`, [
		"Create a new ticket",
		"Continue without a ticket for this session",
		...taskLabels,
		...(closedTasks.length ? ["Closed tickets…"] : []),
	]);
	if (!taskChoice) return false;
	if (taskChoice === "Continue without a ticket for this session") {
		state.activeTaskId = undefined;
		state.activeTaskTitle = undefined;
		state.noTicketForSession = true;
		await saveState(state);
		ctx.ui.notify(`Scryer recorder: ${state.activeProjectName}, no active ticket`, "info");
		return false;
	}
	if (taskChoice === "Create a new ticket") {
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
	} else if (taskChoice === "Closed tickets…") {
		const closedLabels = closedTasks.slice(0, 50).map((t: any) => `${t.title} [${t.status}]`);
		const closedChoice = await ctx.ui.select("Closed ticket", ["Cancel", ...closedLabels]);
		if (!closedChoice || closedChoice === "Cancel") return false;
		const task = closedTasks[closedLabels.indexOf(closedChoice)];
		if (!task) return false;
		state.activeTaskId = task.id;
		state.activeTaskTitle = task.title;
	} else {
		const task = shown[taskLabels.indexOf(taskChoice)];
		if (!task) return false;
		state.activeTaskId = task.id;
		state.activeTaskTitle = task.title;
	}
	state.noTicketForSession = false;
	await saveState(state);
	ctx.ui.notify(`Scryer recorder ticket: ${state.activeTaskTitle}`, "info");
	return true;
}

async function chooseActiveProjectAndTask(ctx: ExtensionContext) {
	if (!state || state.activeProjectId || state.noProjectForSession || !ctx.hasUI) return;
	if (await pickActiveProject(ctx)) await pickActiveTicket(ctx);
}

async function dailyTargetProject(): Promise<any> {
	if (state?.activeProjectId) {
		try {
			return await api(`/api/projects/${state.activeProjectId}`);
		} catch (err: any) {
			if (!String(err?.message ?? err).includes("404")) throw err;
			state.activeProjectId = undefined;
			state.activeProjectName = undefined;
		}
	}
	return findDailiesProject();
}

async function ensureTicket(finalizePrevious = true): Promise<string> {
	if (!state) throw new Error("recorder state missing");
	const nowDate = today();
	const now = Date.now();
	const project = await dailyTargetProject();
	const dateChanged = state.currentDate && state.currentDate !== nowDate;
	const projectChanged = state.ticketProjectId && state.ticketProjectId !== project.id;
	const staleEnough = !state.lastActivityAt || now - state.lastActivityAt >= NEW_DAILY_HOURS * 60 * 60 * 1000;
	if (state.ticketId && !projectChanged && (!dateChanged || !staleEnough)) {
		const existing = await getTicket(state.ticketId);
		if (existing && existing.project_id === project.id) {
			state.ticketTitle = existing.title;
			state.ticketProjectId = project.id;
			state.ticketProjectName = project.name;
			await saveState(state);
			return state.ticketId;
		}
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
			tag_names: ["dailies", state.cwdTag],
			created_by_role: "pi",
			created_by_instance_key: "scryer-recorder",
		}),
	});
	state.ticketId = task.id;
	state.ticketTitle = task.title;
	state.ticketProjectId = project.id;
	state.ticketProjectName = project.name;
	state.currentDate = nowDate;
	state.finalized = false;
	await saveState(state);
	return task.id;
}

async function completeText(ctx: ExtensionContext, prompt: string): Promise<string> {
	if (!ctx.model) throw new Error("No active model");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
	const response = await complete(
		ctx.model,
		{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{ apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "medium" },
	);
	return response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
}

async function generateSummary(ctx: ExtensionContext, reason: string, endSession: boolean): Promise<string> {
	return completeText(ctx, summaryPrompt(ctx, reason, endSession, state, recentTools, recentUserPrompts));
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
	const title = `Pi Daily — ${state.currentDate ?? today()} — ${state.sessionName}`;
	const task = await api(`/api/tasks/${ticketId}`, {
		method: "PATCH",
		body: JSON.stringify({
			title,
			description_md: summary,
			status: endSession ? "human_reviewed_and_closed" : "in_execution",
			tag_names: ["dailies", state.cwdTag],
		}),
	});
	state.ticketTitle = task?.title ?? title;
	return task;
}

async function patchActiveTask(summary: string) {
	if (!state?.activeTaskId) return;
	try {
		const task = await api(`/api/tasks/${state.activeTaskId}`, {
			method: "PATCH",
			body: JSON.stringify({
				description_md: summary,
				status: "in_execution",
				tag_names: [state.cwdTag],
			}),
		});
		state.activeTaskTitle = task?.title ?? state.activeTaskTitle;
	} catch (err: any) {
		if (!String(err?.message ?? err).includes("404")) throw err;
		state.activeTaskId = undefined;
		state.activeTaskTitle = undefined;
	}
}

async function reviseActiveTaskFromCurrentState(ctx: ExtensionContext): Promise<boolean> {
	if (!state?.activeTaskId) return false;
	setRecorderProgress(ctx, "reading active work ticket…");
	const task = await getTicket(state.activeTaskId);
	if (!task) {
		state.activeTaskId = undefined;
		state.activeTaskTitle = undefined;
		await saveState(state);
		return false;
	}
	state.activeTaskTitle = task.title;
	setRecorderProgress(ctx, "generating ticket update from current session…");
	const revised = await completeText(ctx, updateTicketPrompt(ctx, task, recentTools, recentUserPrompts));
	setRecorderProgress(ctx, "writing active work ticket…");
	await patchActiveTask(revised);
	state.summary = revised;
	state.lastSummaryAt = Date.now();
	state.lastUpdateAt = Date.now();
	await saveState(state);
	return true;
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

function activeTargetLabel(): string {
	const project = state?.activeProjectName ?? "Unknown project";
	const ticket = state?.activeTaskTitle ?? "Unknown ticket";
	return `${project}/${ticket}`;
}

async function updateActiveTaskDescription(ctx: ExtensionContext) {
	if (!state || !(await ensureActiveTicketSelected(ctx))) return;
	await foregroundScryer(ctx, `Updating Scryer ticket: ${activeTargetLabel()}`, async () => {
		await withScryerBusy(ctx, `updating ${activeTargetLabel()}…`, async () => {
			const ok = await reviseActiveTaskFromCurrentState(ctx);
			if (!ok) throw new Error("active ticket no longer exists");
			if (ctx.hasUI) ctx.ui.notify(`Updated Work → ${activeTargetLabel()}`, "info");
		});
	});
}

async function addActiveTaskComment(ctx: ExtensionContext) {
	if (!state || !(await ensureActiveTicketSelected(ctx))) return;
	setRecorderProgress(ctx, "summarizing for active ticket comment…");
	const summary = await generateSummary(ctx, "add-comments", false);
	await writeLocalSummary("add-comments", summary, false);
	setRecorderProgress(ctx, `adding comment to ${activeTargetLabel()}…`);
	await commentOnActiveTask(summary);
	state.summary = summary;
	state.lastSummaryAt = Date.now();
	await saveState(state);
	if (ctx.hasUI) ctx.ui.notify(`Added comment to ticket: ${activeTargetLabel()}`, "info");
}

function dailyProjectLabel(): string {
	if (state?.noProjectForSession) return "Dailies";
	return state?.activeProjectName ?? state?.ticketProjectName ?? "Dailies";
}

function dailyTicketLabel(): string {
	return state?.ticketTitle ?? (state?.currentDate ? `Pi Daily — ${state.currentDate} — ${state.sessionName}` : "will create/find daily ticket");
}

function activeWorkLabel(): string {
	if (state?.activeTaskId) return `${state.activeProjectName ?? "selected project"} / ${state.activeTaskTitle ?? state.activeTaskId}`;
	if (state?.noTicketForSession) return "none — consciously skipped for this session";
	return "none selected";
}

function destinationSummary(): string {
	return `Daily → ${dailyProjectLabel()} / ${dailyTicketLabel()} · Work → ${activeWorkLabel()}`;
}

function ago(ts?: number): string {
	if (!ts) return "never";
	const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function deetsLines(): string[] {
	return [
		"# Scryer context",
		`Project: ${state?.activeProjectName ?? (state?.noProjectForSession ? "none — consciously skipped" : "none selected")}`,
		`Ticket: ${state?.activeTaskTitle ?? (state?.noTicketForSession ? "none — consciously skipped" : "none selected")}`,
		`Daily: ${dailyProjectLabel()} / ${dailyTicketLabel()}`,
		`Last save: ${ago(state?.lastSaveAt)}${state?.lastSaveReason ? ` (${state.lastSaveReason})` : ""}`,
		`Last update: ${ago(state?.lastUpdateAt)}`,
		`Last autosave/activity: ${ago(state?.lastActivityAt)}`,
		`Cooldown: ${Math.round(SAVE_COOLDOWN_MS / 60_000)}m; last attempt ${ago(state?.lastSaveAttemptAt)}`,
		`CWD: ${state?.cwd ?? "unknown"}`,
	];
}

function deetsMarkdown(): string {
	return deetsLines().join("\n");
}

function saveDestinationLines(line: string): string[] {
	return [
		`▸ Scryer recorder: ${line}`,
		`  Daily → ${dailyProjectLabel()} / ${dailyTicketLabel()}`,
		`  Work  → ${activeWorkLabel()}`,
	];
}

function setRecorderProgress(ctx: ExtensionContext, line?: string) {
	if (!ctx.hasUI) return;
	if (!line) {
		ctx.ui.setStatus("scryer-recorder", undefined);
		ctx.ui.setWidget("scryer-recorder", undefined);
		(ctx.ui as any).setWorkingMessage?.();
		(ctx.ui as any).setWorkingIndicator?.();
		(ctx.ui as any).setWorkingVisible?.(true);
		return;
	}
	const prefix = scryerBusy ? `BUSY — ${line}` : line;
	foregroundStepUpdate?.(prefix);
	ctx.ui.setStatus("scryer-recorder", prefix);
	if (!foregroundStepUpdate) ctx.ui.setWidget("scryer-recorder", saveDestinationLines(prefix), { placement: "belowEditor" });
	(ctx.ui as any).setWorkingVisible?.(true);
	(ctx.ui as any).setWorkingMessage?.(`Scryer: ${line}`);
	(ctx.ui as any).setWorkingIndicator?.({ frames: ["·", "•", "●", "•"], intervalMs: 120 });
}

async function flushQueuedInputs() {
	if (!activePi || queuedInputs.length === 0) return;
	const pending = queuedInputs;
	queuedInputs = [];
	for (const item of pending) {
		activePi.sendUserMessage(item.images?.length ? [{ type: "text", text: item.text }, ...item.images] as any : item.text, { deliverAs: "followUp" });
	}
}

async function withScryerBusy(ctx: ExtensionContext, label: string, fn: () => Promise<void>) {
	if (scryerBusy) {
		if (ctx.hasUI) ctx.ui.notify(`Scryer is already busy: ${scryerBusy.label}`, "warning");
		return;
	}
	scryerBusy = { label, startedAt: Date.now() };
	setRecorderProgress(ctx, label);
	try {
		await fn();
	} finally {
		scryerBusy = undefined;
		setRecorderProgress(ctx, undefined);
		await flushQueuedInputs();
	}
}

async function foregroundScryer(ctx: ExtensionContext, label: string, fn: () => Promise<void>) {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		await fn();
		return;
	}
	const result = await ctx.ui.custom<Error | null>((tui, theme, _kb, done) => {
		let step = label;
		let frame = 0;
		const frames = ["·", "•", "●", "•"];
		const timer = setInterval(() => { frame = (frame + 1) % frames.length; tui.requestRender(); }, 140);
		foregroundStepUpdate = (line: string) => { step = line; tui.requestRender(); };
		fn()
			.then(() => done(null))
			.catch((err) => done(err instanceof Error ? err : new Error(String(err))))
			.finally(() => { clearInterval(timer); foregroundStepUpdate = undefined; });
		return {
			render: (w: number) => {
				const c = new Container();
				const borderColor = (s: string) => theme.fg("border", s);
				c.addChild(new DynamicBorder(borderColor));
				c.addChild(new Text(`${theme.fg("accent", frames[frame])} ${theme.bold("Scryer")}: ${label}`, 1, 0));
				c.addChild(new Text(`  ${step}`, 1, 0));
				for (const line of saveDestinationLines(step).slice(1)) c.addChild(new Text(theme.fg("muted", line), 1, 0));
				if (queuedInputs.length) c.addChild(new Text(theme.fg("warning", `  Queued messages → ${queuedInputs.length}`), 1, 0));
				c.addChild(new DynamicBorder(borderColor));
				return c.render(w);
			},
			invalidate: () => {},
			handleInput: () => { ctx.ui.notify("Scryer is working; input is held until it finishes.", "info"); },
			dispose: () => { clearInterval(timer); foregroundStepUpdate = undefined; },
		};
	});
	if (result) throw result;
}

async function summarizeAndPersist(reason: string, ctx: ExtensionContext, endSession = false) {
	activeCtx = ctx;
	const ownsBusy = !scryerBusy;
	if (ownsBusy) scryerBusy = { label: `saving to Scryer (${reason})`, startedAt: Date.now() };
	try {
		if (!activePi) throw new Error("recorder pi api missing");
		state ??= await loadState(activePi, ctx);

		// Latch: if a save was attempted by any means in the last cooldown window, ignore this call.
		// Check-and-set is synchronous, so concurrent triggers cannot both pass.
		const sinceLastAttempt = Date.now() - (state.lastSaveAttemptAt ?? 0);
		if (sinceLastAttempt < SAVE_COOLDOWN_MS) {
			if (ctx.hasUI && reason === "manual-save") {
				const mins = Math.max(1, Math.round(sinceLastAttempt / 60_000));
				ctx.ui.notify(`Scryer recorder: save skipped — last save ${mins}m ago (cooldown ${Math.round(SAVE_COOLDOWN_MS / 60_000)}m)`, "info");
			}
			return;
		}
		state.lastSaveAttemptAt = Date.now();
		await saveState(state);

		setRecorderProgress(ctx, "checking Scryer destination…");
		const pmAvailable = await ensurePmReachable(ctx, state, saveState);
		if (pmAvailable) {
			await chooseActiveProjectAndTask(ctx);
			await saveState(state);
		}

		setRecorderProgress(ctx, `saving (${reason}): summarizing with active model…`);
		const summary = await generateSummary(ctx, reason, endSession);

		setRecorderProgress(ctx, "writing local summary…");
		await writeLocalSummary(reason, summary, endSession);

		if (pmAvailable) {
			setRecorderProgress(ctx, "creating/updating daily ticket…");
			let ticketId = await ensureTicket(!endSession);
			setRecorderProgress(ctx, "writing daily ticket…");
			try {
				await patchTicket(ticketId, summary, endSession);
			} catch (err: any) {
				if (!String(err?.message ?? err).includes("404")) throw err;
				setRecorderProgress(ctx, "daily ticket missing; creating a fresh one…");
				state.ticketId = undefined;
				state.ticketProjectId = undefined;
				state.ticketProjectName = undefined;
				state.ticketTitle = undefined;
				state.currentDate = undefined;
				ticketId = await ensureTicket(false);
				await patchTicket(ticketId, summary, endSession);
			}
			if (state.activeTaskId) {
				setRecorderProgress(ctx, "updating active work ticket…");
				await patchActiveTask(summary);
			}
			if (endSession) state.finalized = true;
		} else {
			setRecorderProgress(ctx, "PM unavailable; writing outbox entry…");
			await writeOutbox(reason, summary, endSession);
		}
		state.summary = summary;
		state.lastSummaryAt = Date.now();
		state.lastSaveAt = Date.now();
		state.lastSaveReason = reason;
		state.lastActivityAt = Date.now();
		state.outputTokensSinceSummary = 0;
		await saveState(state);
		if (ctx.hasUI) ctx.ui.notify(`Scryer recorder saved summary (${reason}). ${destinationSummary()}`, "info");
	} finally {
		if (ownsBusy) {
			scryerBusy = undefined;
			setRecorderProgress(ctx, undefined);
			await flushQueuedInputs();
		} else {
			setRecorderProgress(ctx, undefined);
		}
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
		if (ctx.hasUI) {
			ctx.ui.setWidget("scryer-recorder", undefined);
			ctx.ui.setWidget("scryer-recorder-deets", undefined);
		}
		await saveState(state);
	});

	pi.on("input", async (event, ctx) => {
		if (!scryerBusy) return { action: "continue" as const };
		queuedInputs.push({ text: event.text, images: event.images as any });
		if (ctx.hasUI) {
			ctx.ui.notify(`Queued message until Scryer finishes: ${scryerBusy.label}`, "info");
			ctx.ui.setWidget("scryer-recorder", [
				...saveDestinationLines(`BUSY — ${scryerBusy.label}`),
				`  Queued messages → ${queuedInputs.length}`,
			], { placement: "belowEditor" });
			(ctx.ui as any).setWorkingVisible?.(true);
			(ctx.ui as any).setWorkingMessage?.(`Scryer busy — queued ${queuedInputs.length} message${queuedInputs.length === 1 ? "" : "s"}`);
		}
		return { action: "handled" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		activeCtx = ctx;
		state ??= await loadState(pi, ctx);
		state.lastActivityAt = Date.now();
		recentUserPrompts.push(event.prompt ?? "");
		if (recentUserPrompts.length > 30) recentUserPrompts = recentUserPrompts.slice(-30);
		if (idleTimer) clearTimeout(idleTimer);
		await saveState(state);
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
		await saveState(state);
		if (state.outputTokensSinceSummary >= OUTPUT_TOKEN_THRESHOLD) {
			await summarizeAndPersist("output-token-threshold", ctx, false);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeCtx = ctx;
		state ??= await loadState(pi, ctx);
		state.lastActivityAt = Date.now();
		await saveState(state);
		scheduleIdle(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (idleTimer) clearTimeout(idleTimer);
		await saveState(state);
	});

	const register = (name: string, description: string, handler: (ctx: ExtensionContext) => Promise<void>) => {
		pi.registerCommand(name, {
			description,
			handler: async (_args, ctx) => {
				try {
					activeCtx = ctx;
					state ??= await loadState(pi, ctx);
					if (!(await ensurePmReachable(ctx, state, saveState))) return;
					await handler(ctx);
				} catch (err: any) {
					if (ctx.hasUI) ctx.ui.notify(`Scryer recorder ${name} failed: ${err?.message ?? err}`, "error");
				} finally {
					setRecorderProgress(ctx, undefined);
				}
			},
		});
	};

	register("pp", "Repo-aware Scryer project picker", async (ctx) => { await pickActiveProject(ctx); });
	register("project-picker", "Repo-aware Scryer project picker", async (ctx) => { await pickActiveProject(ctx); });
	register("pick-project", "Repo-aware Scryer project picker", async (ctx) => { await pickActiveProject(ctx); });
	register("tp", "Scryer ticket picker for the selected project", async (ctx) => { await pickActiveTicket(ctx); });
	register("ticket-picker", "Scryer ticket picker for the selected project", async (ctx) => { await pickActiveTicket(ctx); });
	register("pt", "Scryer ticket picker for the selected project", async (ctx) => { await pickActiveTicket(ctx); });
	register("pick-ticket", "Scryer ticket picker for the selected project", async (ctx) => { await pickActiveTicket(ctx); });
	register("ut", "Update selected ticket from current session without writing Daily", updateActiveTaskDescription);
	register("update", "Update selected ticket from current session without writing Daily", updateActiveTaskDescription);
	register("update-ticket", "Update selected ticket from current session without writing Daily", updateActiveTaskDescription);
	register("ac", "Add recorder summary as a comment on selected ticket", addActiveTaskComment);
	register("add-comments", "Add recorder summary as a comment on selected ticket", addActiveTaskComment);

	pi.registerCommand("deets", {
		description: "Show current Scryer project/ticket/save context",
		handler: async (_args, ctx) => {
			try {
				activeCtx = ctx;
				state ??= await loadState(pi, ctx);
				const markdown = deetsMarkdown();
				pi.sendMessage({
					customType: "scryer-deets",
					content: markdown,
					display: true,
					details: {
						projectId: state.activeProjectId,
						projectName: state.activeProjectName,
						taskId: state.activeTaskId,
						taskTitle: state.activeTaskTitle,
						dailyTaskId: state.ticketId,
						dailyProjectId: state.ticketProjectId,
					},
				}, { deliverAs: "nextTurn" });
				if (ctx.hasUI) {
					if (deetsTimer) clearTimeout(deetsTimer);
					ctx.ui.setWidget("scryer-recorder-deets", undefined);
					ctx.ui.setWidget("scryer-recorder", deetsLines());
					ctx.ui.notify(`${state.activeProjectName ?? "No project"} / ${state.activeTaskTitle ?? "No ticket"}`, "info");
					deetsTimer = setTimeout(() => {
						if (!scryerBusy) ctx.ui.setWidget("scryer-recorder", undefined);
					}, 15_000);
				}
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Scryer deets failed: ${err?.message ?? err}`, "error");
			}
		},
	});

	pi.registerCommand("save", {
		description: "Save a Scryer recorder summary to the Dailies PM ticket",
		handler: async (_args, ctx) => {
			try {
				activeCtx = ctx;
				state ??= await loadState(pi, ctx);
				await foregroundScryer(ctx, "Saving Scryer Daily / active ticket", async () => {
					await summarizeAndPersist("manual-save", ctx, false);
				});
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Scryer recorder save failed: ${err?.message ?? err}`, "error");
			}
		},
	});
}
