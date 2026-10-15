import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeStartupIdentity, refreshStartupRepo } from "../extensions/comms/identity.ts";
import { startIdentityRegistration, type IdentityRegistration } from "../extensions/comms/registration.ts";
import { detectGitRepo, normalizeGitRepo } from "../extensions/comms/repository.ts";

const options = {
  name: "quiet_badger_abcdefghijkl", session: "pi-session:first", directory: "/workspace/project",
  machine: "current.tailnet.ts.net", serviceUrl: "http://registry.invalid", intervalMs: 60_000,
  detectRepo: async () => undefined,
};
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail("Background registration did not finish");
}

test("Git remote normalization equates SSH/HTTPS without leaking credentials", () => {
  for (const remote of [
    "git@github.com:Example/Project.git", "ssh://git@github.com/Example/Project.git",
    "ssh://git@github.com:22/Example/Project.git", "https://github.com/Example/Project.git",
    "https://user:secret@GitHub.com:443/Example/Project.git/", "http://github.com:80/Example/Project",
    "git://github.com:9418/Example/Project.git", "git@github.com/example/project",
    "https://github.com/Example/Project.git?token=secret#fragment",
  ]) assert.equal(normalizeGitRepo(remote), "git@github.com/example/project", remote);
  assert.equal(normalizeGitRepo("git@gitlab.example:Team/CaseSensitive.git"), "git@gitlab.example/Team/CaseSensitive");
  assert.equal(normalizeGitRepo("ssh://git@host.example:2222/team/repo.git"), "git@host.example:2222/team/repo");
  assert.equal(normalizeGitRepo("git@host.example:2222/team/repo"), "git@host.example:2222/team/repo");
  for (const remote of [undefined, "", "/local/root", "../repo.git", "C:\\repo", "file:///local/repo", "relative/repo", "not a remote"])
    assert.equal(normalizeGitRepo(remote), undefined, String(remote));
});

test("Git discovery notices init plus a later origin, never inventing a portable key from a local path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scryer-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await detectGitRepo(directory), undefined);
  execFileSync("git", ["init", "--quiet", directory]);
  assert.equal(await detectGitRepo(directory), undefined);
  execFileSync("git", ["-C", directory, "remote", "add", "origin", "git@github.com:Example/Project.git"]);
  assert.equal(await detectGitRepo(directory), "git@github.com/example/project");
  execFileSync("git", ["-C", directory, "remote", "set-url", "origin", "https://github.com/Example/Other.git"]);
  assert.equal(await detectGitRepo(directory), "git@github.com/example/other");
});

test("every startup/resume registers, while acknowledged unchanged payloads do not repeat", async (t) => {
  const posts: IdentityRegistration[] = [];
  const post = async (body: IdentityRegistration) => { posts.push(body); };
  const first = startIdentityRegistration({ ...options, post });
  t.after(() => first.stop());
  await first.refresh();
  assert.deepEqual(posts, [{ name: options.name, session: options.session, location: "machine:current.tailnet.ts.net@/workspace/project" }]);
  await first.refresh();
  assert.equal(posts.length, 1);
  first.stop();
  const resumed = startIdentityRegistration({ ...options, post });
  t.after(() => resumed.stop());
  await resumed.refresh();
  assert.deepEqual(posts[1], posts[0]);
});

test("discovered repos update the same registration and are not erased by temporary absence", async (t) => {
  const posts: IdentityRegistration[] = [];
  const persisted: string[] = [];
  let repo: string | undefined;
  const controller = startIdentityRegistration({ ...options,
    detectRepo: async () => repo,
    onRepo: async (value) => { persisted.push(value); },
    post: async (body) => { posts.push(body); },
  });
  t.after(() => controller.stop());
  await controller.refresh();
  assert.equal(posts[0].repo, undefined);
  repo = "git@github.com/example/project";
  await controller.refresh();
  await controller.refresh();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], { ...posts[0], repo });
  repo = undefined;
  await controller.refresh();
  assert.equal(posts.length, 2);
  assert.deepEqual(persisted, ["git@github.com/example/project"]);
});

test("ordinary timer retries failed registrations with the identical name/session/location", async (t) => {
  const posts: IdentityRegistration[] = [];
  const errors: unknown[] = [];
  let offline = true;
  const controller = startIdentityRegistration({ ...options, intervalMs: 10,
    post: async (body) => { posts.push(body); if (offline) throw new Error("offline"); },
    onError: (error) => { errors.push(error); },
  });
  t.after(() => controller.stop());
  await controller.refresh();
  assert.equal(errors.length, 1);
  offline = false;
  await waitFor(() => posts.length === 2);
  await controller.refresh();
  assert.deepEqual(posts[1], posts[0]);
  assert.equal(posts.length, 2);
});

test("in-flight requests coalesce, and shutdown cancels them without later retries", async () => {
  let calls = 0;
  const controller = startIdentityRegistration({ ...options, intervalMs: 5,
    post: async (_body, signal) => {
      calls++;
      await new Promise<void>((_done, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    },
    onError: () => { assert.fail("Shutdown cancellation should not be logged as a registration failure"); },
  });
  const first = controller.refresh();
  assert.equal(first, controller.refresh());
  await waitFor(() => calls === 1);
  controller.stop();
  await first;
  await new Promise((done) => setTimeout(done, 20));
  await controller.refresh();
  assert.equal(calls, 1);
});

test("HTTP transport accepts only 200/201 and retries other statuses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const status of [200, 201, 202, 400, 404, 503]) {
    const errors: unknown[] = [];
    let calls = 0;
    globalThis.fetch = async (url: any, init: any) => {
      assert.equal(url, "http://registry.invalid/api/identities");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { name: options.name, session: options.session, location: "machine:current.tailnet.ts.net@/workspace/project" });
      calls++;
      return Response.json({}, { status });
    };
    const controller = startIdentityRegistration({ ...options, onError: (error) => { errors.push(error); } });
    try {
      await controller.refresh();
      await controller.refresh();
      assert.equal(errors.length, status === 200 || status === 201 ? 0 : 2);
      assert.equal(calls, status === 200 || status === 201 ? 1 : 2);
    } finally { controller.stop(); }
  }
});

test("repo refresh persists without changing identity, creator provenance or action history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scryer-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await initializeStartupIdentity(directory, options.session, {
    environment: async () => ({ machine_name: "creator", tailnet_name: "creator.tailnet" }),
    generateName: () => options.name, now: () => "2026-10-15T00:00:00.000Z",
  });
  const before = structuredClone(identity.record);
  const repo = "git@github.com/example/project";
  await refreshStartupRepo(identity, repo);
  const saved = JSON.parse(await readFile(join(directory, ".scryer"), "utf8"));
  assert.deepEqual(saved, { ...before, created_by: [{ ...before.created_by[0], repo }] });
  assert.equal("registration_status" in saved.created_by[0], false);
  const raw = await readFile(join(directory, ".scryer"), "utf8");
  await refreshStartupRepo(identity, repo);
  assert.equal(await readFile(join(directory, ".scryer"), "utf8"), raw);
  await assert.rejects(refreshStartupRepo({ ...identity, name: "another_agent" }, repo), /startup identity changed/);
  assert.equal(await readFile(join(directory, ".scryer"), "utf8"), raw);
});
