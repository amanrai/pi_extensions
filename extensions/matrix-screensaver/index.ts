import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease } from "@earendil-works/pi-tui";
import { IdleMatrix } from "./idle.ts";

const WIDGET = "matrix-screensaver-controller";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let controller: IdleMatrix | undefined;
  let unsubscribe: (() => void) | undefined;
  let enabled = false;
  let widgetInstalled = false;
  let agentBusy = false;
  let promptOpen = false;

  function disable() {
    enabled = false;
    controller?.stop();
    controller = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    if (widgetInstalled && context) {
      widgetInstalled = false;
      context.ui.setWidget(WIDGET, undefined);
    }
  }

  function activity() { controller?.activity(); }

  function enable(ctx: ExtensionContext) {
    if (enabled) { activity(); return; }
    enabled = true;
    widgetInstalled = true;
    // This zero-row widget obtains Pi's existing TUI through the supported widget
    // factory. A directly owned overlay avoids marking idle animation as a blocking
    // UI prompt, and its handle can safely close without popping another dialog.
    ctx.ui.setWidget(WIDGET, (tui) => {
      const instance = new IdleMatrix(tui, () => context === ctx && enabled && !agentBusy && !promptOpen &&
        ctx.isIdle() && !ctx.hasPendingMessages() && !ctx.ui.getEditorText(), (error: any) => {
          disable();
          ctx.ui.notify(`Matrix screensaver disabled: ${error?.message ?? String(error)}`, "warning");
        });
      controller = instance;
      return { render: () => [], invalidate() {}, dispose: () => instance.stop() };
    }, { placement: "belowEditor" });
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      // Let Pi process terminal capability/cell-size replies and focus reports.
      // They are not wake-up keystrokes (important for remote PTY frontends too).
      if (/^\x1b\[(?:[0-9;]+t|[?>]?[0-9;]*c|[IO])$/.test(data) ||
        /^\x1b\][\s\S]*(?:\x07|\x1b\\)$/.test(data)) return undefined;
      if (isKeyRelease(data)) return controller?.active ? { consume: true } : undefined;
      return controller?.input() ? { consume: true } : undefined;
    });
  }

  pi.registerCommand("matrix", {
    description: "Matrix idle screensaver (default off). Usage: /matrix on | off | status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "status";
      if (command === "off") {
        disable();
        ctx.ui.notify("Matrix screensaver disabled", "info");
      } else if (command === "on") {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("Matrix screensaver requires interactive Pi", "warning");
          return;
        }
        try {
          enable(context ?? ctx);
          ctx.ui.notify("Matrix screensaver enabled: 60 seconds of complete inactivity; any key wakes it", "info");
        } catch (error: any) {
          disable();
          ctx.ui.notify(`Matrix screensaver could not start: ${error?.message ?? String(error)}`, "error");
        }
      } else if (command === "status") {
        ctx.ui.notify(`Matrix screensaver ${enabled ? "enabled (60s idle)" : "disabled"}; /matrix on | off`, "info");
      } else ctx.ui.notify("Usage: /matrix on | off | status", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    disable();
    context = ctx;
    agentBusy = false;
    promptOpen = false;
    // No timers, widget, input listener, or persisted opt-in until /matrix on.
  });
  pi.on("session_shutdown", () => { disable(); context = undefined; });
  pi.on("agent_start", () => { agentBusy = true; activity(); });
  pi.on("agent_settled", () => { agentBusy = false; activity(); });
  pi.on("ui_prompt_start", () => { promptOpen = true; activity(); });
  pi.on("ui_prompt_end", () => { promptOpen = false; activity(); });
  pi.on("input", () => { activity(); return { action: "continue" as const }; });
  pi.on("message_start", activity);
  pi.on("message_update", activity);
  pi.on("message_end", activity);
  pi.on("before_provider_request", activity);
  pi.on("after_provider_response", activity);
  pi.on("tool_call", activity);
  pi.on("tool_result", activity);
  pi.on("tool_execution_start", activity);
  pi.on("tool_execution_update", activity);
  pi.on("tool_execution_end", activity);
  pi.on("user_bash", activity);
  pi.on("session_before_compact", activity);
  pi.on("session_compact", activity);
  pi.on("session_compact_failed", activity);
  pi.on("session_before_tree", activity);
  pi.on("session_tree", activity);
}
