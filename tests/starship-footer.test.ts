import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const host = process.env.PI_TEST_AGENT_ROOT;
test("footer shows startup identity@folder and safely falls back to folder only", { skip: !host }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scryer-footer-"));
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalFetch = globalThis.fetch;
  process.env.HOME = directory;
  // No external starship/gh processes or live PM requests in this test.
  process.env.PATH = "";
  globalThis.fetch = async () => { throw new Error("PM disabled for footer test"); };
  let extension: any;
  let footer: any;
  const ctx = {
    cwd, sessionManager: { getBranch: () => [] },
    ui: { setFooter: (factory: any) => {
      footer = factory({ requestRender() {} }, {}, { onBranchChange: () => () => {} });
    } },
  };
  const invoke = async (event: string) => {
    for (const handler of extension?.handlers.get(event) ?? []) await handler({ type: event }, ctx);
  };
  t.after(async () => {
    await invoke("session_shutdown");
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });
  const { loadExtensions } = await import(pathToFileURL(join(host!, "dist/core/extensions/loader.js")).href);
  const { visibleWidth } = await import(pathToFileURL(join(host!, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
  const loaded = await loadExtensions([resolve("extensions/starship-footer.ts")], cwd);
  assert.deepEqual(loaded.errors, []);
  extension = loaded.extensions[0];
  loaded.runtime.getThinkingLevel = () => "off";
  const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  await writeFile(join(cwd, ".scryer"), JSON.stringify({ created_by: [{ name: "quiet_badger" }] }));
  const before = await readFile(join(cwd, ".scryer"), "utf8");
  await invoke("session_start");
  assert.equal(plain(footer.render(120)[0]), "quiet_badger@~/workspace");
  assert.equal(await readFile(join(cwd, ".scryer"), "utf8"), before);
  for (const width of [1, 8, 20, 80]) assert.ok(visibleWidth(footer.render(width)[0]) <= width);
  await invoke("session_shutdown");
  // A new/reloaded session picks up its own name rather than retaining the old one.
  await writeFile(join(cwd, ".scryer"), JSON.stringify({ created_by: [{ name: "calm_otter" }] }));
  await invoke("session_start");
  assert.equal(plain(footer.render(120)[0]), "calm_otter@~/workspace");
  await invoke("session_shutdown");
  for (const [name, display] of [
    ["quiet_badger_a7c9", "quiet_badger"],
    ["eager_elk_0000", "eager_elk"],
    ["quiet_cafe", "quiet_cafe"], // A legacy noun that looks hexadecimal is not a suffix.
    ["quiet_badger_zzzz", "quiet_badger_zzzz"],
    ["quiet_badger_a7c90", "quiet_badger_a7c90"],
  ]) {
    const contents = JSON.stringify({ created_by: [{ name }] });
    await writeFile(join(cwd, ".scryer"), contents);
    await invoke("session_start");
    assert.equal(plain(footer.render(120)[0]), `${display}@~/workspace`);
    assert.equal(await readFile(join(cwd, ".scryer"), "utf8"), contents);
    await invoke("session_shutdown");
  }
  for (const contents of ["invalid JSON", '{"created_by":[{"name":42}]}', '{"command_runner":["not_the_creator"]}']) {
    await writeFile(join(cwd, ".scryer"), contents);
    await invoke("session_start");
    assert.equal(plain(footer.render(120)[0]), "~/workspace");
    await invoke("session_shutdown");
  }
  await rm(join(cwd, ".scryer"));
  await writeFile(join(directory, ".scryer"), JSON.stringify({ created_by: [{ name: "parent_identity" }] }));
  await invoke("session_start");
  assert.equal(plain(footer.render(120)[0]), "~/workspace");
  await assert.rejects(readFile(join(cwd, ".scryer")), { code: "ENOENT" });
});
