import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reorderChecklist } from "./order.ts";
import { getChecklistForGoal, getSubgoalsForGoal, getTopLevelGoals } from "./read.ts";

const uuid = () => Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
export default function (pi: ExtensionAPI) {
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
      // Session-header cwd is the startup folder, not whichever repo we later inspect.
      const cwd = ctx.sessionManager.getHeader()?.cwd ?? ctx.cwd;
      const record = JSON.parse(await readFile(join(cwd, ".scryer"), "utf8"));
      if (!Array.isArray(record.created_by) || record.created_by.length !== 1 || typeof record.created_by[0]?.name !== "string" || !record.created_by[0].name.trim()) {
        throw new Error("Startup .scryer must have one named created_by identity; no guessed actor or remote writes.");
      }
      const result = await reorderChecklist(params, {
        baseUrl: process.env.SCRYER_API_BASE_URL || process.env.PI_PM_API_BASE_URL || "http://smux-linode:43210",
        actor: { actor_role: "pi-agent", actor_instance_key: record.created_by[0].name },
        signal,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(result.status === "failed" ? { isError: true } : {}) };
    },
  });
}
