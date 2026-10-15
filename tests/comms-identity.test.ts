import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateIdentityName, initializeStartupIdentity } from "../extensions/comms/identity.ts";

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

test("generated names use adjective_noun without people's names", () => {
  for (let index = 0; index < 1000; index++) {
    assert.match(generateIdentityName(), /^[a-z]+_[a-z]+$/);
  }
});
