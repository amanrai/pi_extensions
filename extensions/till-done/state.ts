import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoItem, TodoStatus } from "./types";
import { TOOL_NAMES } from "./types";
import { isValidTodoItem } from "./validation";

// ── Mutable State ──

let todos: TodoItem[] = [];
let autoContinueCount = 0;

function resetAutoContinue(): void {
  autoContinueCount = 0;
}

// ── State Accessors ──

/** Returns a readonly reference to the current todos */
export function getTodos(): readonly TodoItem[] {
  return todos;
}

/** Replaces the entire todo list. Resets auto-continue counter. */
export function setTodos(newTodos: TodoItem[]): void {
  todos = newTodos;
  resetAutoContinue();
}

/** Updates the status of specific todo items by index. Resets auto-continue counter. */
export function updateTodoStatus(indices: readonly number[], newStatus: TodoStatus): void {
  for (const idx of indices) {
    const item = todos[idx];
    if (!item) continue;
    todos[idx] = { ...item, status: newStatus };
  }
  resetAutoContinue();
}

/** Appends new todo items to the existing list. Resets auto-continue counter. */
export function appendTodos(newItems: readonly TodoItem[]): void {
  todos = [...todos, ...newItems];
  resetAutoContinue();
}

/** Inserts new todo items at a specific index. Resets auto-continue counter. */
export function insertTodos(atIndex: number, newItems: readonly TodoItem[]): void {
  todos = [...todos.slice(0, atIndex), ...newItems, ...todos.slice(atIndex)];
  resetAutoContinue();
}

/** Increments and returns the auto-continue counter */
export function incrementAutoContinue(): number {
  return ++autoContinueCount;
}

/** Resets all mutable state. For testing only. */
export function resetState(): void {
  todos = [];
  autoContinueCount = 0;
}

// ── State Reconstruction ──

function hasTodoDetails(d: unknown): d is { todos: unknown[] } {
  return typeof d === "object" && d !== null && "todos" in d && Array.isArray(d.todos);
}

/**
 * Reconstructs todo state from session history.
 * Scans the branch in reverse to find the last tool result from this extension.
 * Filters entries through isValidTodoItem for safety.
 */
export function reconstructState(ctx: ExtensionContext): TodoItem[] {
  const branch = ctx.sessionManager.getBranch();

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult") continue;
    if (!TOOL_NAMES.has(msg.toolName)) continue;

    if (!hasTodoDetails(msg.details)) continue;
    const rawTodos: unknown[] = msg.details.todos;
    if (rawTodos.length > 0) {
      return rawTodos.reduce<TodoItem[]>((acc, t) => {
        if (isValidTodoItem(t)) acc.push({ text: t.text, status: t.status });
        return acc;
      }, []);
    }
  }

  return [];
}

// ── UI Sync ──

/** Updates the status bar and active-items display to reflect current state */
export function updateUI(ctx: ExtensionContext, todoList: readonly TodoItem[]): void {
  if (!ctx.hasUI) return;

  if (todoList.length === 0) {
    ctx.ui.setStatus("til-done", undefined);
    ctx.ui.setStatus("til-done-active", undefined);
    return;
  }

  const total = todoList.length;
  let done = 0;
  const activeLines: string[] = [];

  for (let i = 0; i < total; i++) {
    const item = todoList[i];
    if (!item) continue;
    if (item.status === "completed" || item.status === "abandoned") {
      done++;
    }
    if (item.status === "in_progress") {
      activeLines.push(`[${i}] ${item.text}`);
    }
  }

  // All completed — show done state
  if (done === total) {
    ctx.ui.setStatus("til-done", `✓ Done (${total} items)`);
    ctx.ui.setStatus("til-done-active", undefined);
    return;
  }

  ctx.ui.setStatus("til-done", `📋 ${done}/${total}`);
  ctx.ui.setStatus("til-done-active", activeLines.length > 0 ? activeLines.join("\n") : undefined);
}
