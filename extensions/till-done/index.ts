/**
 * Till-Done Extension — Todo list that iterates until all tasks are complete
 *
 * Registers 3 tools: write_todos, list_todos, edit_todos
 * Todo items are ordered and identified by 0-based index.
 * Statuses: not_started (–), in_progress (●), completed (✓), abandoned (✗)
 *
 * Features:
 * - Full todo list in LLM content after every tool call
 * - Full todo list rendered in history with themed status icons
 * - Progress published via setStatus() for powerline extension to display
 * - Active items published via setStatus() for powerline extension to display
 * - Auto-continue via sendUserMessage when incomplete todos remain at agent_end
 * - Circuit breaker limits auto-continue to 20 iterations
 * - Hidden context injection via before_agent_start listing remaining todos
 * - State persisted in tool result details for proper branching support
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMessageRenderers, registerEventHandlers, clearCountdown } from "./events";
import { resetState } from "./state";
import { createWriteTodosTool, createListTodosTool, createEditTodosTool } from "./tools";

export default function (pi: ExtensionAPI): void {
  // Register message renderers
  registerMessageRenderers(pi);

  // Register event handlers
  registerEventHandlers(pi);

  // Register tools
  pi.registerTool(createWriteTodosTool());
  pi.registerTool(createListTodosTool());
  pi.registerTool(createEditTodosTool());

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, ctx) => {
    clearCountdown(ctx);
    resetState();
  });
}
