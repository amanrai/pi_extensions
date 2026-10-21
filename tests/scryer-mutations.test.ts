import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setParents, moveSubgoals, updateChecklistItems } from "../extensions/scryer-checklist/mutations.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const g = [1, 2, 3, 4, 5].map(id), i1 = id(11), i2 = id(12);
const actor = { actor_role: "pi-agent", actor_instance_key: "test_harrier_abcdefghijkl" };
const edge = (child: string, parent: string, n = 201, extra = {}) => ({ id: id(n), source_goal_id: child, target_goal_id: parent, relationship_type: "supports", deleted_at: null, ...extra });
const add = (goal_id = g[0], parent_ids = [g[2]]) => ({ goals: [{ goal_id, parent_ids }] });
const move = (subgoal_id = g[0], destination_goal_id = g[4]) => ({ moves: [{ subgoal_id, destination_goal_id }] });
const update = (extra = {}) => ({ items: [{ item_id: i1, ...extra }] });
async function fixture(t: any, options: { edges?: any[]; failAt?: number; lostAt?: number; malformedAt?: number; drift?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const links = structuredClone(options.edges ?? [edge(g[0], g[1])]);
  const goals = new Map(g.map(uuid => [uuid, { id: uuid, title: uuid, is_done: 1 }]));
  const items = new Map([
    [i1, { id: i1, goal_id: g[0], title: "A", description_md: "Keep", is_done: 0, completed_at: null as string | null, display_order: 0, created_at: "original" }],
    [i2, { id: i2, goal_id: g[1], title: "B", description_md: "Other", is_done: 1, completed_at: "old-completion" as string | null, display_order: 9, created_at: "original" }],
  ]);
  const comments: any[] = [{ id: id(91), goal_checklist_item_id: i1, body_md: "Previous evidence", author_role: "human", author_instance_key: "owner" }];
  let graphReads = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = req.url!, method = req.method!;
    calls.push({ method, path, body }); const count = calls.length;
    res.setHeader("Content-Type", "application/json");
    if (options.failAt === count) { res.writeHead(503).end('{}'); return; }
    let result: any;
    if (method === "GET" && path === "/api/goal-relationships") {
      graphReads++;
      if (options.drift && graphReads > 1) links.push(edge(g[0], g[1], 999));
      result = links.filter((link: any) => !link.deleted_at);
    } else if (method === "GET" && path.startsWith("/api/goals/")) result = goals.get(path.split('/').at(-1)!);
    else if (method === "GET" && path.startsWith("/api/goal-checklist-items/")) result = items.get(path.split('/').at(-1)!);
    else if (method === "POST" && path === "/api/goal-relationships") {
      result = { id: id(500 + links.length), ...body, deleted_at: null }; links.push(result);
    } else if (method === "DELETE" && path.startsWith("/api/goal-relationships/")) {
      const link = links.find((link: any) => path.endsWith(link.id));
      if (link) { link.deleted_at = "deleted"; result = { id: link.id, deleted_at: link.deleted_at }; }
    } else if (method === "PATCH" && path.startsWith("/api/goal-checklist-items/")) {
      const item = items.get(path.split('/').at(-1)!);
      if (item) {
        if (Object.keys(body).some(key => !["actor_role", "actor_instance_key", "title", "description_md", "is_done"].includes(key))) { res.writeHead(422).end('{}'); return; }
        for (const field of ["title", "description_md", "is_done"]) if (field in body) (item as any)[field] = body[field];
        if ("is_done" in body) item.completed_at = body.is_done ? "new-completion" : null;
        result = item;
      }
    } else if (method === "POST" && /\/api\/goal-checklist-items\/[^/]+\/comments$/.test(path)) {
      const item_id = path.split('/').at(-2)!;
      if (items.has(item_id)) { result = { id: id(700 + comments.length), goal_checklist_item_id: item_id, ...body }; comments.push(result); }
    }
    if (result === undefined) { res.writeHead(404).end('{}'); return; }
    if (options.lostAt === count) { req.socket.destroy(); return; }
    res.end(JSON.stringify(options.malformedAt === count ? {} : result));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, actor, calls, links, items, goals, comments };
}
const parents = (f: any, child = g[0]) => f.links.filter((l: any) => !l.deleted_at && l.relationship_type === "supports" && l.source_goal_id === child).map((l: any) => l.target_goal_id);
const writes = (f: any) => f.calls.filter((c: any) => c.method !== "GET");

test("additive parent batches retain all existing parents, support multiple children and deduplicate requested edges", async t => {
  const f = await fixture(t);
  const result = await setParents({ goals: [{ goal_id: g[0], parent_ids: [g[1], g[2], g[2]] }, { goal_id: g[3], parent_ids: [g[1]] }] }, f);
  assert.equal(result.status, "updated"); assert.equal(result.confirmed.length, 2);
  assert.deepEqual(parents(f), [g[1], g[2]]); assert.deepEqual(parents(f, g[3]), [g[1]]);
  assert.ok(writes(f).every((c: any) => c.method === "POST" && c.body.actor_instance_key === actor.actor_instance_key));
  const count = writes(f).length;
  assert.equal((await setParents(add(g[0], [g[1], g[2]]), f)).status, "unchanged");
  assert.equal(writes(f).length, count);
});

test("additive preflight rejects all-batch cycles/self references/missing Goals before writes", async t => {
  const f = await fixture(t, { edges: [] });
  await assert.rejects(setParents({ goals: [{ goal_id: g[0], parent_ids: [g[1]] }, { goal_id: g[1], parent_ids: [g[0]] }] }, f), /cycle/);
  await assert.rejects(setParents(add(g[0], [g[0]]), f), /itself/);
  await assert.rejects(setParents({ goals: [{ goal_id: g[0], parent_ids: [g[2], id(999)] }] }, f), /404/);
  assert.equal(writes(f).length, 0);
});

test("deleted/non-support edges do not count as parents; unrelated existing cycles do not block additions", async t => {
  const f = await fixture(t, { edges: [edge(g[0], g[2], 201, { deleted_at: "old" }), edge(g[0], g[2], 202, { relationship_type: "related" }), edge(g[3], g[4], 203), edge(g[4], g[3], 204)] });
  const result = await setParents(add(), f);
  assert.equal(result.status, "updated"); assert.equal(result.confirmed.length, 1);
  assert.deepEqual(parents(f), [g[2]]); assert.equal(f.links[0].deleted_at, "old");
});

test("additive link lost-response failure reports uncertainty without retry or deletion", async t => {
  const f = await fixture(t, { edges: [], lostAt: 4 }); // graph + two Goal GETs + first POST
  const result = await setParents(add(), f);
  assert.equal(result.status, "failed"); assert.equal(result.uncertain?.operation, "add_parent");
  assert.deepEqual(parents(f), [g[2]]); assert.equal(writes(f).length, 1);
});

test("exclusive move adds destination BEFORE removing every old parent, preserving child/unrelated links", async t => {
  const f = await fixture(t, { edges: [edge(g[0], g[1], 201), edge(g[0], g[2], 202), edge(g[3], g[0], 203), edge(g[0], g[1], 204, { relationship_type: "related" })] });
  const result = await moveSubgoals(move(), f);
  assert.equal(result.status, "updated"); assert.deepEqual(parents(f), [g[4]]);
  assert.deepEqual(parents(f, g[3]), [g[0]]); assert.equal(f.links[3].deleted_at, null);
  assert.deepEqual(writes(f).map((c: any) => c.method), ["POST", "DELETE", "DELETE"]);
  assert.ok(writes(f).every((c: any) => !c.path.startsWith('/api/goals/')));
});

test("exclusive existing destination is retained; already exclusive is a no-op; batches move independent children", async t => {
  const f = await fixture(t, { edges: [edge(g[0], g[1]), edge(g[0], g[4], 202), edge(g[3], g[2], 203)] });
  assert.equal((await moveSubgoals(move(), f)).status, "updated");
  assert.deepEqual(writes(f).map((c: any) => c.method), ["DELETE"]);
  const count = writes(f).length;
  assert.equal((await moveSubgoals(move(), f)).status, "unchanged"); assert.equal(writes(f).length, count);
  const batch = await moveSubgoals({ moves: [{ subgoal_id: g[0], destination_goal_id: g[2] }, { subgoal_id: g[3], destination_goal_id: g[1] }] }, f);
  assert.equal(batch.status, "updated"); assert.deepEqual(parents(f), [g[2]]); assert.deepEqual(parents(f, g[3]), [g[1]]);
});

test("exclusive preflight rejects descendant cycles, repeated children and unsafe sequential batches", async t => {
  const f = await fixture(t, { edges: [edge(g[0], g[1]), edge(g[3], g[0], 202)] });
  await assert.rejects(moveSubgoals(move(g[0], g[3]), f), /cycle/);
  await assert.rejects(moveSubgoals(move(g[0], g[0]), f), /self/);
  await assert.rejects(moveSubgoals({ moves: [...move().moves, ...move(g[0], g[2]).moves] }, f), /repeated/);
  await assert.rejects(moveSubgoals({ moves: [{ subgoal_id: g[1], destination_goal_id: g[0] }, { subgoal_id: g[0], destination_goal_id: g[2] }] }, f), /cycle/);
  assert.equal(writes(f).length, 0);
});

test("exclusive destination failure never removes old parents", async t => {
  const f = await fixture(t, { failAt: 4 });
  const result = await moveSubgoals(move(), f);
  assert.equal(result.status, "failed"); assert.deepEqual(parents(f), [g[1]]);
  assert.deepEqual(writes(f).map((c: any) => c.method), ["POST"]);
});

test("exclusive deletion failure/lost response reports partial state and does not roll back", async t => {
  for (const options of [{ failAt: 5 }, { lostAt: 5 }, { malformedAt: 5 }]) {
    const f = await fixture(t, options);
    const result = await moveSubgoals(move(), f);
    assert.equal(result.status, "failed"); assert.equal(result.confirmed.length, 1);
    assert.equal(result.uncertain?.operation, "remove_parent");
    assert.ok(parents(f).includes(g[4])); assert.equal(writes(f).length, 2);
  }
});

test("exclusive final read detects unexpected concurrent parent instead of claiming success", async t => {
  const f = await fixture(t, { drift: true });
  const result = await moveSubgoals(move(), f);
  assert.equal(result.status, "failed"); assert.match(result.error!, /read-back/);
  assert.equal(result.uncertain, undefined); assert.equal(writes(f).length, 2);
});

test("post-write relationship reads detect concurrent cycles without automatic repair", async t => {
  for (const exclusive of [false, true]) {
    const f = await fixture(t, { edges: exclusive ? [edge(g[0], g[1])] : [] });
    const target = exclusive ? g[4] : g[2];
    const options = { ...f, fetch: async (url: any, init: any) => {
      const response = await fetch(url, init);
      if (init?.method === "POST") f.links.push(edge(target, g[0], 999));
      return response;
    } };
    const result = exclusive ? await moveSubgoals(move(), options) : await setParents(add(), options);
    assert.equal(result.status, "failed"); assert.match(result.error!, /read-back/);
    assert.equal(result.uncertain, undefined);
    assert.equal(writes(f).length, exclusive ? 2 : 1);
  }
});

test("cross-Goal checklist batches preserve unspecified data/order and append comments without editing history", async t => {
  const f = await fixture(t); const previous = structuredClone(f.comments);
  const result = await updateChecklistItems({ items: [
    { item_id: i1, title: "A updated", description_md: null, status: "complete", append_comments: ["First", "Second"] },
    { item_id: i2, status: "incomplete", append_comments: ["Third"] },
  ] }, f);
  assert.equal(result.status, "updated"); assert.equal(result.confirmed.length, 5);
  assert.equal(f.items.get(i1)!.is_done, 1); assert.equal(f.items.get(i1)!.completed_at, "new-completion");
  assert.equal(f.items.get(i1)!.description_md, null); assert.equal(f.items.get(i1)!.title, "A updated");
  assert.equal(f.items.get(i2)!.is_done, 0); assert.equal(f.items.get(i2)!.completed_at, null);
  assert.equal(f.items.get(i2)!.description_md, "Other"); assert.equal(f.items.get(i2)!.title, "B");
  assert.equal(f.items.get(i1)!.goal_id, g[0]); assert.equal(f.items.get(i2)!.goal_id, g[1]);
  assert.equal(f.items.get(i1)!.display_order, 0); assert.equal(f.items.get(i2)!.display_order, 9);
  assert.deepEqual(f.comments.slice(0, 1), previous); assert.deepEqual(f.comments.slice(1).map(c => c.body_md), ["First", "Second", "Third"]);
  assert.ok(writes(f).filter((c: any) => c.path.endsWith('/comments')).every((c: any) => c.method === "POST"));
});

test("identical fields do not change timestamps; repeated item operations apply sequentially, comments never deduplicate", async t => {
  const f = await fixture(t);
  assert.equal((await updateChecklistItems({ items: [{ item_id: i1 }, { item_id: i2, title: "B", status: "complete", append_comments: [] }] }, f)).status, "unchanged");
  assert.equal(writes(f).length, 0); assert.equal(f.items.get(i2)!.completed_at, "old-completion");
  const result = await updateChecklistItems({ items: [{ item_id: i1, status: "complete", append_comments: ["Same"] }, { item_id: i1, status: "incomplete", append_comments: ["Same"] }] }, f);
  assert.equal(result.status, "updated"); assert.equal(f.items.get(i1)!.is_done, 0);
  assert.deepEqual(f.comments.slice(1).map(c => c.body_md), ["Same", "Same"]);
});

test("bad checklist states/fields/comments and missing later items cause zero writes", async t => {
  const f = await fixture(t);
  for (const change of [{ status: "blocked" }, { status: "in_progress" }, { status: "abandoned" }, { title: " " }, { description_md: 2 }, { append_comments: [""] }, { append_comments: "text" }, { comments: [] }, { display_order: 1 }, { goal_id: g[1] }, { completed_at: "yesterday" }]) {
    await assert.rejects(updateChecklistItems(update(change) as any, f));
  }
  await assert.rejects(updateChecklistItems({ items: [{ item_id: i1, title: "New" }, { item_id: id(999), status: "complete" }] }, f), /404/);
  assert.equal(writes(f).length, 0);
});

test("checklist failure after PATCH/between comments reports confirmations and stops without replay", async t => {
  for (const options of [{ failAt: 4 }, { lostAt: 4 }, { malformedAt: 4 }]) {
    const f = await fixture(t, options);
    const result = await updateChecklistItems(update({ title: "New", append_comments: ["One", "Two", "Three"] }), f);
    assert.equal(result.status, "failed"); assert.equal(result.confirmed.length, 2);
    assert.equal(result.uncertain?.operation, "append_comment"); assert.equal(writes(f).length, 3);
    assert.equal(f.items.get(i1)!.title, "New"); assert.equal(f.comments[0].body_md, "Previous evidence");
  }
});

test("cancellation before operations sends nothing; cancellation after confirmed comment does not retry", async t => {
  const f = await fixture(t); const cancelled = new AbortController(); cancelled.abort();
  for (const run of [() => setParents(add(), { ...f, signal: cancelled.signal }), () => moveSubgoals(move(), { ...f, signal: cancelled.signal }), () => updateChecklistItems(update({ title: "New" }), { ...f, signal: cancelled.signal })]) await assert.rejects(run());
  assert.equal(f.calls.length, 0);
  const controller = new AbortController();
  const result = await updateChecklistItems(update({ append_comments: ["One", "Two"] }), { ...f, signal: controller.signal, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (init?.method === "POST") { const saved = await response.json(); controller.abort(); return Response.json(saved); }
    return response;
  } });
  assert.equal(result.status, "failed"); assert.equal(result.confirmed.length, 1);
  assert.equal(result.uncertain, undefined); assert.equal(f.comments.length, 2);
});

test("malformed batch shapes and supplied actor/position fields fail before network work", async t => {
  const f = await fixture(t);
  for (const [run, values] of [
    [setParents, [{}, { goals: [] }, { goals: [{ goal_id: g[0], parent_ids: [] }] }, { goals: [{ goal_id: "title", parent_ids: [g[1]] }] }]],
    [moveSubgoals, [{}, { moves: [] }, { moves: [{ subgoal_id: g[0], destination_goal_id: "title" }] }]],
    [updateChecklistItems, [{}, { items: [] }, { items: [{ item_id: "title" }] }]],
  ] as any[]) for (const value of values) await assert.rejects(run(value, f));
  assert.equal(f.calls.length, 0);
  for (const [run, value] of [[setParents, add()], [moveSubgoals, move()], [updateChecklistItems, update({ title: "New" })]] as any[]) {
    await assert.rejects(run(value, { ...f, actor: { ...actor, actor_instance_key: "" } }), /attribution/);
  }
  assert.equal(f.calls.length, 0);
});

const host = process.env.PI_TEST_AGENT_ROOT;
test("all three Pi-registered write tools execute with startup attribution and structured failure results", { skip: !host }, async t => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "goal-mutations-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, ".scryer"), JSON.stringify({ created_by: [{ name: actor.actor_instance_key }] }));
  const old = process.env.SCRYER_API_BASE_URL; process.env.SCRYER_API_BASE_URL = f.baseUrl;
  t.after(() => { if (old === undefined) delete process.env.SCRYER_API_BASE_URL; else process.env.SCRYER_API_BASE_URL = old; });
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("extensions/scryer-checklist/index.ts")], directory);
  assert.deepEqual(loaded.errors, []);
  const tool = (name: string) => loaded.extensions[0].tools.get(name).definition;
  const ctx = { cwd: "/elsewhere", sessionManager: { getHeader: () => ({ cwd: directory }) } };
  for (const [name, input] of [["set_parent_for_goal", add()], ["move_subgoal_to_goal", move()], ["update_checklist_items", update({ title: "New", append_comments: ["Logged"] })]] as const) {
    const result = await tool(name).execute(name, input, undefined, undefined, ctx);
    assert.equal(result.structuredContent.status, "updated"); assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  for (const call of writes(f)) assert.equal(call.body.actor_instance_key ?? call.body.author_instance_key, actor.actor_instance_key);
  const failed = await fixture(t, { failAt: 2 }); process.env.SCRYER_API_BASE_URL = failed.baseUrl;
  const error = await tool("update_checklist_items").execute("failure", update({ title: "New" }), undefined, undefined, ctx);
  assert.equal(error.isError, true); assert.equal(error.structuredContent.status, "failed");
  await writeFile(join(directory, ".scryer"), '{"created_by":[]}');
  const count = failed.calls.length;
  await assert.rejects(tool("set_parent_for_goal").execute("identity", add(), undefined, undefined, ctx), /identity/);
  assert.equal(failed.calls.length, count);
});
