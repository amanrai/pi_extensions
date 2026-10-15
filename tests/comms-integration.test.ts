import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// Optional integration test against the installed Pi runtime, with no model/API network calls.
const host = process.env.PI_TEST_AGENT_ROOT;
test("Pi tool events become per-update folder metadata, without replay", { skip: !host }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scryer-integration-"));
  await mkdir(join(directory, "first"));
  await mkdir(join(directory, "second"));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  process.env.HOME = directory;
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const ai = await import(pathToFileURL(join(host!, "node_modules/@earendil-works/pi-ai/dist/compat.js")).href);
  const branch: any[] = [];
  const posts: any[] = [];
  const registrations: any[] = [];
  let registrationOffline = true;
  let activeSessionId = "stable-session-id";
  const notifications: { text: string; level: string }[] = [];
  let inference = 0;
  const stream = (_model: any, context: any) => ({ result: async () => {
    const systemPrompt = context.messages.find((message: any) => message.role === "system").content;
    assert.match(systemPrompt, /"coding":true/);
    assert.match(systemPrompt, /Revisions to notes require new updates/);
    const input = JSON.parse(context.messages.find((message: any) => message.role === "user").content[0].text);
    inference++;
    const touches = input.folderTouches;
    if (inference === 1) assert.equal(touches.length, 2);
    else assert.deepEqual(touches, []);
    const updates = inference === 1 ? [
      { kind: "progress", title: "First change", body: "Changed first file", touchIds: [touches[0].id] },
      { kind: "progress", title: "Second change", body: "<coding>Changed second file</coding>", coding: true, touchIds: [touches[1].id] },
      { kind: "decision", title: "Discussion", body: "A decision without file changes", coding: false, touchIds: [] },
    ] : [{ kind: "progress", title: "Code review", body: "Reviewed changes without file edits", coding: true, touchIds: [] }];
    return { content: [{ type: "text", text: JSON.stringify({ updates }) }], stopReason: "stop" };
  } });
  ai.registerApiProvider({ api: "scryer-test-api", stream, streamSimple: stream }, "scryer-test");
  globalThis.fetch = async (url: any, options: any = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/identities") {
      registrations.push(JSON.parse(options.body));
      // A hanging/offline registry must not block startup or semantic updates.
      if (registrationOffline) return new Promise((_done, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("offline registration cancelled")), { once: true });
      });
      return Response.json({ ok: true });
    }
    if (path === "/api/updates") {
      if (options.method === "POST") { posts.push(JSON.parse(options.body)); return Response.json({}); }
      return Response.json({ updates: [] });
    }
    if (path === "/api/projects") return Response.json([{ id: "project", name: "Agent Sessions", slug: "agent-sessions" }]);
    if (path === "/api/task-types") return Response.json([{ id: "type", key: "work" }]);
    if (path === "/api/tasks") return Response.json({ id: "task" });
    if (path === "/api/tasks/task") return Response.json({ id: "task", description_md: "" });
    if (path === "/api/responses") return Response.json({ responses: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  const loaded = await loadExtensions([resolve("extensions/comms/index.ts")], directory);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  loaded.runtime.sendMessage = () => {};
  loaded.runtime.appendEntry = (customType: string, data: unknown) => branch.push({ type: "custom", customType, data });
  const ctx = {
    cwd: directory, hasUI: false, mode: "json",
    ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
    sessionManager: { getSessionId: () => activeSessionId, getSessionFile: () => undefined, getBranch: () => branch },
    model: { api: "scryer-test-api", provider: "scryer-test", id: "test" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
  };
  const invoke = async (event: string, data: any = {}) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  t.after(async () => {
    await invoke("session_shutdown");
    ai.unregisterApiProviders("scryer-test");
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
  });
  const waitForBatch = async (count: number) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (posts.length === count && !(globalThis as any).__scryerCommsStatus().running) return;
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.fail(`Batch did not finish; notifications=${JSON.stringify(notifications)}`);
  };
  await invoke("session_start");
  await extension.commands.get("comms-update-delay").handler("1", ctx);
  branch.push({ type: "message", message: { role: "user", content: "Make two changes" } });
  await invoke("tool_result", { toolName: "edit", input: { path: "first/file" }, isError: false });
  await invoke("tool_result", { toolName: "write", input: { path: "second/file" }, isError: false });
  await invoke("tool_result", { toolName: "read", input: { path: "unrelated/file" }, isError: false });
  await invoke("tool_result", { toolName: "bash", input: { command: "git status" }, isError: false });
  await invoke("tool_result", { toolName: "write", input: { path: "failed/file" }, isError: true });
  branch.push({ type: "message", message: { role: "assistant", content: "Made two changes" } });
  await invoke("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await waitForBatch(3);
  const name = JSON.parse(await readFile(join(directory, ".scryer"), "utf8")).created_by[0].name;
  assert.equal(posts[0].metadata.v2meta.identity, name);
  assert.equal(posts[0].metadata.v2meta.foldersTouched.length, 1);
  assert.ok(posts[0].metadata.v2meta.foldersTouched[0].endsWith(`:${directory}/first`));
  assert.ok(posts[1].metadata.v2meta.foldersTouched[0].endsWith(`:${directory}/second`));
  assert.deepEqual(posts[2].metadata.v2meta.foldersTouched, []);
  assert.equal(posts[0].body, "<coding>Changed first file</coding>", "Observed file changes are tagged even if the model omits coding");
  assert.equal(posts[1].body, "<coding>Changed second file</coding>", "Already tagged bodies are not double-wrapped");
  assert.equal(posts[2].body, "A decision without file changes", "Non-coding discussion remains unwrapped");
  assert.equal(posts[0].metadata.source, "secondary-agent");
  assert.equal(posts[0].metadata.v2meta.identities, undefined);
  for (let attempt = 0; attempt < 200 && registrations.length === 0; attempt++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, name);
  assert.equal(registrations[0].session, "pi-session:stable-session-id");
  assert.ok(registrations[0].location.endsWith(`@${directory}`));
  assert.equal(registrations[0].repo, undefined);
  registrationOffline = false;
  // Reinitialization restores sent markers rather than replaying old folder touches.
  await extension.commands.get("comms-init").handler("", ctx);
  branch.push({ type: "message", message: { role: "user", content: "Discuss next steps" } });
  branch.push({ type: "message", message: { role: "assistant", content: "Next steps" } });
  await invoke("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await waitForBatch(4);
  assert.deepEqual(posts[3].metadata.v2meta.foldersTouched, []);
  assert.equal(posts[3].body, "<coding>Reviewed changes without file edits</coding>", "Coding notes without touched folders are tagged too");
  for (let attempt = 0; attempt < 200 && registrations.length < 2; attempt++) await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(registrations[1], registrations[0], "Reload/resume always registers the same pair again");
  activeSessionId = "new-session-id";
  await extension.commands.get("comms-init").handler("", ctx);
  for (let attempt = 0; attempt < 200 && registrations.length < 3; attempt++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(registrations[2].session, "pi-session:new-session-id");
  assert.equal(registrations[2].name, name);
  assert.equal(JSON.parse(await readFile(join(directory, ".scryer"), "utf8")).created_by[0].session, "pi-session:stable-session-id");
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync("git", ["-C", directory, "remote", "add", "origin", "git@github.com:Example/Project.git"]);
  await invoke("tool_result", { toolName: "bash", input: { command: "git init" }, isError: false });
  for (let attempt = 0; attempt < 200 && registrations.length < 4; attempt++) await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(registrations[3], { ...registrations[2], repo: "git@github.com/example/project" });
  assert.equal(JSON.parse(await readFile(join(directory, ".scryer"), "utf8")).created_by[0].repo, "git@github.com/example/project");
});
