import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { goalMetadata, goalOperations, initializeGoalFile, sessionGoalPath, transitionGoal } from "../extensions/comms/goals.ts";

const id = "80fcdba1-fefa-4126-82b6-851be04177cf";
const other = "f43950dc-732f-4a83-a534-478d869286cc";
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "session-goals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, ".scryer-test");
}

test("main session ID and header cwd determine path, not producer or changed cwd", () => {
  assert.equal(sessionGoalPath({ cwd: "/changed", sessionManager: { getSessionId: () => "main-session", getHeader: () => ({ cwd: "/startup" }) } }), "/startup/.scryer-main-session");
  assert.throws(() => sessionGoalPath({ cwd: "/", sessionManager: { getSessionId: () => "../unsafe" } }));
});

test("initialization is exclusive, preserves resumed state, isolates sessions", async t => {
  const path = await fixture(t);
  await Promise.all([initializeGoalFile(path), initializeGoalFile(path)]);
  await transitionGoal(path, "goal_start", id, "Filter updates");
  const before = await readFile(path, "utf8");
  await initializeGoalFile(path);
  assert.equal(await readFile(path, "utf8"), before);
  await initializeGoalFile(path + "-other");
  assert.deepEqual(JSON.parse(await readFile(path + "-other", "utf8")).current, []);
  await writeFile(path, "invalid");
  await assert.rejects(initializeGoalFile(path));
  assert.equal(await readFile(path, "utf8"), "invalid");
});

test("four transitions are exclusive and idempotent; only changes emit events", async t => {
  const path = await fixture(t);
  await initializeGoalFile(path);
  const events: any[] = [];
  for (const [operation, target] of Object.entries(goalOperations)) {
    const publish = async (field: string, uuid: string) => { events.push({ [field]: uuid }); };
    assert.equal((await transitionGoal(path, operation as any, id, "Filter updates", publish)).changed, true);
    assert.equal((await transitionGoal(path, operation as any, id, "Ignored rename", publish)).changed, false);
    const data = JSON.parse(await readFile(path, "utf8"));
    for (const [key, entries] of Object.entries(data)) assert.equal((entries as any[]).length, key === target ? 1 : 0);
    assert.equal(data[target][0].title, "Filter updates");
  }
  assert.equal(events.length, 4);
  assert.deepEqual(events[0], { goal_start: id });
});

test("parallel tools do not lose moves, clean duplicates and preserve additional lists", async t => {
  const path = await fixture(t);
  await initializeGoalFile(path);
  await Promise.all([transitionGoal(path, "goal_start", id), transitionGoal(path, "goal_start", other, "Tools")]);
  let data = JSON.parse(await readFile(path, "utf8"));
  assert.equal(data.current.length, 2);
  data.stopped = [{ id, title: "Duplicate" }];
  await writeFile(path, JSON.stringify(data));
  assert.equal((await transitionGoal(path, "goal_start", id)).changed, true);
  data = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(data.stopped, []);
  assert.equal(data.current.length, 2);
});

test("publication reads fresh current only and preserves other metadata", async t => {
  const path = await fixture(t);
  await initializeGoalFile(path);
  const meta = { source: "observer", v2meta: { identity: "agent", foldersTouched: ["host:/path"] } };
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  for (const expected of [[], [{ id, title: "Goal" }], [{ id, title: "Goal" }, { id: other, title: "Other" }]]) {
    await writeFile(path, JSON.stringify({ current: expected, finish: "Not read for publication" }));
    assert.deepEqual(await goalMetadata(path, meta, warn), { ...meta, v2meta: { ...meta.v2meta, goals: expected } });
  }
  assert.deepEqual(warnings, []);
  for (const value of ["invalid", '{}', '{"current":null}', '{"current":[{"id":"bad","title":"Goal"}]}']) {
    await writeFile(path, value);
    const result: any = await goalMetadata(path, meta, warn);
    assert.deepEqual(result.v2meta.goals, []);
  }
  await rm(path);
  assert.deepEqual((await goalMetadata(path, meta, warn) as any).v2meta.goals, []);
  // Reading a directory is an OS read error even when tests run as root.
  assert.deepEqual((await goalMetadata(join(path, ".."), meta, warn) as any).v2meta.goals, []);
  assert.equal(warnings.length, 6);
});

test("failed writes emit no event; delivery failure leaves local state and reports failure", async t => {
  const path = await fixture(t);
  let calls = 0;
  const publish = async () => { calls++; throw new Error("offline"); };
  await assert.rejects(transitionGoal(path, "goal_start", id, undefined, publish));
  assert.equal(calls, 0);
  await initializeGoalFile(path);
  const result = await transitionGoal(path, "goal_start", id, undefined, publish);
  assert.equal(result.changed, true);
  assert.equal(result.eventError, "offline");
  assert.equal((await transitionGoal(path, "goal_start", id, undefined, publish)).changed, false);
  assert.equal(calls, 1);
});
