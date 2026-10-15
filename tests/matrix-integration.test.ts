import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { fakeMatrixTui } from "./matrix-fixture.ts";

const host = process.env.PI_TEST_AGENT_ROOT;
test("Pi Matrix command is opt-in, wakes safely, and always resets to disabled", { skip: !host }, async (t) => {
  const originalPath = process.env.PATH;
  // No cmatrix, shell command, platform utility, model call, or server is needed.
  process.env.PATH = "";
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("extensions/matrix-screensaver/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const fake = fakeMatrixTui();
  const listeners = new Set<(data: string) => any>();
  const widgets = new Map<string, any>();
  const notifications: string[] = [];
  const forwarded: string[] = [];
  let widgetCalls = 0, listenerCalls = 0, sentMessages = 0;
  let mode = "tui", idle = true, pending = false, draft = "";
  loaded.runtime.sendUserMessage = () => { sentMessages++; };
  const ctx = {
    cwd: process.cwd(), hasUI: true, get mode() { return mode; },
    isIdle: () => idle, hasPendingMessages: () => pending,
    ui: {
      notify: (text: string) => notifications.push(text),
      getEditorText: () => draft,
      setWidget: (key: string, factory: any, options: any) => {
        widgetCalls++;
        widgets.get(key)?.dispose?.();
        widgets.delete(key);
        if (factory) {
          assert.deepEqual(options, { placement: "belowEditor" });
          const widget = factory(fake.tui, {});
          assert.deepEqual(widget.render(80), [], "The controller takes no prompt/footer space");
          widgets.set(key, widget);
        }
      },
      onTerminalInput: (listener: (data: string) => any) => {
        listenerCalls++;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
  const invoke = async (event: string, data: any = {}) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  const command = (args: string) => extension.commands.get("matrix").handler(args, ctx);
  const raw = (data: string) => {
    for (const listener of listeners) if (listener(data)?.consume) return true;
    forwarded.push(data);
    return false;
  };
  t.after(async () => {
    await invoke("session_shutdown", { reason: "quit" });
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  await invoke("session_start", { reason: "startup" });
  t.mock.timers.tick(3_600_000);
  assert.deepEqual(fake.counts(), { shows: 0, hides: 0, renders: 0 });
  assert.equal(widgetCalls, 0);
  assert.equal(listenerCalls, 0, "Disabled PTY windows get no animation/input hook");
  await command("");
  assert.match(notifications.at(-1)!, /disabled/);
  await command("on");
  assert.equal(widgets.size, 1);
  assert.equal(listeners.size, 1);
  t.mock.timers.tick(59_999);
  assert.equal(fake.counts().shows, 0);
  await invoke("tool_execution_update");
  t.mock.timers.tick(59_999);
  assert.equal(fake.counts().shows, 0);
  t.mock.timers.tick(1);
  assert.equal(fake.counts().shows, 1);
  for (const report of ["\x1b[6;16;8t", "\x1b[?1;2c", "\x1b[I", "\x1b]11;rgb:0000/0000/0000\x07"]) {
    assert.equal(raw(report), false, "Terminal replies are passed back to Pi, not treated as typing");
    assert.equal(fake.entries.at(-1)?.closed, false);
  }
  forwarded.length = 0;
  assert.equal(raw("\x1b[97;1:3u"), true, "A Kitty key-release report is swallowed without waking");
  assert.equal(fake.entries.at(-1)?.closed, false);
  assert.equal(raw("a"), true, "Wake-up key does not reach the editor");
  assert.equal(fake.entries.at(-1)?.closed, true);
  assert.deepEqual(forwarded, []);
  assert.equal(raw("b"), false);
  assert.deepEqual(forwarded, ["b"]);
  for (const wake of ["\r", "\x03", "\x1b[200~pasted text\x1b[201~", "🙂"]) {
    t.mock.timers.tick(60_000);
    assert.equal(raw(wake), true);
  }
  assert.deepEqual(forwarded, ["b"]);
  assert.equal(sentMessages, 0);
  await invoke("agent_start");
  t.mock.timers.tick(60_000);
  const beforeBusy = fake.counts().shows;
  assert.equal(fake.entries.at(-1)?.closed, true);
  await invoke("message_update");
  t.mock.timers.tick(60_000);
  assert.equal(fake.counts().shows, beforeBusy, "No saver during a quiet model/tool run");
  await invoke("agent_end");
  t.mock.timers.tick(60_000);
  assert.equal(fake.counts().shows, beforeBusy, "Retries/continuations must settle first");
  await invoke("agent_settled");
  draft = "unfinished input";
  t.mock.timers.tick(60_000);
  assert.equal(fake.counts().shows, beforeBusy);
  draft = "";
  pending = true;
  t.mock.timers.tick(1000);
  assert.equal(fake.counts().shows, beforeBusy);
  pending = false;
  idle = false;
  t.mock.timers.tick(1000);
  assert.equal(fake.counts().shows, beforeBusy);
  idle = true;
  await invoke("ui_prompt_start");
  t.mock.timers.tick(60_000);
  assert.equal(fake.counts().shows, beforeBusy, "No animation over an input dialog");
  await invoke("ui_prompt_end");
  t.mock.timers.tick(60_000);
  assert.equal(fake.counts().shows, beforeBusy + 1);
  await invoke("input", { text: "work resumed" });
  assert.equal(fake.entries.at(-1)?.closed, true);
  await command("off");
  assert.equal(listeners.size, 0);
  assert.equal(widgets.size, 0);
  const stopped = fake.counts();
  t.mock.timers.tick(3_600_000);
  assert.deepEqual(fake.counts(), stopped);
  for (const reason of ["reload", "new", "resume", "fork", "startup"]) {
    await command("on");
    t.mock.timers.tick(60_000);
    const shows = fake.counts().shows;
    await invoke("session_shutdown", { reason });
    await invoke("session_start", { reason });
    t.mock.timers.tick(60_000);
    assert.equal(fake.counts().shows, shows, `${reason} must not retain enabled state`);
    assert.equal(widgets.size, 0);
    assert.equal(listeners.size, 0);
    await command("status");
    assert.match(notifications.at(-1)!, /disabled/);
  }
  for (const value of ["rpc", "json", "print"]) {
    mode = value;
    await invoke("session_start", { reason: "startup" });
    const calls: number = widgetCalls;
    await command("on");
    assert.match(notifications.at(-1)!, /requires interactive/);
    assert.equal(widgetCalls, calls);
    assert.equal(listeners.size, 0);
  }
  mode = "tui";
  await invoke("session_start", { reason: "startup" });
  await command("invalid argument");
  assert.match(notifications.at(-1)!, /Usage:/);
  assert.equal(listeners.size, 0);
});
