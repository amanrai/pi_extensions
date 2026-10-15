import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { commandTouchedFolders } from "./commands.ts";

const exec = promisify(execFile);
const codeExtensions = new Set(".ts .tsx .js .jsx .mjs .cjs .mts .cts .py .pyi .rb .go .rs .c .h .cc .hh .cpp .hpp .cs .java .kt .kts .swift .m .mm .php .pl .pm .lua .r .jl .scala .sc .clj .cljs .ex .exs .erl .hrl .hs .ml .fs .fsx .vb .dart .sh .bash .zsh .fish .ps1 .psm1 .bat .cmd .sql .html .htm .css .scss .sass .less .vue .svelte .astro .graphql .gql .proto .ipynb".split(" "));
export function isCodePath(path: string) {
  return codeExtensions.has(extname(path).toLowerCase()) || /^(?:Dockerfile(?:\..+)?|Makefile|GNUmakefile|Rakefile|Gemfile|Justfile)$/i.test(basename(path));
}

async function fingerprint(path: string): Promise<string | null | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined;
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error: any) { return error?.code === "ENOENT" ? null : undefined; }
}

async function codeFiles(folders: string[]) {
  const paths = new Set<string>();
  const observed: string[] = [];
  for (const folder of folders) {
    try {
      const { stdout } = await exec("git", ["-C", folder, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
      const files = stdout.split("\0").filter(Boolean);
      // Conservative bounded observation, never an expensive filesystem audit.
      if (files.length > 2000) continue;
      observed.push(folder);
      for (const file of files) if (isCodePath(file)) paths.add(resolve(folder, file));
    } catch { /* No repo: direct edit/write tools still have exact evidence. */ }
  }
  return { paths: [...paths], folders: observed };
}

export type ChangeSnapshot = { hashes: Map<string, string | null | undefined>; folders?: string[] };
export async function beforeCodeChange(tool: string, input: Record<string, unknown>, cwd: string): Promise<ChangeSnapshot | undefined> {
  let paths: string[];
  let folders: string[] | undefined;
  if (["edit", "write"].includes(tool) && typeof input.path === "string") {
    const path = resolve(cwd, input.path.startsWith("~/") ? `${homedir()}/${input.path.slice(2)}` : input.path);
    if (!isCodePath(path)) return undefined;
    paths = [path];
  } else if (tool === "bash" && typeof input.command === "string") {
    folders = await commandTouchedFolders(input.command, cwd);
    if (!folders.length) return undefined;
    const listing = await codeFiles(folders);
    paths = listing.paths;
    folders = listing.folders;
  } else return undefined;
  const hashes: ChangeSnapshot["hashes"] = new Map();
  for (let index = 0; index < paths.length; index += 8) {
    const batch = await Promise.all(paths.slice(index, index + 8).map(async (path) => [path, await fingerprint(path)] as const));
    for (const [path, hash] of batch) hashes.set(path, hash);
  }
  return { folders, hashes };
}

/** A command name, a successful no-op, or an old dirty tree is not a code change. */
export async function afterCodeChange(before: ChangeSnapshot | undefined): Promise<boolean> {
  if (!before) return false;
  const paths = new Set([...before.hashes.keys(), ...(before.folders ? (await codeFiles(before.folders)).paths : [])]);
  for (const path of paths) {
    const previous = before.hashes.has(path) ? before.hashes.get(path) : null;
    const next = await fingerprint(path);
    if (previous !== undefined && next !== undefined && previous !== next) return true;
  }
  return false;
}
