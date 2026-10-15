import assert from "node:assert/strict";
import { test } from "node:test";
import { WindowActivity, windowActivity, sourceChunks, idleTimers, FLUSH_IDLE_MS, RECAP_IDLE_MS, RECAP_LOOKBACK_MS } from "../extensions/comms/activity.ts";
import { prepareIdleRecap, prepareManualRecap, deliverRecap } from "../extensions/comms/recaps.ts";

const scope = "machine:/repo";
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("history belongs to one window and spans saved-session switches", () => {
  const owner = {};
  const activity = windowActivity(owner);
  activity.record(scope, "session-a", "user", "Decide API semantics", 10);
  assert.equal(windowActivity(owner), activity);
  activity.record(scope, "session-b", "assistant", "Implemented API", 20);
  assert.equal(activity.snapshot(scope, 30).events.length, 2);
  assert.equal(windowActivity({}).snapshot(scope, 30).events.length, 0);
  activity.record("other-machine:/repo", "a", "user", "Excluded", 25);
  activity.record("machine:/other-repo", "b", "user", "Excluded too", 26);
  assert.equal(activity.snapshot(scope, 30).events.length, 2);
});

test("rolling 12 hours includes old recapped work, but requires new work to post", async () => {
  const activity = new WindowActivity();
  activity.record(scope, "a", "user", "Original decision", 0);
  const manual = prepareManualRecap(activity, scope, "Manual", ["Original decision"], 1);
  await deliverRecap(activity, manual, async () => {});
  assert.equal(activity.snapshot(scope, 2).hasNewWork, false);
  let calls = 0;
  const generate = async () => { calls++; return { newWork: true, parts: ["full notes"] }; };
  assert.equal(await prepareIdleRecap({ activity, scope, label: "repo", machine: "machine", repo: "/repo", generate, now: 2 }), undefined);
  assert.equal(calls, 0);
  activity.record(scope, "b", "assistant", "New implementation", 3);
  const result = await prepareIdleRecap({ activity, scope, label: "repo", machine: "machine", repo: "/repo", now: 4,
    generate: async (input) => {
      assert.match(String(input.source), /Original decision/);
      assert.match(String(input.source), /New implementation/);
      assert.match(String(input.source), /"newSinceRecap":false/);
      return { newWork: true, parts: ["Original decision AND new implementation"] };
    } });
  assert.ok(result);
  assert.match(result.parts[0].title, /^Idle Recap/);
  await deliverRecap(activity, result, async () => {});
  assert.equal(activity.snapshot(scope, 5).hasNewWork, false);
});

test("empty or expired histories produce no recap or model call", async () => {
  const activity = new WindowActivity();
  activity.record(scope, "a", "user", "Too old", 0);
  let calls = 0;
  const result = await prepareIdleRecap({ activity, scope, label: "repo", machine: "machine", repo: "/repo",
    now: RECAP_LOOKBACK_MS + 1, generate: async () => { calls++; return { newWork: true, parts: ["no"] }; } });
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("non-work activity is reviewed without posting or inventing a sent recap", async () => {
  const activity = new WindowActivity();
  activity.record(scope, "a", "user", "hello", 1);
  const result = await prepareIdleRecap({ activity, scope, label: "repo", machine: "machine", repo: "/repo", now: 2,
    generate: async () => ({ newWork: false, parts: ["Only a greeting"] }) });
  assert.equal(result, undefined);
  assert.equal(activity.checkpoints.has(scope), false);
  assert.equal(activity.snapshot(scope, 3).hasNewWork, false);
});

test("oversized sources are losslessly split with repeated eligibility headers", () => {
  const activity = new WindowActivity();
  activity.record(scope, "a", "tool", "Start 🙂\n".repeat(1000), 1);
  const chunks = sourceChunks(activity.events, 0, 100);
  assert.ok(chunks.length > 10);
  const joined = chunks.map((chunk) => chunk.text).join("");
  const decoded = JSON.parse(joined);
  assert.equal(decoded.text, activity.events[0].text);
  assert.ok(chunks.every((chunk) => chunk.records[0].newSinceRecap));
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk.text)));
});

test("recaps keep long bodies intact and all source chunks get summarized", async () => {
  const activity = new WindowActivity();
  activity.record(scope, "a", "assistant", "Implementation with rationale. ".repeat(100), 1);
  const body = "Detailed decisions and validation. ".repeat(100);
  let calls = 0;
  const delivery = await prepareIdleRecap({ activity, scope, label: "repo", machine: "machine", repo: "/repo", now: 2, chunkLimit: 500,
    generate: async () => { calls++; return { newWork: true, parts: [`<coding>${body}</coding>`] }; } });
  assert.ok(delivery);
  assert.equal(delivery.parts.length, calls);
  assert.ok(calls > 1);
  assert.ok(delivery.parts.every((part) => part.body === body.trim() && !part.body.includes("<coding>")));
});

test("partial delivery retries only unverified stable IDs and never advances checkpoint early", async () => {
  const activity = new WindowActivity();
  activity.record(scope, "a", "user", "Work", 1);
  const delivery = prepareManualRecap(activity, scope, "Manual", ["one", "two"], 2);
  const attempts: string[] = [];
  await assert.rejects(deliverRecap(activity, delivery, async (part, index) => {
    attempts.push(part.id);
    if (index === 1) throw new Error("truncated readback");
  }), /truncated/);
  assert.equal(activity.checkpoints.has(scope), false);
  assert.equal(activity.pending.get(scope), delivery);
  assert.equal(delivery.parts[0].verified, true);
  // Activity during delivery must remain eligible after its older snapshot completes.
  activity.record(scope, "b", "user", "New work", 3);
  await deliverRecap(activity, delivery, async (part) => { attempts.push(part.id); });
  assert.deepEqual(attempts, [delivery.parts[0].id, delivery.parts[1].id, delivery.parts[1].id]);
  assert.equal(activity.checkpoints.get(scope), 1);
  assert.equal(activity.snapshot(scope, 4).hasNewWork, true);
});

test("invalid model responses cannot advance the recap checkpoint", async () => {
  const activity = new WindowActivity();
  activity.record(scope, "a", "user", "Work", 1);
  await assert.rejects(prepareIdleRecap({ activity, scope, label: "repo", machine: "machine", repo: "/repo", now: 2,
    generate: async () => ({ newWork: true, parts: [] }) }), /Invalid or incomplete/);
  assert.equal(activity.snapshot(scope, 3).hasNewWork, true);
});

test("30-second flush does not depend on creating an interaction; 30-minute recap is separate", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const activity = new WindowActivity();
  activity.touch();
  const calls: string[] = [];
  const timers = idleTimers({ activity, canRun: () => true, flush: async () => { calls.push("flush"); },
    recap: async () => { calls.push("recap"); }, onError: () => assert.fail("Unexpected timer error") });
  timers.reset();
  t.mock.timers.tick(FLUSH_IDLE_MS - 1); await settle();
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(calls, ["flush"]);
  t.mock.timers.tick(RECAP_IDLE_MS - FLUSH_IDLE_MS); await settle();
  assert.deepEqual(calls, ["flush", "recap"]);
  t.mock.timers.tick(RECAP_IDLE_MS); await settle();
  assert.deepEqual(calls, ["flush", "recap"], "Comms' own work does not restart timers");
  timers.stop();
});

test("user/model/tool activity resets both timers; busy/draft sessions cannot recap", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const activity = new WindowActivity();
  let canRun = true;
  let flushes = 0, recaps = 0;
  const timers = idleTimers({ activity, canRun: () => canRun, flush: async () => { flushes++; },
    recap: async () => { recaps++; }, onError: () => assert.fail("Unexpected error") });
  timers.reset();
  t.mock.timers.tick(20_000);
  activity.touch(); timers.reset();
  t.mock.timers.tick(20_000); await settle();
  assert.equal(flushes, 0);
  canRun = false;
  t.mock.timers.tick(RECAP_IDLE_MS); await settle();
  assert.equal(recaps, 0);
  assert.equal(flushes, 0);
  canRun = true;
  t.mock.timers.tick(1000); await settle();
  assert.equal(flushes, 1);
  assert.equal(recaps, 1);
  activity.touch(); timers.reset(); timers.stop();
  t.mock.timers.tick(RECAP_IDLE_MS); await settle();
  assert.equal(recaps, 1, "Shutdown cancels both timers");
});

test("transient failures retry after 30 seconds without faking user activity", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const activity = new WindowActivity();
  let calls = 0, failures = 0;
  const timers = idleTimers({ activity, canRun: () => true, flush: async () => {}, recap: async () => {
    if (++calls === 1) throw new Error("offline");
  }, onError: () => { failures++; } });
  timers.reset();
  t.mock.timers.tick(RECAP_IDLE_MS); await settle();
  assert.equal(calls, 1);
  assert.equal(failures, 1);
  t.mock.timers.tick(FLUSH_IDLE_MS); await settle();
  assert.equal(calls, 2);
  assert.equal(activity.lastActivityAt, 0);
  timers.stop();
});
