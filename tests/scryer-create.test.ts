import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSubgoals, validateCreateSubgoals } from "../extensions/scryer-checklist/create.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const parent = id(1), ancestor = id(2);
const actor = { actor_role: "pi-agent", actor_instance_key: "test_harrier_abcdefghijkl" };
const input = { goal_id: parent, subgoals: [{ title: "First" }, { title: "Second", description_md: "Why", checklist_items: [{ title: "A" }, { title: "B", description_md: "How" }] }] };
async function fixture(t: any, options: { failAt?: number; lostAt?: number; invalidAt?: number; missingParent?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const goals: any[] = [], links: any[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
    calls.push({ method: req.method!, path: req.url!, body });
    const n = calls.length;
    res.setHeader("Content-Type", "application/json");
    if (options.failAt === n) { res.writeHead(503).end('{}'); return; }
    let response: unknown;
    if (req.method === "GET" && req.url === `/api/goals/${parent}`) {
      if (options.missingParent) { res.writeHead(404).end('{}'); return; }
      response = { id: parent, title: "Parent itself has a parent", supports: ancestor };
    } else if (req.method === "POST" && req.url === "/api/goals") {
      response = { ...body, id: id(10 + goals.length), is_done: 0 }; goals.push(response);
    } else if (req.method === "POST" && req.url === "/api/goal-relationships") {
      response = { ...body, id: id(100 + links.length) }; links.push(response);
    } else { res.writeHead(404).end('{}'); return; }
    if (options.lostAt === n) { req.socket.destroy(); return; }
    res.end(JSON.stringify(options.invalidAt === n ? {} : response));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, actor, calls, goals, links };
}

test("JSON batch accepts title-only and optional descriptions/checklists; links in order beneath non-root parent", async t => {
  const f = await fixture(t);
  const original = structuredClone(input);
  const result = await createSubgoals(input, f);
  assert.equal(result.status, "created");
  assert.deepEqual(result.created_goal_ids, [id(10), id(11)]);
  assert.deepEqual(result.linked_goal_ids, [id(10), id(11)]);
  assert.equal(result.http_requests, 5);
  assert.deepEqual(f.calls.map(c => [c.method, c.path]), [["GET", `/api/goals/${parent}`], ["POST", "/api/goals"], ["POST", "/api/goal-relationships"], ["POST", "/api/goals"], ["POST", "/api/goal-relationships"]]);
  assert.deepEqual(f.calls[1].body, { ...actor, title: "First" });
  assert.deepEqual(f.calls[3].body, { ...actor, title: "Second", description_md: "Why", checklist_items: [{ title: "A", display_order: 0 }, { title: "B", description_md: "How", display_order: 1 }] });
  assert.deepEqual(f.links.map(l => [l.source_goal_id, l.target_goal_id, l.relationship_type]), [[id(10), parent, "supports"], [id(11), parent, "supports"]]);
  assert.deepEqual(input, original, "input content is not modified");
});

test("empty optional values are valid; repeated titles create distinct IDs rather than inferred deduplication", async t => {
  const f = await fixture(t);
  const result = await createSubgoals({ goal_id: parent.toUpperCase(), subgoals: [{ title: "Same", description_md: "", checklist_items: [] }, { title: "Same" }] }, f);
  assert.equal(result.status, "created"); assert.notEqual(result.linked_goal_ids[0], result.linked_goal_ids[1]);
  assert.deepEqual(f.goals[0].checklist_items, []);
});

test("entire batch including nested checklist is validated before network work", async t => {
  const f = await fixture(t);
  for (const bad of [null, {}, { ...input, goal_id: "title" }, { ...input, subgoals: [] }, { ...input, actor_role: "human" },
    { goal_id: parent, subgoals: [{ title: "Valid" }, { title: " " }] },
    { goal_id: parent, subgoals: [{ title: "A", description_md: null }] },
    { goal_id: parent, subgoals: [{ title: "A", checklist_items: "B" }] },
    { goal_id: parent, subgoals: [{ title: "A", checklist_items: [{ title: "" }] }] },
    { goal_id: parent, subgoals: [{ title: "A", is_done: 1 }] },
    { goal_id: parent, subgoals: [{ title: "A", checklist_items: [{ title: "B", is_done: 1 }] }] },
  ]) {
    assert.throws(() => validateCreateSubgoals(bad));
    await assert.rejects(createSubgoals(bad as any, f));
  }
  assert.equal(f.calls.length, 0);
});

test("missing parent fails before any creation; reads do not infer parentlessness", async t => {
  const f = await fixture(t, { missingParent: true });
  await assert.rejects(createSubgoals(input, f), /404/);
  assert.equal(f.calls.length, 1); assert.equal(f.goals.length, 0);
});

test("link failure reports orphan UUID and stops without rollback or next creation", async t => {
  const f = await fixture(t, { failAt: 3 });
  const result = await createSubgoals(input, f);
  assert.equal(result.status, "failed"); assert.deepEqual(result.created_goal_ids, [id(10)]);
  assert.deepEqual(result.linked_goal_ids, []); assert.equal(result.uncertain_stage, "link_goal");
  assert.equal(result.uncertain_goal_id, id(10)); assert.equal(f.goals.length, 1); assert.equal(f.calls.length, 3);
});

test("later creation failure preserves earlier linked results and never retries", async t => {
  const f = await fixture(t, { failAt: 4 });
  const result = await createSubgoals(input, f);
  assert.equal(result.status, "failed"); assert.deepEqual(result.linked_goal_ids, [id(10)]);
  assert.equal(result.failed_subgoal_title, "Second"); assert.equal(result.uncertain_stage, "create_goal");
  assert.equal(f.calls.length, 4); assert.match(result.error!, /no retry, cleanup or rollback/);
});

test("lost create/link responses retain uncertainty, without duplicate creation or blind retry", async t => {
  for (const lostAt of [2, 3]) {
    const f = await fixture(t, { lostAt });
    const result = await createSubgoals(input, f);
    assert.equal(result.status, "failed"); assert.equal(f.goals.length, 1);
    assert.equal(result.uncertain_stage, lostAt === 2 ? "create_goal" : "link_goal");
    assert.equal(f.calls.length, lostAt); assert.equal(f.links.length, lostAt === 3 ? 1 : 0);
    assert.deepEqual(result.linked_goal_ids, []);
  }
});

test("unconfirmed/malformed write responses fail rather than inventing linked IDs", async t => {
  for (const invalidAt of [2, 3]) {
    const f = await fixture(t, { invalidAt });
    const result = await createSubgoals(input, f);
    assert.equal(result.status, "failed"); assert.deepEqual(result.linked_goal_ids, []);
    assert.equal(f.calls.length, invalidAt);
  }
});

test("cancellation or missing actor before work sends nothing", async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createSubgoals(input, { ...f, signal: controller.signal }));
  await assert.rejects(createSubgoals(input, { ...f, actor: { ...actor, actor_instance_key: "" } }));
  assert.equal(f.calls.length, 0);
});

test("cancellation after confirmed create retains UUID but does not send a link", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await createSubgoals(input, { ...f, signal: controller.signal, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith("/api/goals")) {
      const saved = await response.json(); controller.abort(); return Response.json(saved);
    }
    return response;
  } });
  assert.equal(result.status, "failed"); assert.deepEqual(result.created_goal_ids, [id(10)]);
  assert.deepEqual(result.linked_goal_ids, []); assert.equal(result.uncertain_stage, undefined);
  assert.equal(f.calls.length, 2);
});

const host = process.env.PI_TEST_AGENT_ROOT;
test("Pi registered tool accepts JSON and returns UUID array; partial failure is an error with structured progress", { skip: !host }, async t => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "create-subgoals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, ".scryer"), JSON.stringify({ created_by: [{ name: actor.actor_instance_key }] }));
  const old = process.env.SCRYER_API_BASE_URL; process.env.SCRYER_API_BASE_URL = f.baseUrl;
  t.after(() => { if (old === undefined) delete process.env.SCRYER_API_BASE_URL; else process.env.SCRYER_API_BASE_URL = old; });
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("extensions/scryer-checklist/index.ts")], directory);
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions[0].tools.get("create_subgoals_for_goal").definition;
  const ctx = { cwd: "/elsewhere", sessionManager: { getHeader: () => ({ cwd: directory }) } };
  const result = await tool.execute("create", input, undefined, undefined, ctx);
  assert.deepEqual(JSON.parse(result.content[0].text), [id(10), id(11)]);
  assert.deepEqual(result.structuredContent, [id(10), id(11)]); assert.equal(result.isError, undefined);
  assert.equal(f.goals[0].actor_instance_key, actor.actor_instance_key);
  const failed = await fixture(t, { failAt: 3 }); process.env.SCRYER_API_BASE_URL = failed.baseUrl;
  const error = await tool.execute("partial", input, undefined, undefined, ctx);
  assert.equal(error.isError, true); assert.deepEqual(error.structuredContent.created_goal_ids, [id(10)]);
  await writeFile(join(directory, ".scryer"), '{"created_by":[]}');
  const count = failed.calls.length;
  await assert.rejects(tool.execute("missing-identity", input, undefined, undefined, ctx), /identity/);
  assert.equal(failed.calls.length, count);
});
