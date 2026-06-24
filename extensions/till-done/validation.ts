import type { TodoItem, TodoStatus } from "./types";
import { VALID_STATUSES, MAX_TODO_TEXT_LENGTH } from "./types";

/**
 * Type guard: validates that `obj` is a well-formed TodoItem.
 *
 * Rejects:
 * - Non-objects or null
 * - Missing or non-string `text` / `status`
 * - Invalid status value
 * - Empty text or text exceeding MAX_TODO_TEXT_LENGTH
 */
export function isValidTodoItem(obj: unknown): obj is TodoItem {
  if (typeof obj !== "object" || obj === null) return false;
  const t = obj as Record<string, unknown>;
  if (typeof t.text !== "string") return false;
  if (!t.text || t.text.length === 0) return false;
  if (t.text.length > MAX_TODO_TEXT_LENGTH) return false;
  if (typeof t.status !== "string") return false;
  if (!VALID_STATUSES.has(t.status as TodoStatus)) return false;
  return true;
}

/** Returns true if the status represents an incomplete (actionable) item */
export function isIncomplete(status: TodoStatus): boolean {
  return status === "not_started" || status === "in_progress";
}

/** Creates a deep copy of a todo array */
export function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((t) => ({ text: t.text, status: t.status }));
}
