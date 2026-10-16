import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type RepositoryContext = { root: string; origin?: string; relativeDirectory: string };

function safeOrigin(origin: string): string {
  if (!origin.includes("://")) return origin;
  try {
    const url = new URL(origin);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return "[unavailable: invalid remote URL]"; }
}

/** Read-only facts about the startup folder; no project/Goal inference or Git mutation. */
export async function repositoryContext(directory: string): Promise<RepositoryContext | undefined> {
  const options = { cwd: directory, timeout: 2000, maxBuffer: 1024 * 1024 };
  let root: string;
  try {
    root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], options)).stdout.trim();
    if (!root) return undefined;
  } catch { return undefined; }
  let origin: string | undefined;
  try {
    const remote = (await execFileAsync("git", ["config", "--get", "remote.origin.url"], options)).stdout.trim();
    if (remote) origin = safeOrigin(remote);
  } catch { /* Local-only repositories need not have an origin. */ }
  const actualDirectory = await realpath(directory).catch(() => directory);
  return { root, origin, relativeDirectory: relative(root, actualDirectory) || "." };
}
