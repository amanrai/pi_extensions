import { complete } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import { DAILIES_SLUG, IDLE_MS, OUTPUT_TOKEN_THRESHOLD, OUTBOX_DIR, SAVE_COOLDOWN_MS, SUMMARIES_DIR, NEW_DAILY_HOURS, PM_URL } from "./config.ts";
import type { RecorderState, ToolEvent } from "./types.ts";
import { api, ensurePmReachable, findDailiesProject, findWorkTaskType, getTicket } from "./api.ts";
import { displayPath, loadState, saveState, today } from "./state.ts";
import { projectLabel, projectScore, repoContext } from "./repo.ts";
import { contentText, summaryPrompt, updateTicketPrompt } from "./prompts.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendTouchlogEntry, readTouchlog, type TouchLogEntry } from "./touchlog.ts";
import { overlayStyle } from "./overlay-style.ts";
import { describeModalConfig, modalAnchorOption, modalBodyRows, modalHeightOption, modalOffsetYOption, modalWidthOption, parseModalConfigArgs, readModalConfig, writeModalConfig } from "./modal-config.ts";

const execFileAsync = promisify(execFile);

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
let foregroundPlan: Array<{ label: string; match: RegExp }> = [];
let foregroundStepIndex = 0;
let pendingSave: { reason: string; ctx: ExtensionContext; endSession: boolean } | undefined;
let contextGateBusy = false;
const widgetTimers = new Map<string, NodeJS.Timeout>();

function setTransientWidget(ctx: ExtensionContext, key: string, lines: string[], options?: any, ttlMs = 30_000) {
	if (!ctx.hasUI) return;
	if (widgetTimers.has(key)) clearTimeout(widgetTimers.get(key));
	ctx.ui.setWidget(key, lines, options);
	widgetTimers.set(key, setTimeout(() => {
		ctx.ui.setWidget(key, undefined);
		widgetTimers.delete(key);
	}, ttlMs));
}

function clearTransientWidget(ctx: ExtensionContext, key: string) {
	if (widgetTimers.has(key)) clearTimeout(widgetTimers.get(key));
	widgetTimers.delete(key);
	if (ctx.hasUI) ctx.ui.setWidget(key, undefined);
}

type PickerItem = SelectItem & { value: string };

async function pickFromList(ctx: ExtensionContext, title: string, subtitle: string, items: PickerItem[], height = 12): Promise<string | undefined> {
	if (!items.length) return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));
		if (subtitle) container.addChild(new Text(theme.fg("dim", subtitle)));
		const list = new SelectList(items, Math.min(height, Math.max(5, items.length)), {
			selectedPrefix: (s) => theme.fg("accent", s),
			selectedText: (s) => theme.fg("accent", s),
			description: (s) => theme.fg("muted", s),
			scrollInfo: (s) => theme.fg("dim", s),
			noMatch: (s) => theme.fg("warning", s),
		});
		list.onSelect = (item) => done(String(item.value));
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel")));
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
		};
	});
}

function repoDescription(project: any, score?: number): string {
	const bits: string[] = [];
	if (score) bits.push(`match ${score}`);
	if (project.remote_repo_url) bits.push(project.remote_repo_url);
	else if (project.relative_repo_path) bits.push(project.relative_repo_path);
	if (project.description_md) bits.push(String(project.description_md).replace(/\s+/g, " ").slice(0, 90));
	return bits.join(" · ");
}

function taskDescription(task: any): string {
	const parts = [String(task.status ?? "unknown")];
	const updated = ago(Date.parse(task.updated_at));
	if (updated !== "never") parts.push(`updated ${updated}`);
	const tags = (task.tags ?? []).map((t: any) => t.name).filter(Boolean).slice(0, 4).join(", ");
	if (tags) parts.push(tags);
	const desc = String(task.description_md ?? "").replace(/[#*_`>\-\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
	if (desc) parts.push(desc);
	return parts.join(" · ");
}

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
	const title = repo.remote
		? `Project for ${displayPath(repo.root)}`
		: `Project for ${displayPath(repo.root)}`;
	const subtitle = repo.remote ? `repo remote: ${repo.remote}` : "repo-aware suggestions first";
	const obviousItems: PickerItem[] = [
		...obvious.map((x: any) => ({
			value: `project:${x.project.id}`,
			label: projectLabel(x.project, x.score),
			description: repoDescription(x.project, x.score),
		})),
		{ value: "other", label: "Other project…", description: `${other.length} remaining projects` },
		{ value: "none", label: "Continue without a project for this session", description: "Daily saves fall back to Dailies project" },
	];
	let choice = await pickFromList(ctx, title, subtitle, obviousItems, 12);
	if (!choice) return false;
	let project: any | undefined;
	if (choice === "none") {
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
	if (choice === "other") {
		const otherItems: PickerItem[] = [
			{ value: "cancel", label: "Cancel", description: "Return without changing project" },
			...other.map((x: any) => ({
				value: `project:${x.project.id}`,
				label: `${x.project.name} (${x.project.slug})`,
				description: repoDescription(x.project),
			})),
		];
		choice = await pickFromList(ctx, "Other Scryer project", "type to filter projects", otherItems, 16);
		if (!choice || choice === "cancel") return false;
	}
	const projectId = choice.startsWith("project:") ? choice.slice("project:".length) : undefined;
	project = scored.find((x: any) => x.project.id === projectId)?.project;
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

async function setActiveProjectById(ctx: ExtensionContext, projectId: string): Promise<boolean> {
	if (!state) return false;
	const project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
	if (!project?.id) throw new Error(`Project not found: ${projectId}`);
	state.activeProjectId = project.id;
	state.activeProjectName = project.name;
	state.activeTaskId = undefined;
	state.activeTaskTitle = undefined;
	state.noProjectForSession = false;
	state.noTicketForSession = false;
	await saveState(state);
	if (ctx.hasUI) ctx.ui.notify(`Scryer recorder project: ${project.name}`, "info");
	return true;
}

async function setActiveTicketById(ctx: ExtensionContext, ticketId: string): Promise<boolean> {
	if (!state) return false;
	const task = await getTicket(ticketId);
	if (!task?.id) throw new Error(`Ticket not found: ${ticketId}`);
	state.activeTaskId = task.id;
	state.activeTaskTitle = task.title;
	const projectId = task.project_id ?? task.projectId ?? task.project?.id;
	if (projectId) {
		state.activeProjectId = projectId;
		try {
			const project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
			state.activeProjectName = project?.name ?? task.project?.name ?? state.activeProjectName;
		} catch {
			state.activeProjectName = task.project?.name ?? state.activeProjectName;
		}
	}
	state.noProjectForSession = false;
	state.noTicketForSession = false;
	await saveState(state);
	if (ctx.hasUI) ctx.ui.notify(`Scryer recorder ticket: ${state.activeTaskTitle}`, "info");
	return true;
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
	const shown = openTasks.slice(0, 40);
	const ticketItems: PickerItem[] = [
		{ value: "create", label: "Create a new ticket", description: `in ${state.activeProjectName ?? "project"}` },
		{ value: "none", label: "Continue without a ticket for this session", description: "Daily still saves to selected project" },
		...shown.map((t: any) => ({
			value: `task:${t.id}`,
			label: t.title,
			description: taskDescription(t),
		})),
		...(closedTasks.length ? [{ value: "closed", label: "Closed tickets…", description: `${closedTasks.length} closed tickets` }] : []),
	];
	let taskChoice = await pickFromList(ctx, `Ticket in ${state.activeProjectName ?? "project"}`, "type to filter tickets", ticketItems, 16);
	if (!taskChoice) return false;
	if (taskChoice === "none") {
		state.activeTaskId = undefined;
		state.activeTaskTitle = undefined;
		state.noTicketForSession = true;
		await saveState(state);
		ctx.ui.notify(`Scryer recorder: ${state.activeProjectName}, no active ticket`, "info");
		return false;
	}
	if (taskChoice === "create") {
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
	} else if (taskChoice === "closed") {
		const closedItems: PickerItem[] = [
			{ value: "cancel", label: "Cancel", description: "Return without changing ticket" },
			...closedTasks.slice(0, 80).map((t: any) => ({
				value: `task:${t.id}`,
				label: t.title,
				description: taskDescription(t),
			})),
		];
		taskChoice = await pickFromList(ctx, "Closed ticket", "type to filter closed tickets", closedItems, 16);
		if (!taskChoice || taskChoice === "cancel") return false;
		const taskId = taskChoice.startsWith("task:") ? taskChoice.slice("task:".length) : undefined;
		const task = closedTasks.find((t: any) => t.id === taskId);
		if (!task) return false;
		state.activeTaskId = task.id;
		state.activeTaskTitle = task.title;
	} else {
		const taskId = taskChoice.startsWith("task:") ? taskChoice.slice("task:".length) : undefined;
		const task = shown.find((t: any) => t.id === taskId);
		if (!task) return false;
		state.activeTaskId = task.id;
		state.activeTaskTitle = task.title;
	}
	state.noTicketForSession = false;
	await saveState(state);
	ctx.ui.notify(`Scryer recorder ticket: ${state.activeTaskTitle}`, "info");
	return true;
}

function hasScryerContextDecision(): boolean {
	if (!state) return false;
	if (state.noProjectForSession) return true;
	if (!state.activeProjectId) return false;
	return Boolean(state.activeTaskId || state.noTicketForSession);
}

async function ensureScryerContext(ctx: ExtensionContext, source: "startup" | "input" = "input"): Promise<boolean> {
	if (!state || !ctx.hasUI || ctx.mode !== "tui") return true;
	if (hasScryerContextDecision()) return true;
	if (contextGateBusy) return false;
	contextGateBusy = true;
	try {
		if (!(await ensurePmReachable(ctx, state, saveState))) {
			ctx.ui.notify("Scryer context gate deferred — PM system unavailable", "warning");
			return true;
		}
		if (source === "startup") ctx.ui.notify("Choose Scryer context for this Pi session", "info");
		if (!state.activeProjectId && !state.noProjectForSession) await pickActiveProject(ctx);
		if (state.activeProjectId && !state.activeTaskId && !state.noTicketForSession) await pickActiveTicket(ctx);
		if (!hasScryerContextDecision()) {
			ctx.ui.notify("Scryer context still missing — pick a ticket/project or consciously skip", "warning");
			return false;
		}
		return true;
	} finally {
		contextGateBusy = false;
	}
}

async function chooseActiveProjectAndTask(ctx: ExtensionContext) {
	if (!state || hasScryerContextDecision() || !ctx.hasUI) return;
	await ensureScryerContext(ctx, "input");
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
	showCompletion(ctx, "update");
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

function expandPath(rawPath: string, cwd: string): string {
	const trimmed = rawPath.trim();
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

async function gitRoot(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

function isCommitCommand(command: string): boolean {
	return /(^|[;&|()\s])git\s+(?:-C\s+\S+\s+)?commit\b/.test(command);
}

function unquoteShellPath(path: string): string {
	return path.trim().replace(/^['"]|['"]$/g, "");
}

function inferCommitCwd(ctx: ExtensionContext, command: string): string {
	const gitC = command.match(/\bgit\s+-C\s+([^\s;&|]+)\s+commit\b/);
	if (gitC?.[1]) return expandPath(unquoteShellPath(gitC[1]), ctx.cwd);
	const cdMatches = [...command.matchAll(/(?:^|[;&|]\s*)cd\s+([^;&|]+?)\s*(?:&&|;)/g)];
	const lastCd = cdMatches.at(-1)?.[1];
	if (lastCd) return expandPath(unquoteShellPath(lastCd), ctx.cwd);
	return ctx.cwd;
}

async function recordCommitIfAny(ctx: ExtensionContext, command: string, ok: boolean) {
	if (!ok || !isCommitCommand(command)) return;
	const root = await gitRoot(inferCommitCwd(ctx, command));
	if (!root) return;
	try {
		const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%H%x00%ct%x00%s"], { cwd: root, timeout: 3000 });
		const [hash, ts, subject] = stdout.trim().split("\x00");
		if (!hash || !ts || !subject) return;
		await appendTouchlogEntry(ctx, { repoRoot: root, hash, subject, timestamp: Number(ts) * 1000 });
	} catch {}
}

async function collectTouchedCommits(ctx: ExtensionContext): Promise<TouchLogEntry[]> {
	return (await readTouchlog(ctx)).sort((a, b) => b.timestamp - a.timestamp);
}

function touchedMarkdown(rows: TouchLogEntry[]): string {
	if (!rows.length) return "## Commits touched this session\n\nNo commits recorded for this Pi session yet.";
	return [
		"## Commits touched this session",
		"",
		...rows.map((r) => `- \`${r.repoName}\` \`${r.hash.slice(0, 7)}\` ${r.subject} — ${ago(r.timestamp)}`),
	].join("\n");
}

function replaceMarkdownSection(md: string, heading: string, section: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(^|\\n)${escaped}[\\s\\S]*?(?=\\n##\\s|$)`);
	if (re.test(md)) return md.replace(re, `\n${section}`).trimStart();
	return `${md.trimEnd()}\n\n${section}\n`;
}

async function updateDailyTouchedSection(ctx: ExtensionContext, markdown: string) {
	if (!state) return;
	if (!(await ensurePmReachable(ctx, state, saveState))) return;
	const ticketId = await ensureTicket(false);
	const ticket = await getTicket(ticketId);
	const next = replaceMarkdownSection(String(ticket?.description_md ?? ""), "## Commits touched this session", markdown);
	await api(`/api/tasks/${ticketId}`, {
		method: "PATCH",
		body: JSON.stringify({ description_md: next, tag_names: ["dailies", state.cwdTag] }),
	});
	state.ticketTitle = ticket?.title ?? state.ticketTitle;
	await saveState(state);
}

function groupedTouchedLines(rows: TouchLogEntry[]): string[] {
	if (!rows.length) return ["No commits recorded for this Pi session yet."];
	const byRepo = new Map<string, TouchLogEntry[]>();
	for (const row of rows) {
		const key = row.repoName || row.repoRoot;
		byRepo.set(key, [...(byRepo.get(key) ?? []), row]);
	}
	const lines: string[] = [];
	for (const [repo, commits] of byRepo) {
		lines.push(`${repo}  ${commits.length} commit${commits.length === 1 ? "" : "s"}`);
		for (const c of commits) lines.push(`  ● ${c.hash.slice(0, 7)} ${c.subject} · ${ago(c.timestamp)}`);
	}
	return lines;
}

async function showScrollableModal(ctx: ExtensionContext, title: string, lines: string[], subtitle = "") {
	if (!ctx.hasUI) return;
	const modalConfig = await readModalConfig();
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let top = 0;
		function pageSize() {
			const terminalHeight = Math.floor((tui as any).height ?? 22);
			const chromeRows = 4 + (subtitle ? 1 : 0);
			return Math.max(8, modalBodyRows(modalConfig, terminalHeight, chromeRows));
		}
		function clamp() { top = Math.max(0, Math.min(top, Math.max(0, lines.length - pageSize()))); }
		return {
			render: (width: number) => {
				clamp();
				const panelWidth = Math.max(20, width - 2);
				const rendered: string[] = [];
				rendered.push(overlayStyle.border(panelWidth));
				rendered.push(overlayStyle.title(title, panelWidth));
				if (subtitle) rendered.push(overlayStyle.muted(subtitle, panelWidth));
				const size = pageSize();
				const visible = lines.slice(top, top + size);
				for (const line of visible) rendered.push(overlayStyle.line(truncateToWidth(line || " ", panelWidth), panelWidth));
				for (let i = visible.length; i < size; i++) rendered.push(overlayStyle.line("", panelWidth));
				rendered.push(overlayStyle.muted(`${top + 1}-${Math.min(lines.length, top + size)} / ${lines.length}  ↑↓ scroll • esc close`, panelWidth));
				rendered.push(overlayStyle.border(panelWidth));
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
	}, { overlay: true, overlayOptions: { anchor: modalAnchorOption(modalConfig), offsetY: modalOffsetYOption(modalConfig), width: modalWidthOption(modalConfig), maxHeight: modalHeightOption(modalConfig) } });
}

async function showCockpit(ctx: ExtensionContext) {
	state ??= activePi ? await loadState(activePi, ctx) : state;
	const rows = await collectTouchedCommits(ctx);
	const repos = new Set(rows.map((r) => r.repoName || r.repoRoot));
	const latest = rows[0];
	const lines = [
		`Scryer   ${state?.activeProjectName ?? (state?.noProjectForSession ? "no project" : "pick project")}`,
		`Ticket   ${state?.activeTaskTitle ?? (state?.noTicketForSession ? "no ticket" : "pick ticket")}`,
		`Daily    ${dailyProjectLabel()} / ${dailyTicketLabel()}`,
		`Update   ${ago(state?.lastUpdateAt)}     Save ${ago(state?.lastSaveAt)}`,
		`Queue    ${pendingSave ? `save queued: ${pendingSave.reason}` : "clear"}     Input ${queuedInputs.length ? `${queuedInputs.length} queued` : "clear"}`,
		`Repos    ${repos.size} touched     Commits ${rows.length}`,
		latest ? `Latest   ${latest.repoName} ${latest.hash.slice(0, 7)} ${latest.subject} · ${ago(latest.timestamp)}` : "Latest   none recorded",
		"",
		...groupedTouchedLines(rows),
	];
	await showScrollableModal(ctx, "Session cockpit", lines);
}

function showCompletion(ctx: ExtensionContext, kind: "save" | "update") {
	const lines = kind === "update"
		? ["✓ Ticket read", "✓ Update generated", `✓ Work ticket updated: ${activeWorkLabel()}`]
		: ["✓ Summary generated", `✓ Daily updated: ${dailyProjectLabel()} / ${dailyTicketLabel()}`, state?.activeTaskId ? `✓ Work ticket updated: ${activeWorkLabel()}` : "○ No active work ticket", "✓ Touchlog available in /cockpit"];
	setTransientWidget(ctx, "scryer-complete", [kind === "update" ? "Scryer update complete" : "Scryer save complete", ...lines], { placement: "belowEditor" });
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
		clearTransientWidget(ctx, "scryer-recorder");
		(ctx.ui as any).setWorkingMessage?.();
		(ctx.ui as any).setWorkingIndicator?.();
		(ctx.ui as any).setWorkingVisible?.(true);
		return;
	}
	const prefix = scryerBusy ? `BUSY — ${line}` : line;
	const idx = foregroundPlan.findIndex((step) => step.match.test(line));
	if (idx >= 0) foregroundStepIndex = idx;
	foregroundStepUpdate?.(prefix);
	ctx.ui.setStatus("scryer-recorder", prefix);
	if (!foregroundStepUpdate) setTransientWidget(ctx, "scryer-recorder", saveDestinationLines(prefix), { placement: "belowEditor" });
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

function planForScryer(label: string) {
	if (/updat/i.test(label)) return [
		{ label: "Read active ticket", match: /reading active work ticket/i },
		{ label: "Generate ticket update", match: /generating ticket update|revising active work ticket/i },
		{ label: "Write active ticket", match: /writing active work ticket|updating active/i },
	];
	return [
		{ label: "Check destination", match: /checking Scryer destination/i },
		{ label: "Generate summary", match: /summarizing with active model/i },
		{ label: "Write local summary", match: /writing local summary/i },
		{ label: "Create/update Daily", match: /creating\/updating daily|daily ticket missing/i },
		{ label: "Write Daily", match: /writing daily ticket/i },
		{ label: "Update work ticket", match: /updating active work ticket/i },
	];
}

async function foregroundScryer(ctx: ExtensionContext, label: string, fn: () => Promise<void>) {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		await fn();
		return;
	}
	const result = await ctx.ui.custom<Error | null>((tui, theme, _kb, done) => {
		let step = label;
		let frame = 0;
		foregroundPlan = planForScryer(label);
		foregroundStepIndex = 0;
		const frames = ["·", "•", "●", "•"];
		const timer = setInterval(() => { frame = (frame + 1) % frames.length; tui.requestRender(); }, 140);
		foregroundStepUpdate = (line: string) => { step = line; tui.requestRender(); };
		fn()
			.then(() => done(null))
			.catch((err) => done(err instanceof Error ? err : new Error(String(err))))
			.finally(() => { clearInterval(timer); foregroundStepUpdate = undefined; foregroundPlan = []; foregroundStepIndex = 0; });
		return {
			render: (w: number) => {
				const c = new Container();
				const borderColor = (s: string) => theme.fg("border", s);
				c.addChild(new DynamicBorder(borderColor));
				c.addChild(new Text(`${theme.fg("accent", frames[frame])} ${theme.bold("Scryer")}: ${label}`, 1, 0));
				foregroundPlan.forEach((planned, i) => {
					const marker = i < foregroundStepIndex ? theme.fg("muted", "✓") : i === foregroundStepIndex ? theme.fg("accent", "●") : theme.fg("dim", "○");
					const text = i === foregroundStepIndex ? theme.fg("accent", planned.label) : i < foregroundStepIndex ? theme.fg("muted", planned.label) : theme.fg("dim", planned.label);
					c.addChild(new Text(`  ${marker} ${text}`, 1, 0));
				});
				c.addChild(new Text(theme.fg("dim", `  current: ${step}`), 1, 0));
				for (const line of saveDestinationLines(step).slice(1)) c.addChild(new Text(theme.fg("muted", line), 1, 0));
				if (queuedInputs.length) c.addChild(new Text(theme.fg("warning", `  Queued messages → ${queuedInputs.length}`), 1, 0));
				c.addChild(new DynamicBorder(borderColor));
				return c.render(w);
			},
			invalidate: () => {},
			handleInput: () => { ctx.ui.notify("Scryer is working; input is held until it finishes.", "info"); },
			dispose: () => { clearInterval(timer); foregroundStepUpdate = undefined; foregroundPlan = []; foregroundStepIndex = 0; },
		};
	});
	if (result) throw result;
}

async function runForegroundSave(reason: string, ctx: ExtensionContext, endSession = false) {
	let saved = false;
	await foregroundScryer(ctx, `Saving Scryer (${reason})`, async () => {
		saved = await summarizeAndPersist(reason, ctx, endSession);
	});
	if (saved) showCompletion(ctx, "save");
}

function queueSave(reason: string, ctx: ExtensionContext, endSession = false) {
	pendingSave = { reason, ctx, endSession };
	if (ctx.hasUI) ctx.ui.notify(`Scryer save queued: ${reason}`, "info");
}

async function flushPendingSave(ctx?: ExtensionContext) {
	if (!pendingSave || scryerBusy) return;
	const save = pendingSave;
	const runCtx = ctx ?? save.ctx;
	if (runCtx.isIdle && !runCtx.isIdle()) return;
	pendingSave = undefined;
	await runForegroundSave(save.reason, runCtx, save.endSession);
}

async function requestSave(reason: string, ctx: ExtensionContext, endSession = false, force = false) {
	activeCtx = ctx;
	if (!force && ((ctx.isIdle && !ctx.isIdle()) || scryerBusy)) {
		queueSave(reason, ctx, endSession);
		return;
	}
	await runForegroundSave(reason, ctx, endSession);
}

async function summarizeAndPersist(reason: string, ctx: ExtensionContext, endSession = false): Promise<boolean> {
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
			return false;
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
		return true;
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
		if (activeCtx) requestSave("idle", activeCtx, true, false).catch(() => undefined);
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
		state.sessionStartedAt ??= Date.now();
		state.lastActivityAt = Date.now();
		if (ctx.hasUI) {
			clearTransientWidget(ctx, "scryer-recorder");
			ctx.ui.setWidget("scryer-recorder-deets", undefined);
		}
		await saveState(state);
		// Disabled for smux/iPad usability: do not block startup on keyboard-driven
		// project/ticket pickers. The picker functionality remains available via
		// /pp, /pt, and the existing input-time context gate.
		// await ensureScryerContext(ctx, "startup");
	});

	pi.on("input", async (event, ctx) => {
		state ??= await loadState(pi, ctx);
		// Disabled for smux/iPad usability: do not interrupt normal input with
		// keyboard-driven project/ticket pickers. Manual selection remains
		// available via /pp, /pt, and related Scryer commands.
		// if (!scryerBusy && !(await ensureScryerContext(ctx, "input"))) return { action: "handled" as const };
		if (!scryerBusy) return { action: "continue" as const };
		queuedInputs.push({ text: event.text, images: event.images as any });
		if (ctx.hasUI) {
			ctx.ui.notify(`Queued message until Scryer finishes: ${scryerBusy.label}`, "info");
			setTransientWidget(ctx, "scryer-recorder", [
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

	pi.on("tool_result", async (event: any, ctx) => {
		const last = [...recentTools].reverse().find((t) => t.name === event.toolName && t.ok === undefined);
		const ok = !event.result?.isError;
		if (last) {
			last.ok = ok;
			last.error = event.result?.isError ? contentText(event.result?.content).slice(0, 200) : undefined;
		}
		if (event.toolName === "bash") {
			const input = (event.input ?? last?.input) as any;
			const command = String(input?.command ?? "");
			await recordCommitIfAny(ctx, command, ok);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		state ??= await loadState(pi, ctx);
		state.outputTokensSinceSummary += outputTokens(event.message as AssistantMessage);
		state.lastActivityAt = Date.now();
		await saveState(state);
		if (state.outputTokensSinceSummary >= OUTPUT_TOKEN_THRESHOLD) {
			await requestSave("output-token-threshold", ctx, false, false);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeCtx = ctx;
		state ??= await loadState(pi, ctx);
		state.lastActivityAt = Date.now();
		await saveState(state);
		await flushPendingSave(ctx);
		scheduleIdle(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (idleTimer) clearTimeout(idleTimer);
		for (const timer of widgetTimers.values()) clearTimeout(timer);
		widgetTimers.clear();
		await saveState(state);
	});

	const register = (name: string, description: string, handler: (ctx: ExtensionContext, args: string) => Promise<void>) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				try {
					activeCtx = ctx;
					state ??= await loadState(pi, ctx);
					if (!(await ensurePmReachable(ctx, state, saveState))) return;
					await handler(ctx, String(args ?? "").trim());
				} catch (err: any) {
					if (ctx.hasUI) ctx.ui.notify(`Scryer recorder ${name} failed: ${err?.message ?? err}`, "error");
				} finally {
					setRecorderProgress(ctx, undefined);
				}
			},
		});
	};

	register("pp", "Set Scryer project by ID, or open repo-aware project picker", async (ctx, args) => { args ? await setActiveProjectById(ctx, args) : await pickActiveProject(ctx); });
	register("project-picker", "Repo-aware Scryer project picker", async (ctx) => { await pickActiveProject(ctx); });
	register("pick-project", "Repo-aware Scryer project picker", async (ctx) => { await pickActiveProject(ctx); });
	register("tp", "Set Scryer ticket by ID, or open ticket picker for the selected project", async (ctx, args) => { args ? await setActiveTicketById(ctx, args) : await pickActiveTicket(ctx); });
	register("ticket-picker", "Scryer ticket picker for the selected project", async (ctx) => { await pickActiveTicket(ctx); });
	register("pt", "Scryer ticket picker for the selected project", async (ctx) => { await pickActiveTicket(ctx); });
	register("pick-ticket", "Scryer ticket picker for the selected project", async (ctx) => { await pickActiveTicket(ctx); });
	register("ut", "Update selected ticket from current session without writing Daily", updateActiveTaskDescription);
	register("update", "Update selected ticket from current session without writing Daily", updateActiveTaskDescription);
	register("update-ticket", "Update selected ticket from current session without writing Daily", updateActiveTaskDescription);
	register("ac", "Add recorder summary as a comment on selected ticket", addActiveTaskComment);
	register("add-comments", "Add recorder summary as a comment on selected ticket", addActiveTaskComment);

	pi.registerCommand("scryer", {
		description: "Show available slash commands in a Scryer modal",
		handler: async (args, ctx) => {
			try {
				const filter = args.trim() as "extension" | "prompt" | "skill" | "";
				const commands = pi.getCommands?.() ?? [];
				const filtered = filter ? commands.filter((cmd: any) => cmd.source === filter) : commands;
				const lines: string[] = [];
				lines.push(`Commands available: ${filtered.length}${filter ? ` (${filter})` : ""}`);
				lines.push("Built-in TUI commands may not be listed here.");
				lines.push("");
				const sources: Array<{ key: string; label: string }> = [
					{ key: "extension", label: "Extensions" },
					{ key: "prompt", label: "Prompts" },
					{ key: "skill", label: "Skills" },
				];
				for (const source of sources) {
					const group = filtered.filter((cmd: any) => cmd.source === source.key).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
					if (!group.length) continue;
					lines.push(`## ${source.label}`);
					for (const cmd of group) {
						const desc = cmd.description ? ` — ${cmd.description}` : "";
						const scope = cmd.sourceInfo?.scope ? ` [${cmd.sourceInfo.scope}]` : "";
						lines.push(`/${cmd.name}${scope}${desc}`);
					}
					lines.push("");
				}
				await showScrollableModal(ctx, "Scryer commands", lines, "usage: /scryer [extension|prompt|skill]");
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Scryer command list failed: ${err?.message ?? err}`, "error");
			}
		},
	});

	pi.registerCommand("modal-config", {
		description: "Configure modal width/height/top. Usage: /modal-config [width <cols>] [height <rows>] [top <rows>] | /modal-config <cols> <rows> [top] | /modal-config reset",
		handler: async (args, ctx) => {
			try {
				const existing = await readModalConfig();
				const parsed = parseModalConfigArgs(args, existing);
				if (parsed.config && !parsed.showOnly) await writeModalConfig(parsed.config);
				const message = parsed.showOnly && parsed.config
					? `modal config: ${describeModalConfig(parsed.config)}`
					: parsed.message;
				if (ctx.hasUI) ctx.ui.notify(message, parsed.config ? "info" : "error");
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`modal-config failed: ${err?.message ?? err}`, "error");
			}
		},
	});

	pi.registerCommand("cockpit", {
		description: "Open Scryer session cockpit",
		handler: async (_args, ctx) => {
			try {
				activeCtx = ctx;
				state ??= await loadState(pi, ctx);
				await showCockpit(ctx);
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Scryer cockpit failed: ${err?.message ?? err}`, "error");
			}
		},
	});

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
				await requestSave("manual-save", ctx, false, true);
			} catch (err: any) {
				if (ctx.hasUI) ctx.ui.notify(`Scryer recorder save failed: ${err?.message ?? err}`, "error");
			}
		},
	});
}
