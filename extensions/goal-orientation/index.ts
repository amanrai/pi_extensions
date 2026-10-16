import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { goalStartupPrompt } from "./prompts.ts";
import { repositoryContext } from "./context.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("goal", {
    description: "Start a conversation about which Goal to orient to",
    type: "boolean",
    default: false,
  });

  let started = false;
  let stopped = false;
  let orientationUI: ExtensionContext["ui"] | undefined;
  function finishOrientation() {
    if (!orientationUI) return;
    // Explicitly clear even if the startup turn began before TUI event subscription.
    orientationUI.setWorkingVisible(false);
    orientationUI.setWorkingMessage();
    orientationUI.setWorkingVisible(true);
    orientationUI = undefined;
  }
  pi.on("before_provider_request", () => {
    // session_start can precede the TUI's normal turn_start listener. At this
    // boundary Pi is streaming, so this also makes the built-in loader visible.
    orientationUI?.setWorkingVisible(true);
  });
  pi.on("agent_settled", finishOrientation);
  pi.on("session_shutdown", () => { stopped = true; finishOrientation(); });
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
    if (stopped) return;
    orientationUI = ctx.ui;
    orientationUI.setWorkingMessage("Orienting…");
    orientationUI.setWorkingVisible(true);
    const repo = await repositoryContext(ctx.cwd);
    if (stopped) return;
    pi.sendMessage({
      customType: "goal-orientation-startup",
      content: goalStartupPrompt(ctx.cwd, name, repo),
      display: false,
      details: { mode: "goal", directory: ctx.cwd, identity: name },
    }, { triggerTurn: true });
  });
}
