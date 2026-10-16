import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { goalStartupPrompt } from "./prompts.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("goal", {
    description: "Start a conversation about which Goal to orient to",
    type: "boolean",
    default: false,
  });

  let started = false;
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || started || pi.getFlag("goal") !== true) return;
    started = true;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("--goal currently requires interactive Pi", "warning");
      return;
    }
    pi.sendMessage({
      customType: "goal-orientation-startup",
      content: goalStartupPrompt(ctx.cwd),
      display: false,
      details: { mode: "goal", directory: ctx.cwd },
    }, { triggerTurn: true });
  });
}
