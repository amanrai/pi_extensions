import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { goalStartupPrompt, introductionName } from "../extensions/goal-orientation/prompts.ts";

test("introductions use friendly capitalized names without random suffixes", () => {
  for (const name of ["impressed_harrier", "impressed_harrier_abcdefghijkl", "impressed_harrier_a1b2c3d4e5f6", "impressed_harrier_a7c9"]) {
    assert.equal(introductionName(name), "Impressed Harrier");
  }
  assert.equal(introductionName("printed_swordtail"), "Printed Swordtail");
});

test("startup prompt retains the user-reviewed wording and actual directory", () => {
  const cwd = '/work/a folder/"quoted"';
  const name = "quiet_otter_abcdefghijkl";
  const prompt = goalStartupPrompt(cwd, name);
  assert.ok(prompt.includes(JSON.stringify(name)));
  assert.ok(prompt.includes('When introducing yourself, use "Quiet Otter"'));
  assert.ok(prompt.includes("Keep your full startup identity name, including any suffix, in records and interaction-service updates"));
  assert.ok(prompt.includes("telling the user your name and where you are"));
  assert.ok(prompt.includes(JSON.stringify(cwd)));
  assert.ok(prompt.includes("http://smux-linode:43210"));
  assert.ok(prompt.includes("Is there a Goal you'd like me to orient to?"));
  assert.ok(prompt.includes("provide a numbered list of open goals, if asked"));
  assert.ok(prompt.includes("Do not render the uuids"));
  assert.ok(prompt.includes("may select multiple goals"));
  assert.ok(prompt.includes("Once the user selects a goal, send an update to the interaction service with your name and both the title and the uuid of the goal you have been selected to work on"));
  assert.ok(prompt.includes("Planning a Goal is different from executing it"));
  assert.ok(prompt.includes("normally requires an approved checklist"));
  assert.ok(prompt.includes("If no open todo list is available, offer to build one collaboratively"));
  assert.ok(prompt.includes("A checklist's existence does not by itself mean the user has approved it"));
  assert.ok(prompt.includes("The user may explicitly ask you to do something without a pre-existing checklist; that is okay"));
  assert.ok(prompt.includes("keep adding what you do to a checklist within the selected Goal. Create the checklist if necessary"));
  assert.ok(prompt.includes("Recording the work does not authorize additional work"));
  assert.ok(prompt.includes("The goals and checklists are to be maintained on JEPM - don't do anything that is untraceable later."));
  assert.ok(prompt.includes("You may not execute any work until explicitly authorized by the user"));
  assert.ok(!prompt.includes("The user started Pi with"));
  assert.ok(!prompt.includes("When the user supplies a Goal UUID"));
});

const host = process.env.PI_TEST_AGENT_ROOT;
test("Pi --goal starts one extension-authored turn; ordinary startup and reload remain quiet", { skip: !host }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "goal-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "loom");
  const name = "quiet_otter_abcdefghijkl";
  await mkdir(cwd);
  await writeFile(join(root, ".scryer"), JSON.stringify({ created_by: [{ name: "not_the_startup_identity" }] }));
  await writeFile(join(cwd, ".scryer"), JSON.stringify({ created_by: [{ name }] }));
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
    const workingMessages: (string | undefined)[] = [], workingVisibility: boolean[] = [];
    loaded.runtime.sendMessage = (message: any, options: any) => messages.push({ message, options });
    loaded.runtime.sendUserMessage = () => assert.fail("Do not impersonate user input");
    const ctx = { cwd, mode, ui: {
      notify: (text: string) => warnings.push(text),
      setWorkingMessage: (message?: string) => workingMessages.push(message),
      setWorkingVisible: (visible: boolean) => workingVisibility.push(visible),
    } };
    const invoke = async (event: string, data: any = {}) => {
      for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
    };
    const start = (reason: string) => invoke("session_start", { reason });
    return { start, invoke, messages, warnings, workingMessages, workingVisibility };
  };
  const normal = await load();
  await normal.start("startup");
  assert.deepEqual(normal.messages, []);
  await normal.invoke("before_provider_request");
  await normal.invoke("agent_settled");
  assert.deepEqual(normal.workingMessages, []);
  assert.deepEqual(normal.workingVisibility, []);
  const active = await load(true);
  await active.start("startup");
  assert.equal(active.messages.length, 1);
  assert.deepEqual(active.workingMessages, ["Orienting…"]);
  assert.deepEqual(active.workingVisibility, [true]);
  await active.invoke("before_provider_request");
  assert.deepEqual(active.workingVisibility, [true, true], "Show the native loader once startup streaming begins");
  await active.invoke("agent_settled");
  assert.deepEqual(active.workingMessages, ["Orienting…", undefined]);
  assert.deepEqual(active.workingVisibility, [true, true, false, true], "Clear the orientation loader and restore default visibility");
  await active.invoke("before_provider_request");
  await active.invoke("agent_settled");
  await active.invoke("session_shutdown");
  assert.equal(active.workingMessages.length, 2, "Normal later turns do not retain orientation UI overrides");
  assert.deepEqual(active.messages[0], {
    message: { customType: "goal-orientation-startup", content: goalStartupPrompt(cwd, name), display: false,
      details: { mode: "goal", directory: cwd, identity: name } },
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
    assert.deepEqual(noninteractive.workingMessages, []);
    assert.deepEqual(noninteractive.workingVisibility, []);
  }
  const interrupted = await load(true);
  await interrupted.start("startup");
  await interrupted.invoke("session_shutdown");
  assert.deepEqual(interrupted.workingMessages, ["Orienting…", undefined]);
  assert.deepEqual(interrupted.workingVisibility, [true, false, true]);
  for (const invalid of ["not JSON", "{}", '{"created_by":[]}', '{"created_by":[{"name":""}]}',
    '{"created_by":[{"name":"one"},{"name":"two"}]}']) {
    await writeFile(join(cwd, ".scryer"), invalid);
    const invalidIdentity = await load(true);
    await invalidIdentity.start("startup");
    assert.deepEqual(invalidIdentity.messages, []);
    assert.match(invalidIdentity.warnings[0], /Could not read the startup identity/);
  }
  await unlink(join(cwd, ".scryer"));
  const missingIdentity = await load(true);
  await missingIdentity.start("startup");
  assert.deepEqual(missingIdentity.messages, [], "Do not substitute the parent identity");
  assert.match(missingIdentity.warnings[0], /Could not read the startup identity/);
});
