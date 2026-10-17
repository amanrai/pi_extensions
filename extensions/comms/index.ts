import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalMetadata, goalOperations, initializeGoalFile, sessionGoalPath, transitionGoal } from "./goals.ts";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir, hostname } from "node:os";
import { Type } from "typebox";
import { isDeepStrictEqual } from "node:util";
import { beforeCodeChange, afterCodeChange, type ChangeSnapshot } from "./changes.ts";
import { confirmedCommits, snapshotCommits } from "./commands.ts";
import { windowActivity, idleTimers, type WindowActivity, type RecapDelivery, type RecapSender } from "./activity.ts";
import { localRepoRoot } from "./repository.ts";
import { RECAP_SYSTEM_PROMPT, prepareIdleRecap, prepareManualRecap, deliverRecap } from "./recaps.ts";
import { detectRuntimeMachineName, initializeStartupIdentity, recordFolderActions, refreshStartupRepo, updateIdentityMetadata, type StartupIdentity } from "./identity.ts";
import { startIdentityRegistration } from "./registration.ts";
import { formatUpdateBody, extractJson } from "./updates.ts";
import { FOLDER_TOUCH, FOLDER_TOUCHES_SENT, observeFolderTouch, pendingFolderTouches, selectUpdateFolders, type FolderTouch } from "./folders.ts";

type InteractionChoice = { id: string; label: string; send?: string; custom?: boolean };
type InteractionRequest = {
  id: string;
  from: string;
  kind: string;
  payload: {
    title?: string;
    body?: string;
    choices?: InteractionChoice[];
    [key: string]: unknown;
  };
};
type InteractionResponse = {
  id: string;
  requestId: string;
  from: string;
  responder: Record<string, unknown>;
  response: { kind: string; choiceId?: string; text?: string; [key: string]: unknown };
  receivedAt?: string;
};
type SessionUpdate = {
  id: string;
  from: string;
  kind: "progress" | "decision" | "blocked" | "waiting" | "done" | "error";
  title: string;
  body: string;
  level?: "info" | "success" | "warning" | "error";
  metadata?: Record<string, unknown>;
  createdAt?: string;
  receivedAt?: string;
};

type CommsState = {
  bySession: Record<string, string>;
  sessionTaskBySession?: Record<string, string>;
};

type PmProject = { id: string; name: string; slug?: string; description_md?: string };
type PmTaskType = { id: string; key?: string; name?: string; is_default?: number | boolean };
type PmTask = { id: string; title: string; description_md?: string };

// Default interaction service: henrietta (the visor-gateway container hosts it).
const SERVICE_URL = (process.env.SCRYER_INTERACTIONS_URL ?? "http://100.112.203.22:43217").replace(/\/$/, "");
const PM_URL = (process.env.SCRYER_PM_URL ?? "http://smux-linode:43210").replace(/\/$/, "");
const SESSIONS_PROJECT_SLUG = process.env.SCRYER_SESSIONS_PROJECT_SLUG ?? "agent-sessions";
const SESSIONS_PROJECT_ID = process.env.SCRYER_SESSIONS_PROJECT_ID;
const SESSIONS_TASK_TYPE_ID = process.env.SCRYER_SESSIONS_TASK_TYPE_ID;
const STATE_DIR = join(homedir(), ".pi", "agent", "comms");
const STATE_PATH = join(STATE_DIR, "state.json");
const INFERENCE_LOG_PATH = join(STATE_DIR, "inference-log.jsonl");
const MARKER_PREFIX = "@@SCRYER_INTERACTION_PRODUCER_V1@@";
const MARKER_SUFFIX = "@@END_SCRYER_INTERACTION_PRODUCER@@";
const MARKER_RE = /^@@SCRYER_INTERACTION_PRODUCER_V1@@(\{[^\r\n]*\})@@END_SCRYER_INTERACTION_PRODUCER@@$/;

let currentCtx: ExtensionContext | undefined;
let producerFrom: string | undefined;
let startupIdentity: StartupIdentity | undefined;
let identityRegistration: ReturnType<typeof startIdentityRegistration> | undefined;
let machineName = hostname();
let consumerEnabled = false;
let consumerTimer: NodeJS.Timeout | undefined;
let responseTimer: NodeJS.Timeout | undefined;
let terminalInputUnsubscribe: (() => void) | undefined;
let activeModalRequestId: string | undefined;
let lastResponseSince = "";
let inferenceDelayMs = Number(process.env.SCRYER_COMMS_INFERENCE_DELAY_MS ?? 30_000);
let updateBatchTurns = Number.isFinite(Number(process.env.SCRYER_COMMS_UPDATE_BATCH_TURNS)) ? Math.max(1, Math.floor(Number(process.env.SCRYER_COMMS_UPDATE_BATCH_TURNS))) : 3;
let pendingInference: { timer?: NodeJS.Timeout; abort?: AbortController; token: number } | undefined;
let inferenceToken = 0;
let updateInferenceToken = 0;
let semanticUpdateCursor = 0;
let semanticUpdateRunning = false;
let semanticUpdatePromise: Promise<void> | undefined;
let lastUpdatePostAt = 0;
let lastUpdateHash = "";
let appendSentTouches: (updateId: string, touchIds: string[]) => void;
const discoveredFrom = new Set<string>();
const processedResponses = new Set<string>();
let activity: WindowActivity | undefined;
let recapScope = "";
let recapRepo = "";
let activeSession = "";
let idle: ReturnType<typeof idleTimers> | undefined;
let lifetime = new AbortController();
let recapAbort: AbortController | undefined;
let agentBusy = false;
const changeSnapshots = new Map<string, ChangeSnapshot | undefined>();
const commitSnapshots = new Map<string, Map<string, string | undefined>>();

function userActivity() {
  activity?.touch();
  recapAbort?.abort();
  idle?.reset();
}

function recordActivity(role: string, text: string) {
  activity?.record(recapScope, activeSession, role, text);
  userActivity();
}

function canRunIdle(ctx: ExtensionContext) {
  return !agentBusy && !editorHasDraft(ctx) && ctx.isIdle() && !ctx.hasPendingMessages();
}

const RESET = "\x1b[0m";
const BG = "\x1b[48;2;0;0;0m";
const FG = "\x1b[38;2;255;255;255m";
const BOLD = "\x1b[1m";
const CONTENT_PAD = 2;

function insetLine(s: string, width: number): string {
  const pad = " ".repeat(Math.min(CONTENT_PAD, Math.floor(width / 4)));
  const innerWidth = Math.max(1, width - visibleWidth(pad) * 2);
  return pad + padAnsi(truncateToWidth(s, innerWidth), innerWidth) + pad;
}

const overlayStyle = {
  line(s: string, width: number) { return BG + FG + insetLine(s, width) + RESET; },
  muted(s: string, width?: number) { return width ? BG + FG + insetLine(s, width) + RESET : BG + FG + s + RESET; },
  title(s: string, width?: number) { return width ? BG + BOLD + FG + insetLine(s, width) + RESET : `${BG}${BOLD}${FG}${s}${RESET}`; },
  accent(s: string) { return BG + FG + s + RESET; },
  border(width: number) { return BG + FG + "─".repeat(Math.max(1, width)) + RESET; },
};

const MODAL_OVERLAY_OPTIONS = { anchor: "center", offsetY: 0, width: "90%", maxHeight: "80%" } as const;

async function readState(): Promise<CommsState> {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")) as CommsState; }
  catch { return { bySession: {} }; }
}

async function writeState(state: CommsState) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function sessionKey(ctx: ExtensionContext) {
  // The runtime ID exists before the first session-file write, and survives resume.
  const id = ctx.sessionManager.getSessionId?.();
  if (id) return `pi-session:${id}`;
  const file = ctx.sessionManager.getSessionFile?.();
  if (file) {
    try {
      const first = (await readFile(file, "utf8")).split(/\r?\n/, 1)[0];
      const header = JSON.parse(first || "{}");
      if (typeof header.id === "string" && header.id) return `pi-session:${header.id}`;
    } catch {}
    return `pi-session-file:${createHash("sha1").update(file).digest("hex")}`;
  }
  return `pi-ephemeral:${createHash("sha1").update(`${ctx.cwd}:${process.pid}`).digest("hex")}`;
}

async function ensureProducerFrom(ctx: ExtensionContext) {
  const key = await sessionKey(ctx);
  const state = await readState();
  state.bySession[key] ??= randomUUID();
  await writeState(state);
  return state.bySession[key];
}

function observeMarker(line: string) {
  const match = MARKER_RE.exec(line.trim());
  if (!match) return;
  try {
    const payload = JSON.parse(match[1]);
    if (typeof payload.from === "string" && payload.from) discoveredFrom.add(payload.from);
  } catch {}
}

function producerMarker(from: string, ctx: ExtensionContext) {
  return `${MARKER_PREFIX}${JSON.stringify({
    from,
    emittedAt: new Date().toISOString(),
    kind: "pi",
    cwd: ctx.cwd,
    identity: startupIdentity?.name,
    sessionFile: ctx.sessionManager.getSessionFile?.() ? basename(ctx.sessionManager.getSessionFile()!) : undefined,
  })}${MARKER_SUFFIX}`;
}

function emitMarker(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!producerFrom) return;
  const marker = producerMarker(producerFrom, ctx);
  observeMarker(marker);
  pi.sendMessage({ customType: "scryer-comms-producer", content: marker, display: true });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVICE_URL}${path}`, { ...init, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]), headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return await res.json() as T;
}

async function pmApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PM_URL}${path}`, { ...init, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]), headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`PM API ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function logInference(row: Record<string, unknown>) {
  await mkdir(STATE_DIR, { recursive: true });
  await appendFile(INFERENCE_LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), from: producerFrom, ...row })}\n`);
}

function textFromMessage(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
  return "";
}

function recentConversation(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  const items: { role: "user" | "assistant"; text: string }[] = [];
  let users = 0;
  let assistants = 0;
  for (let i = branch.length - 1; i >= 0 && (users < 3 || assistants < 3); i--) {
    const entry: any = branch[i];
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (role === "user" && users >= 3) continue;
    if (role === "assistant" && assistants >= 3) continue;
    const text = textFromMessage(entry.message).trim();
    if (!text) continue;
    if (role === "user") users += 1;
    else assistants += 1;
    items.push({ role, text });
  }
  return items.reverse();
}

function cancelPendingInference(reason: string) {
  if (!pendingInference) return;
  if (pendingInference.timer) clearTimeout(pendingInference.timer);
  pendingInference.abort?.abort();
  void logInference({ event: "cancelled", reason, token: pendingInference.token });
  pendingInference = undefined;
}

function editorHasDraft(ctx: ExtensionContext) {
  if (!ctx.hasUI || ctx.mode !== "tui") return false;
  try { return Boolean(ctx.ui.getEditorText?.().trim()); }
  catch { return false; }
}

function updateHash(update: Pick<SessionUpdate, "kind" | "title" | "body" | "level">) {
  return createHash("sha1")
    .update(`${update.kind}\n${update.level ?? ""}\n${update.title.trim().toLowerCase()}\n${update.body.trim().toLowerCase()}`)
    .digest("hex");
}

function normalizeChoices(choices: any[]): InteractionChoice[] {
  return choices.slice(0, 5).map((choice, idx) => ({
    id: typeof choice.id === "string" && choice.id ? choice.id : `choice-${idx + 1}`,
    label: String(choice.label ?? choice.send ?? `Choice ${idx + 1}`).slice(0, 120),
    send: typeof choice.send === "string" ? choice.send : undefined,
    custom: Boolean(choice.custom),
  })).filter((choice) => choice.label.trim());
}

function padAnsi(s: string, width: number) {
  const v = visibleWidth(s);
  return v >= width ? truncateToWidth(s, width) : s + " ".repeat(width - v);
}

async function submitResponse(request: InteractionRequest, response: InteractionResponse["response"]) {
  await api("/api/responses", {
    method: "POST",
    body: JSON.stringify({
      id: randomUUID(),
      requestId: request.id,
      from: request.from,
      responder: { kind: "pi-tui", pid: process.pid },
      response,
    }),
  });
}

async function showInteractionModal(ctx: ExtensionContext, request: InteractionRequest) {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  activeModalRequestId = request.id;
  const choices = request.payload.choices?.length ? request.payload.choices : [{ id: "custom", label: "Type response…", custom: true }];
  await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
    let selected = 0;
    let customMode = false;
    let draft = "";
    function finish() { done(undefined); }
    return {
      render: (width: number) => {
        const panelWidth = Math.max(20, width - 2);
        const lines: string[] = [];
        lines.push(overlayStyle.border(panelWidth));
        lines.push(overlayStyle.title(String(request.payload.title ?? "Input needed"), panelWidth));
        const body = String(request.payload.body ?? "The agent is waiting for direction.");
        for (const line of body.split(/\r?\n/).slice(0, 6)) lines.push(overlayStyle.line(truncateToWidth(line || " ", panelWidth - 4), panelWidth));
        lines.push(overlayStyle.line("", panelWidth));
        if (customMode) {
          lines.push(overlayStyle.muted("Type response", panelWidth));
          lines.push(overlayStyle.line(padAnsi(truncateToWidth(draft || " ", panelWidth - 4), panelWidth - 4), panelWidth));
          lines.push(overlayStyle.muted("enter send • esc dismiss", panelWidth));
        } else {
          choices.forEach((choice, idx) => {
            const prefix = idx === selected ? "> " : "  ";
            const text = `${prefix}${choice.label}`;
            lines.push(idx === selected ? overlayStyle.accent(padAnsi(truncateToWidth(text, panelWidth), panelWidth)) : overlayStyle.line(text, panelWidth));
          });
          lines.push(overlayStyle.muted("↑↓ choose • enter select • esc dismiss", panelWidth));
        }
        lines.push(overlayStyle.border(panelWidth));
        return lines;
      },
      invalidate: () => {},
      handleInput: async (data: string) => {
        try {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            await submitResponse(request, { kind: "dismiss" });
            return finish();
          }
          if (customMode) {
            if (matchesKey(data, Key.enter)) {
              if (draft.trim()) await submitResponse(request, { kind: "custom", text: draft.trim() });
              return finish();
            }
            if (matchesKey(data, Key.backspace)) draft = draft.slice(0, -1);
            else if (data >= " " && !data.startsWith("\x1b")) draft += data;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
          else if (matchesKey(data, Key.down)) selected = Math.min(choices.length - 1, selected + 1);
          else if (matchesKey(data, Key.enter)) {
            const choice = choices[selected];
            if (choice.custom) { customMode = true; tui.requestRender(); return; }
            await submitResponse(request, { kind: "choice", choiceId: choice.id, text: choice.send ?? choice.label });
            return finish();
          }
          tui.requestRender();
        } catch (err: any) {
          ctx.ui.notify(`comms response failed: ${err?.message ?? err}`, "error");
          finish();
        }
      },
    };
  }, { overlay: true, overlayOptions: MODAL_OVERLAY_OPTIONS });
  activeModalRequestId = undefined;
}

async function pollActiveRequests(ctx: ExtensionContext) {
  if (!consumerEnabled || activeModalRequestId || discoveredFrom.size === 0) return;
  const from = [...discoveredFrom].join(",");
  const data = await api<{ requests: InteractionRequest[] }>(`/api/requests/active?from=${encodeURIComponent(from)}`);
  const next = data.requests[0];
  if (next) void showInteractionModal(ctx, next);
}

async function pollResponses(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!producerFrom) return;
  const qs = lastResponseSince ? `?from=${encodeURIComponent(producerFrom)}&since=${encodeURIComponent(lastResponseSince)}` : `?from=${encodeURIComponent(producerFrom)}`;
  const data = await api<{ responses: InteractionResponse[] }>(`/api/responses${qs}`);
  for (const response of data.responses) {
    if (processedResponses.has(response.id)) continue;
    processedResponses.add(response.id);
    if (response.receivedAt) lastResponseSince = response.receivedAt;
    if (response.response.kind === "dismiss") continue;
    const text = response.response.text?.trim();
    if (!text) continue;
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  }
}

function stopTimers() {
  lifetime.abort();
  recapAbort?.abort();
  idle?.stop();
  idle = undefined;
  identityRegistration?.stop();
  identityRegistration = undefined;
  if (consumerTimer) clearInterval(consumerTimer);
  if (responseTimer) clearInterval(responseTimer);
  terminalInputUnsubscribe?.();
  consumerTimer = undefined;
  responseTimer = undefined;
  terminalInputUnsubscribe = undefined;
}

async function startComms(pi: ExtensionAPI, ctx: ExtensionContext) {
  stopTimers();
  cancelPendingInference("session-start");
  lifetime = new AbortController();
  agentBusy = false;
  changeSnapshots.clear();
  commitSnapshots.clear();
  currentCtx = ctx;
  producerFrom = await ensureProducerFrom(ctx);
  startupIdentity = undefined;
  try {
    [startupIdentity, machineName] = await Promise.all([
      initializeStartupIdentity(ctx.cwd, await sessionKey(ctx)),
      detectRuntimeMachineName(ctx.cwd),
    ]);
  } catch (err: any) {
    const error = err?.message ?? String(err);
    ctx.ui.notify(`Scryer identity initialization failed: ${error}`, "error");
    await logInference({ event: "identity-startup-error", error });
  }
  activeSession = await sessionKey(ctx);
  try {
    const path = sessionGoalPath(ctx);
    await initializeGoalFile(path);
    pi.sendMessage({ customType: "scryer-session-goals", content: `Session Goal file: ${path}. Use goal_start, goal_finish, goal_complete, goal_abandon and goal_ready_for_review to manage mutually exclusive current, finish, complete, abandon and ready_for_review lists. These tools do not update the PM system.`, display: false });
  } catch (error: any) { warnGoals(ctx, `Session Goal initialization failed: ${error?.message ?? String(error)}`); }
  activity = windowActivity(ctx.sessionManager);
  recapRepo = await localRepoRoot(ctx.cwd);
  recapScope = `${machineName}:${recapRepo}`;
  activity.touch();
  semanticUpdateCursor = ctx.sessionManager.getBranch().length;
  semanticUpdateRunning = false;
  semanticUpdatePromise = undefined;
  publishCommsStatus();
  // Do not replay old responses after reload/resume. Comms responses are edge-triggered.
  lastResponseSince = new Date().toISOString();
  processedResponses.clear();
  emitMarker(pi, ctx);
  const identity = startupIdentity;
  if (identity) {
    identityRegistration = startIdentityRegistration({
      name: identity.name, session: await sessionKey(ctx), directory: identity.directory,
      machine: machineName, serviceUrl: SERVICE_URL,
      onRepo: (repo) => refreshStartupRepo(identity, repo),
      onError: (err: any) => logInference({ event: "identity-registration-error", error: err?.message ?? String(err) }),
    });
  }
  consumerTimer = setInterval(() => { if (currentCtx) pollActiveRequests(currentCtx).catch(() => {}); }, 1200);
  responseTimer = setInterval(() => { if (currentCtx) pollResponses(pi, currentCtx).catch(() => {}); }, 1200);
  if (ctx.hasUI && ctx.mode === "tui") {
    idle = idleTimers({
      activity, canRun: () => canRunIdle(ctx),
      flush: () => forceSemanticUpdateFlush(ctx),
      recap: () => runIdleRecap(ctx),
      onError: (kind, error: any) => { void logInference({ event: `idle-${kind}-error`, error: error?.message ?? String(error) }); },
    });
    terminalInputUnsubscribe = ctx.ui.onTerminalInput(() => {
      userActivity();
      if (pendingInference) cancelPendingInference("terminal-input");
    });
    idle.reset();
  }
}

async function createInteractionRequest(payload: InteractionRequest["payload"]) {
  if (!producerFrom) throw new Error("comms not initialized");
  const id = randomUUID();
  await api("/api/requests", {
    method: "POST",
    body: JSON.stringify({ id, from: producerFrom, kind: "choice", payload, createdAt: new Date().toISOString() }),
  });
  return id;
}

function formatSessionTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`.trim();
}

function sessionRepoLabel(ctx: ExtensionContext) {
  return basename(ctx.cwd || process.cwd()) || "Pi";
}

function sessionFileLabel(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile?.();
  return file ? basename(file) : "unknown";
}

function sessionTaskTitle(ctx: ExtensionContext) {
  return `Pi Session — ${sessionRepoLabel(ctx)} — ${formatSessionTime()}`;
}

function initialSessionDescription(ctx: ExtensionContext, key: string) {
  const lines = [
    `# ${sessionTaskTitle(ctx)}`,
    "",
    `Started: ${new Date().toISOString()}`,
    `CWD: ${ctx.cwd}`,
    `Session file: ${sessionFileLabel(ctx)}`,
    `Producer: ${producerFrom ?? "unknown"}`,
    `Session key: ${key}`,
    "",
    "## Updates",
    "",
    "<!-- scryer-comms-updates:start -->",
    "<!-- scryer-comms-updates:end -->",
  ];
  return lines.join("\n");
}

async function findSessionsProject() {
  if (SESSIONS_PROJECT_ID) return await pmApi<PmProject>(`/api/projects/${encodeURIComponent(SESSIONS_PROJECT_ID)}`);
  const projects = await pmApi<PmProject[]>("/api/projects");
  const slug = SESSIONS_PROJECT_SLUG.toLowerCase();
  const found = projects.find((project) => String(project.slug ?? "").toLowerCase() === slug || String(project.name ?? "").toLowerCase() === slug);
  if (!found) throw new Error(`Sessions project not found: ${SESSIONS_PROJECT_SLUG}`);
  return found;
}

async function findSessionTaskType(projectId: string) {
  if (SESSIONS_TASK_TYPE_ID) return SESSIONS_TASK_TYPE_ID;
  const types = await pmApi<PmTaskType[]>(`/api/task-types?project_id=${encodeURIComponent(projectId)}`);
  const preferred = types.find((type) => type.key === "work") ?? types.find((type) => type.is_default) ?? types[0];
  if (!preferred?.id) throw new Error("Sessions project has no task types");
  return preferred.id;
}

async function ensureSessionTask(ctx: ExtensionContext, target?: RecapSender["task"]) {
  const key = target?.key ?? await sessionKey(ctx);
  const state = await readState();
  const existingId = state.sessionTaskBySession?.[key];
  if (existingId) return existingId;

  const project = await findSessionsProject();
  const taskTypeId = await findSessionTaskType(project.id);
  const task = await pmApi<PmTask>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: target?.title ?? sessionTaskTitle(ctx),
      project_id: project.id,
      task_type_id: taskTypeId,
      status: "in_execution",
      description_md: target?.description ?? initialSessionDescription(ctx, key),
      tag_names: ["pi"],
      created_by_role: "pi",
      created_by_instance_key: "comms",
    }),
  });
  state.sessionTaskBySession ??= {};
  state.sessionTaskBySession[key] = task.id;
  await writeState(state);
  await logInference({ event: "session-task-created", taskId: task.id, projectId: project.id, key });
  return task.id;
}

function updateEntryMarkdown(update: SessionUpdate) {
  const created = update.createdAt ?? new Date().toISOString();
  return [
    `<!-- scryer-comms-update:id=${update.id} -->`,
    `### ${created} — ${update.kind} — ${update.title}`,
    "",
    update.body.trim(),
    "",
  ].join("\n");
}

function appendUpdateToDescription(description: string | undefined, update: SessionUpdate) {
  const marker = `<!-- scryer-comms-update:id=${update.id} -->`;
  const start = "<!-- scryer-comms-updates:start -->";
  const end = "<!-- scryer-comms-updates:end -->";
  const base = description?.trim() || ["# Pi Session", "", "## Updates", "", start, end].join("\n");
  if (base.includes(marker)) return base;
  const entry = updateEntryMarkdown(update).trimEnd();
  if (base.includes(start) && base.includes(end)) return base.replace(end, `${entry}\n\n${end}`);
  return `${base}\n\n## Updates\n\n${start}\n${entry}\n\n${end}`;
}

async function appendSessionTaskUpdate(ctx: ExtensionContext, update: SessionUpdate, target?: RecapSender["task"]) {
  const taskId = await ensureSessionTask(ctx, target);
  const task = await pmApi<PmTask>(`/api/tasks/${encodeURIComponent(taskId)}`);
  const description_md = appendUpdateToDescription(task.description_md, update);
  if (description_md === task.description_md) return;
  await pmApi(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify({ description_md }),
  });
  await logInference({ event: "session-task-updated", taskId, updateId: update.id, kind: update.kind });
}

function warnGoals(ctx: ExtensionContext | undefined, message: string) {
  if (ctx?.hasUI) ctx.ui.notify(message, "warning");
  else console.error(message);
  void logInference({ event: "goal-tracking-warning", message }).catch(() => {});
}

async function createSessionUpdate(update: Omit<SessionUpdate, "id" | "from" | "createdAt" | "receivedAt">, options: { force?: boolean; ctx?: ExtensionContext; foldersTouched?: string[]; coding?: boolean; id?: string; fullBody?: boolean; verify?: boolean; signal?: AbortSignal; sender?: RecapSender; createdAt?: string; transition?: boolean; goals?: { id: string; title: string }[] } = {}) {
  if (!producerFrom && !options.sender) throw new Error("comms not initialized");
  if (!startupIdentity && !options.sender) throw new Error("Scryer startup identity is required for updates");
  const from = options.sender?.from ?? producerFrom!;
  const ctx = options.ctx ?? currentCtx;
  let metadata: Record<string, unknown> = updateIdentityMetadata(update.metadata, options.sender?.identity ?? startupIdentity!.name, options.foldersTouched);
  try {
    if (!ctx) throw new Error("Main Pi session context unavailable");
    metadata = options.goals
      ? { ...metadata, v2meta: { ...(metadata.v2meta as Record<string, unknown>), goals: options.goals } }
      : await goalMetadata(options.sender?.goalPath ?? sessionGoalPath(ctx), metadata, message => warnGoals(ctx, message));
  } catch (error: any) {
    warnGoals(ctx, `Scryer Goal attribution failed: ${error?.message ?? String(error)}; sending goals: []`);
    metadata = { ...metadata, v2meta: { ...(metadata.v2meta as Record<string, unknown>), goals: [] } };
  }
  const normalized = {
    kind: update.kind,
    title: update.title.trim().slice(0, 140),
    body: formatUpdateBody(update.body, options.coding, options.fullBody ? Infinity : undefined),
    level: update.level,
  };
  if (!normalized.title || !normalized.body) throw new Error("update title and body required");
  const hash = updateHash(normalized);
  const important = update.kind === "blocked" || update.kind === "error" || update.kind === "done" || update.kind === "waiting";
  if (!options.force && hash === lastUpdateHash) return undefined;
  if (!options.force && !important && Date.now() - lastUpdatePostAt < 45_000) return undefined;
  const id = options.id ?? randomUUID();
  const createdAt = options.createdAt ?? new Date().toISOString();
  const payload = { id, from, ...normalized, metadata, createdAt };
  options.signal?.throwIfAborted();
  try {
    await api("/api/updates", { method: "POST", body: JSON.stringify(payload), signal: options.signal ?? AbortSignal.timeout(10_000) });
  } catch (error) {
    // A retry may encounter an already-stored part after a lost acknowledgment.
    if (!options.verify || options.signal?.aborted) throw error;
    await verifyStoredUpdate(payload, options.signal);
  }
  if (options.verify) await verifyStoredUpdate(payload, options.signal);
  options.signal?.throwIfAborted();
  if (!options.transition) {
    lastUpdatePostAt = Date.now();
    lastUpdateHash = hash;
  }
  if (ctx && !options.transition) {
    await appendSessionTaskUpdate(ctx, payload, options.sender?.task)
      .catch((err) => logInference({ event: "session-task-error", updateId: id, error: err?.message ?? String(err) }));
  }
  options.signal?.throwIfAborted();
  return id;
}

async function verifyStoredUpdate(update: SessionUpdate, signal?: AbortSignal) {
  const data = await api<{ updates: SessionUpdate[] }>(`/api/updates?from=${encodeURIComponent(update.from)}&limit=500`, { signal: signal ?? AbortSignal.timeout(10_000) });
  const stored = data.updates.find((row) => row.id === update.id);
  if (!stored || stored.from !== update.from || stored.title !== update.title || stored.body !== update.body ||
    stored.kind !== update.kind || stored.level !== update.level || stored.createdAt !== update.createdAt ||
    !isDeepStrictEqual(stored.metadata, update.metadata)) {
    throw new Error(`Full recap readback failed: ${update.id}`);
  }
}

async function sendRecap(ctx: ExtensionContext, history: WindowActivity, delivery: RecapDelivery, signal: AbortSignal) {
  if (!producerFrom || !startupIdentity) throw new Error("Scryer startup identity is required for recaps");
  const sender = delivery.sender ??= { from: producerFrom, identity: startupIdentity.name, machine: machineName, repo: recapRepo, goalPath: sessionGoalPath(ctx),
    task: { key: activeSession, title: sessionTaskTitle(ctx), description: initialSessionDescription(ctx, activeSession) } };
  const { machine, repo } = sender;
  await deliverRecap(history, delivery, async (part, index) => {
    signal.throwIfAborted();
    part.createdAt ??= new Date().toISOString();
    // A stable recap ID must retain its first-attempt metadata on retry/readback.
    if (!part.goals) {
      const snapshot = await goalMetadata(sender.goalPath ?? sessionGoalPath(ctx), {}, message => warnGoals(ctx, message));
      part.goals = (snapshot.v2meta as { goals: { id: string; title: string }[] }).goals;
    }
    await createSessionUpdate({
      kind: "progress", title: part.title, body: part.body, level: "info",
      metadata: { source: delivery.source, recapId: delivery.id, part: index + 1, parts: delivery.parts.length,
        windowId: history.id, machine, repo, rangeStart: new Date(delivery.start).toISOString(),
        rangeEnd: new Date(delivery.end).toISOString(), throughSequence: delivery.through },
    }, { force: true, ctx, id: part.id, fullBody: true, verify: true, coding: false, signal, sender, createdAt: part.createdAt, goals: part.goals });
  });
  await logInference({ event: "recap-delivered", recapId: delivery.id, source: delivery.source, parts: delivery.parts.length, through: delivery.through });
}

async function runIdleRecap(ctx: ExtensionContext) {
  if (!activity || !ctx.model || !canRunIdle(ctx)) return;
  const history = activity;
  const scope = recapScope;
  const repo = recapRepo;
  const machine = machineName;
  const model = ctx.model;
  const registry = ctx.modelRegistry;
  const signal = AbortSignal.any([lifetime.signal, (recapAbort = new AbortController()).signal, AbortSignal.timeout(10 * 60_000)]);
  // If an interrupted delivery finishes first, recap any newer work too.
  for (let pass = 0; pass < 2; pass++) {
    const delivery = await prepareIdleRecap({
      activity: history, scope, repo, machine, label: basename(repo),
      chunkLimit: Math.max(512, Math.min(16_000, Math.floor(((model.contextWindow ?? 32_000) - 2048) / 4))),
      generate: async (input) => {
        signal.throwIfAborted();
        const auth = await registry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
        const result = await complete(model, { systemPrompt: RECAP_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(input) }], timestamp: Date.now() }] },
          { apiKey: auth.apiKey, headers: auth.headers, signal,
            maxTokens: Math.min(model.maxTokens ?? 8192, 8192, Math.max(256, Math.floor((model.contextWindow ?? 32_000) / 3))) });
        signal.throwIfAborted();
        if (result.stopReason !== "stop") throw new Error(`Incomplete recap: ${result.stopReason}`);
        return extractJson(textFromMessage(result));
      },
    });
    signal.throwIfAborted();
    if (!delivery) return;
    await sendRecap(ctx, history, delivery, signal);
  }
}

async function recentUpdates(limit = 5) {
  if (!producerFrom) return [] as SessionUpdate[];
  // Mechanical transition events must not displace the observer's previous reports.
  for (let size = limit; ; size = Math.min(500, size * 2)) {
    const data = await api<{ updates: SessionUpdate[] }>(`/api/updates?from=${encodeURIComponent(producerFrom)}&limit=${size}`);
    const reports = data.updates.filter(update => !(update.title === "update_event" && update.body === "update_event" &&
      Object.keys(goalOperations).some(field => Boolean((update.metadata?.v2meta as Record<string, unknown>)?.[field]))));
    if (reports.length >= limit || data.updates.length < size || size === 500) return reports.slice(-limit);
  }
}

async function createTestRequest(ctx: ExtensionContext) {
  await createInteractionRequest({
    title: "Comms test",
    body: "Choose a response. Selecting one sends a user message back into Pi.",
    choices: [
      { id: "ok", label: "Say it works", send: "comms test worked" },
      { id: "custom", label: "Type response…", custom: true },
    ],
  });
  ctx.ui.notify("comms test request created", "info");
}

async function createTestUpdate(ctx: ExtensionContext) {
  const id = await createSessionUpdate({
    kind: "progress",
    title: "Comms update test",
    body: "This is a semantic walkaway-monitoring update from the Pi comms extension.",
    level: "info",
    metadata: { source: "manual-test" },
  }, { force: true, ctx });
  ctx.ui.notify(`comms test update created${id ? `: ${id}` : ""}`, "info");
}

const INFERENCE_SYSTEM_PROMPT = `You create interaction prompts for an idle agent session.
Given recent user/assistant messages, propose concise choices for the user.
Return ONLY JSON matching:
{"create":true,"title":"...","body":"...","choices":[{"label":"...","send":"..."},{"label":"Type response","custom":true}]}
or {"create":false,"reason":"..."}.
Rules:
- Usually create suggestions when the assistant appears idle or waiting.
- Include 2-4 useful choices plus a custom response choice.
- Choice send text should be exactly what to send back as the next user message.
- Avoid destructive defaults or risky actions unless the user explicitly asked.`;

const UPDATE_SYSTEM_PROMPT = `You create semantic decision/progress updates for batches of an agent session.
Return ONLY JSON matching:
{"updates":[{"kind":"progress|decision|blocked|waiting|done|error","title":"...","body":"...","coding":true,"level":"info|success|warning|error","touchIds":["observed-touch-id"]}]}
or {"updates":[]}.
Rules:
- The input contains a batch of new user/assistant conversation messages, previous updates, and observed folderTouches from successful file changes or allowlisted state-changing commands.
- For each update, include touchIds for ONLY the observed actions that specific update describes. Copy IDs exactly; never invent IDs or paths. Discussion-only updates use touchIds: [].
- Use the tool, summary, folders, and createdAt of each observation to match it to the update. Separate unrelated work into separate updates. Do not attach the entire session's folders to every update.
- Emit zero or more updates; use separate updates for separate decisions, actions, commits, pushes, blockers, or completions.
- Create updates when something meaningful changed since the previous updates; err on the side of logging useful micro-context.
- Set coding: true ONLY when this specific update describes an actual code change and references an observed touch with codeChanged: true. Discussion, planning, read-only reviews, test/build runs, commits/pushes without a new code change, and recaps are NOT coding notes. Set coding: false for those. Return plain body text; the extension enforces the evidence requirement and adds/removes coding tags.
- A request to make a note requires an update containing the note itself, not just a report that a local notes file was written. Revisions to notes require new updates; previous updates are never rewritten.
- Optimize for decision logging: record decisions made, why they were made, alternatives rejected, assumptions introduced, and follow-up implied by the decision.
- Also record current progress, blockers, waiting states, errors, or completion when useful.
- If commits or pushes happened, explicitly include the repo, branch, commit SHA(s), remote/PR if known, and whether the work was pushed.
- Do not narrate trivial conversation turns or greetings.
- Keep each title under 80 characters and each body under 500 characters.
- If a decision has been taken and a question has been asked, include both in the title.
- Use blocked/error for problems, waiting when the agent needs user input, done for completed requested work, decision for notable recommendations/choices, progress otherwise.`;

async function runInference(ctx: ExtensionContext, token: number, signal: AbortSignal) {
  if (!ctx.model) return;
  if (editorHasDraft(ctx)) {
    await logInference({ event: "skipped", token, reason: "editor-draft" });
    return;
  }
  const messages = recentConversation(ctx);
  const input = { messages };
  await logInference({ event: "request", token, model: `${ctx.model.provider}/${ctx.model.id}`, input });
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: JSON.stringify(input, null, 2) }],
    timestamp: Date.now(),
  };
  const result = await complete(ctx.model, { systemPrompt: INFERENCE_SYSTEM_PROMPT, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal });
  const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
  const parsed = extractJson(text);
  await logInference({ event: "response", token, stopReason: result.stopReason, raw: text, parsed });
  if (signal.aborted || pendingInference?.token !== token) return;
  if (editorHasDraft(ctx)) {
    await logInference({ event: "skipped", token, reason: "editor-draft-after-response" });
    return;
  }
  if (!parsed?.create) return;
  const choices = Array.isArray(parsed.choices) ? normalizeChoices(parsed.choices) : [];
  if (!choices.some((choice) => choice.custom)) choices.push({ id: "custom", label: "Type response…", custom: true });
  await forceSemanticUpdateFlush(ctx).catch((err) => logInference({ event: "forced-update-flush-error", token, error: err?.message ?? String(err) }));
  if (signal.aborted || pendingInference?.token !== token) return;
  await createInteractionRequest({
    title: String(parsed.title ?? "Next step?"),
    body: String(parsed.body ?? "The agent is waiting for direction."),
    choices,
  });
  await logInference({ event: "created", token });
}

type ConversationMessage = { role: "user" | "assistant"; text: string };

function conversationMessages(ctx: ExtensionContext, startIndex: number, endIndex: number): ConversationMessage[] {
  return ctx.sessionManager.getBranch().slice(startIndex, endIndex)
    .filter((entry: any) => entry?.type === "message")
    .map((entry: any) => ({ role: entry.message?.role, text: textFromMessage(entry.message).trim() }))
    .filter((message: any): message is ConversationMessage => (message.role === "user" || message.role === "assistant") && Boolean(message.text));
}

function userTurnCount(messages: ConversationMessage[]) {
  return messages.filter((message) => message.role === "user").length;
}

async function runUpdateInference(ctx: ExtensionContext, token: number, messages: ConversationMessage[], folderTouches: FolderTouch[], signal: AbortSignal) {
  if (!ctx.model) return;
  const previousUpdates = await recentUpdates(5).catch(() => []);
  const input = { messages, previousUpdates, folderTouches };
  await logInference({ event: "update-request", token, model: `${ctx.model.provider}/${ctx.model.id}`, batchMessages: messages.length, batchUserTurns: userTurnCount(messages), input });
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: JSON.stringify(input, null, 2) }],
    timestamp: Date.now(),
  };
  signal.throwIfAborted();
  const result = await complete(ctx.model, { systemPrompt: UPDATE_SYSTEM_PROMPT, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal });
  signal.throwIfAborted();
  const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
  const parsed = extractJson(text);
  await logInference({ event: "update-response", token, stopReason: result.stopReason, raw: text, parsed });
  const updates = Array.isArray(parsed?.updates) ? parsed.updates : (parsed?.create ? [parsed] : []);
  let created = 0;
  for (const update of updates) {
    const kind = ["progress", "decision", "blocked", "waiting", "done", "error"].includes(update?.kind) ? update.kind : "progress";
    const level = ["info", "success", "warning", "error"].includes(update?.level) ? update.level : kind === "error" ? "error" : kind === "blocked" || kind === "waiting" ? "warning" : kind === "done" ? "success" : "info";
    signal.throwIfAborted();
    const selected = selectUpdateFolders(folderTouches, update?.touchIds, machineName);
    const id = await createSessionUpdate({
      kind,
      title: String(update?.title ?? "Session update"),
      body: String(update?.body ?? "The agent made progress."),
      level,
      metadata: { source: "secondary-agent", token, batch: true },
    }, { force: true, ctx, foldersTouched: selected.foldersTouched, coding: update?.coding !== false && selected.codeChanged, signal });
    if (id) {
      created += 1;
      if (selected.touchIds.length) appendSentTouches(id, selected.touchIds);
    }
  }
  await logInference({ event: created ? "updates-created" : "updates-skipped", token, count: created });
}

function scheduleInference(ctx: ExtensionContext) {
  cancelPendingInference("superseded");
  if (editorHasDraft(ctx)) {
    void logInference({ event: "skipped", reason: "editor-draft-before-schedule", token: inferenceToken + 1 });
    return;
  }
  const token = ++inferenceToken;
  const abort = new AbortController();
  pendingInference = { token, abort };
  pendingInference.timer = setTimeout(() => {
    const active = pendingInference;
    if (!active || active.token !== token) return;
    active.timer = undefined;
    if (editorHasDraft(ctx)) {
      void logInference({ event: "skipped", reason: "editor-draft-before-run", token });
      pendingInference = undefined;
      return;
    }
    runInference(ctx, token, abort.signal).catch((err) => logInference({ event: "error", token, error: err?.message ?? String(err) }));
  }, inferenceDelayMs);
}

function semanticUpdateStatus(ctx = currentCtx) {
  if (!ctx) return { configured: true, running: semanticUpdateRunning, batchTurns: updateBatchTurns, userTurns: 0, remainingUserTurns: updateBatchTurns };
  const branch = ctx.sessionManager.getBranch();
  const messages = conversationMessages(ctx, semanticUpdateCursor, branch.length);
  const turns = userTurnCount(messages);
  return {
    configured: true,
    running: semanticUpdateRunning,
    batchTurns: updateBatchTurns,
    userTurns: turns,
    remainingUserTurns: Math.max(0, updateBatchTurns - turns),
    batchMessages: messages.length,
  };
}

function publishCommsStatus() {
  (globalThis as any).__scryerCommsStatus = () => semanticUpdateStatus(currentCtx);
}

function startUpdateBatch(ctx: ExtensionContext, messages: ConversationMessage[], reason: string) {
  const branch = ctx.sessionManager.getBranch();
  const folderTouches = pendingFolderTouches(branch);
  const end = branch.length;
  const signal = lifetime.signal;
  const token = ++updateInferenceToken;
  semanticUpdateRunning = true;
  let succeeded = false;
  semanticUpdatePromise = runUpdateInference(ctx, token, messages, folderTouches, signal)
    .then(() => { if (!signal.aborted) { semanticUpdateCursor = end; succeeded = true; } })
    .finally(() => {
      if (signal.aborted) return;
      semanticUpdateRunning = false;
      semanticUpdatePromise = undefined;
      if (succeeded && currentCtx && reason === "batch") maybeRunUpdateBatch(currentCtx);
    });
  // Keep failures retryable: neither the conversation cursor nor sent markers advance.
  void semanticUpdatePromise.catch((err) => logInference({ event: "update-error", token, reason, error: err?.message ?? String(err) }));
  return semanticUpdatePromise;
}

function maybeRunUpdateBatch(ctx: ExtensionContext) {
  if (semanticUpdateRunning) return;
  const branch = ctx.sessionManager.getBranch();
  const messages = conversationMessages(ctx, semanticUpdateCursor, branch.length);
  if (userTurnCount(messages) < updateBatchTurns) return;
  void startUpdateBatch(ctx, messages, "batch").catch(() => {});
}

async function forceSemanticUpdateFlush(ctx: ExtensionContext) {
  while (semanticUpdatePromise) await semanticUpdatePromise.catch(() => undefined);
  const branch = ctx.sessionManager.getBranch();
  const messages = conversationMessages(ctx, semanticUpdateCursor, branch.length);
  if (!messages.length && !pendingFolderTouches(branch).length) return;
  await logInference({ event: "forced-update-flush", messages: messages.length, userTurns: userTurnCount(messages) });
  await startUpdateBatch(ctx, messages, "forced-interaction");
}

export default function (pi: ExtensionAPI) {
  publishCommsStatus();
  for (const operation of Object.keys(goalOperations) as (keyof typeof goalOperations)[]) {
    pi.registerTool({
      name: operation, label: operation,
      description: `Move a Goal exclusively to the session file's ${goalOperations[operation]} list. Mechanical local tracking only; does not update PM records. Emits a mechanical comms event (title/body: update_event) only on membership change.${operation === "goal_ready_for_review" ? " Call when you believe your work is done and ready for user review." : operation === "goal_complete" ? " Call when the user says the Goal has been accomplished." : ""}`,
      parameters: Type.Object({ id: Type.String({ description: "Goal UUID" }), title: Type.Optional(Type.String({ description: "Goal title if known; retained on later moves. UUID is used when unknown; no PM lookup." })) }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const path = sessionGoalPath(ctx);
        const result = await withFileMutationQueue(path, () => transitionGoal(path, operation, params.id, params.title, async (field, id) => {
          await createSessionUpdate({ kind: "progress", title: "update_event", body: "update_event", metadata: { v2meta: { [field]: id } } }, { force: true, ctx, transition: true });
        }));
        if (result.eventError) warnGoals(ctx, `Goal moved locally, but transition event delivery failed: ${result.eventError}. Repeating the same operation is a no-op and will not resend.`);
        return { content: [{ type: "text", text: `${result.changed ? "Moved" : "Already in"} ${params.id}: ${goalOperations[operation]} (${path})${result.eventError ? `; event delivery failed: ${result.eventError}` : ""}` }], details: { path, ...result } };
      },
    });
  }
  pi.registerTool({
    name: "send_recap",
    label: "Send Recap",
    description: "Send a user-requested recap as append-only comms updates. Supply the complete detailed notes, split into parts as needed. Preserves and verifies full bodies, uses no coding tags, and resets this window/repo's manual/idle recap checkpoint only after every part is stored intact. Use this instead of direct HTTP for manual recaps.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      parts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!activity) throw new Error("comms not initialized");
      recapAbort?.abort();
      const history = activity;
      const delivery = prepareManualRecap(history, recapScope, params.title, params.parts);
      await sendRecap(ctx, history, delivery, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]));
      return { content: [{ type: "text", text: `Recap ${delivery.id}: all ${delivery.parts.length} parts stored and verified in full.` }],
        details: { recapId: delivery.id, parts: delivery.parts.length, windowId: history.id } };
    },
  });
  pi.registerTool({
    name: "create_interaction_request",
    label: "Create Interaction Request",
    description: "Create a generic Scryer interaction request for the current Pi session.",
    parameters: Type.Object({
      title: Type.String(),
      body: Type.Optional(Type.String()),
      choices: Type.Array(Type.Object({
        label: Type.String(),
        send: Type.Optional(Type.String()),
        custom: Type.Optional(Type.Boolean()),
      })),
    }),
    async execute(_toolCallId, params) {
      const choices = params.choices.map((choice, idx) => ({
        id: `choice-${idx + 1}`,
        label: choice.label,
        send: choice.send,
        custom: choice.custom,
      }));
      const id = await createInteractionRequest({ title: params.title, body: params.body, choices });
      return { content: [{ type: "text", text: `Created interaction request ${id}` }], details: { id, from: producerFrom } };
    },
  });

  appendSentTouches = (updateId, touchIds) => pi.appendEntry(FOLDER_TOUCHES_SENT, { updateId, touchIds });
  pi.on("session_start", async (_event, ctx) => { await startComms(pi, ctx); });
  pi.on("tool_call", async (event, ctx) => {
    userActivity();
    try { changeSnapshots.set(event.toolCallId, await beforeCodeChange(event.toolName, event.input, ctx.cwd)); }
    catch { changeSnapshots.delete(event.toolCallId); }
    if (event.toolName === "bash" && typeof event.input.command === "string") {
      try { commitSnapshots.set(event.toolCallId, await snapshotCommits(event.input.command, ctx.cwd)); }
      catch { commitSnapshots.delete(event.toolCallId); }
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    userActivity();
    if (event.toolName !== "send_recap") recordActivity("tool", `${event.toolName}\n${JSON.stringify(event.input)}\n${textFromMessage(event)}`);
    if (!event.isError && ["bash", "edit", "write"].includes(event.toolName)) {
      void identityRegistration?.refresh();
    }
    try {
      const before = changeSnapshots.get(event.toolCallId);
      changeSnapshots.delete(event.toolCallId);
      const commitsBefore = commitSnapshots.get(event.toolCallId);
      commitSnapshots.delete(event.toolCallId);
      const codeChanged = !event.isError && await afterCodeChange(before);
      const touch = await observeFolderTouch(event.toolName, event.input, event.isError, ctx.cwd, codeChanged);
      if (touch) {
        pi.appendEntry(FOLDER_TOUCH, touch);
        if (!startupIdentity) throw new Error("Startup identity is unavailable for attribution");
        const commits = commitsBefore ? await confirmedCommits(commitsBefore) : new Set<string>();
        const actions = (touch.actions ?? []).filter((action) => action.role !== "version-manager" || commits.has(action.folder));
        await recordFolderActions(actions, startupIdentity.name, await sessionKey(ctx), touch.createdAt);
      }
    } catch (err: any) {
      await logInference({ event: "folder-tracking-error", tool: event.toolName, error: err?.message ?? String(err) });
      ctx.ui.notify("Scryer could not record folder attribution for this tool result", "warning");
    }
  });
  pi.on("input", async () => {
    userActivity();
    cancelPendingInference("user-input");
    return { action: "continue" as const };
  });
  pi.on("agent_start", async () => { agentBusy = true; userActivity(); });
  pi.on("agent_settled", async (_event, ctx) => {
    agentBusy = false;
    userActivity();
    maybeRunUpdateBatch(ctx);
    scheduleInference(ctx);
  });
  pi.on("message_start", async () => { userActivity(); });
  pi.on("message_update", async () => { userActivity(); });
  pi.on("tool_execution_start", async () => { userActivity(); });
  pi.on("tool_execution_update", async () => { userActivity(); });
  pi.on("tool_execution_end", async () => { userActivity(); });
  pi.on("before_provider_request", async () => { userActivity(); });
  pi.on("user_bash", async (event) => { recordActivity("user-bash", event.command); });
  pi.on("message_end", async (event, ctx) => {
    userActivity();
    const msg: any = event.message;
    if (msg?.role === "user" || msg?.role === "assistant") {
      recordActivity(msg.role, textFromMessage(msg));
    }
    if (msg?.role !== "assistant") return;
    if (msg.stopReason && msg.stopReason !== "stop") return;
    maybeRunUpdateBatch(ctx);
    scheduleInference(ctx);
  });
  pi.on("session_shutdown", async () => { cancelPendingInference("shutdown"); stopTimers(); changeSnapshots.clear(); commitSnapshots.clear(); currentCtx = undefined; activeModalRequestId = undefined; });

  pi.registerCommand("comms-init", {
    description: "Reinitialize Scryer interaction comms producer and local TUI consumer",
    handler: async (_args, ctx) => {
      await startComms(pi, ctx);
      ctx.ui.notify(`comms initialized; TUI consumer ${consumerEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
  pi.registerCommand("comms-disable", {
    description: "Disable local Pi TUI interaction modals for this session only",
    handler: async (_args, ctx) => { consumerEnabled = false; ctx.ui.notify("comms TUI consumer disabled for this session", "info"); },
  });
  pi.registerCommand("comms-enable", {
    description: "Enable local Pi TUI interaction modals for this session",
    handler: async (_args, ctx) => { consumerEnabled = true; ctx.ui.notify("comms TUI consumer enabled", "info"); },
  });
  pi.registerCommand("comms-enable-tui", {
    description: "Enable local Pi TUI interaction modals for this session",
    handler: async (_args, ctx) => { consumerEnabled = true; ctx.ui.notify("comms TUI consumer enabled", "info"); },
  });
  pi.registerCommand("comms-disable-tui", {
    description: "Disable local Pi TUI interaction modals for this session only",
    handler: async (_args, ctx) => { consumerEnabled = false; ctx.ui.notify("comms TUI consumer disabled for this session", "info"); },
  });
  pi.registerCommand("comms-delay", {
    description: "Set current-session comms interaction inference delay in seconds. Usage: /comms-delay 30",
    handler: async (args, ctx) => {
      const seconds = Number(String(args ?? "").trim());
      if (!Number.isFinite(seconds) || seconds < 0) {
        ctx.ui.notify(`comms interaction inference delay: ${Math.round(inferenceDelayMs / 1000)}s`, "info");
        return;
      }
      inferenceDelayMs = Math.floor(seconds * 1000);
      ctx.ui.notify(`comms interaction inference delay set to ${seconds}s for this session`, "info");
    },
  });
  pi.registerCommand("comms-update-delay", {
    description: "Set current-session semantic update batch size in user turns. Usage: /comms-update-delay 3",
    handler: async (args, ctx) => {
      const turns = Number(String(args ?? "").trim());
      if (!Number.isFinite(turns) || turns < 1) {
        ctx.ui.notify(`comms semantic update batch size: ${updateBatchTurns} user turn${updateBatchTurns === 1 ? "" : "s"}`, "info");
        return;
      }
      updateBatchTurns = Math.max(1, Math.floor(turns));
      ctx.ui.notify(`comms semantic update batch size set to ${updateBatchTurns} user turn${updateBatchTurns === 1 ? "" : "s"} for this session`, "info");
    },
  });
  pi.registerCommand("comms-status", {
    description: "Show Scryer interaction comms status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`comms: producer=${producerFrom ?? "none"} discovered=${[...discoveredFrom].join(",") || "none"} consumer=${consumerEnabled ? "on" : "off"} interactionDelay=${Math.round(inferenceDelayMs / 1000)}s updateBatchTurns=${updateBatchTurns}`, "info");
    },
  });
  pi.registerCommand("comms-test", {
    description: "Create a local test interaction request",
    handler: async (_args, ctx) => {
      try { await createTestRequest(ctx); }
      catch (err: any) { ctx.ui.notify(`comms test failed: ${err?.message ?? err}`, "error"); }
    },
  });
  pi.registerCommand("comms-test-update", {
    description: "Create a local test semantic session update",
    handler: async (_args, ctx) => {
      try { await createTestUpdate(ctx); }
      catch (err: any) { ctx.ui.notify(`comms test update failed: ${err?.message ?? err}`, "error"); }
    },
  });
}
