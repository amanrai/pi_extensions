import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reorderChecklist } from "./order.ts";
import { getChecklistForGoal, getSubgoalsForGoal, getTopLevelGoals } from "./read.ts";
import { createSubgoals } from "./create.ts";
import { setParents, moveSubgoals, updateChecklistItems, type BatchResult } from "./mutations.ts";

const uuid = () => Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
async function startupActor(ctx: ExtensionContext) {
  const cwd = ctx.sessionManager.getHeader()?.cwd ?? ctx.cwd;
  const record = JSON.parse(await readFile(join(cwd, ".scryer"), "utf8"));
  if (!Array.isArray(record.created_by) || record.created_by.length !== 1 || typeof record.created_by[0]?.name !== "string" || !record.created_by[0].name.trim()) {
    throw new Error("Startup .scryer must have one named created_by identity; no guessed actor or remote writes.");
  }
  return { actor_role: "pi-agent", actor_instance_key: record.created_by[0].name };
}
const batchOutput = Type.Object({
  status: Type.Union([Type.Literal("updated"), Type.Literal("unchanged"), Type.Literal("failed")]),
  confirmed: Type.Array(Type.Record(Type.String(), Type.String())), http_requests: Type.Integer(),
  uncertain: Type.Optional(Type.Record(Type.String(), Type.String())), error: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(Type.Unknown())),
});
function batchResult(result: BatchResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, structuredContent: result, ...(result.status === "failed" ? { isError: true } : {}) };
}
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "set_parent_for_goal", label: "Add Goal parents",
    description: "ADD parents without replacing any existing parents. JSON {goals:[{goal_id: child UUID,parent_ids:[parent UUID,...]},...]}; supports multiple children/parents in one call. Creates only missing active supports links (source child, target parent), skipping duplicate/existing links. Any existing undeleted Goal may be a parent, including one with parents. Validates all references and checks requested graph cycles before writes; read-back verifies requested additions. No Goal content/completion/orientation/authorization changes. Not atomic or cross-instance locked; partial/unknown failures report confirmed and uncertain operations. No automatic retry/rollback. For exclusive replacement use move_subgoal_to_goal instead. Requires explicit user-authorized parent additions.",
    parameters: Type.Object({ goals: Type.Array(Type.Object({ goal_id: uuid(), parent_ids: Type.Array(uuid(), { minItems: 1 }) }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
    outputSchema: batchOutput,
    async execute(_id, params, signal, _update, ctx) {
      return batchResult(await setParents(params, { baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210", actor: await startupActor(ctx), signal }));
    },
  });
  pi.registerTool({
    name: "move_subgoal_to_goal", label: "Move sub-Goals exclusively",
    description: "EXCLUSIVELY reparent existing sub-Goals: remove ALL their other active parent links and attach to each chosen destination. JSON {moves:[{subgoal_id: UUID,destination_goal_id: UUID},...]}. One destination per sub-Goal; repeated subgoal_id in one batch is rejected. Validates records/cycles in supplied sequential order before writes. Confirms destination link before deleting old parent links; preserves child links, other relationship types and Goal content/status. Final read-back verifies exclusive parent sets. Not atomic: failure/concurrent edits may leave multiple parents; reports confirmed/uncertain operations, no automatic retry/rollback. Never deletes a Goal. Requires explicit user authorization for exclusive moves. For additive parents use set_parent_for_goal instead.",
    parameters: Type.Object({ moves: Type.Array(Type.Object({ subgoal_id: uuid(), destination_goal_id: uuid() }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
    outputSchema: batchOutput,
    async execute(_id, params, signal, _update, ctx) {
      return batchResult(await moveSubgoals(params, { baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210", actor: await startupActor(ctx), signal }));
    },
  });
  pi.registerTool({
    name: "update_checklist_items", label: "Update checklist items",
    description: "Update checklist items across ANY Goals. JSON {items:[{item_id: UUID,title?,description_md?:string|null,status?:'complete'|'incomplete',append_comments?:[text,...]},...]}. Omitted fields unchanged; null clears description. Backend supports ONLY complete/incomplete (is_done and server-managed completed_at), not ticket workflow states; reopening clears timestamp. Comments are POSTed in supplied order, NEVER edited/deleted or deduplicated by text. No Goal membership, checklist position, Goal completion, orientation or execution-authorization changes. Entire batch validates and all unique items are read before writes; repeated item updates apply sequentially. Identical fields/empty updates skip PATCH; each supplied comment still appends. Returns confirmed mutations/new comment UUIDs and last-confirmed item records. Non-atomic: stops on partial/unknown failure; inspect before further action, no automatic retry/rollback. Only mark work complete when actually performed.",
    parameters: Type.Object({ items: Type.Array(Type.Object({
      item_id: uuid(), title: Type.Optional(Type.String({ minLength: 1 })),
      description_md: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      status: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("incomplete")])),
      append_comments: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
    outputSchema: batchOutput,
    async execute(_id, params, signal, _update, ctx) {
      return batchResult(await updateChecklistItems(params, { baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210", actor: await startupActor(ctx), signal }));
    },
  });
  pi.registerTool({
    name: "create_subgoals_for_goal",
    label: "Create sub-Goals",
    description: "Create and link new sub-Goals beneath an existing Goal. JSON: {goal_id: parent UUID, subgoals:[{title,description_md?,checklist_items?:[{title,description_md?}]}]}. Only title is required within each new Goal/checklist item; descriptions and checklists may be omitted. Preserves supplied Goal/checklist order. Parent may itself have parents. Success returns a JSON array of newly created-and-linked UUIDs in input order. Each child supports the supplied parent. Validates the complete batch before writes. No completion, orientation, assignment or execution authorization. NOT atomic: on failure, error result reports created_goal_ids, linked_goal_ids and any uncertain operation; stop and inspect rather than blindly retry. No automatic retry/rollback/deletion. Writes attributed to full startup .scryer creator identity. Requires user-authorized record creation, not authorization to execute the recorded work.",
    parameters: Type.Object({
      goal_id: uuid(),
      subgoals: Type.Array(Type.Object({
        title: Type.String({ minLength: 1 }),
        description_md: Type.Optional(Type.String()),
        checklist_items: Type.Optional(Type.Array(Type.Object({
          title: Type.String({ minLength: 1 }), description_md: Type.Optional(Type.String()),
        }, { additionalProperties: false }))),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false }),
    outputSchema: Type.Union([Type.Array(uuid()), Type.Object({
      status: Type.Literal("failed"), created_goal_ids: Type.Array(uuid()), linked_goal_ids: Type.Array(uuid()),
      http_requests: Type.Integer(), error: Type.String(), failed_subgoal_title: Type.Optional(Type.String()),
      uncertain_stage: Type.Optional(Type.Union([Type.Literal("create_goal"), Type.Literal("link_goal")])),
      uncertain_goal_id: Type.Optional(uuid()),
    }, { additionalProperties: false })]),
    async execute(_id, params, signal, _update, ctx) {
      const result = await createSubgoals(params, {
        baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210",
        actor: await startupActor(ctx), signal,
      });
      const output = result.status === "created" ? result.linked_goal_ids : result;
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: result, structuredContent: output, ...(result.status === "failed" ? { isError: true } : {}) };
    },
  });
  pi.registerTool({
    name: "get_top_level_goals",
    label: "Get top-level Goals",
    description: "Read all undeleted JEPM Goals with NO recorded parent. No arguments: {}. A Goal has a parent when it is the source (child) of any active supports relationship; target is parent. Includes completed roots; a completed/hidden/unlisted parent does not turn its child into a root. Other relationship types and deleted edges do not establish parents. Returns Goal records with all list-API fields in API order, not nested descendants or expanded checklists. Empty result is []. Two HTTP GETs (Goals and relationships), no snapshot-isolation guarantee; failures are errors rather than partial/empty success. Read-only, no persistent cache, orientation or authorization changes. Present titles, not UUIDs, to the user.",
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Array(Type.Unknown()),
    async execute(_id, _params, signal) {
      const goals = await getTopLevelGoals({
        baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210",
        signal,
      });
      return { content: [{ type: "text", text: JSON.stringify(goals) }], details: goals, structuredContent: goals };
    },
  });
  pi.registerTool({
    name: "get_checklist_for_goal",
    label: "Get Goal checklist",
    description: "Read the full active checklist for one JEPM Goal. Supply goal_id (UUID). Returns all checklist items in current API order, preserving every API-provided item field, including UUID, title, description, completion, position and timestamps. Empty checklist returns []. Deleted items and separate comment histories are not included. One HTTP GET; no caching, writes, orientation or authorization changes. Use returned UUIDs for checklist operations; present titles to the user and clarify ambiguous titles. HTTP/invalid-response failures are errors, never an empty-success substitute.",
    parameters: Type.Object({ goal_id: uuid() }, { additionalProperties: false }),
    outputSchema: Type.Array(Type.Unknown()),
    async execute(_id, params, signal) {
      const items = await getChecklistForGoal(params.goal_id, {
        baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210",
        signal,
      });
      return { content: [{ type: "text", text: JSON.stringify(items) }], details: items, structuredContent: items };
    },
  });
  pi.registerTool({
    name: "get_subgoals_for_goal",
    label: "Get nested sub-Goals",
    description: "Read all nested sub-Goals for one JEPM Goal UUID (goal_id). Returns a hierarchy array of {goal: full API Goal record, subgoals: [...same structure...]}; excludes the requested root itself. Follows active recorded supports links: source is child, target is parent. Recurses to leaves, retaining completed Goals and preserving API relationship order; repeated edges are deduplicated. Shared descendants appear under each parent, fetched once per call. No descendants returns []; missing Goals, cycles or incomplete/failed reads are errors, never partial success. GET only; no mutation, orientation or authorization changes. No persisted cache. Present titles, not UUIDs, to the user.",
    parameters: Type.Object({ goal_id: uuid() }, { additionalProperties: false }),
    outputSchema: Type.Array(Type.Unknown()),
    async execute(_id, params, signal) {
      const subgoals = await getSubgoalsForGoal(params.goal_id, {
        baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210",
        signal,
      });
      return { content: [{ type: "text", text: JSON.stringify(subgoals) }], details: subgoals, structuredContent: subgoals };
    },
  });
  pi.registerTool({
    name: "scryer_reorder_checklist",
    label: "Reorder Scryer checklist",
    description: "Reorder one JEPM Goal's active checklist using UUID-based relative moves. Supply goal_id and moves:[{item_id,operation:'move_before'|'move_after',anchor_id}]. Moves apply sequentially; all other items keep their relative order. Resolve UUIDs first; discuss titles with the user and clarify ambiguous matches. No indexes, titles, group operations or complete-order lists. Validates all moves before writing and reads back the final order. Returns before/intended/observed items (UUIDs and titles), confirmed_updates and http_requests. Only positions change; no content, completion, Goal orientation or authorization changes. JEPM writes are NOT atomic: failure may leave partial/unknown order; inspect the result before deciding what to do, never blindly retry. No automatic mutation retry/rollback. Requires explicit user-requested reordering.",
    parameters: Type.Object({
      goal_id: uuid(),
      moves: Type.Array(Type.Object({
        item_id: uuid(),
        operation: Type.Union([Type.Literal("move_before"), Type.Literal("move_after")]),
        anchor_id: uuid(),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await reorderChecklist(params, {
        baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210",
        actor: await startupActor(ctx),
        signal,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(result.status === "failed" ? { isError: true } : {}) };
    },
  });
}
