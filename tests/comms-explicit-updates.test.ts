import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { sendExplicitUpdate, validateExplicitUpdate, type ExplicitUpdate } from "../extensions/comms/explicit-updates.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sender = { from: id(1), identity: "test_harrier_abcdefghijkl" };
const payload = (): ExplicitUpdate => ({ id: id(2), from: sender.from, kind: "decision", title: "Explicit update", body: "Preserve exactly", metadata: { source: "caller supplied", v2meta: { identity: sender.identity, foldersTouched: [], goals: [{ id: id(3), title: "Explicit alternate Goal" }] } } });
async function fixture(t: any, options: { postStatus?: number; dropPost?: boolean; readStatus?: number; corrupt?: (row: any) => any; invalidRead?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [], updates = new Map<string, any>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: req.method!, path: req.url!, body }); res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      if (options.postStatus) { res.writeHead(options.postStatus).end('{}'); return; }
      if (updates.has(body.id)) { res.writeHead(409).end('{"error":"duplicate update id"}'); return; }
      updates.set(body.id, { ...body, createdAt: "server-created", receivedAt: "server-received" });
      if (options.dropPost) { req.socket.destroy(); return; }
      res.writeHead(201).end(JSON.stringify({ ok: true, id: body.id, from: body.from })); return;
    }
    if (options.readStatus) { res.writeHead(options.readStatus).end('{}'); return; }
    const url = new URL(req.url!, 'http://local');
    assert.equal(url.searchParams.get('limit'), '500');
    const rows = [...updates.values()].filter(row => row.from === url.searchParams.get('from')).map(row => options.corrupt ? options.corrupt(structuredClone(row)) : row);
    res.end(JSON.stringify(options.invalidRead ? { updates: "bad" } : { updates: rows }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, sender, calls, updates };
}

test("all explicit fields, alternate Goal metadata, Unicode/whitespace/long content pass through exactly", async t => {
  const f = await fixture(t); const p = payload();
  p.title = '  ' + 'Long title '.repeat(30) + '  '; p.body = '  λ\n' + 'full body '.repeat(5000) + '\n  ';
  p.metadata.v2meta.foldersTouched = ['thinkpad:/home/amanrai/Code', 'mini:/Users/amanrai/Code'];
  const before = structuredClone(p);
  const result = await sendExplicitUpdate(p, f);
  assert.equal(result.status, 'sent'); assert.equal(result.verified, true); assert.equal(result.http_requests, 2);
  assert.deepEqual(f.calls[0].body, before); assert.deepEqual(p, before);
  assert.equal(f.updates.get(p.id).body, p.body); assert.equal(f.updates.get(p.id).title, p.title);
  assert.equal(f.calls[0].body.createdAt, undefined, 'tool adds no fields; server owns its timestamps');
  assert.deepEqual(f.updates.get(p.id).metadata.v2meta.goals, p.metadata.v2meta.goals);
});

test("explicit empty folder/Goal arrays stay empty; coding markup is neither added nor stripped", async t => {
  const f = await fixture(t); const p = payload(); p.metadata.v2meta.goals = []; p.body = '<coding>Caller supplied fixture text</coding>';
  assert.equal((await sendExplicitUpdate(p, f)).status, 'sent');
  assert.deepEqual(f.calls[0].body, p);
});

test("missing required fields and invalid attribution/metadata fail before network work", async t => {
  const f = await fixture(t);
  const cases: any[] = [];
  for (const field of ['id', 'from', 'kind', 'title', 'body', 'metadata']) { const p: any = payload(); delete p[field]; cases.push(p); }
  for (const field of ['identity', 'foldersTouched', 'goals']) { const p: any = payload(); delete p.metadata.v2meta[field]; cases.push(p); }
  for (const change of [
    (p: any) => { p.id = 'bad'; }, (p: any) => { p.from = id(99); },
    (p: any) => { p.metadata.v2meta.identity = 'another_identity'; },
    (p: any) => { p.metadata.v2meta.identity = { name: sender.identity }; },
    (p: any) => { p.metadata.identities = []; }, (p: any) => { p.metadata.created_by = []; },
    (p: any) => { p.metadata.v2meta.identities = []; },
    (p: any) => { p.metadata.v2meta.goals = undefined; },
    (p: any) => { p.metadata.v2meta.goals.push(p.metadata.v2meta.goals[0]); },
    (p: any) => { p.metadata.v2meta.goals[0].id = 'title'; },
    (p: any) => { delete p.metadata.v2meta.goals[0].title; },
    (p: any) => { p.metadata.v2meta.foldersTouched = ['relative/path']; },
    (p: any) => { p.metadata.v2meta.foldersTouched = undefined; },
    (p: any) => { p.kind = ' '; }, (p: any) => { p.body = ''; }, (p: any) => { p.title = null; },
    (p: any) => { p.createdAt = 'not an accepted script field'; },
  ]) { const p = payload(); change(p); cases.push(p); }
  for (const p of cases) {
    assert.throws(() => validateExplicitUpdate(p, sender)); await assert.rejects(sendExplicitUpdate(p, f));
  }
  assert.equal(f.calls.length, 0);
});

test("identical explicit id replay verifies existing data, while conflicting id never overwrites", async t => {
  const f = await fixture(t); const p = payload();
  assert.equal((await sendExplicitUpdate(p, f)).status, 'sent');
  assert.equal((await sendExplicitUpdate(p, f)).status, 'already_stored');
  const conflict = await sendExplicitUpdate({ ...p, body: 'Different payload' }, f);
  assert.equal(conflict.status, 'failed'); assert.equal(conflict.verified, false);
  assert.equal(f.updates.size, 1); assert.equal(f.updates.get(p.id).body, p.body);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 3, 'one explicit POST per invocation, no internal retries');
});

test("lost POST acknowledgment reports unverified delivery and never reposts", async t => {
  const f = await fixture(t, { dropPost: true });
  const result = await sendExplicitUpdate(payload(), f);
  assert.equal(result.status, 'failed'); assert.equal(result.verified, false);
  assert.equal(result.http_requests, 1); assert.equal(f.updates.size, 1); assert.equal(f.calls.length, 1);
  assert.match(result.error!, /may already be stored/);
});

test("service errors, unreadable read-back and altered stored fields never claim success", async t => {
  for (const options of [{ postStatus: 400 }, { postStatus: 503 }, { readStatus: 503 }, { invalidRead: true },
    { corrupt: (row: any) => ({ ...row, body: 'truncated' }) },
    { corrupt: (row: any) => ({ ...row, metadata: { ...row.metadata, v2meta: { ...row.metadata.v2meta, goals: [] } } }) },
    { corrupt: (row: any) => ({ ...row, id: id(99) }) },
  ]) {
    const f = await fixture(t, options);
    const result = await sendExplicitUpdate(payload(), f);
    assert.equal(result.status, 'failed'); assert.equal(result.verified, false);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  }
});

test("cancellation before send does nothing; after POST reports possible delivery without retry", async t => {
  const f = await fixture(t); const before = new AbortController(); before.abort();
  await assert.rejects(sendExplicitUpdate(payload(), { ...f, signal: before.signal }));
  assert.equal(f.calls.length, 0);
  const after = new AbortController();
  const result = await sendExplicitUpdate(payload(), { ...f, signal: after.signal, fetch: async (url, init) => {
    const response = await fetch(url, init); after.abort(); return response;
  } });
  assert.equal(result.status, 'failed'); assert.equal(result.verified, false);
  assert.equal(f.calls.length, 1); assert.equal(f.updates.size, 1);
});
