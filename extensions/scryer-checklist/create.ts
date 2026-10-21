import type { Actor } from "./order.ts";
export type NewChecklistItem = { title: string; description_md?: string };
export type NewSubgoal = { title: string; description_md?: string; checklist_items?: NewChecklistItem[] };
export type CreateSubgoalsInput = { goal_id: string; subgoals: NewSubgoal[] };
export type CreateSubgoalsResult = {
  status: "created" | "failed";
  created_goal_ids: string[];
  linked_goal_ids: string[];
  http_requests: number;
  failed_subgoal_title?: string;
  uncertain_stage?: "create_goal" | "link_goal";
  uncertain_goal_id?: string;
  error?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function definition(value: unknown, checklist: boolean) {
  if (!object(value) || typeof value.title !== "string" || !value.title.trim()) throw new Error("Every sub-Goal and checklist item requires a nonblank title.");
  const allowed = checklist ? ["title", "description_md"] : ["title", "description_md", "checklist_items"];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported definition field; use title, optional description_md and optional checklist_items.");
  if (value.description_md !== undefined && typeof value.description_md !== "string") throw new Error("description_md must be a string when supplied.");
  if (!checklist && value.checklist_items !== undefined) {
    if (!Array.isArray(value.checklist_items)) throw new Error("checklist_items must be an array when supplied.");
    for (const item of value.checklist_items) definition(item, true);
  }
}
export function validateCreateSubgoals(value: unknown): asserts value is CreateSubgoalsInput {
  if (!object(value) || Object.keys(value).some(key => key !== "goal_id" && key !== "subgoals") || typeof value.goal_id !== "string" || !uuid.test(value.goal_id)) throw new Error("Supply goal_id (UUID) and subgoals in a JSON object.");
  if (!Array.isArray(value.subgoals) || value.subgoals.length === 0) throw new Error("subgoals must be a nonempty array.");
  for (const subgoal of value.subgoals) definition(subgoal, false);
}
export async function createSubgoals(input: CreateSubgoalsInput, options: { baseUrl: string; actor: Actor; signal?: AbortSignal; fetch?: typeof fetch }): Promise<CreateSubgoalsResult> {
  validateCreateSubgoals(input); // Entire batch, including optional checklists, before any network/write.
  if (!options.actor.actor_role.trim() || !options.actor.actor_instance_key.trim()) throw new Error("Missing actor attribution.");
  const parentId = input.goal_id.toLowerCase();
  let requests = 0;
  async function request(path: string, body?: unknown) {
    options.signal?.throwIfAborted();
    requests++;
    const response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]),
    });
    if (!response.ok) throw new Error(`JEPM HTTP ${response.status}; no automatic retry.`);
    return response.json();
  }
  const parent = await request(`/api/goals/${parentId}`);
  if (!object(parent) || typeof parent.id !== "string" || parent.id.toLowerCase() !== parentId || parent.deleted_at) throw new Error("JEPM did not return the requested active parent Goal.");
  // No parentlessness requirement: an existing sub-Goal is a valid parent here.
  const result: CreateSubgoalsResult = { status: "created", created_goal_ids: [], linked_goal_ids: [], http_requests: requests };
  let current: NewSubgoal | undefined;
  try {
    for (const subgoal of input.subgoals) {
      current = subgoal;
      options.signal?.throwIfAborted();
      result.uncertain_stage = "create_goal";
      const saved = await request("/api/goals", {
        ...options.actor, title: subgoal.title,
        ...(subgoal.description_md === undefined ? {} : { description_md: subgoal.description_md }),
        ...(subgoal.checklist_items === undefined ? {} : { checklist_items: subgoal.checklist_items.map((item, display_order) => ({ ...item, display_order })) }),
      });
      if (!object(saved) || typeof saved.id !== "string" || !uuid.test(saved.id) || saved.id.toLowerCase() === parentId || result.created_goal_ids.includes(saved.id.toLowerCase())) throw new Error("JEPM did not confirm a distinct new Goal UUID.");
      const child = saved.id.toLowerCase();
      result.created_goal_ids.push(child);
      delete result.uncertain_stage;
      options.signal?.throwIfAborted();
      result.uncertain_stage = "link_goal";
      result.uncertain_goal_id = child;
      const link = await request("/api/goal-relationships", { ...options.actor, source_goal_id: child, target_goal_id: parentId, relationship_type: "supports" });
      if (!object(link) || typeof link.source_goal_id !== "string" || link.source_goal_id.toLowerCase() !== child || typeof link.target_goal_id !== "string" || link.target_goal_id.toLowerCase() !== parentId || link.relationship_type !== "supports" || link.deleted_at) throw new Error("JEPM did not confirm the requested child-to-parent link.");
      result.linked_goal_ids.push(child);
      delete result.uncertain_stage;
      delete result.uncertain_goal_id;
    }
  } catch (error) {
    result.status = "failed";
    result.failed_subgoal_title = current?.title;
    result.error = `${error instanceof Error ? error.message : String(error)} Batch is not atomic. Inspect created/linked IDs and any uncertain operation before further action; no retry, cleanup or rollback was attempted.`;
  }
  return { ...result, http_requests: requests };
}
