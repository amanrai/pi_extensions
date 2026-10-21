import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const host = process.env.PI_TEST_AGENT_ROOT;
test("registered explicit comms tool preserves a different Goal set without session changes or PM mirroring", { skip: !host }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "explicit-comms-"));
  const oldHome = process.env.HOME, oldFetch = globalThis.fetch;
  process.env.HOME = directory;
  const posts: any[] = [], calls: { path: string; method: string }[] = [], messages: any[] = [];
  globalThis.fetch = async (url: any, init: any = {}) => {
    const parsed = new URL(String(url)), path = parsed.pathname, method = init.method ?? "GET";
    calls.push({ path, method });
    if (path === "/api/identities") return Response.json({ ok: true });
    if (path === "/api/requests/active") return Response.json({ requests: [] });
    if (path === "/api/responses") return Response.json({ responses: [] });
    if (path === "/api/updates") {
      if (method === "POST") {
        const body = JSON.parse(init.body);
        if (posts.some(p => p.id === body.id)) return Response.json({ error: "duplicate" }, { status: 409 });
        posts.push(body); return Response.json({ ok: true, id: body.id, from: body.from }, { status: 201 });
      }
      return Response.json({ updates: posts.filter(p => p.from === parsed.searchParams.get('from')) });
    }
    throw new Error(`Unexpected request (no PM mirror permitted): ${path}`);
  };
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("extensions/comms/index.ts")], directory);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  loaded.runtime.sendMessage = (message: any) => messages.push(message);
  loaded.runtime.appendEntry = () => {};
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const ctx = { cwd: directory, hasUI: false, mode: "json", ui: { notify: () => {} }, sessionManager: { getSessionId: () => sessionId, getHeader: () => ({ cwd: directory }), getSessionFile: () => undefined, getBranch: () => [] } };
  const invoke = async (event: string) => { for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event }, ctx); };
  t.after(async () => {
    await invoke("session_shutdown"); globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  });
  const tool = extension.tools.get("send_comms_update").definition;
  await assert.rejects(tool.execute("before-start", {}, undefined, undefined, ctx), /not initialized/);
  assert.equal(calls.length, 0);
  await invoke("session_start");
  const marker = messages.find(m => m.customType === "scryer-comms-producer").content;
  const producer = JSON.parse(marker.slice(marker.indexOf('{'), marker.lastIndexOf('}') + 1));
  const current = { id: "00000000-0000-4000-8000-000000000002", title: "Current session Goal" };
  const alternative = { id: "00000000-0000-4000-8000-000000000003", title: "Different explicit Goal" };
  const path = join(directory, `.scryer-${sessionId}`);
  await writeFile(path, JSON.stringify({ current: [current], finish: [], complete: [], abandon: [], ready_for_review: [] }));
  const before = await readFile(path, "utf8");
  const payload = { id: "00000000-0000-4000-8000-000000000004", from: producer.from, kind: "decision", title: "Explicit test", body: "Exact unwrapped body", metadata: { caller: "preserved", v2meta: { identity: producer.identity, foldersTouched: [], goals: [alternative] } } };
  const statusBefore = (globalThis as any).__scryerCommsStatus();
  const result = await tool.execute("send", payload, undefined, undefined, ctx);
  assert.equal(result.structuredContent.status, "sent"); assert.equal(result.structuredContent.verified, true); assert.equal(result.isError, undefined);
  assert.deepEqual(posts, [payload]); assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual((globalThis as any).__scryerCommsStatus(), statusBefore);
  assert.deepEqual((await tool.execute("same-id", payload, undefined, undefined, ctx)).structuredContent.status, "already_stored");
  assert.equal(posts.length, 1);
  const conflict = await tool.execute("conflict", { ...payload, body: "Different" }, undefined, undefined, ctx);
  assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.verified, false);
  // Explicit metadata must not depend even on the readability of session tracking.
  await writeFile(path, "invalid JSON");
  const empty = { ...payload, id: "00000000-0000-4000-8000-000000000005", metadata: { v2meta: { identity: producer.identity, foldersTouched: [], goals: [] } } };
  assert.equal((await tool.execute("empty-explicit", empty, undefined, undefined, ctx)).structuredContent.status, "sent");
  assert.equal(await readFile(path, "utf8"), "invalid JSON"); assert.deepEqual(posts.at(-1), empty);
  const count = calls.length;
  for (const bad of [{ ...payload, from: current.id }, { ...payload, metadata: { v2meta: { ...payload.metadata.v2meta, identity: 'wrong_identity' } } }, { ...payload, metadata: { v2meta: { identity: producer.identity } } }]) await assert.rejects(tool.execute("invalid", bad, undefined, undefined, ctx));
  assert.equal(calls.length, count);
  assert.ok(!calls.some(c => c.path.startsWith('/api/projects') || c.path.startsWith('/api/tasks')));
});
