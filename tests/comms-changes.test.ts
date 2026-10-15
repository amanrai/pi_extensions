import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeCodeChange, afterCodeChange, isCodePath } from "../extensions/comms/changes.ts";

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "scryer-code-change-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("only actual source-file byte changes provide coding evidence", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "code.ts"), "const value = 1;\n");
  const before = await beforeCodeChange("edit", { path: "code.ts" }, dir);
  assert.equal(await afterCodeChange(before), false);
  await writeFile(join(dir, "code.ts"), "const value = 2;\n");
  assert.equal(await afterCodeChange(before), true);
  assert.equal(await afterCodeChange(undefined), false);
});

test("new code files and deletions count; markdown and identity bookkeeping do not", async (t) => {
  const dir = await fixture(t);
  const before = await beforeCodeChange("write", { path: "new.py" }, dir);
  assert.equal(await afterCodeChange(before), false);
  await writeFile(join(dir, "new.py"), "print('new')\n");
  assert.equal(await afterCodeChange(before), true);
  const deletion = await beforeCodeChange("edit", { path: "new.py" }, dir);
  await rm(join(dir, "new.py"));
  assert.equal(await afterCodeChange(deletion), true);
  assert.equal(await beforeCodeChange("write", { path: "README.md" }, dir), undefined);
  assert.equal(await beforeCodeChange("edit", { path: ".scryer" }, dir), undefined);
  assert.equal(isCodePath("tests/file.test.ts"), true);
});

test("allowlisted Bash changes compare bytes, not existing dirty state or Git activity", async (t) => {
  const dir = await fixture(t);
  execFileSync("git", ["init", "--quiet", dir]);
  await writeFile(join(dir, "code.ts"), "const value = 1;\n");
  const command = "python3 -c \"open('code.ts', 'w').write('const value = 2;')\"";
  const before = await beforeCodeChange("bash", { command }, dir);
  assert.ok(before);
  assert.equal(await afterCodeChange(before), false);
  await writeFile(join(dir, "code.ts"), "const value = 2;");
  assert.equal(await afterCodeChange(before), true);
  const commit = await beforeCodeChange("bash", { command: "git commit -am 'checkpoint'" }, dir);
  assert.equal(await afterCodeChange(commit), false);
  assert.equal(await beforeCodeChange("bash", { command: "git status" }, dir), undefined);
});

test("unknown or oversized fingerprints never become fabricated change evidence", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "large.ts"), "x".repeat(2 * 1024 * 1024 + 1));
  const before = await beforeCodeChange("edit", { path: "large.ts" }, dir);
  assert.equal(await afterCodeChange(before), false);
  await writeFile(join(dir, "large.ts"), "small now");
  assert.equal(await afterCodeChange(before), false, "An unknown before-state cannot prove a change");
});

test("Bash detection includes newly created source files", async (t) => {
  const dir = await fixture(t);
  execFileSync("git", ["init", "--quiet", dir]);
  const before = await beforeCodeChange("bash", { command: "echo 'export const x = 1;' > new.ts" }, dir);
  await writeFile(join(dir, "new.ts"), "export const x = 1;\n");
  assert.equal(await afterCodeChange(before), true);
});
