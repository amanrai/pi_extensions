import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { goalStartupPrompt } from "../extensions/goal-orientation/prompts.ts";

test("startup prompt retains the user-reviewed wording and actual directory", () => {
  const cwd = '/work/a folder/"quoted"';
  const prompt = goalStartupPrompt(cwd);
  assert.ok(prompt.includes(JSON.stringify(cwd)));
  assert.ok(prompt.includes("http://smux-linode:43210"));
  assert.ok(prompt.includes("Is there a Goal you'd like me to orient to?"));
  assert.ok(prompt.includes("provide a numbered list of open goals, if asked"));
  assert.ok(prompt.includes("Do not render the uuids"));
  assert.ok(prompt.includes("may select multiple goals"));
  assert.ok(prompt.includes("You may not execute any work until explicitly authorized by the user"));
  assert.ok(!prompt.includes("The user started Pi with"));
  assert.ok(!prompt.includes("When the user supplies a Goal UUID"));
});

const host = process.env.PI_TEST_AGENT_ROOT;
test("Pi --goal starts one extension-authored turn; ordinary startup and reload remain quiet", { skip: !host }, async () => {
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const load = async (enabled = false, mode = "tui") => {
    const loaded = await loadExtensions([resolve("extensions/goal-orientation/index.ts")], process.cwd());
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.equal(extension.flags.get("goal").type, "boolean");
    assert.equal(extension.flags.get("goal").default, false);
    assert.deepEqual([...extension.flags.keys()], ["goal"], "Unfinished execution modes are not advertised");
    loaded.runtime.flagValues.set("goal", enabled);
    const messages: any[] = [], warnings: string[] = [];
    loaded.runtime.sendMessage = (message: any, options: any) => messages.push({ message, options });
    loaded.runtime.sendUserMessage = () => assert.fail("Do not impersonate user input");
    const ctx = { cwd: "/work/loom", mode, ui: { notify: (text: string) => warnings.push(text) } };
    const start = async (reason: string) => {
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason }, ctx);
    };
    return { start, messages, warnings };
  };
  const normal = await load();
  await normal.start("startup");
  assert.deepEqual(normal.messages, []);
  const active = await load(true);
  await active.start("startup");
  assert.equal(active.messages.length, 1);
  assert.deepEqual(active.messages[0], {
    message: { customType: "goal-orientation-startup", content: goalStartupPrompt("/work/loom"), display: false,
      details: { mode: "goal", directory: "/work/loom" } },
    options: { triggerTurn: true },
  });
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) await active.start(reason);
  assert.equal(active.messages.length, 1);
  const reloaded = await load(true);
  await reloaded.start("reload");
  assert.deepEqual(reloaded.messages, []);
  for (const mode of ["json", "rpc", "print"]) {
    const noninteractive = await load(true, mode);
    await noninteractive.start("startup");
    assert.deepEqual(noninteractive.messages, []);
    assert.match(noninteractive.warnings[0], /requires interactive Pi/);
  }
});
