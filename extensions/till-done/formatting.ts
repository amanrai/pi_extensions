import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TodoItem, TodoStatus, TodoDetails } from "./types";
import { STATUS_ICONS } from "./types";

// ── Plain-Text Formatting (for LLM content) ──

/** Returns the plain-text icon character for a given status */
export function getPlainIcon(status: TodoStatus): string {
  return STATUS_ICONS[status];
}

/** Formats a single todo item as plain text */
function formatItem(todo: TodoItem, index: number): string {
  return `${getPlainIcon(todo.status)} [${index}] ${todo.text}`;
}

/** Formats the full todo list as plain text for LLM consumption */
export function formatTodoListText(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "No todos";
  return todos.map((t, i) => formatItem(t, i)).join("\n");
}

/** Formats a subset of todos (by index) as plain text for remaining-item display */
export function formatRemainingList(
  todos: readonly TodoItem[],
  indices: readonly number[],
): string {
  const result: string[] = [];
  for (const i of indices) {
    const todo = todos[i];
    if (todo) result.push(formatItem(todo, i));
  }
  return result.join("\n");
}

// ── Themed Formatting (for TUI rendering) ──

/** Returns a themed (colored) icon string for a given status */
export function getStatusIcon(status: TodoStatus, theme: Theme): string {
  switch (status) {
    case "not_started":
      return theme.fg("dim", STATUS_ICONS.not_started);
    case "in_progress":
      return theme.fg("warning", STATUS_ICONS.in_progress);
    case "completed":
      return theme.fg("success", STATUS_ICONS.completed);
    case "abandoned":
      return theme.fg("error", STATUS_ICONS.abandoned);
  }
}

/** Returns a themed label for a todo item, with strikethrough for terminal statuses */
export function getTodoLabel(text: string, status: TodoStatus, theme: Theme): string {
  if (status === "completed" || status === "abandoned") {
    return theme.fg("dim", theme.strikethrough(text));
  }
  return theme.fg("text", text);
}

/** Renders the full todo list as themed text for TUI display */
export function renderTodoList(todos: readonly TodoItem[], theme: Theme): string {
  if (todos.length === 0) return theme.fg("dim", "No todos");
  return todos
    .map(
      (t, i) =>
        `${getStatusIcon(t.status, theme)} ${theme.fg("accent", `[${i}]`)} ${getTodoLabel(
          t.text,
          t.status,
          theme,
        )}`,
    )
    .join("\n");
}

// ── Tool Result Renderer ──

/** Shared renderResult for all three tools — renders themed todo list or error */
export function renderToolResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  _options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: unknown,
): Text {
  // Cast is safe — tool execute functions return TypedToolResult with TodoDetails
  const details = result.details as TodoDetails | undefined;
  if (!details) {
    const text = result.content[0]?.text ?? "";
    return new Text(text, 0, 0);
  }
  if (details.error) {
    return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
  }
  return new Text(renderTodoList(details.todos, theme), 0, 0);
}
