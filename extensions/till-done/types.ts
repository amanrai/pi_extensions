/** Status values for a todo item */
export type TodoStatus = "not_started" | "in_progress" | "completed" | "abandoned";

/** A single todo item */
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

/** Details persisted in tool result entries for state reconstruction */
export interface TodoDetails {
  action: "write" | "list" | "edit";
  todos: TodoItem[];
  error?: string;
}

// ── Constants ──

/** Maximum length of a todo item's text string */
export const MAX_TODO_TEXT_LENGTH = 1000;

/** Maximum consecutive auto-continue iterations before circuit breaker trips */
export const MAX_AUTO_CONTINUE = 20;

/** Maximum number of todos allowed */
export const MAX_TODOS = 100;

/** Maximum number of indices in a single edit_todos call */
export const MAX_INDICES = 50;

/** Initial status for newly created todo items */
export const INITIAL_STATUS: TodoStatus = "not_started";

/** Set of valid TodoStatus values for runtime validation */
export const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set<TodoStatus>([
  "not_started",
  "in_progress",
  "completed",
  "abandoned",
]);

/** Tool names that produce TodoDetails for state reconstruction */
export const TOOL_NAMES = new Set(["write_todos", "edit_todos"]);

// ── Lookup Maps (single source of truth for all mappings) ──

/** Status → plain-text icon character */
export const STATUS_ICONS: Record<TodoStatus, string> = {
  not_started: "–",
  in_progress: "●",
  completed: "✓",
  abandoned: "✗",
};

/** edit_todos action → resulting TodoStatus */
export const ACTION_TO_STATUS: Record<"start" | "complete" | "abandon", TodoStatus> = {
  start: "in_progress",
  complete: "completed",
  abandon: "abandoned",
};

/** edit_todos action → human-readable past-tense label */
export const ACTION_LABELS: Record<"start" | "complete" | "abandon", string> = {
  start: "Started",
  complete: "Completed",
  abandon: "Abandoned",
};
