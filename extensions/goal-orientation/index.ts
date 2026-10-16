import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { goalStartupPrompt } from "./prompts.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("goal", {
    description: "Start a conversation about which Goal to orient to",
    type: "boolean",
    default: false,
  });

  let started = false;
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || started || pi.getFlag("goal") !== true) return;
    started = true;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("--goal currently requires interactive Pi", "warning");
      return;
    }
    let name: string;
    try {
      const record = JSON.parse(await readFile(join(ctx.cwd, ".scryer"), "utf8"));
      const creator = record.created_by;
      if (!Array.isArray(creator) || creator.length !== 1 ||
        typeof creator[0]?.name !== "string" || !creator[0].name.trim()) {
        throw new Error("Missing startup creator identity");
      }
      name = creator[0].name;
    } catch {
      ctx.ui.notify("Could not read the startup identity from .scryer; Goal orientation did not start", "warning");
      return;
    }
    pi.sendMessage({
      customType: "goal-orientation-startup",
      content: goalStartupPrompt(ctx.cwd, name),
      display: false,
      details: { mode: "goal", directory: ctx.cwd, identity: name },
    }, { triggerTurn: true });
  });
}
