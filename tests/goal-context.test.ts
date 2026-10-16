import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repositoryContext } from "../extensions/goal-orientation/context.ts";
import { goalStartupPrompt } from "../extensions/goal-orientation/prompts.ts";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "goal-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo with spaces");
  await mkdir(repo);
  return { root, repo };
}

test("non-repository startup explicitly reports no repository", async (t) => {
  const { repo } = await fixture(t);
  assert.equal(await repositoryContext(repo), undefined);
  assert.ok(goalStartupPrompt(repo, "impressed_harrier").includes("No Git repository was found"));
});

test("repository root, origin and exact startup subfolder are composed as facts", async (t) => {
  const { repo } = await fixture(t);
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:amanrai/loom.git"]);
  const nested = join(repo, "src", "a folder");
  await mkdir(nested, { recursive: true });
  const context = await repositoryContext(nested);
  assert.deepEqual(context, { root: await realpath(repo), origin: "git@github.com:amanrai/loom.git", relativeDirectory: "src/a folder" });
  assert.equal((await repositoryContext(repo))?.relativeDirectory, ".");
  const prompt = goalStartupPrompt(nested, "impressed_harrier", context);
  assert.ok(prompt.includes(`Git repository root: ${JSON.stringify(context!.root)}`));
  assert.ok(prompt.includes('Origin remote: "git@github.com:amanrai/loom.git"'));
  assert.ok(prompt.includes('Startup folder relative to the repository root: "src/a folder"'));
});

test("local-only repositories do not invent an origin", async (t) => {
  const { repo } = await fixture(t);
  execFileSync("git", ["init", "--quiet", repo]);
  const context = await repositoryContext(repo);
  assert.deepEqual(context, { root: await realpath(repo), origin: undefined, relativeDirectory: "." });
  assert.ok(goalStartupPrompt(repo, "impressed_harrier", context).includes("No origin remote is configured"));
});

test("remote URL credentials and query tokens are not included in startup context", async (t) => {
  const { repo } = await fixture(t);
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://user:secret@github.com/amanrai/loom.git?token=private#fragment"]);
  const context = await repositoryContext(repo);
  assert.equal(context?.origin, "https://github.com/amanrai/loom.git");
  assert.ok(!goalStartupPrompt(repo, "impressed_harrier", context).includes("secret"));
});

test("symlink startup folders resolve relative to the actual repository root", async (t) => {
  const { root, repo } = await fixture(t);
  execFileSync("git", ["init", "--quiet", repo]);
  await mkdir(join(repo, "src"));
  const link = join(root, "linked-src");
  await symlink(join(repo, "src"), link);
  assert.equal((await repositoryContext(link))?.relativeDirectory, "src");
});
