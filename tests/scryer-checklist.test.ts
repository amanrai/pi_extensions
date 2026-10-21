import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { planOrder, reorderChecklist, validateInput, type Item, type Move } from "../extensions/scryer-checklist/order.ts";
import { getChecklistForGoal } from "../extensions/scryer-checklist/read.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const goal = id(99);
const items = (): Item[] => ["A", "B", "C", "D"].map((title, i) => ({ id: id(i + 1), goal_id: goal, title, display_order: i }));
const move = (item: number, operation: Move["operation"], anchor: number): Move => ({ item_id: id(item), operation, anchor_id: id(anchor) });
const input = (...moves: Move[]) => ({ goal_id: goal, moves });
const actor = { actor_role: "pi-agent", actor_instance_key: "test_harrier_abcdefghijkl" };
const titles = (list: { title: string }[]) => list.map(item => item.title).join("");
async function fixture(t: any, setup: { failPatch?: number; lostResponse?: boolean; drift?: boolean; invalid?: unknown; readFailure?: boolean } = {}) {
  let rows = items().map(item => ({ ...item, description_md: `Keep ${item.title}`, is_done: 1, completed_at: "2026-01-01T00:00:00Z" }));
  const calls: { method: string; path: string; body?: any }[] = [];
  let patches = 0, reads = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: req.method!, path: req.url!, body });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      reads++;
      if (reads > 1 && setup.readFailure) { res.writeHead(503).end('{}'); return; }
      const order = [...rows].sort((a, b) => (a.display_order ?? -Infinity) - (b.display_order ?? -Infinity));
      if (setup.drift && reads > 1) order.reverse();
      res.end(JSON.stringify(setup.invalid === undefined ? order : setup.invalid)); return;
    }
    patches++;
    if (patches === setup.failPatch && !setup.lostResponse) { res.writeHead(503).end('{}'); return; }
    assert.deepEqual(Object.keys(body).sort(), ["actor_instance_key", "actor_role", "display_order"]);
    assert.equal(body.actor_instance_key, actor.actor_instance_key);
    const row = rows.find(item => req.url!.endsWith(item.id))!;
    row.display_order = body.display_order;
    if (patches === setup.failPatch && setup.lostResponse) { req.socket.destroy(); return; }
    res.end(JSON.stringify(row));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  return { baseUrl, actor, rows, calls };
}

test("agreed before and after examples; pure planning preserves source and unaffected order", () => {
  const original = items();
  assert.equal(titles(planOrder(original, [move(3, "move_before", 1)])), "CABD");
  assert.equal(titles(planOrder(original, [move(1, "move_after", 3)])), "BCAD");
  assert.equal(titles(original), "ABCD");
});

test("sequential moves use previous results and can describe a complete order", () => {
  assert.equal(titles(planOrder(items(), [move(3, "move_before", 1), move(4, "move_after", 3)])), "CDAB");
  assert.equal(titles(planOrder(items(), [move(4, "move_before", 1), move(3, "move_before", 1), move(2, "move_before", 1)])), "DCBA");
});

test("every pair/direction preserves membership, adjacency and unaffected relative order", () => {
  for (let a = 1; a <= 4; a++) for (let b = 1; b <= 4; b++) for (const op of ["move_before", "move_after"] as const) {
    if (a === b) continue;
    const result = planOrder(items(), [move(a, op, b)]);
    assert.equal(result.findIndex(i => i.id === id(a)), result.findIndex(i => i.id === id(b)) + (op === "move_before" ? -1 : 1));
    assert.deepEqual(result.filter(i => i.id !== id(a)), items().filter(i => i.id !== id(a)));
  }
});

test("reject indexes, titles, extra fields, self moves, bad operations and empty/oversized requests", () => {
  for (const bad of [null, {}, { goal_id: "Title", moves: [] }, input(), input(move(1, "move_before", 1)),
    { ...input(move(1, "move_before", 2)), index: 0 }, input({ ...move(1, "move_before", 2), index: 0 } as any),
    input({ ...move(1, "move_before", 2), item_id: "A" }), input({ ...move(1, "move_before", 2), operation: "set_order" } as any),
    { goal_id: goal, moves: Array(101).fill(move(1, "move_before", 2)) }]) assert.throws(() => validateInput(bad));
});

test("real HTTP calls persist only changed positions, attribute writes and verify final order", async t => {
  const f = await fixture(t);
  const result = await reorderChecklist(input(move(3, "move_before", 1)), f);
  assert.equal(result.status, "reordered");
  assert.equal(titles(result.observed!), "CABD");
  assert.deepEqual(result.confirmed_updates, [id(3), id(1), id(2)]);
  assert.equal(result.http_requests, 5);
  assert.deepEqual(f.calls.map(c => c.method), ["GET", "PATCH", "PATCH", "PATCH", "GET"]);
  for (const row of f.rows) { assert.equal(row.description_md, `Keep ${row.title}`); assert.equal(row.is_done, 1); }
});

test("all moves validated before writes, including wrong checklist/deleted/missing anchor", async t => {
  const f = await fixture(t);
  await assert.rejects(reorderChecklist(input(move(3, "move_before", 1), move(1, "move_after", 88)), f), /belong/);
  assert.deepEqual(f.calls.map(c => c.method), ["GET"]);
});

test("no-op and net-no-op batches do not write or renumber nulls/ties", async t => {
  const f = await fixture(t);
  f.rows.forEach(row => { (row as any).display_order = null; });
  for (const moves of [[move(1, "move_before", 2)], [move(3, "move_before", 1), move(3, "move_after", 2)]]) {
    const result = await reorderChecklist(input(...moves), f);
    assert.equal(result.status, "unchanged"); assert.equal(result.http_requests, 1);
  }
  assert.ok(f.calls.every(c => c.method === "GET"));
});

test("real moves normalize null positions based on API ordering", async t => {
  const f = await fixture(t);
  f.rows.forEach(row => { (row as any).display_order = null; });
  const result = await reorderChecklist(input(move(4, "move_before", 1)), f);
  assert.equal(result.status, "reordered"); assert.equal(titles(result.observed!), "DABC");
  assert.equal(result.confirmed_updates.length, 4);
});

test("HTTP failure stops writes, returns confirmed/uncertain/observed state, never retries", async t => {
  const f = await fixture(t, { failPatch: 2 });
  const result = await reorderChecklist(input(move(3, "move_before", 1)), f);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.confirmed_updates, [id(3)]); assert.equal(result.uncertain_item_id, id(1));
  assert.equal(f.calls.filter(c => c.method === "PATCH").length, 2);
  assert.ok(result.observed); assert.match(result.error!, /partial or uncertain/);
});

test("lost response after commit is unknown, not retried or rolled back", async t => {
  const f = await fixture(t, { failPatch: 2, lostResponse: true });
  const result = await reorderChecklist(input(move(3, "move_before", 1)), f);
  assert.equal(result.status, "failed"); assert.equal(result.uncertain_item_id, id(1));
  assert.equal(f.rows[0].display_order, 1, "write happened although response was lost");
  assert.equal(f.calls.filter(c => c.method === "PATCH").length, 2);
});

test("read-back mismatch detects drift without repair; unavailable verification is not success", async t => {
  for (const setup of [{ drift: true }, { readFailure: true }]) {
    const f = await fixture(t, setup);
    const result = await reorderChecklist(input(move(3, "move_before", 1)), f);
    assert.equal(result.status, "failed"); assert.equal(result.confirmed_updates.length, 3);
    assert.equal(result.uncertain_item_id, undefined);
    assert.equal(f.calls.filter(c => c.method === "PATCH").length, 3);
  }
});

test("malformed or foreign API records fail closed before mutation", async t => {
  for (const invalid of [{}, [{ ...items()[0], goal_id: id(88) }], [items()[0], items()[0]], [{ ...items()[0], display_order: 0.5 }]]) {
    const f = await fixture(t, { invalid });
    await assert.rejects(reorderChecklist(input(move(3, "move_before", 1)), f));
    assert.ok(f.calls.every(c => c.method === "GET"));
  }
});

test("cancellation before start sends nothing; missing actor sends nothing", async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reorderChecklist(input(move(3, "move_before", 1)), { ...f, signal: controller.signal }));
  await assert.rejects(reorderChecklist(input(move(3, "move_before", 1)), { ...f, actor: { ...actor, actor_instance_key: "" } }));
  assert.equal(f.calls.length, 0);
});

test("same-process calls on one checklist serialize their read-modify-write operations", async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([reorderChecklist(input(move(3, "move_before", 1)), f), reorderChecklist(input(move(4, "move_after", 3)), f)]);
  assert.equal(a.status, "reordered"); assert.equal(b.status, "reordered");
  assert.equal(titles(b.before), "CABD"); assert.equal(titles(b.observed!), "CDAB");
});

const host = process.env.PI_TEST_AGENT_ROOT;
test("installed Pi loads distinct read/reorder tools; registered execute uses startup identity, returns errors, requires no skill", { skip: !host }, async t => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "checklist-tool-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, ".scryer"), JSON.stringify({ created_by: [{ name: actor.actor_instance_key }] }));
  const old = process.env.SCRYER_API_BASE_URL; process.env.SCRYER_API_BASE_URL = f.baseUrl;
  t.after(() => { if (old === undefined) delete process.env.SCRYER_API_BASE_URL; else process.env.SCRYER_API_BASE_URL = old; });
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("extensions/scryer-checklist/index.ts")], directory);
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions[0].tools;
  assert.deepEqual([...tools.keys()], ["get_top_level_goals", "get_checklist_for_goal", "get_subgoals_for_goal", "scryer_reorder_checklist"]);
  const readTool = tools.get("get_checklist_for_goal").definition;
  const readResult = await readTool.execute("read", { goal_id: goal }, undefined, undefined, {});
  assert.deepEqual(readResult.details, f.rows);
  assert.deepEqual(readResult.structuredContent, f.rows);
  assert.deepEqual(JSON.parse(readResult.content[0].text), f.rows);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "GET", "read tool needs no startup identity or skill");
  const tool = tools.get("scryer_reorder_checklist").definition;
  console.log("TOOL_DEFINITION " + JSON.stringify({
    serialized_registration_bytes: Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    scope: "Fixed additional tool definition; registration JSON, not provider-specific token accounting",
  }));
  const ctx = { cwd: "/not-startup", sessionManager: { getHeader: () => ({ cwd: directory }) } };
  const result = await tool.execute("test", input(move(3, "move_before", 1)), undefined, undefined, ctx);
  assert.equal(result.details.status, "reordered"); assert.equal(result.isError, undefined);
  assert.equal(titles(result.details.observed), "CABD");
  assert.match(tool.description, /NOT atomic/);
  const failed = await fixture(t, { failPatch: 1 });
  process.env.SCRYER_API_BASE_URL = failed.baseUrl;
  const error = await tool.execute("failure", input(move(3, "move_before", 1)), undefined, undefined, ctx);
  assert.equal(error.isError, true); assert.equal(error.details.status, "failed");
  process.env.SCRYER_API_BASE_URL = f.baseUrl;
  await writeFile(join(directory, ".scryer"), '{"created_by":[]}');
  const count = f.calls.length;
  await assert.rejects(tool.execute("test", input(move(1, "move_after", 3)), undefined, undefined, ctx), /identity/);
  assert.equal(f.calls.length, count);
});

test("cancellation between writes reports partial work and sends no subsequent mutation", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await reorderChecklist(input(move(3, "move_before", 1)), {
    ...f, signal: controller.signal,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "PATCH") {
        const saved = await response.json();
        controller.abort();
        return Response.json(saved);
      }
      return response;
    },
  });
  assert.equal(result.status, "failed"); assert.deepEqual(result.confirmed_updates, [id(3)]);
  assert.equal(result.uncertain_item_id, undefined);
  assert.deepEqual(f.calls.map(c => c.method), ["GET", "PATCH"]);
});

test("tied and sparse positions preserve API order when calculating moves", async t => {
  const f = await fixture(t);
  [10, 10, 50, 200].forEach((position, i) => { f.rows[i].display_order = position; });
  const result = await reorderChecklist(input(move(1, "move_after", 3)), f);
  assert.equal(result.status, "reordered"); assert.equal(titles(result.observed!), "BCAD");
});

test("workload comparison executes an authored HTTP script and tool core against identical fixtures", async t => {
  const f = await fixture(t);
  const args = input(move(3, "move_before", 1));
  // Deliberately strong baseline: one bash invocation, known IDs, no schema discovery.
  // Both paths read, compute, update changed positions, and verify. This script only
  // covers the success case; the reusable tool additionally handles the tested failures.
  const script = `const [base, input, actor] = process.argv.slice(1).map(JSON.parse);
const request = async (path, body) => {
  const r = await fetch(base + path, {method: body ? 'PATCH' : 'GET',
    headers: {'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
  if (!r.ok) throw Error('HTTP ' + r.status);
  return r.json();
};
const path = '/api/goals/' + input.goal_id + '/checklist-items';
const original = await request(path), order = [...original];
for (const m of input.moves) {
  const i = order.findIndex(x => x.id === m.item_id);
  if (i < 0 || !order.some(x => x.id === m.anchor_id) || m.item_id === m.anchor_id) throw Error('Invalid move');
  const [item] = order.splice(i, 1);
  order.splice(order.findIndex(x => x.id === m.anchor_id) + (m.operation === 'move_after' ? 1 : 0), 0, item);
}
for (const [i, item] of order.entries()) if (item.display_order !== i)
  await request('/api/goal-checklist-items/' + item.id, {...actor, display_order:i});
const observed = await request(path);
if (observed.map(x=>x.id).join() !== order.map(x=>x.id).join()) throw Error('Verification failed');
console.log(JSON.stringify(observed.map(({id,title})=>({id,title}))));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(f.baseUrl), JSON.stringify(args), JSON.stringify(actor)]);
  const baselineRequests = f.calls.length;
  f.rows.splice(0, f.rows.length, ...items().map(item => ({ ...item, description_md: `Keep ${item.title}`, is_done: 1, completed_at: "2026-01-01T00:00:00Z" })));
  const result = await reorderChecklist(args, f);
  assert.deepEqual(JSON.parse(stdout), result.observed);
  assert.equal(baselineRequests, result.http_requests);
  const toolPayloadBytes = Buffer.byteLength(JSON.stringify(args));
  // Count the actual shell command payload needed to reproduce this baseline.
  const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const command = ["node", "--input-type=module", "-e", script, JSON.stringify(f.baseUrl), JSON.stringify(args), JSON.stringify(actor)].map(shellQuote).join(" ");
  const bashPayloadBytes = Buffer.byteLength(JSON.stringify({ command }));
  assert.ok(bashPayloadBytes > toolPayloadBytes);
  console.log("WORKLOAD " + JSON.stringify({
    fixture: "ABCD -> move C before A -> CABD", known_uuids: true,
    baseline_model_facing_invocations: 1, tool_model_facing_invocations: 1,
    baseline_http_requests: baselineRequests, tool_http_requests: result.http_requests,
    authored_bash_argument_bytes: bashPayloadBytes, tool_argument_bytes: toolPayloadBytes,
    reduction_percent: Number(((1 - toolPayloadBytes / bashPayloadBytes) * 100).toFixed(1)),
    scope: "UTF-8 argument bytes, not tokens, model latency or an LLM benchmark; excludes fixed tool declaration and result text",
  }));
});
