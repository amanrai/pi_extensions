import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RECAP_IDLE_MS, FLUSH_IDLE_MS, windowActivity } from "../extensions/comms/activity.ts";

const host = process.env.PI_TEST_AGENT_ROOT;
test("Pi idle lifecycle flushes, spans sessions/reload, verifies full recaps, and honors manual checkpoints", { skip: !host }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scryer-idle-integration-"));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  process.env.HOME = directory;
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const ai = await import(pathToFileURL(join(host!, "node_modules/@earendil-works/pi-ai/dist/compat.js")).href);
  let branch: any[] = [];
  let session = "session-a";
  const posts: any[] = [];
  const attempts: string[] = [];
  const recapInputs: any[] = [];
  const notifications: string[] = [];
  let interactions = 0;
  let truncateReadback = true;
  let terminalInput: (() => void) | undefined;
  let releaseRecap: (() => void) | undefined;
  let blockRecap = false;
  const body = "Decisions, rationale, implementation, validation and deferred work. ".repeat(100).trim();
  const stream = (_model: any, context: any) => ({ result: async () => {
    const system = String(context.messages.find((message: any) => message.role === "system").content);
    const input = JSON.parse(context.messages.find((message: any) => message.role === "user").content[0].text);
    let parsed: any;
    if (system.includes("You produce a detailed factual recap")) {
      recapInputs.push(input);
      if (blockRecap) await new Promise<void>((done) => { releaseRecap = done; });
      const records = input.source.split("\n").map((line: string) => JSON.parse(line));
      const newWork = records.some((record: any) => record.newSinceRecap && record.text !== "Recap sent and verified.");
      parsed = { newWork, parts: [body, "Remaining work and caveats."] };
    } else if (system.includes("You create semantic")) {
      parsed = { updates: [{ kind: "progress", title: "Ordinary update", body: "Meaningful work was discussed", coding: true, touchIds: [] }] };
    } else {
      interactions++;
      parsed = { create: false, reason: "No useful interaction" };
    }
    return { content: [{ type: "text", text: JSON.stringify(parsed) }], stopReason: "stop" };
  } });
  ai.registerApiProvider({ api: "scryer-idle-test-api", stream, streamSimple: stream }, "scryer-idle-test");
  globalThis.fetch = async (url: any, options: any = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path === "/api/identities") return Response.json({ ok: true });
    if (path === "/api/updates") {
      if (options.method === "POST") {
        const update = JSON.parse(options.body);
        attempts.push(update.id);
        if (posts.some((row) => row.id === update.id)) return Response.json({ error: "duplicate update id" }, { status: 409 });
        posts.push(update);
        return Response.json({ ok: true }, { status: 201 });
      }
      const rows = posts.filter((row) => row.from === parsed.searchParams.get("from"));
      return Response.json({ updates: rows.map((row) => truncateReadback && row.metadata.source === "idle-recap" ? { ...row, body: row.body.slice(0, 100) } : row) });
    }
    if (path === "/api/projects") return Response.json([{ id: "project", name: "Agent Sessions", slug: "agent-sessions" }]);
    if (path === "/api/task-types") return Response.json([{ id: "type", key: "work" }]);
    if (path === "/api/tasks") return Response.json({ id: "task" });
    if (path === "/api/tasks/task") return Response.json({ id: "task", description_md: "" });
    if (path === "/api/responses") return Response.json({ responses: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  const ctx = {
    cwd: directory, hasUI: true, mode: "tui", isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: (text: string) => notifications.push(text), getEditorText: () => "",
      onTerminalInput: (fn: () => void) => { terminalInput = fn; return () => { terminalInput = undefined; }; } },
    sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getBranch: () => branch },
    model: { api: "scryer-idle-test-api", provider: "scryer-idle-test", id: "test", contextWindow: 32000 },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
  };
  let extension: any;
  const load = async () => {
    const loaded = await loadExtensions([resolve("extensions/comms/index.ts")], directory);
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    loaded.runtime.sendMessage = () => {};
    loaded.runtime.appendEntry = (customType: string, data: unknown) => branch.push({ type: "custom", customType, data });
  };
  const invoke = async (event: string, data: any = {}) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  const message = async (role: string, text: string) => {
    const msg = { role, content: text, stopReason: "stop" };
    branch.push({ type: "message", message: msg });
    await invoke("message_end", { message: msg });
  };
  const drain = async () => { for (let i = 0; i < 80; i++) await new Promise((done) => setImmediate(done)); };
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 1000; i++) {
      if (predicate()) { await drain(); return; }
      await new Promise((done) => setImmediate(done));
    }
    assert.fail(`Timed out: posts=${posts.length}, inputs=${recapInputs.length}, notifications=${JSON.stringify(notifications)}`);
  };
  t.after(async () => {
    releaseRecap?.();
    await invoke("session_shutdown", { reason: "quit" });
    ai.unregisterApiProviders("scryer-idle-test");
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    t.mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  });
  await load();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-15T01:00:00Z").getTime() });
  await invoke("session_start", { reason: "startup" });
  await invoke("agent_start");
  await message("user", "Architecture A: choose offline-capable local names");
  await message("assistant", "Decided against server-reserved identity names");
  await invoke("agent_settled");
  t.mock.timers.tick(FLUSH_IDLE_MS);
  await wait(() => posts.length === 1 && interactions === 1);
  assert.equal(posts[0].metadata.source, "secondary-agent");
  assert.equal(posts[0].body, "Meaningful work was discussed", "An unsupported model coding flag is stripped");
  await message("user", "Implementation B: add the client registration API");
  await invoke("session_shutdown", { reason: "new" });
  session = "session-b";
  branch = [{ type: "message", message: { role: "user", content: "OTHER WINDOW: this saved history must not be imported" } }];
  await load();
  await invoke("session_start", { reason: "new" });
  t.mock.timers.tick(RECAP_IDLE_MS);
  await wait(() => posts.some((row) => row.metadata.source === "idle-recap"));
  const history = windowActivity(ctx.sessionManager);
  assert.equal(history.checkpoints.size, 0, "Truncated readback cannot acknowledge a recap");
  assert.equal(history.pending.size, 1);
  assert.match(recapInputs[0].source, /Architecture A/);
  assert.match(recapInputs[0].source, /Implementation B/);
  assert.doesNotMatch(recapInputs[0].source, /OTHER WINDOW/);
  const firstId = posts.find((row) => row.metadata.source === "idle-recap").id;
  const changedGoals = [{ id: "80fcdba1-fefa-4126-82b6-851be04177cf", title: "Changed after first attempt" }];
  await writeFile(join(directory, `.scryer-${session}`), JSON.stringify({ current: changedGoals, finish: [], complete: [], abandon: [] }));
  truncateReadback = false;
  await invoke("session_shutdown", { reason: "resume" });
  session = "session-c";
  branch = [];
  await load();
  await invoke("session_start", { reason: "resume" });
  await writeFile(join(directory, `.scryer-${session}`), JSON.stringify({ current: changedGoals, finish: [], complete: [], abandon: [] }));
  await invoke("session_shutdown", { reason: "reload" });
  await load();
  await invoke("session_start", { reason: "reload" });
  t.mock.timers.tick(RECAP_IDLE_MS);
  await wait(() => history.checkpoints.size === 1);
  const recaps = posts.filter((row) => row.metadata.source === "idle-recap");
  assert.equal(recaps.length, 2);
  assert.equal(recaps[0].body, body);
  assert.equal(recaps[0].from, recaps[1].from, "Retries across sessions preserve the original producer");
  assert.ok(recaps.every((row) => row.title.startsWith("Idle Recap") && !row.body.includes("<coding>")));
  assert.equal(attempts.filter((id) => id === firstId).length, 2, "A lost acknowledgment retries the stable ID, not a duplicate row");
  assert.equal(history.pending.size, 0);
  assert.deepEqual(recaps[0].metadata.v2meta.goals, [], "Retry retains original Goal snapshot after session/Goal changes");
  assert.deepEqual(recaps[1].metadata.v2meta.goals, changedGoals, "A new part uses its original sender session file at publication time");
  terminalInput!();
  t.mock.timers.tick(RECAP_IDLE_MS); await drain();
  assert.equal(posts.filter((row) => row.metadata.source === "idle-recap").length, 2, "No work means no repeated recap");
  await invoke("input", { text: "New decision C" });
  await message("user", "New decision C: keep the recap local to this window");
  const manualTool = extension.tools.get("send_recap").definition;
  const manual = await manualTool.execute("manual", { title: "Requested recap", parts: [body] }, undefined, undefined, ctx);
  assert.match(manual.content[0].text, /stored and verified in full/);
  await message("assistant", "Recap sent and verified.");
  terminalInput!();
  t.mock.timers.tick(RECAP_IDLE_MS); await drain();
  assert.equal(posts.filter((row) => row.metadata.source === "idle-recap").length, 2, "Manual recap and its acknowledgment do not cause another recap");
  assert.equal(posts.find((row) => row.metadata.source === "manual-recap").body, body);
  // Real activity during a slow recap cancels generation before anything is posted.
  await invoke("input", { text: "Decision D" });
  await message("user", "Decision D: test cancellation");
  blockRecap = true;
  t.mock.timers.tick(RECAP_IDLE_MS);
  await wait(() => Boolean(releaseRecap));
  await invoke("input", { text: "More work resumed" });
  await message("user", "More work resumed after the timer fired");
  releaseRecap!(); await drain();
  assert.equal(posts.filter((row) => row.metadata.source === "idle-recap").length, 2);
  assert.equal(history.pending.size, 0);
  assert.equal(history.snapshot(`${recaps[0].metadata.machine}:${directory}`).hasNewWork, true);
});
