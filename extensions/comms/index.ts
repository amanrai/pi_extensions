import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { modalAnchorOption, modalHeightOption, modalOffsetYOption, modalWidthOption, readModalConfig } from "../scryer/modal-config.ts";
import { overlayStyle } from "../scryer/overlay-style.ts";
import { Type } from "typebox";

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
};

const SERVICE_URL = (process.env.SCRYER_INTERACTIONS_URL ?? "http://127.0.0.1:43217").replace(/\/$/, "");
const STATE_DIR = join(homedir(), ".pi", "agent", "comms");
const STATE_PATH = join(STATE_DIR, "state.json");
const INFERENCE_LOG_PATH = join(STATE_DIR, "inference-log.jsonl");
const MARKER_PREFIX = "@@SCRYER_INTERACTION_PRODUCER_V1@@";
const MARKER_SUFFIX = "@@END_SCRYER_INTERACTION_PRODUCER@@";
const MARKER_RE = /^@@SCRYER_INTERACTION_PRODUCER_V1@@(\{[^\r\n]*\})@@END_SCRYER_INTERACTION_PRODUCER@@$/;

let currentCtx: ExtensionContext | undefined;
let producerFrom: string | undefined;
let consumerEnabled = false;
let consumerTimer: NodeJS.Timeout | undefined;
let responseTimer: NodeJS.Timeout | undefined;
let terminalInputUnsubscribe: (() => void) | undefined;
let activeModalRequestId: string | undefined;
let lastResponseSince = "";
let inferenceDelayMs = Number(process.env.SCRYER_COMMS_INFERENCE_DELAY_MS ?? 30_000);
let updateDelayMs = Number(process.env.SCRYER_COMMS_UPDATE_DELAY_MS ?? 8_000);
let pendingInference: { timer?: NodeJS.Timeout; abort?: AbortController; token: number } | undefined;
let pendingUpdateInference: { timer?: NodeJS.Timeout; abort?: AbortController; token: number } | undefined;
let inferenceToken = 0;
let updateInferenceToken = 0;
let lastUpdatePostAt = 0;
let lastUpdateHash = "";
const discoveredFrom = new Set<string>();
const processedResponses = new Set<string>();

async function readState(): Promise<CommsState> {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")) as CommsState; }
  catch { return { bySession: {} }; }
}

async function writeState(state: CommsState) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function sessionKey(ctx: ExtensionContext) {
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
  const res = await fetch(`${SERVICE_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return await res.json() as T;
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

function cancelPendingUpdateInference(reason: string) {
  if (!pendingUpdateInference) return;
  if (pendingUpdateInference.timer) clearTimeout(pendingUpdateInference.timer);
  pendingUpdateInference.abort?.abort();
  void logInference({ event: "update-cancelled", reason, token: pendingUpdateInference.token });
  pendingUpdateInference = undefined;
}

function updateHash(update: Pick<SessionUpdate, "kind" | "title" | "body" | "level">) {
  return createHash("sha1")
    .update(`${update.kind}\n${update.level ?? ""}\n${update.title.trim().toLowerCase()}\n${update.body.trim().toLowerCase()}`)
    .digest("hex");
}

function extractJson(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in inference response");
  return JSON.parse(raw.slice(start, end + 1));
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
  const modalConfig = await readModalConfig();
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
  }, { overlay: true, overlayOptions: { anchor: modalAnchorOption(modalConfig), offsetY: modalOffsetYOption(modalConfig), width: modalWidthOption(modalConfig), maxHeight: modalHeightOption(modalConfig) } });
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
  if (consumerTimer) clearInterval(consumerTimer);
  if (responseTimer) clearInterval(responseTimer);
  terminalInputUnsubscribe?.();
  consumerTimer = undefined;
  responseTimer = undefined;
  terminalInputUnsubscribe = undefined;
}

async function startComms(pi: ExtensionAPI, ctx: ExtensionContext) {
  currentCtx = ctx;
  producerFrom = await ensureProducerFrom(ctx);
  // Do not replay old responses after reload/resume. Comms responses are edge-triggered.
  lastResponseSince = new Date().toISOString();
  processedResponses.clear();
  emitMarker(pi, ctx);
  stopTimers();
  consumerTimer = setInterval(() => { if (currentCtx) pollActiveRequests(currentCtx).catch(() => {}); }, 1200);
  responseTimer = setInterval(() => { if (currentCtx) pollResponses(pi, currentCtx).catch(() => {}); }, 1200);
  if (ctx.hasUI && ctx.mode === "tui") {
    terminalInputUnsubscribe = ctx.ui.onTerminalInput(() => {
      if (pendingInference) cancelPendingInference("terminal-input");
      if (pendingUpdateInference) cancelPendingUpdateInference("terminal-input");
    });
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

async function createSessionUpdate(update: Omit<SessionUpdate, "id" | "from" | "createdAt" | "receivedAt">, options: { force?: boolean } = {}) {
  if (!producerFrom) throw new Error("comms not initialized");
  const normalized = {
    kind: update.kind,
    title: update.title.trim().slice(0, 140),
    body: update.body.trim().slice(0, 1200),
    level: update.level,
  };
  if (!normalized.title || !normalized.body) throw new Error("update title and body required");
  const hash = updateHash(normalized);
  const important = update.kind === "blocked" || update.kind === "error" || update.kind === "done" || update.kind === "waiting";
  if (!options.force && hash === lastUpdateHash) return undefined;
  if (!options.force && !important && Date.now() - lastUpdatePostAt < 45_000) return undefined;
  const id = randomUUID();
  await api("/api/updates", {
    method: "POST",
    body: JSON.stringify({ id, from: producerFrom, ...normalized, metadata: update.metadata ?? {}, createdAt: new Date().toISOString() }),
  });
  lastUpdatePostAt = Date.now();
  lastUpdateHash = hash;
  return id;
}

async function recentUpdates(limit = 5) {
  if (!producerFrom) return [] as SessionUpdate[];
  const data = await api<{ updates: SessionUpdate[] }>(`/api/updates?from=${encodeURIComponent(producerFrom)}&limit=${limit}`);
  return data.updates;
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
  }, { force: true });
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

const UPDATE_SYSTEM_PROMPT = `You create semantic walkaway-monitoring updates for an agent session.
Return ONLY JSON matching:
{"create":true,"kind":"progress|decision|blocked|waiting|done|error","title":"...","body":"...","level":"info|success|warning|error"}
or {"create":false,"reason":"..."}.
Rules:
- Create an update only when something meaningful changed since the previous updates.
- Optimize for a user who walked away and wants to know current progress, decisions, blockers, waiting states, errors, or completion.
- Do not narrate trivial conversation turns, greetings, or unchanged state.
- Keep title under 80 characters and body under 500 characters.
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
  await createInteractionRequest({
    title: String(parsed.title ?? "Next step?"),
    body: String(parsed.body ?? "The agent is waiting for direction."),
    choices,
  });
  await logInference({ event: "created", token });
}

async function runUpdateInference(ctx: ExtensionContext, token: number, signal: AbortSignal) {
  if (!ctx.model) return;
  const messages = recentConversation(ctx);
  const previousUpdates = await recentUpdates(5).catch(() => []);
  const input = { messages, previousUpdates };
  await logInference({ event: "update-request", token, model: `${ctx.model.provider}/${ctx.model.id}`, input });
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: JSON.stringify(input, null, 2) }],
    timestamp: Date.now(),
  };
  const result = await complete(ctx.model, { systemPrompt: UPDATE_SYSTEM_PROMPT, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal });
  const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
  const parsed = extractJson(text);
  await logInference({ event: "update-response", token, stopReason: result.stopReason, raw: text, parsed });
  if (signal.aborted || pendingUpdateInference?.token !== token) return;
  if (!parsed?.create) return;
  const kind = ["progress", "decision", "blocked", "waiting", "done", "error"].includes(parsed.kind) ? parsed.kind : "progress";
  const level = ["info", "success", "warning", "error"].includes(parsed.level) ? parsed.level : kind === "error" ? "error" : kind === "blocked" || kind === "waiting" ? "warning" : kind === "done" ? "success" : "info";
  const id = await createSessionUpdate({
    kind,
    title: String(parsed.title ?? "Session update"),
    body: String(parsed.body ?? "The agent made progress."),
    level,
    metadata: { source: "secondary-agent", token },
  });
  await logInference({ event: id ? "update-created" : "update-skipped", token, id });
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

function scheduleUpdateInference(ctx: ExtensionContext) {
  cancelPendingUpdateInference("superseded");
  const token = ++updateInferenceToken;
  const abort = new AbortController();
  pendingUpdateInference = { token, abort };
  pendingUpdateInference.timer = setTimeout(() => {
    const active = pendingUpdateInference;
    if (!active || active.token !== token) return;
    active.timer = undefined;
    runUpdateInference(ctx, token, abort.signal).catch((err) => logInference({ event: "update-error", token, error: err?.message ?? String(err) }));
  }, updateDelayMs);
}

export default function (pi: ExtensionAPI) {
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

  pi.on("session_start", async (_event, ctx) => { await startComms(pi, ctx); });
  pi.on("input", async () => {
    cancelPendingInference("user-input");
    cancelPendingUpdateInference("user-input");
    return { action: "continue" as const };
  });
  pi.on("message_end", async (event, ctx) => {
    const msg: any = event.message;
    if (msg?.role !== "assistant") return;
    if (msg.stopReason && msg.stopReason !== "stop") return;
    scheduleUpdateInference(ctx);
    scheduleInference(ctx);
  });
  pi.on("session_shutdown", async () => { cancelPendingInference("shutdown"); cancelPendingUpdateInference("shutdown"); stopTimers(); currentCtx = undefined; activeModalRequestId = undefined; });

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
    description: "Set current-session semantic update inference delay in seconds. Usage: /comms-update-delay 8",
    handler: async (args, ctx) => {
      const seconds = Number(String(args ?? "").trim());
      if (!Number.isFinite(seconds) || seconds < 0) {
        ctx.ui.notify(`comms update inference delay: ${Math.round(updateDelayMs / 1000)}s`, "info");
        return;
      }
      updateDelayMs = Math.floor(seconds * 1000);
      ctx.ui.notify(`comms update inference delay set to ${seconds}s for this session`, "info");
    },
  });
  pi.registerCommand("comms-status", {
    description: "Show Scryer interaction comms status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`comms: producer=${producerFrom ?? "none"} discovered=${[...discoveredFrom].join(",") || "none"} consumer=${consumerEnabled ? "on" : "off"} interactionDelay=${Math.round(inferenceDelayMs / 1000)}s updateDelay=${Math.round(updateDelayMs / 1000)}s`, "info");
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
