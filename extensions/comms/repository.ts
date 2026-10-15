import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A transport-independent remote key, never a machine-local Git root. */
export function normalizeGitRepo(remote: string | undefined): string | undefined {
  if (!remote?.trim()) return undefined;
  const value = remote.trim();
  if (/^(?:[A-Za-z]:[\\/]|[/.~])/.test(value)) return undefined;
  let host: string;
  let path: string;
  try {
    if (value.includes("://")) {
      const url = new URL(value);
      if (!["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(url.protocol)) return undefined;
      const defaultPort = ((url.protocol === "ssh:" || url.protocol === "git+ssh:") && url.port === "22")
        || (url.protocol === "git:" && url.port === "9418");
      host = url.hostname.toLowerCase() + (url.port && !defaultPort ? `:${url.port}` : "");
      path = url.pathname;
    } else {
      const canonical = /^git@([^/:\s]+(?::\d+)?)\/(.+)$/.exec(value);
      const scp = /^(?:[^/@\s]+@)?([^/:\s]+):(.+)$/.exec(value);
      // Accept our canonical key as well as Git's user@host:path syntax.
      const match = canonical ?? scp;
      if (!match) return undefined;
      host = match[1].toLowerCase();
      path = match[2];
    }
  } catch {
    return undefined;
  }
  path = path.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !path || /\s/.test(host + path)) return undefined;
  // GitHub paths are case-insensitive. Other hosts may have case-sensitive paths.
  if (host === "github.com") path = path.toLowerCase();
  return `git@${host}/${path}`;
}

/** No origin (including a newly initialized repo) means no portable repo key yet. */
export async function detectGitRepo(directory: string): Promise<string | undefined> {
  try {
    const options = { cwd: directory, timeout: 2000, maxBuffer: 1024 * 1024 };
    await execFileAsync("git", ["rev-parse", "--show-toplevel"], options);
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], options);
    return normalizeGitRepo(stdout);
  } catch {
    return undefined;
  }
}
