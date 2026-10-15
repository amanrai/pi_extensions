import { execFile } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import adjectives from "./words/adjectives.ts";
import nouns from "./words/nouns.ts";

export type CreatorIdentity = {
  name: string;
  machine_name?: string;
  tailnet_name?: string;
  repo?: string;
  created_at: string;
  session: string;
  [key: string]: unknown;
};

export type TouchIdentity = { name: string; touched_at: string[] };

export type ScryerRecord = {
  created_by: CreatorIdentity[];
  command_runner: (string | TouchIdentity)[];
  file_modifier: (string | TouchIdentity)[];
  "version-manager": (string | TouchIdentity)[];
  [key: string]: unknown;
};

export type StartupIdentity = {
  directory: string;
  name: string;
  record: ScryerRecord;
};

type Environment = { machine_name?: string; tailnet_name?: string; repo?: string };
type StartupOptions = {
  environment?: () => Promise<Environment>;
  generateName?: () => string;
  now?: () => string;
};

const execFileAsync = promisify(execFile);
const adjectiveWords = adjectives.filter((word) => /^[a-z]+$/.test(word));
const nounWords = nouns.filter((word) => /^[a-z]+$/.test(word));

export function generateIdentityName() {
  return `${adjectiveWords[randomInt(adjectiveWords.length)]}_${nounWords[randomInt(nounWords.length)]}_${randomBytes(2).toString("hex")}`;
}

/** Attach only the sender's name; never send the folder's identity lists. */
export function updateIdentityMetadata(metadata: Record<string, unknown> | undefined, name: string, foldersTouched: readonly string[] = []) {
  if (!name.trim()) throw new Error("Scryer startup identity is required for updates");
  const previous = metadata?.v2meta;
  const v2meta: Record<string, unknown> = previous && typeof previous === "object" && !Array.isArray(previous)
    ? { ...previous as Record<string, unknown> }
    : {};
  delete v2meta.identities;
  return { ...metadata, v2meta: { ...v2meta, identity: name, foldersTouched: [...new Set(foldersTouched)].sort() } };
}

async function output(command: string, args: string[], cwd: string) {
  try {
    const result = await execFileAsync(command, args, { cwd, timeout: 2000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function tailnetMachineName(status: string | undefined): string | undefined {
  try {
    const self = JSON.parse(status ?? "{}").Self;
    const dnsName = self?.DNSName;
    if (typeof dnsName === "string" && dnsName.trim()) return dnsName.trim().replace(/\.$/, "");
    if (typeof self?.HostName === "string" && self.HostName.trim()) return self.HostName.trim();
  } catch { /* Tailscale is optional. */ }
  return undefined;
}

export function runtimeMachineName(status: string | undefined, fallback: string): string {
  return tailnetMachineName(status) ?? fallback;
}

export async function detectRuntimeMachineName(directory: string): Promise<string> {
  return runtimeMachineName(await output("tailscale", ["status", "--json"], directory), hostname());
}

async function detectEnvironment(directory: string): Promise<Environment> {
  const [status, remote, root] = await Promise.all([
    output("tailscale", ["status", "--json"], directory),
    output("git", ["config", "--get", "remote.origin.url"], directory),
    output("git", ["rev-parse", "--show-toplevel"], directory),
  ]);
  const tailnet_name = tailnetMachineName(status);
  return { machine_name: hostname() || undefined, tailnet_name, repo: root ? remote ?? root : undefined };
}

function parseRecord(raw: string, path: string): ScryerRecord {
  const record = JSON.parse(raw);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  record.created_by ??= [];
  if (!Array.isArray(record.created_by) || record.created_by.length > 1) {
    throw new Error(`${path}: created_by must contain at most one identity`);
  }
  for (const creator of record.created_by) {
    if (!creator || typeof creator !== "object" || typeof creator.name !== "string" || !creator.name.trim()) {
      throw new Error(`${path}: created_by requires an identity record with a name`);
    }
  }
  for (const role of ["command_runner", "file_modifier", "version-manager"]) {
    record[role] ??= [];
    if (!Array.isArray(record[role]) || !record[role].every((entry: unknown) => {
      // Retain compatibility with files written before touch timestamps were added.
      if (typeof entry === "string") return Boolean(entry.trim());
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const touch = entry as TouchIdentity;
      return typeof touch.name === "string" && Boolean(touch.name.trim()) &&
        Array.isArray(touch.touched_at) && touch.touched_at.every((hour) =>
          typeof hour === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}Z$/.test(hour));
    })) {
      throw new Error(`${path}: ${role} requires names or name/touched_at entries`);
    }
  }
  return record;
}

async function readRecord(path: string): Promise<ScryerRecord> {
  try {
    return parseRecord(await readFile(path, "utf8"), path);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { created_by: [], command_runner: [], file_modifier: [], "version-manager": [] };
    }
    throw error;
  }
}

// Serialize read/modify/write across concurrent Pi processes in the same folder.
// A leftover lock is reported rather than risking overwriting another writer.
async function withRecordLock<T>(directory: string, action: (path: string) => Promise<T>): Promise<T> {
  const path = join(directory, ".scryer");
  const lockPath = `${path}.lock`;
  let lock;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  if (!lock) throw new Error(`Timed out waiting for ${lockPath}; check for a stopped writer before removing the lock`);
  try {
    return await action(path);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function writeRecord(path: string, record: ScryerRecord) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o644);
    try {
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Resolve only this folder's identity. Never inherit a parent folder's name. */
export async function initializeStartupIdentity(
  directory: string,
  session: string,
  options: StartupOptions = {},
): Promise<StartupIdentity> {
  directory = resolve(directory);
  const environment = await (options.environment ?? (() => detectEnvironment(directory)))();
  return withRecordLock(directory, async (path) => {
    const record = await readRecord(path);
    const before = JSON.stringify(record);
    let creator = record.created_by[0];
    if (!creator) {
      creator = {
        name: (options.generateName ?? generateIdentityName)(),
        ...environment,
        created_at: (options.now ?? (() => new Date().toISOString()))(),
        session,
      };
      record.created_by.push(creator);
    } else if (environment.repo && creator.repo !== environment.repo) {
      // A repo may have been initialized or given a remote since creation.
      // Machine/tailnet provenance, creation time, and session never change.
      creator.repo = environment.repo;
    }
    if (JSON.stringify(record) !== before) await writeRecord(path, record);
    return { directory, name: creator.name, record };
  });
}
