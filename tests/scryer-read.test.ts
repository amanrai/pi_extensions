import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getChecklistForGoal, getSubgoalsForGoal } from "../extensions/scryer-checklist/read.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const root = id(1), a = id(2), b = id(3), c = id(4), other = id(5);
const fullGoal = (uuid: string) => ({ id: uuid, title: `Goal ${uuid}`, description_md: "Preserve me", is_done: 1, checklist_items: [{ title: "Retained checklist" }], extra: { future_field: true } });
const edge = (source: string, target: string, extra = {}) => ({ source_goal_id: source, target_goal_id: target, relationship_type: "supports", ...extra });
function fixture(routes: Record<string, unknown>) {
  const calls: { path: string; method: string | undefined }[] = [];
  const options = { baseUrl: "http://synthetic.invalid/", fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method });
    assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
    const body = routes[path];
    if (body instanceof Error) throw body;
    if (body instanceof Response) return body.clone();
    return body === undefined ? Response.json({}, { status: 404 }) : Response.json(body);
  }) as typeof fetch };
  return { calls, options };
}
function hierarchy(extra: Record<string, unknown> = {}) {
  return fixture({
    [`/api/goals/${root}`]: fullGoal(root), [`/api/goals/${root}/relationships`]: [edge(a, root), edge(b, root)],
    [`/api/goals/${a}`]: fullGoal(a), [`/api/goals/${a}/relationships`]: [edge(a, root), edge(c, a)],
    [`/api/goals/${b}`]: fullGoal(b), [`/api/goals/${b}/relationships`]: [edge(b, root)],
    [`/api/goals/${c}`]: fullGoal(c), [`/api/goals/${c}/relationships`]: [edge(c, a)],
    ...extra,
  });
}

test("checklist read preserves all fields and API ordering, uses one GET, no identity required", async () => {
  const items = [
    { id: b, goal_id: root, title: "B", display_order: null, description_md: "Full description", is_done: 1, completed_at: "2026-01-01T00:00:00Z", extra: { nested: [1, 2] } },
    { id: a, goal_id: root, title: "A", display_order: 90, created_at: "timestamp", updated_at: "timestamp" },
  ];
  const f = fixture({ [`/api/goals/${root}/checklist-items`]: items });
  assert.deepEqual(await getChecklistForGoal(root.toUpperCase(), f.options), items);
  assert.equal(f.calls.length, 1);
});

test("empty checklist is successful; missing Goal, transport error and malformed JSON are not empty success", async () => {
  const path = `/api/goals/${root}/checklist-items`;
  assert.deepEqual(await getChecklistForGoal(root, fixture({ [path]: [] }).options), []);
  for (const body of [Response.json({}, { status: 404 }), new Error("offline"), new Response("not JSON")]) {
    await assert.rejects(getChecklistForGoal(root, fixture({ [path]: body }).options));
  }
});

test("checklist rejects non-array, malformed, duplicate, deleted and foreign items", async () => {
  const valid = { id: a, goal_id: root, title: "A" };
  for (const body of [{}, [null], [{ ...valid, id: "not UUID" }], [{ ...valid, goal_id: other }], [valid, valid], [{ ...valid, deleted_at: "yesterday" }]]) {
    await assert.rejects(getChecklistForGoal(root, fixture({ [`/api/goals/${root}/checklist-items`]: body }).options));
  }
});

test("both readers reject invalid UUIDs and prior cancellation without network calls", async () => {
  for (const read of [getChecklistForGoal, getSubgoalsForGoal]) {
    const f = fixture({});
    await assert.rejects(read("title not UUID", f.options));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(read(root, { ...f.options, signal: controller.signal }));
    assert.equal(f.calls.length, 0);
  }
});

test("nested traversal returns full records under exact recorded hierarchy, including completed Goals", async () => {
  const f = hierarchy();
  assert.deepEqual(await getSubgoalsForGoal(root, f.options), [
    { goal: fullGoal(a), subgoals: [{ goal: fullGoal(c), subgoals: [] }] },
    { goal: fullGoal(b), subgoals: [] },
  ]);
  assert.equal(f.calls.length, 8, "one Goal read and relationship read per unique node");
});

test("parent links, unrelated links, other relationship types and deleted edges are not children", async () => {
  const f = hierarchy({ [`/api/goals/${root}/relationships`]: [edge(root, other), edge(other, a), edge(other, root, { relationship_type: "related" }), edge(other, root, { deleted_at: "yesterday" }), edge(a, root), edge(a, root)] });
  const result = await getSubgoalsForGoal(root, f.options);
  assert.deepEqual(result.map(node => node.goal.id), [a]);
  assert.equal(result[0].subgoals[0].goal.id, c);
  assert.ok(!f.calls.some(call => call.path === `/api/goals/${other}`));
});

test("shared descendants appear under every parent, without repeated network fetching", async () => {
  const f = hierarchy({ [`/api/goals/${b}/relationships`]: [edge(c, b)] });
  const result = await getSubgoalsForGoal(root, f.options);
  assert.equal(result[0].subgoals[0].goal.id, c); assert.equal(result[1].subgoals[0].goal.id, c);
  assert.equal(f.calls.length, 8);
});

test("empty hierarchy differs from missing parent", async () => {
  const f = fixture({ [`/api/goals/${root}`]: fullGoal(root), [`/api/goals/${root}/relationships`]: [] });
  assert.deepEqual(await getSubgoalsForGoal(root, f.options), []);
  await assert.rejects(getSubgoalsForGoal(root, fixture({}).options), /404/);
});

test("cycles and self-support fail rather than silently returning a truncated tree", async () => {
  for (const links of [[edge(root, c)], [edge(c, c)]]) {
    const f = hierarchy({ [`/api/goals/${c}/relationships`]: links });
    await assert.rejects(getSubgoalsForGoal(root, f.options), /Cycle/);
  }
});

test("failed descendant read, bad relationships and wrong Goal identity never return partial success", async () => {
  for (const changes of [
    { [`/api/goals/${c}`]: Response.json({}, { status: 503 }) },
    { [`/api/goals/${a}`]: fullGoal(other) },
    { [`/api/goals/${a}/relationships`]: {} },
    { [`/api/goals/${a}/relationships`]: [null] },
    { [`/api/goals/${a}/relationships`]: [edge("bad", a)] },
  ]) await assert.rejects(getSubgoalsForGoal(root, hierarchy(changes).options));
});

const host = process.env.PI_TEST_AGENT_ROOT;
test("registered nested-subgoal tool executes through Pi loader and real HTTP without an identity", { skip: !host }, async t => {
  const routes: Record<string, unknown> = {
    [`/api/goals/${root}`]: fullGoal(root), [`/api/goals/${root}/relationships`]: [edge(a, root)],
    [`/api/goals/${a}`]: fullGoal(a), [`/api/goals/${a}/relationships`]: [edge(c, a)],
    [`/api/goals/${c}`]: fullGoal(c), [`/api/goals/${c}/relationships`]: [],
  };
  const calls: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET"); calls.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    if (!(req.url! in routes)) res.writeHead(404).end('{}');
    else res.end(JSON.stringify(routes[req.url!]));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const old = process.env.SCRYER_API_BASE_URL;
  process.env.SCRYER_API_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(() => { if (old === undefined) delete process.env.SCRYER_API_BASE_URL; else process.env.SCRYER_API_BASE_URL = old; });
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("extensions/scryer-checklist/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []); assert.equal(calls.length, 0, "loading performs no requests");
  const tool = loaded.extensions[0].tools.get("get_subgoals_for_goal").definition;
  const expected = [{ goal: fullGoal(a), subgoals: [{ goal: fullGoal(c), subgoals: [] }] }];
  const result = await tool.execute("nested", { goal_id: root }, undefined, undefined, {});
  assert.deepEqual(result.details, expected); assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(JSON.parse(result.content[0].text), expected); assert.equal(calls.length, 6);
  delete routes[`/api/goals/${c}`];
  await assert.rejects(tool.execute("failure", { goal_id: root }, undefined, undefined, {}), /404/);
});

test("read calls do not persist caches across requests", async () => {
  const routes = { [`/api/goals/${root}`]: fullGoal(root), [`/api/goals/${root}/relationships`]: [] as unknown[] };
  const f = fixture(routes);
  assert.deepEqual(await getSubgoalsForGoal(root, f.options), []);
  routes[`/api/goals/${root}/relationships`].push(edge(a, root));
  await assert.rejects(getSubgoalsForGoal(root, f.options), /404/, "newly linked child is fetched on next call");
});
