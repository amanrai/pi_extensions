import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export type Goal = { id: string; title: string };
export const goalLists = ["current", "finish", "complete", "abandon"] as const;
export type GoalList = typeof goalLists[number];
export const goalOperations = { goal_start: "current", goal_finish: "finish", goal_complete: "complete", goal_abandon: "abandon" } as const;
export type GoalOperation = keyof typeof goalOperations;
export type GoalFile = Record<string, Goal[]> & Record<GoalList, Goal[]>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validGoalId(id: unknown): id is string { return typeof id === "string" && UUID.test(id); }

export function sessionGoalPath(ctx: { cwd: string; sessionManager: { getSessionId?: () => string; getHeader?: () => { cwd?: string } | null } }): string {
  const id = ctx.sessionManager.getSessionId?.();
  if (!id || !/^[\w-]+$/.test(id)) throw new Error("Main Pi session ID is unavailable or unsafe");
  return join(resolve(ctx.sessionManager.getHeader?.()?.cwd ?? ctx.cwd), `.scryer-${id}`);
}

function entries(value: unknown, label: string): Goal[] {
  if (!Array.isArray(value) || value.some(g => !g || !validGoalId(g.id) || typeof g.title !== "string" || !g.title.trim())) {
    throw new Error(`Invalid ${label}: expected an array of Goal {id: UUID, title: nonempty string} entries`);
  }
  return value;
}

// Publication deliberately reads only current; historical lists are not attribution.
export async function readCurrentGoals(path: string): Promise<Goal[]> {
  const data = JSON.parse(await readFile(path, "utf8"));
  return entries(data?.current, "current");
}

async function readGoalFile(path: string): Promise<GoalFile> {
  const data = JSON.parse(await readFile(path, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a Goal-list object");
  for (const name of goalLists) if (!(name in data)) throw new Error(`Missing ${name} list`);
  for (const [name, value] of Object.entries(data)) entries(value, name);
  return data;
}

// Publish complete bytes without overwriting an existing (even invalid) file.
export async function initializeGoalFile(path: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ current: [], finish: [], complete: [], abandon: [] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    try { await link(temporary, path); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
  } finally { await unlink(temporary); }
  await readGoalFile(path);
}

// Serialize transitions (including their event publication) across all four tools.
// Atomic rename also ensures readers never see partial JSON. Separate session IDs
// use separate files; this is not a cross-process locking service.
const queues = new Map<string, Promise<unknown>>();
export async function transitionGoal(path: string, operation: GoalOperation, id: string, title?: string,
  publish?: (operation: GoalOperation, id: string) => Promise<void>): Promise<{ changed: boolean; goal: Goal; eventError?: string }> {
  if (!validGoalId(id)) throw new Error("Goal id must be a UUID");
  id = id.toLowerCase();
  const previous = queues.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const data = await readGoalFile(path);
    const target = goalOperations[operation];
    if (!target) throw new Error("Unknown Goal operation");
    const occurrences = Object.entries(data).flatMap(([list, goals]) => goals.filter(g => g.id.toLowerCase() === id).map(goal => ({ list, goal })));
    const existing = occurrences[0]?.goal;
    if (occurrences.length === 1 && occurrences[0].list === target) return { changed: false, goal: existing! };
    // No PM lookup: a caller may supply a title; otherwise retain it or use the UUID.
    const goal = { id, title: title?.trim() || existing?.title || id };
    for (const list of Object.keys(data)) data[list] = data[list].filter(g => g.id.toLowerCase() !== id);
    data[target].push(goal);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
    try { await publish?.(operation, id); }
    catch (error: any) { return { changed: true, goal, eventError: error?.message ?? String(error) }; }
    return { changed: true, goal };
  });
  queues.set(path, pending);
  try { return await pending; }
  finally { if (queues.get(path) === pending) queues.delete(path); }
}

export async function goalMetadata(path: string, metadata: Record<string, unknown>, warn: (message: string) => void): Promise<Record<string, unknown>> {
  let goals: Goal[] = [];
  try { goals = await readCurrentGoals(path); }
  catch (error: any) { warn(`Scryer Goal tracking ${path}: ${error instanceof SyntaxError ? "invalid JSON" : error?.code ?? error?.message ?? String(error)}; sending goals: []`); }
  return { ...metadata, v2meta: { ...(metadata.v2meta as Record<string, unknown> ?? {}), goals } };
}
