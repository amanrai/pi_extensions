import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reorderChecklist } from "./order.ts";

const uuid = () => Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
export default function (pi: ExtensionAPI) {
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
