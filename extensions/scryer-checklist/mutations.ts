import type { Actor } from "./order.ts";
type Options = { baseUrl: string; actor: Actor; signal?: AbortSignal; fetch?: typeof fetch };
type Json = Record<string, any>;
export type BatchResult = {
  status: "updated" | "unchanged" | "failed";
  confirmed: Record<string, string>[];
  http_requests: number;
  uncertain?: Record<string, string>;
  error?: string;
  items?: Json[];
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error("References must be UUIDs.");
  return value.toLowerCase();
}
function obj(value: unknown): asserts value is Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
}
function keys(value: unknown, allowed: string[]): asserts value is Json {
  obj(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unexpected field in operation.");
}
function list(value: unknown): asserts value is any[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Supply a nonempty operation list.");
}
function record(value: unknown, expectedId?: string): Json {
  obj(value);
  const id = uuid(value.id);
  if ((expectedId && id !== expectedId) || value.deleted_at) throw new Error("API did not return the requested active record.");
  return value;
}
function client(options: Options) {
  if (!options.actor.actor_role.trim() || !options.actor.actor_instance_key.trim()) throw new Error("Missing actor attribution.");
  let count = 0;
  return {
    options,
    get count() { return count; },
    async request(method: string, path: string, body?: unknown): Promise<any> {
      options.signal?.throwIfAborted(); count++;
      const response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/$/, "")}${path}`, {
        method, headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]),
      });
      if (!response.ok) throw new Error(`JEPM HTTP ${response.status}; no automatic retry.`);
      return response.json();
    },
  };
}
type Client = ReturnType<typeof client>;
const initial = (): BatchResult => ({ status: "unchanged", confirmed: [], http_requests: 0 });
async function write(c: Client, result: BatchResult, operation: string, method: string, path: string, body: unknown, context: Record<string, string>, validate: (saved: any) => string) {
  c.options.signal?.throwIfAborted();
  result.uncertain = { operation, ...context };
  const saved = await c.request(method, path, body);
  const id = validate(saved);
  result.confirmed.push({ operation, id, ...context });
  delete result.uncertain;
  return saved;
}
async function finish(c: Client, result: BatchResult, run: () => Promise<void>) {
  try { await run(); result.status = result.confirmed.length ? "updated" : "unchanged"; }
  catch (error) {
    result.status = "failed";
    result.error = `${error instanceof Error ? error.message : String(error)} Batch is not atomic; inspect confirmed/uncertain operations before further action. No retry or rollback was attempted.`;
  }
  result.http_requests = c.count;
  return result;
}
type Link = { id: string; source_goal_id: string; target_goal_id: string };
async function links(c: Client): Promise<Link[]> {
  const value = await c.request("GET", "/api/goal-relationships");
  if (!Array.isArray(value)) throw new Error("API returned invalid relationships.");
  const active: Link[] = [];
  for (const link of value) {
    obj(link);
    if (typeof link.relationship_type !== "string") throw new Error("API returned an invalid relationship type.");
    const id = uuid(link.id), source = uuid(link.source_goal_id), target = uuid(link.target_goal_id);
    if (link.relationship_type === "supports" && !link.deleted_at) active.push({ id, source_goal_id: source, target_goal_id: target });
  }
  return active;
}
function graph(edges: Link[]) {
  const parents = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!parents.has(edge.source_goal_id)) parents.set(edge.source_goal_id, new Set());
    parents.get(edge.source_goal_id)!.add(edge.target_goal_id);
  }
  return parents;
}
function reaches(parents: Map<string, Set<string>>, start: string, target: string): boolean {
  const pending = [start], seen = new Set<string>();
  while (pending.length) {
    const node = pending.pop()!;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node); pending.push(...(parents.get(node) ?? []));
  }
  return false;
}
async function preflightGoals(c: Client, ids: string[]) {
  for (const id of new Set(ids)) record(await c.request("GET", `/api/goals/${id}`), id);
}
async function addLink(c: Client, result: BatchResult, child: string, parent: string) {
  return write(c, result, "add_parent", "POST", "/api/goal-relationships", { ...c.options.actor, source_goal_id: child, target_goal_id: parent, relationship_type: "supports" }, { goal_id: child, parent_id: parent }, saved => {
    record(saved);
    if (uuid(saved.source_goal_id) !== child || uuid(saved.target_goal_id) !== parent || saved.relationship_type !== "supports") throw new Error("API did not confirm the parent link.");
    return uuid(saved.id);
  });
}
export async function setParents(input: { goals: { goal_id: string; parent_ids: string[] }[] }, options: Options): Promise<BatchResult> {
  keys(input, ["goals"]); list(input.goals);
  const pairs = new Map<string, [string, string]>();
  for (const item of input.goals) {
    keys(item, ["goal_id", "parent_ids"]); list(item.parent_ids);
    const child = uuid(item.goal_id);
    for (const value of item.parent_ids) {
      const parent = uuid(value);
      if (child === parent) throw new Error("A Goal cannot parent itself.");
      pairs.set(`${child}/${parent}`, [child, parent]);
    }
  }
  const c = client(options), edges = await links(c), parents = graph(edges);
  await preflightGoals(c, [...pairs.values()].flat());
  const pending = [...pairs.values()].filter(([child, parent]) => !parents.get(child)?.has(parent));
  for (const [child, parent] of pending) {
    if (!parents.has(child)) parents.set(child, new Set());
    parents.get(child)!.add(parent);
  }
  for (const [child, parent] of pending) if (reaches(parents, parent, child)) throw new Error("Requested parent additions create a hierarchy cycle; no writes performed.");
  const result = initial();
  return finish(c, result, async () => {
    for (const [child, parent] of pending) await addLink(c, result, child, parent);
    const observed = await links(c);
    for (const [child, parent] of pairs.values()) if (!observed.some(link => link.source_goal_id === child && link.target_goal_id === parent)) throw new Error("Parent read-back differs from requested additions; inspect concurrent changes.");
    const observedGraph = graph(observed);
    for (const [child, parent] of pending) if (reaches(observedGraph, parent, child)) throw new Error("Parent read-back contains a cycle; inspect concurrent changes.");
  });
}
export async function moveSubgoals(input: { moves: { subgoal_id: string; destination_goal_id: string }[] }, options: Options): Promise<BatchResult> {
  keys(input, ["moves"]); list(input.moves);
  const seen = new Set<string>();
  const moves = input.moves.map(move => {
    keys(move, ["subgoal_id", "destination_goal_id"]);
    const child = uuid(move.subgoal_id), parent = uuid(move.destination_goal_id);
    if (child === parent || seen.has(child)) throw new Error("No self-parent or repeated sub-Goal in an exclusive-move batch.");
    seen.add(child); return { child, parent };
  });
  const c = client(options), edges = await links(c), parents = graph(edges);
  await preflightGoals(c, moves.flatMap(move => [move.child, move.parent]));
  // Preflight the caller's sequential order, not just the final graph.
  for (const { child, parent } of moves) {
    parents.set(child, new Set([parent]));
    if (reaches(parents, parent, child)) throw new Error("Move creates a hierarchy cycle at this step; no writes performed.");
  }
  const result = initial();
  return finish(c, result, async () => {
    for (const { child, parent } of moves) {
      const previous = edges.filter(link => link.source_goal_id === child);
      if (!previous.some(link => link.target_goal_id === parent)) await addLink(c, result, child, parent);
      for (const old of previous.filter(link => link.target_goal_id !== parent)) {
        await write(c, result, "remove_parent", "DELETE", `/api/goal-relationships/${old.id}`, options.actor, { goal_id: child, parent_id: old.target_goal_id, relationship_id: old.id }, saved => {
          obj(saved);
          if (uuid(saved.id) !== old.id || typeof saved.deleted_at !== "string" || !saved.deleted_at) throw new Error("API did not confirm removal of the old parent link.");
          return old.id;
        });
      }
    }
    const observed = graph(await links(c));
    for (const { child, parent } of moves) {
      if (observed.get(child)?.size !== 1 || !observed.get(child)?.has(parent) || reaches(observed, parent, child)) throw new Error("Exclusive-parent read-back failed; inspect partial or concurrent changes.");
    }
  });
}
export type ChecklistChange = { item_id: string; title?: string; description_md?: string | null; status?: "complete" | "incomplete"; append_comments?: string[] };
export async function updateChecklistItems(input: { items: ChecklistChange[] }, options: Options): Promise<BatchResult> {
  keys(input, ["items"]); list(input.items);
  for (const item of input.items) {
    keys(item, ["item_id", "title", "description_md", "status", "append_comments"]); uuid(item.item_id);
    if (item.title !== undefined && (typeof item.title !== "string" || !item.title.trim())) throw new Error("Title must be nonblank.");
    if (item.description_md !== undefined && item.description_md !== null && typeof item.description_md !== "string") throw new Error("Description must be a string or null.");
    if (item.status !== undefined && item.status !== "complete" && item.status !== "incomplete") throw new Error("Backend checklist status supports only complete/incomplete.");
    if (item.append_comments !== undefined && (!Array.isArray(item.append_comments) || item.append_comments.some(body => typeof body !== "string" || !body.trim()))) throw new Error("append_comments must contain nonblank text strings.");
  }
  const c = client(options), current = new Map<string, Json>();
  for (const change of input.items) {
    const id = uuid(change.item_id);
    if (!current.has(id)) {
      const item = record(await c.request("GET", `/api/goal-checklist-items/${id}`), id);
      uuid(item.goal_id);
      if (item.is_done !== 0 && item.is_done !== 1) throw new Error("API returned invalid checklist completion state.");
      current.set(id, item);
    }
  }
  const result = initial();
  const outcome = await finish(c, result, async () => {
    for (const change of input.items) {
      const id = uuid(change.item_id), original = current.get(id)!;
      const fields: Json = {};
      if (change.title !== undefined && change.title !== original.title) fields.title = change.title;
      if (change.description_md !== undefined && change.description_md !== original.description_md) fields.description_md = change.description_md;
      if (change.status !== undefined) {
        const done = change.status === "complete" ? 1 : 0;
        if (done !== original.is_done || (done === 0 && original.completed_at != null) || (done === 1 && original.completed_at == null)) fields.is_done = done;
      }
      if (Object.keys(fields).length) {
        const saved = await write(c, result, "update_item", "PATCH", `/api/goal-checklist-items/${id}`, { ...options.actor, ...fields }, { item_id: id }, value => {
          record(value, id);
          if (uuid(value.goal_id) !== uuid(original.goal_id) || value.display_order !== original.display_order || Object.entries(fields).some(([key, expected]) => value[key] !== expected)) throw new Error("API did not confirm the item fields without changing its Goal/order.");
          if (fields.is_done === 0 && value.completed_at !== null) throw new Error("API did not clear completion timestamp.");
          if (fields.is_done === 1 && !value.completed_at) throw new Error("API did not supply completion timestamp.");
          return id;
        });
        current.set(id, saved);
      }
      for (const body of change.append_comments ?? []) {
        await write(c, result, "append_comment", "POST", `/api/goal-checklist-items/${id}/comments`, { author_role: options.actor.actor_role, author_instance_key: options.actor.actor_instance_key, body_md: body }, { item_id: id }, saved => {
          record(saved);
          if (uuid(saved.goal_checklist_item_id) !== id || saved.body_md !== body || saved.author_role !== options.actor.actor_role || saved.author_instance_key !== options.actor.actor_instance_key) throw new Error("API did not confirm the appended comment.");
          return uuid(saved.id);
        });
      }
    }
  });
  outcome.items = [...current.values()];
  return outcome;
}
