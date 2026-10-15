import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quote } from "shell-quote";
import { commandTouchedFolders } from "../extensions/comms/commands.ts";
import { FOLDER_TOUCH, FOLDER_TOUCHES_SENT, observeFolderTouch, pendingFolderTouches, selectUpdateFolders, type FolderTouch } from "../extensions/comms/folders.ts";

async function fixture(t: any) {
  const cwd = await mkdtemp(join(tmpdir(), "scryer-folders-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "nested"));
  await mkdir(join(cwd, "other"));
  return cwd;
}

for (const command of [
  "ls -la", "rg hello nested", "find . -type f", "git status --short", "git diff", "git log -1",
  "cat nested/file", "sed 's/a/b/' nested/file", "perl -pe 's/a/b/' nested/file", "tee",
  "echo 'rm nested/file > another'", "cat nested/file > /dev/null", "echo hi 2>&1",
  "python -c 'print(1)'", "node -e 'console.log(1)'",
  quote(["python", "-c", `print('Path("nested/a").write_text("hi")')`]),
  quote(["node", "-e", `console.log('writeFileSync("nested/a","hi")')`]),
  "touch --help", "patch --dry-run", "git commit --dry-run",
  "cat <<'EOF'\nrm nested/file\nEOF",
  "if false; then\ntouch nested/file\nfi", "false && touch nested/file || true",
]) {
  test(`read-only or unsupported command does not record folders: ${command}`, async (t) => {
    const cwd = await fixture(t);
    assert.deepEqual(await commandTouchedFolders(command, cwd), []);
  });
}

for (const command of [
  "touch nested/file", "mkdir -p nested/new", "cp source nested/file", "cp source nested",
  "cp --target-directory=nested source", "cp -t nested source", "rm -rf nested/file", "rm nested/*.txt",
  "mv other/file nested/file", "rm -f nested/file", "ln -s source nested/link", "truncate -s 0 nested/file",
  "chmod 644 nested/file", "chown user nested/file", "echo hi > nested/file", "echo hi >> nested/file",
  "cat source | tee nested/file", "sed -i 's/a/b/' nested/file", "sed -i '' 's/a/b/' nested/file",
  "sed --in-place -e 's/a/b/' nested/file", "perl -i -pe 's/a/b/' nested/file",
  'python -c \'open("nested/file", "w").write("hi")\'',
  'python -c \'from pathlib import Path; Path("nested/file").write_text("hi")\'',
  'node -e \'require("fs").writeFileSync("nested/file", "hi")\'',
  'node -e \'require("fs").copyFileSync("other/source", "nested/file")\'',
  'python -c \'import shutil; shutil.copy("other/source", "nested/file")\'',
  'python -c \'from pathlib import Path; p = Path("nested/file"); p.write_text("hi")\'',
  "node --input-type=module <<'JS'\nimport fs from 'node:fs';\nfs.writeFileSync('nested/file', 'hello');\nJS",
  "python - <<'PY'\nfrom pathlib import Path\nPath('nested/file').write_text('hello')\nPY",
  "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: nested/file\n@@\n-old\n+new\n*** End Patch\nPATCH",
  "patch -p1 <<'PATCH'\n--- a/nested/file\n+++ b/nested/file\n@@ -1 +1 @@\n-old\n+new\nPATCH",
]) {
  test(`known state-changing command records execution and affected folders: ${command}`, async (t) => {
    const cwd = await fixture(t);
    const expected = command.startsWith("mv ") ? [cwd, join(cwd, "nested"), join(cwd, "other")] : [cwd, join(cwd, "nested")];
    assert.deepEqual(await commandTouchedFolders(command, cwd), expected.sort());
  });
}

test("cd and git -C resolve command working folders", async (t) => {
  const cwd = await fixture(t);
  assert.deepEqual(await commandTouchedFolders("cd nested && touch file", cwd), [join(cwd, "nested")]);
  assert.deepEqual(await commandTouchedFolders("cd nested\ntouch file", cwd), [join(cwd, "nested")]);
  assert.deepEqual(await commandTouchedFolders("git -C nested commit -m message", cwd), [join(cwd, "nested")]);
});

test("redirections and git -C have independent working folders", async (t) => {
  const cwd = await fixture(t);
  assert.deepEqual(await commandTouchedFolders("git -C nested status > other/log", cwd), [cwd, join(cwd, "other")]);
  assert.deepEqual(await commandTouchedFolders("git -C nested commit -m msg > other/log", cwd), [cwd, join(cwd, "nested"), join(cwd, "other")]);
});

test("script files are inspected without executing them", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "edit.py"), 'from pathlib import Path\nPath("nested/file").write_text("hello")');
  assert.deepEqual(await commandTouchedFolders("python edit.py", cwd), [cwd, join(cwd, "nested")]);
  await writeFile(join(cwd, "read.py"), 'print("write_text")');
  assert.deepEqual(await commandTouchedFolders("python read.py", cwd), []);
});

test("separate shell commands and multiline quoted scripts are handled", async (t) => {
  const cwd = await fixture(t);
  assert.deepEqual(await commandTouchedFolders('node -e \'const fs = require("fs");\nfs.writeFileSync("nested/file", "hi");\'', cwd), [cwd, join(cwd, "nested")]);
  assert.deepEqual(await commandTouchedFolders("touch nested/file; touch other/file", cwd), [cwd, join(cwd, "nested"), join(cwd, "other")]);
});

test("direct writes/edits count, reads and failed results do not", async (t) => {
  const cwd = await fixture(t);
  for (const tool of ["write", "edit"]) {
    const touch = await observeFolderTouch(tool, { path: "nested/file" }, false, cwd);
    assert.deepEqual(touch?.folders, [join(cwd, "nested")]);
  }
  assert.equal(await observeFolderTouch("read", { path: "nested/file" }, false, cwd), undefined);
  assert.equal(await observeFolderTouch("write", { path: "nested/file" }, true, cwd), undefined);
  assert.equal(await observeFolderTouch("bash", { command: "touch nested/file" }, true, cwd), undefined);
});

const touches: FolderTouch[] = [
  { id: "one", tool: "edit", summary: "edit first", folders: ["/repo/first"], createdAt: "2026-10-15T00:00:00Z" },
  { id: "two", tool: "edit", summary: "edit second", folders: ["/repo/second", "/repo/first"], createdAt: "2026-10-15T00:01:00Z" },
];

test("each update references only its own observed folders, qualified on this machine", () => {
  assert.deepEqual(selectUpdateFolders(touches, ["one", "invented"], "current.tailnet.ts.net"), {
    touchIds: ["one"], foldersTouched: ["current.tailnet.ts.net:/repo/first"], codeChanged: false,
  });
  assert.deepEqual(selectUpdateFolders(touches, ["two", "one", "one"], "machine").foldersTouched, ["machine:/repo/first", "machine:/repo/second"]);
  assert.deepEqual(selectUpdateFolders(touches, [], "machine"), { touchIds: [], foldersTouched: [], codeChanged: false });
  assert.deepEqual(selectUpdateFolders(touches, undefined, "machine"), { touchIds: [], foldersTouched: [], codeChanged: false });
});

test("pending observations survive reloads, while sent ones and abandoned branches do not replay", () => {
  const entries = touches.map((data) => ({ type: "custom", customType: FOLDER_TOUCH, data }));
  const sent = { type: "custom", customType: FOLDER_TOUCHES_SENT, data: { touchIds: ["one"] } };
  assert.deepEqual(pendingFolderTouches(entries), touches);
  assert.deepEqual(pendingFolderTouches([...entries, sent]), [touches[1]]);
  assert.deepEqual(pendingFolderTouches([entries[0], sent]), []);
  // Sending one snapshot must not clear touches that arrived while inference ran.
  assert.deepEqual(pendingFolderTouches([entries[0], sent, entries[1]]), [touches[1]]);
});
