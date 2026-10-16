import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandAttribution, confirmedCommits, snapshotCommits } from "../extensions/comms/commands.ts";
import { observeFolderTouch } from "../extensions/comms/folders.ts";
import { initializeStartupIdentity, recordFolderActions } from "../extensions/comms/identity.ts";

async function fixture(t: any) {
  const cwd = await mkdtemp(join(tmpdir(), "scryer-attribution-"));
  await mkdir(join(cwd, "nested"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const saved = async (folder: string) => JSON.parse(await readFile(join(folder, ".scryer"), "utf8"));
const hour = "2026-10-16T02:10:00.000Z";

test("edit/write attribute only file_modifier; commands separate execution from file changes", async (t) => {
  const cwd = await fixture(t);
  assert.deepEqual((await observeFolderTouch("edit", { path: "nested/file.ts" }, false, cwd))?.actions,
    [{ role: "file_modifier", folder: join(cwd, "nested") }]);
  assert.deepEqual(await commandAttribution("touch nested/file", cwd), {
    commandFolders: [cwd], fileFolders: [join(cwd, "nested")], commitFolders: [],
  });
  assert.deepEqual(await commandAttribution("git -C nested commit -m message", cwd), {
    commandFolders: [join(cwd, "nested")], fileFolders: [], commitFolders: [join(cwd, "nested")],
  });
  assert.deepEqual(await commandAttribution("git -C nested commit -m message > log", cwd), {
    commandFolders: [cwd, join(cwd, "nested")], fileFolders: [cwd], commitFolders: [join(cwd, "nested")],
  });
  for (const command of ["git status", "git commit --dry-run", "git commit --help", "cat nested/file"]) {
    assert.deepEqual(await commandAttribution(command, cwd), { commandFolders: [], fileFolders: [], commitFolders: [] });
  }
});

test("missing folder records use the startup identity without inventing a creator", async (t) => {
  const cwd = await fixture(t);
  const nested = join(cwd, "nested");
  await recordFolderActions([{ folder: nested, role: "file_modifier" }], "startup_agent", "session", hour);
  const record = await saved(nested);
  assert.deepEqual(record.created_by, []);
  assert.equal(record.created_at, hour);
  assert.equal(record.session, "session");
  assert.deepEqual(record.file_modifier, [{ name: "startup_agent", touched_at: ["2026-10-16T02Z"] }]);
  assert.deepEqual(record.command_runner, []);
  assert.deepEqual(record["version-manager"], []);
  const identity = await initializeStartupIdentity(nested, "later-session", {
    environment: async () => ({}), generateName: () => "later_creator", now: () => hour,
  });
  assert.equal(identity.name, "later_creator");
  assert.deepEqual((await saved(nested)).file_modifier, record.file_modifier);
});

test("hourly touches deduplicate, merge legacy entries, preserve other agents and creator provenance", async (t) => {
  const cwd = await fixture(t);
  const creator = { name: "other_creator", machine_name: "old-machine", tailnet_name: "old-tailnet", created_at: hour, session: "old" };
  await writeFile(join(cwd, ".scryer"), JSON.stringify({
    created_by: [creator], command_runner: ["startup_agent", { name: "startup_agent", touched_at: ["2026-10-15T23Z"] }],
    file_modifier: [{ name: "someone_else", touched_at: ["2026-10-15T12Z"] }], "version-manager": [], custom: true,
  }));
  const actions = [{ folder: cwd, role: "command_runner" as const }];
  await recordFolderActions(actions, "startup_agent", "new", hour);
  const first = await stat(join(cwd, ".scryer"));
  await recordFolderActions(actions, "startup_agent", "new", "2026-10-16T02:59:59Z");
  assert.equal((await stat(join(cwd, ".scryer"))).mtimeMs, first.mtimeMs);
  await recordFolderActions(actions, "startup_agent", "new", "2026-10-16T03:00:00Z");
  const record = await saved(cwd);
  assert.deepEqual(record.created_by, [creator]);
  assert.deepEqual(record.command_runner, [{ name: "startup_agent", touched_at: ["2026-10-15T23Z", "2026-10-16T02Z", "2026-10-16T03Z"] }]);
  assert.deepEqual(record.file_modifier, [{ name: "someone_else", touched_at: ["2026-10-15T12Z"] }]);
  assert.equal(record.custom, true);
});

test("concurrent actions preserve all agents and action-specific roles", async (t) => {
  const cwd = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => recordFolderActions([
    { folder: cwd, role: i % 2 ? "file_modifier" : "command_runner" },
  ], `agent_${i}`, "session", hour)));
  const record = await saved(cwd);
  assert.equal(record.command_runner.length, 6);
  assert.equal(record.file_modifier.length, 6);
  assert.deepEqual(record["version-manager"], []);
  assert.equal(new Set([...record.command_runner, ...record.file_modifier].map((entry: any) => entry.name)).size, 12);
});

test("invalid existing attribution is not overwritten; deleted folders are not recreated", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, ".scryer"), "invalid");
  await assert.rejects(recordFolderActions([{ folder: cwd, role: "command_runner" }], "agent", "session", hour));
  assert.equal(await readFile(join(cwd, ".scryer"), "utf8"), "invalid");
  const missing = join(cwd, "deleted");
  await recordFolderActions([{ folder: missing, role: "file_modifier" }], "agent", "session", hour);
  await assert.rejects(stat(missing), { code: "ENOENT" });
});

test("records discover repos created later without changing creator provenance", async (t) => {
  const cwd = await fixture(t);
  const actions = [{ folder: join(cwd, "nested"), role: "file_modifier" as const }];
  await recordFolderActions(actions, "agent", "session", hour);
  execFileSync("git", ["init", "--quiet", cwd]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:Example/Repo.git"]);
  await recordFolderActions(actions, "agent", "session", hour);
  assert.equal((await saved(join(cwd, "nested"))).repo, "git@github.com/example/repo");
});

test("version-manager requires a real HEAD change, including initial commits", async (t) => {
  const cwd = await fixture(t);
  execFileSync("git", ["init", "--quiet", cwd]);
  const command = "git -c user.name=Test -c user.email=test@example.com commit --allow-empty -m test";
  const before = await snapshotCommits(command, cwd);
  assert.deepEqual(await confirmedCommits(before), new Set());
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "test"]);
  assert.deepEqual(await confirmedCommits(before), new Set([cwd]));
  const after = await snapshotCommits(command, cwd);
  assert.deepEqual(await confirmedCommits(after), new Set());
});
