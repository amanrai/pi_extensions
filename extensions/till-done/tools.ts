import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoItem, TodoDetails } from "./types";
import {
  ACTION_TO_STATUS,
  ACTION_LABELS,
  INITIAL_STATUS,
  MAX_INDICES,
  MAX_TODO_TEXT_LENGTH,
  MAX_TODOS,
} from "./types";
import { cloneTodos } from "./validation";
import { formatTodoListText, renderToolResult } from "./formatting";
import { getTodos, setTodos, appendTodos, insertTodos, updateTodoStatus, updateUI } from "./state";

// ── Schemas ──

const WriteTodosParams = Type.Object({
  mode: StringEnum(["replace", "append", "insert"] as const, {
    description:
      "Mode: 'replace' clears and replaces the entire list, 'append' adds to the end, 'insert' inserts at a specific index",
  }),
  index: Type.Optional(
    Type.Integer({
      description: "0-based index to insert at (required for 'insert' mode)",
    }),
  ),
  todos: Type.Array(
    Type.Object({
      text: Type.String({ description: "Description of the task", maxLength: 1000 }),
    }),
    { description: "Ordered list of todo items", maxItems: 100 },
  ),
});

const ListTodosParams = Type.Object({});

const EditTodosParams = Type.Object({
  action: StringEnum(["start", "complete", "abandon"] as const, {
    description: "Action to apply to the todo items",
  }),
  indices: Type.Array(Type.Integer({ minimum: 0 }), {
    description: "0-based indices to apply the action to",
    minItems: 1,
    maxItems: MAX_INDICES,
  }),
});

// ── Helpers ──

function makeErrorResult(
  action: "write" | "edit",
  errorText: string,
  errorCode: string,
): { content: Array<{ type: "text"; text: string }>; details: TodoDetails } {
  return {
    content: [{ type: "text" as const, text: errorText }],
    details: { action, todos: [], error: errorCode },
  };
}

function toNewItems(items: readonly { text: string }[]): TodoItem[] {
  return items.map((t) => ({ text: t.text, status: INITIAL_STATUS }));
}

type WriteResult = { content: Array<{ type: "text"; text: string }>; details: TodoDetails };

function writeSuccessResult(ctx: ExtensionContext, message: string): WriteResult {
  updateUI(ctx, getTodos());
  return {
    content: [{ type: "text" as const, text: message + "\n\n" + formatTodoListText(getTodos()) }],
    details: { action: "write" as const, todos: cloneTodos(getTodos()) },
  };
}

/** Handle insert mode for write_todos execute. */
function handleInsertMode(
  params: { index?: number; todos: { text: string }[] },
  currentTodos: readonly TodoItem[],
  ctx: ExtensionContext,
): { content: Array<{ type: "text"; text: string }>; details: TodoDetails } {
  // Validate index parameter
  if (params.index === undefined) {
    return makeErrorResult(
      "write",
      "Error: 'index' is required for the 'insert' mode",
      "index required for insert",
    );
  }

  // Validate index range (0 to length inclusive)
  if (params.index < 0 || params.index > currentTodos.length) {
    return makeErrorResult(
      "write",
      `Error: index ${params.index} out of range (0 to ${currentTodos.length})`,
      `index ${params.index} out of range (0 to ${currentTodos.length})`,
    );
  }

  // Check total count
  if (currentTodos.length + params.todos.length > MAX_TODOS) {
    return makeErrorResult(
      "write",
      `Error: inserting ${params.todos.length} item(s) would exceed maximum of ${MAX_TODOS} todos (currently ${currentTodos.length})`,
      "max todos exceeded",
    );
  }

  const newItems: TodoItem[] = toNewItems(params.todos);
  insertTodos(params.index, newItems);

  return writeSuccessResult(ctx, `Inserted ${newItems.length} item(s) at index ${params.index}`);
}

// ── Tool Factories ──

export function createWriteTodosTool(): ToolDefinition<typeof WriteTodosParams, TodoDetails> {
  return {
    name: "write_todos",
    label: "Write Todos",
    description:
      "Manage a todo list with modes: 'replace' clears and replaces the entire list, 'append' adds items to the end without changing existing item statuses, 'insert' inserts items at a specific index without changing existing item statuses. Each new item starts as 'not_started'.",
    parameters: WriteTodosParams,
    promptSnippet:
      "Manage a todo list: write (replace/append/insert), list, edit (start/complete/abandon by indices)",
    promptGuidelines: [
      "Use write_todos with mode 'replace' to create or replace the full todo list at the start of a task.",
      "Use write_todos with mode 'append' to add new items to the end of the existing list.",
      "Use write_todos with mode 'insert' and an 'index' parameter to insert items at a specific position.",
      "Use edit_todos with action 'start' and an array of 0-based indices to begin work on specific items.",
      "Use edit_todos with action 'complete' and an array of 0-based indices to mark items as done.",
      "Use edit_todos with action 'abandon' and an array of 0-based indices when items are no longer needed.",
      "Use list_todos to review the current todo list.",
      "Always call edit_todos with action 'start' on the next item before working on it, then 'complete' when done.",
    ],

    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Defense-in-depth text length check
      const oversizedIdx = params.todos.findIndex((t) => t.text.length > MAX_TODO_TEXT_LENGTH);
      if (oversizedIdx >= 0) {
        return makeErrorResult(
          "write",
          `Item ${oversizedIdx + 1} text exceeds ${MAX_TODO_TEXT_LENGTH} characters.`,
          "text too long",
        );
      }

      const currentTodos = getTodos();

      if (params.mode === "replace") {
        const newTodos = toNewItems(params.todos);
        setTodos(newTodos);

        return writeSuccessResult(ctx, `Wrote ${newTodos.length} todo item(s)`);
      }

      if (params.mode === "append") {
        if (currentTodos.length + params.todos.length > MAX_TODOS) {
          return makeErrorResult(
            "write",
            `Error: appending ${params.todos.length} item(s) would exceed maximum of ${MAX_TODOS} todos (currently ${currentTodos.length})`,
            "max todos exceeded",
          );
        }

        const newItems: TodoItem[] = toNewItems(params.todos);
        appendTodos(newItems);

        return writeSuccessResult(ctx, `Appended ${newItems.length} item(s)`);
      }

      // Mode is narrowed to "insert" after replace/append branches
      return handleInsertMode(params, currentTodos, ctx);
    },

    renderCall(args, theme) {
      const modeLabel = args.mode;
      const count = args.todos.length;
      let extra = "";
      if (modeLabel === "insert" && args.index !== undefined) {
        extra = ` @${args.index}`;
      }
      return new Text(
        theme.fg("toolTitle", theme.bold("write_todos ")) +
          theme.fg("warning", `${modeLabel} `) +
          theme.fg("muted", `(${count} items${extra})`),
        0,
        0,
      );
    },

    renderResult: renderToolResult,
  };
}

export function createListTodosTool(): ToolDefinition<typeof ListTodosParams, TodoDetails> {
  return {
    name: "list_todos",
    label: "List Todos",
    description: "List all todos with their current status and 0-based indices.",
    parameters: ListTodosParams,

    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text" as const, text: formatTodoListText(getTodos()) }],
        details: { action: "list" as const, todos: [] },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("list_todos")), 0, 0);
    },

    renderResult: renderToolResult,
  };
}

export function createEditTodosTool(): ToolDefinition<typeof EditTodosParams, TodoDetails> {
  return {
    name: "edit_todos",
    label: "Edit Todos",
    description:
      "Apply an action ('start', 'complete', or 'abandon') to todo items by 0-based index. Batch operations are atomic — if any index is invalid, no changes are applied.",
    parameters: EditTodosParams,

    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const currentTodos = getTodos();

      if (currentTodos.length === 0) {
        return makeErrorResult("edit", "Error: no todos exist", "no todos exist");
      }

      // Deduplicate and validate all indices atomically
      const uniqueIndices = [...new Set(params.indices)];
      const invalid = uniqueIndices.filter((i) => i < 0 || i >= currentTodos.length);
      if (invalid.length > 0) {
        return makeErrorResult(
          "edit",
          `Error: indices [${invalid.join(", ")}] out of range (0 to ${currentTodos.length - 1})`,
          `indices [${invalid.join(", ")}] out of range (0 to ${currentTodos.length - 1})`,
        );
      }

      const newStatus = ACTION_TO_STATUS[params.action];
      updateTodoStatus(uniqueIndices, newStatus);
      updateUI(ctx, getTodos());

      const actionLabel = ACTION_LABELS[params.action];

      return {
        content: [
          {
            type: "text" as const,
            text: `${actionLabel} [${uniqueIndices.join(", ")}]\n\n${formatTodoListText(getTodos())}`,
          },
        ],
        details: { action: "edit" as const, todos: cloneTodos(getTodos()) },
      };
    },

    renderCall(args, theme) {
      const indices = `[${args.indices.join(", ")}]`;
      return new Text(
        theme.fg("toolTitle", theme.bold("edit_todos ")) +
          theme.fg("warning", `${args.action} `) +
          theme.fg("accent", indices),
        0,
        0,
      );
    },

    renderResult: renderToolResult,
  };
}
