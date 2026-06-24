import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MAX_AUTO_CONTINUE } from "./types";
import type { TodoItem } from "./types";
import { isIncomplete } from "./validation";
import { formatTodoListText, formatRemainingList } from "./formatting";
import { getTodos, setTodos, reconstructState, updateUI, incrementAutoContinue } from "./state";

// Module-level countdown handle — prevents stacked intervals when agent_end
// fires while a previous countdown is still active (race condition guard).
let activeCountdown: ReturnType<typeof setInterval> | null = null;

// Module-level timeout handle — tracks setTimeout in no-UI fallback path
let activeTimeout: ReturnType<typeof setTimeout> | null = null;

/** Countdown duration in seconds for auto-continue. */
export const COUNTDOWN_SECONDS = 3;

/** Clear any active countdown interval, timeout, and remove the countdown widget. */
export function clearCountdown(ctx: ExtensionContext): void {
  if (activeCountdown !== null) {
    clearInterval(activeCountdown);
    activeCountdown = null;
  }
  if (activeTimeout !== null) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
  if (ctx.hasUI) {
    ctx.ui.setWidget("til-done-countdown", undefined);
  }
}

/** Check if the last assistant message was aborted (user interrupted). */
function wasAborted(messages: { role: string; stopReason?: string }[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") {
      return msg.stopReason === "aborted";
    }
  }
  return false;
}

/** Send auto-continue prompt, falling back to followUp delivery if agent is busy. */
function trySendAutoContinue(pi: ExtensionAPI, prompt: string): void {
  try {
    pi.sendUserMessage(prompt);
  } catch {
    try {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } catch {
      // Last resort — notify the user
      try {
        pi.sendMessage(
          {
            customType: "til-done-complete",
            content: "⚠ Auto-continue failed — you may need to continue manually.",
            display: true,
          },
          { triggerTurn: false },
        );
      } catch {
        // Completely silent — no way to reach the user
      }
    }
  }
}

/** Find the next incomplete todo to work on. Returns null if none found. */
function findNextIncomplete(
  todos: readonly TodoItem[],
): { indices: number[]; nextIdx: number } | null {
  const incompleteIndices: number[] = [];
  let nextInProgressIdx = -1;
  let firstNotStartedIdx = -1;

  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i];
    if (!todo || !isIncomplete(todo.status)) continue;
    incompleteIndices.push(i);
    if (todo.status === "in_progress" && nextInProgressIdx === -1) {
      nextInProgressIdx = i;
    }
    if (todo.status === "not_started" && firstNotStartedIdx === -1) {
      firstNotStartedIdx = i;
    }
  }

  if (incompleteIndices.length === 0) return null;

  const nextIdx = nextInProgressIdx !== -1 ? nextInProgressIdx : firstNotStartedIdx;
  if (nextIdx === -1) return null;
  return { indices: incompleteIndices, nextIdx };
}

/** Schedule auto-continue with countdown UI or timeout fallback. */
function scheduleAutoContinue(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
  if (ctx.hasUI) {
    if (activeCountdown !== null) {
      clearInterval(activeCountdown);
    }

    let remaining = COUNTDOWN_SECONDS;
    const interval = setInterval(() => {
      try {
        remaining--;
        if (remaining > 0) {
          ctx.ui.setWidget(
            "til-done-countdown",
            [`⏳ Auto-continuing in ${remaining}s... (type anything to interrupt)`],
            { placement: "aboveEditor" },
          );
        } else {
          clearCountdown(ctx);
          trySendAutoContinue(pi, prompt);
        }
      } catch {
        clearCountdown(ctx);
      }
    }, 1000);
    activeCountdown = interval;

    ctx.ui.setWidget(
      "til-done-countdown",
      [`⏳ Auto-continuing in ${COUNTDOWN_SECONDS}s... (type anything to interrupt)`],
      { placement: "aboveEditor" },
    );
  } else {
    if (activeTimeout !== null) {
      clearTimeout(activeTimeout);
    }
    activeTimeout = setTimeout(() => {
      activeTimeout = null;
      trySendAutoContinue(pi, prompt);
    }, COUNTDOWN_SECONDS * 1000);
  }
}

/** Handle agent_end event — auto-continue when incomplete todos remain. */
function handleAgentEnd(
  pi: ExtensionAPI,
  messages: { role: string; stopReason?: string }[],
  ctx: ExtensionContext,
): void {
  const todos = getTodos();

  if (todos.length === 0) return;
  if (wasAborted(messages)) return;

  const count = incrementAutoContinue();
  if (count > MAX_AUTO_CONTINUE) {
    pi.sendMessage(
      {
        customType: "til-done-complete",
        content: `Auto-continue limit reached (${MAX_AUTO_CONTINUE} iterations). Remaining todos were not completed. Take over manually.`,
        display: true,
      },
      { triggerTurn: false },
    );
    return;
  }

  const result = findNextIncomplete(todos);
  if (!result) return;

  const remainingList = formatRemainingList(todos, result.indices);
  const nextItem = todos[result.nextIdx];
  if (!nextItem) return;
  const nextAction = nextItem.status === "in_progress" ? "complete" : "start";

  const prompt = [
    "There are still incomplete todos. Continue working on the remaining todos.",
    "",
    "Remaining items:",
    remainingList,
    "",
    `Next action: edit_todos with action '${nextAction}' and indices [${result.nextIdx}]`,
  ].join("\n");

  scheduleAutoContinue(pi, ctx, prompt);
}

// ── Message Renderers ──

export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("til-done-context", (message, _opts, theme) => {
    return new Text(theme.fg("accent", "📋 ") + theme.fg("dim", message.content as string), 0, 0);
  });

  pi.registerMessageRenderer("til-done-complete", (message, _opts, theme) => {
    return new Text(theme.fg("success", "✓ ") + theme.fg("text", message.content as string), 0, 0);
  });

  pi.registerMessageRenderer("til-done-countdown", (message, _opts, theme) => {
    return new Text(theme.fg("accent", "⏳ ") + theme.fg("dim", message.content as string), 0, 0);
  });
}

// ── Event Handlers ──

export function registerEventHandlers(pi: ExtensionAPI): void {
  pi.on("session_start", (_, ctx) => {
    clearCountdown(ctx);
    const todos = reconstructState(ctx);
    setTodos(todos);
    updateUI(ctx, todos);
  });

  pi.on("session_tree", (_, ctx) => {
    clearCountdown(ctx);
    const todos = reconstructState(ctx);
    setTodos(todos);
    updateUI(ctx, todos);
  });

  pi.on("before_agent_start", () => {
    const todos = getTodos();
    const remaining = todos.filter((t) => isIncomplete(t.status)).length;
    if (remaining === 0) return;

    const todoList = formatTodoListText(todos);

    return {
      message: {
        customType: "til-done-context",
        content: `[TILL-DONE ACTIVE]\n\nCurrent todo list:\n${todoList}\n\n${remaining} item(s) remaining. Continue working through the list. Call edit_todos with action 'start' on the next item before working on it, then 'complete' when done.`,
        display: false,
      },
    };
  });

  pi.on("agent_end", (event, ctx) => {
    handleAgentEnd(pi, event.messages, ctx);
  });
}
