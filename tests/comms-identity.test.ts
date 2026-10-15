import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateIdentityName, initializeStartupIdentity, runtimeMachineName, tailnetMachineName, updateIdentityMetadata } from "../extensions/comms/identity.ts";

const options = {
  environment: async () => ({ machine_name: "creator-machine", tailnet_name: "creator-tailnet" }),
  generateName: () => "quiet_badger",
  now: () => "2026-10-15T00:00:00.000Z",
};

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "scryer-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function record(directory: string) {
  return JSON.parse(await readFile(join(directory, ".scryer"), "utf8"));
}

test("startup creates a singleton creator and empty action lists", async (t) => {
  const directory = await fixture(t);
  const identity = await initializeStartupIdentity(directory, "pi-session:first", options);
  assert.equal(identity.name, "quiet_badger");
  assert.deepEqual(await record(directory), {
    created_by: [{
      name: "quiet_badger",
      machine_name: "creator-machine",
      tailnet_name: "creator-tailnet",
      created_at: "2026-10-15T00:00:00.000Z",
      session: "pi-session:first",
    }],
    command_runner: [],
    file_modifier: [],
    "version-manager": [],
  });
  assert.deepEqual(await readdir(directory), [".scryer"]);
});

test("another session/device inherits the name without replacing creator provenance", async (t) => {
  const directory = await fixture(t);
  await initializeStartupIdentity(directory, "pi-session:first", options);
  const before = await readFile(join(directory, ".scryer"), "utf8");
  const identity = await initializeStartupIdentity(directory, "pi-session:second", {
    environment: async () => ({ machine_name: "other-machine", tailnet_name: "other-tailnet" }),
    generateName: () => { throw new Error("must reuse existing creator"); },
  });
  assert.equal(identity.name, "quiet_badger");
  assert.equal(await readFile(join(directory, ".scryer"), "utf8"), before);
});

test("startup adds a creator to an existing action-only file without changing its lists", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, ".scryer"), JSON.stringify({
    command_runner: ["calm_otter"], file_modifier: ["small_fox"], "version-manager": [], custom: { retained: true },
  }));
  await initializeStartupIdentity(directory, "pi-session:new", options);
  const saved = await record(directory);
  assert.equal(saved.created_by[0].name, "quiet_badger");
  assert.deepEqual(saved.command_runner, ["calm_otter"]);
  assert.deepEqual(saved.file_modifier, ["small_fox"]);
  assert.deepEqual(saved.custom, { retained: true });
});

test("startup does not inherit a parent folder's identity", async (t) => {
  const directory = await fixture(t);
  await initializeStartupIdentity(directory, "pi-session:parent", options);
  const child = join(directory, "child");
  await mkdir(child);
  const identity = await initializeStartupIdentity(child, "pi-session:child", {
    ...options, generateName: () => "calm_otter",
  });
  assert.equal(identity.name, "calm_otter");
  assert.equal((await record(directory)).created_by[0].name, "quiet_badger");
});

test("a repo discovered on a later startup is added without replacing creator details", async (t) => {
  const directory = await fixture(t);
  await initializeStartupIdentity(directory, "pi-session:first", options);
  await initializeStartupIdentity(directory, "pi-session:second", {
    environment: async () => ({ machine_name: "other", repo: "https://github.com/example/repo.git" }),
  });
  const creator = (await record(directory)).created_by[0];
  assert.equal(creator.repo, "https://github.com/example/repo.git");
  assert.equal(creator.machine_name, "creator-machine");
  assert.equal(creator.session, "pi-session:first");
});

test("missing optional environment data is allowed", async (t) => {
  const directory = await fixture(t);
  await initializeStartupIdentity(directory, "pi-session:first", { ...options, environment: async () => ({}) });
  const creator = (await record(directory)).created_by[0];
  assert.equal(creator.machine_name, undefined);
  assert.equal(creator.tailnet_name, undefined);
  assert.equal(creator.repo, undefined);
});

test("concurrent startups converge on one creator", async (t) => {
  const directory = await fixture(t);
  const identities = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    initializeStartupIdentity(directory, `pi-session:${index}`, {
      ...options, generateName: () => `quiet_badger${index}`,
    }),
  ));
  assert.equal(new Set(identities.map((identity) => identity.name)).size, 1);
  assert.equal((await record(directory)).created_by.length, 1);
  assert.deepEqual(await readdir(directory), [".scryer"]);
});

for (const invalid of ["not json", "[]", '{"created_by":[{"name":"one"},{"name":"two"}]}', '{"command_runner":[{}]}']) {
  test(`invalid existing data is never overwritten: ${invalid}`, async (t) => {
    const directory = await fixture(t);
    await writeFile(join(directory, ".scryer"), invalid);
    await assert.rejects(initializeStartupIdentity(directory, "pi-session:first", options));
    assert.equal(await readFile(join(directory, ".scryer"), "utf8"), invalid);
    assert.deepEqual(await readdir(directory), [".scryer"]);
  });
}

test("update metadata contains only the sender name and preserves existing fields", () => {
  const metadata = {
    source: "secondary-agent", token: 1, batch: true,
    v2meta: { identity: "old_name", identities: [{ created_by: [] }], unrelated: true },
  };
  const before = JSON.stringify(metadata);
  assert.deepEqual(updateIdentityMetadata(metadata, "impressed_harrier"), {
    source: "secondary-agent", token: 1, batch: true,
    v2meta: { identity: "impressed_harrier", unrelated: true, foldersTouched: [] },
  });
  assert.equal(JSON.stringify(metadata), before);
});

test("updates without prior metadata still carry the sender name", () => {
  assert.deepEqual(updateIdentityMetadata(undefined, "quiet_badger"), {
    v2meta: { identity: "quiet_badger", foldersTouched: [] },
  });
});

test("invalid prior v2meta is replaced, and an empty sender is rejected", () => {
  for (const v2meta of [null, false, "invalid", []]) {
    assert.deepEqual(updateIdentityMetadata({ v2meta }, "quiet_badger"), {
      v2meta: { identity: "quiet_badger", foldersTouched: [] },
    });
  }
  assert.throws(() => updateIdentityMetadata({}, " "), /startup identity is required/);
});

test("startup preserves action entries with UTC hourly touch timestamps", async (t) => {
  const directory = await fixture(t);
  const touch = { name: "impressed_harrier", touched_at: ["2026-10-15T02Z"] };
  await writeFile(join(directory, ".scryer"), JSON.stringify({ file_modifier: [touch] }));
  const identity = await initializeStartupIdentity(directory, "pi-session:new", options);
  assert.deepEqual(identity.record.file_modifier, [touch]);
  assert.deepEqual((await record(directory)).file_modifier, [touch]);
});

test("folder metadata is deduplicated and cannot reuse stale folders", () => {
  const metadata = { v2meta: { foldersTouched: ["old:/repo"] } };
  assert.deepEqual(updateIdentityMetadata(metadata, "quiet_badger", ["current:/b", "current:/a", "current:/a"]), {
    v2meta: { identity: "quiet_badger", foldersTouched: ["current:/a", "current:/b"] },
  });
  assert.deepEqual(updateIdentityMetadata(metadata, "quiet_badger").v2meta.foldersTouched, []);
});

test("runtime machine qualification prefers current Tailscale DNS name, then host name", () => {
  assert.equal(runtimeMachineName(JSON.stringify({ Self: { DNSName: "current.tailnet.ts.net.", HostName: "host" } }), "local"), "current.tailnet.ts.net");
  assert.equal(runtimeMachineName(JSON.stringify({ Self: { HostName: "tail-host" } }), "local"), "tail-host");
  assert.equal(runtimeMachineName(undefined, "local"), "local");
  assert.equal(runtimeMachineName("bad json", "local"), "local");
});

test("tailnet identity is the machine, never the account or network name", () => {
  const status = JSON.stringify({
    CurrentTailnet: { Name: "account@example.com" },
    Self: { DNSName: "machine.tailnet.ts.net.", HostName: "local-host" },
  });
  assert.equal(tailnetMachineName(status), "machine.tailnet.ts.net");
  assert.equal(tailnetMachineName(JSON.stringify({ Self: { HostName: "tail-host" } })), "tail-host");
  assert.equal(tailnetMachineName(JSON.stringify({ CurrentTailnet: { Name: "account@example.com" } })), undefined);
  assert.equal(tailnetMachineName(undefined), undefined);
  assert.equal(tailnetMachineName("bad json"), undefined);
});

test("default creator detection stores the Tailscale machine name", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fixture(t);
  const bin = join(directory, "bin");
  await mkdir(bin);
  const status = { CurrentTailnet: { Name: "account@example.com" }, Self: { DNSName: "alias.tailnet.ts.net.", HostName: "local-host" } };
  await writeFile(join(bin, "tailscale"), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(status))});\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const identity = await initializeStartupIdentity(directory, "pi-session:test", { generateName: () => "quiet_badger" });
    assert.equal(identity.record.created_by[0].tailnet_name, "alias.tailnet.ts.net");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("generated names use adjective_noun without people's names", () => {
  for (let index = 0; index < 1000; index++) {
    assert.match(generateIdentityName(), /^[a-z]+_[a-z]+$/);
  }
});
