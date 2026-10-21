type ReadOptions = { baseUrl: string; signal?: AbortSignal; fetch?: typeof fetch };
function goalUuid(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("goal_id must be a UUID.");
  return value.toLowerCase();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function get(path: string, options: ReadOptions): Promise<unknown> {
  options.signal?.throwIfAborted();
  const response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/$/, "")}${path}`, {
    method: "GET", headers: { Accept: "application/json" },
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) throw new Error(`JEPM HTTP ${response.status}; requested data was not retrieved.`);
  return response.json();
}
async function getGoal(id: string, options: ReadOptions): Promise<Record<string, unknown>> {
  const goal = await get(`/api/goals/${id}`, options);
  if (!record(goal) || typeof goal.id !== "string" || goal.id.toLowerCase() !== id || typeof goal.title !== "string" || goal.deleted_at) throw new Error("JEPM returned an invalid Goal record.");
  return goal;
}
export async function getChecklistForGoal(goalId: string, options: ReadOptions): Promise<Record<string, unknown>[]> {
  const goal = goalUuid(goalId);
  const items = await get(`/api/goals/${goal}/checklist-items`, options);
  const seen = new Set<string>();
  if (!Array.isArray(items)) throw new Error("JEPM returned a non-array checklist.");
  for (const item of items) {
    if (!record(item) || typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id) || typeof item.goal_id !== "string" || item.goal_id.toLowerCase() !== goal || typeof item.title !== "string" || seen.has(item.id.toLowerCase()) || item.deleted_at) throw new Error("JEPM returned invalid, duplicate, deleted or foreign checklist items.");
    seen.add(item.id.toLowerCase());
  }
  // Preserve every API field, UUID spelling and API ordering; no projections or cache.
  return items;
}
export async function getTopLevelGoals(options: ReadOptions): Promise<Record<string, unknown>[]> {
  const goals = await get("/api/goals?include_done=true&include_deleted=false", options);
  const relationships = await get("/api/goal-relationships", options);
  if (!Array.isArray(goals) || !Array.isArray(relationships)) throw new Error("JEPM returned non-array Goals or relationships.");
  const seen = new Set<string>();
  for (const goal of goals) {
    if (!record(goal) || typeof goal.id !== "string" || typeof goal.title !== "string" || goal.deleted_at) throw new Error("JEPM returned an invalid or deleted Goal record.");
    const id = goalUuid(goal.id);
    if (seen.has(id)) throw new Error("JEPM returned duplicate Goal UUIDs.");
    seen.add(id);
  }
  const children = new Set<string>();
  for (const link of relationships) {
    if (!record(link) || typeof link.source_goal_id !== "string" || typeof link.target_goal_id !== "string" || typeof link.relationship_type !== "string") throw new Error("JEPM returned an invalid Goal relationship.");
    const source = goalUuid(link.source_goal_id);
    goalUuid(link.target_goal_id);
    // A parent outside the returned Goal set must not promote its child to root.
    if (link.relationship_type === "supports" && !link.deleted_at) children.add(source);
  }
  return goals.filter(goal => !children.has(goal.id.toLowerCase()));
}
export type SubgoalNode = { goal: Record<string, unknown>; subgoals: SubgoalNode[] };
export async function getSubgoalsForGoal(goalId: string, options: ReadOptions): Promise<SubgoalNode[]> {
  const root = goalUuid(goalId);
  // Per-invocation memoization only. Shared descendants are rendered under each
  // recorded parent, but fetched once. An ancestor path, not a global visited set,
  // distinguishes a cycle from legitimate multiple-parent relationships.
  const records = new Map<string, Record<string, unknown>>();
  const edges = new Map<string, string[]>();
  async function visit(id: string, ancestors: Set<string>): Promise<SubgoalNode> {
    if (ancestors.has(id)) throw new Error("Cycle in recorded Goal hierarchy; no complete hierarchy returned.");
    options.signal?.throwIfAborted();
    if (!records.has(id)) records.set(id, await getGoal(id, options));
    if (!edges.has(id)) {
      const relationships = await get(`/api/goals/${id}/relationships`, options);
      if (!Array.isArray(relationships)) throw new Error("JEPM returned non-array Goal relationships.");
      const children = new Set<string>();
      for (const link of relationships) {
        if (!record(link) || typeof link.source_goal_id !== "string" || typeof link.target_goal_id !== "string" || typeof link.relationship_type !== "string") throw new Error("JEPM returned an invalid Goal relationship.");
        const source = goalUuid(link.source_goal_id), target = goalUuid(link.target_goal_id);
        if (link.relationship_type === "supports" && target === id && !link.deleted_at) children.add(source);
      }
      edges.set(id, [...children]);
    }
    const path = new Set(ancestors).add(id);
    const subgoals: SubgoalNode[] = [];
    for (const child of edges.get(id)!) subgoals.push(await visit(child, path));
    return { goal: records.get(id)!, subgoals };
  }
  // Reading root also distinguishes a missing Goal from an empty hierarchy.
  return (await visit(root, new Set())).subgoals;
}
