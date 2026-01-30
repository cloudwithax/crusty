import { z } from "zod";
import { getDatabase, getAsyncDatabase } from "../data/db";
import { debug } from "../utils/debug.ts";

const CreateTodoSchema = z.object({
  title: z.string().describe("Title of the todo list"),
  items: z
    .array(
      z.object({
        task: z.string().describe("The task description"),
        priority: z.enum(["high", "medium", "low"]).describe("Priority level"),
        estimatedEffort: z.string().optional().describe("Estimated time/effort (e.g., '30 min', '2 hours')"),
      })
    )
    .describe("List of todo items"),
});

const UpdateTodoSchema = z.object({
  todoId: z.string().describe("ID of the todo list to update"),
  items: z
    .array(
      z.object({
        task: z.string().describe("The task description"),
        priority: z.enum(["high", "medium", "low"]).describe("Priority level"),
        estimatedEffort: z.string().optional().describe("Estimated time/effort"),
        completed: z.boolean().describe("Whether this item is completed"),
      })
    )
    .describe("Updated list of todo items"),
});

const MarkCompleteSchema = z.object({
  todoId: z.string().describe("ID of the todo list"),
  itemIndex: z.number().describe("Index of the item to mark complete"),
});

interface TodoItem {
  task: string;
  priority: "high" | "medium" | "low";
  estimatedEffort?: string;
  completed: boolean;
}

interface TodoList {
  id: string;
  title: string;
  items: TodoItem[];
  createdAt: Date;
  updatedAt: Date;
}

function generateTodoId(): string {
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function getTodoWithItems(todoId: string, userId: number): Promise<TodoList | null> {
  const asyncDb = getAsyncDatabase();

  if (asyncDb) {
    const todoRow = await asyncDb.get<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
    }>(
      "SELECT id, title, created_at, updated_at FROM todos WHERE id = $1 AND user_id = $2",
      todoId,
      userId
    );

    if (!todoRow) return null;

    const itemRows = await asyncDb.all<{
      task: string;
      priority: string;
      estimated_effort: string | null;
      completed: number;
    }>(
      "SELECT task, priority, estimated_effort, completed FROM todo_items WHERE todo_id = $1 ORDER BY item_order",
      todoId
    );

    return {
      id: todoRow.id,
      title: todoRow.title,
      items: itemRows.map((row) => ({
        task: row.task,
        priority: row.priority as "high" | "medium" | "low",
        estimatedEffort: row.estimated_effort ?? undefined,
        completed: row.completed === 1,
      })),
      createdAt: new Date(todoRow.created_at * 1000),
      updatedAt: new Date(todoRow.updated_at * 1000),
    };
  }

  const db = getDatabase();
  const todoRow = db
    .query<{ id: string; title: string; created_at: number; updated_at: number }>(
      "SELECT id, title, created_at, updated_at FROM todos WHERE id = ? AND user_id = ?"
    )
    .get(todoId, userId);

  if (!todoRow) return null;

  const itemRows = db
    .query<{ task: string; priority: string; estimated_effort: string | null; completed: number }>(
      "SELECT task, priority, estimated_effort, completed FROM todo_items WHERE todo_id = ? ORDER BY item_order"
    )
    .all(todoId);

  return {
    id: todoRow.id,
    title: todoRow.title,
    items: itemRows.map((row) => ({
      task: row.task,
      priority: row.priority as "high" | "medium" | "low",
      estimatedEffort: row.estimated_effort ?? undefined,
      completed: row.completed === 1,
    })),
    createdAt: new Date(todoRow.created_at * 1000),
    updatedAt: new Date(todoRow.updated_at * 1000),
  };
}

function formatTodoList(todo: TodoList): string {
  const items = todo.items
    .map((item, index) => {
      const status = item.completed ? "done" : "o";
      const priority = item.priority === "high" ? "[!]" : item.priority === "medium" ? "[~]" : "[-]";
      const effort = item.estimatedEffort ? ` (${item.estimatedEffort})` : "";
      return `${status} ${index + 1}. ${priority} ${item.task}${effort}`;
    })
    .join("\n");

  const completedCount = todo.items.filter((i) => i.completed).length;
  const progress = todo.items.length > 0 ? `\n\nProgress: ${completedCount}/${todo.items.length} completed` : "";

  return `*${todo.title}*\n\n${items}${progress}`;
}

export const todoTools = {
  todo_create: {
    description:
      "Create a structured todo list for multi-step tasks, projects, or complex workflows. Use when the user mentions multiple actions, sequences, deadlines, or objectives that need organization.",
    schema: CreateTodoSchema,
    handler: async (args: z.infer<typeof CreateTodoSchema>, userId: number) => {
      const asyncDb = getAsyncDatabase();
      const todoId = generateTodoId();
      const now = Math.floor(Date.now() / 1000);

      if (asyncDb) {
        await asyncDb.run(
          "INSERT INTO todos (id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
          [todoId, userId, args.title, now, now]
        );

        for (let i = 0; i < args.items.length; i++) {
          const item = args.items[i]!;
          await asyncDb.run(
            "INSERT INTO todo_items (todo_id, task, priority, estimated_effort, completed, item_order) VALUES ($1, $2, $3, $4, 0, $5)",
            [todoId, item.task, item.priority, item.estimatedEffort ?? null, i]
          );
        }
      } else {
        const db = getDatabase();
        db.run("INSERT INTO todos (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
          todoId,
          userId,
          args.title,
          now,
          now,
        ]);

        for (let i = 0; i < args.items.length; i++) {
          const item = args.items[i]!;
          db.run(
            "INSERT INTO todo_items (todo_id, task, priority, estimated_effort, completed, item_order) VALUES (?, ?, ?, ?, 0, ?)",
            [todoId, item.task, item.priority, item.estimatedEffort ?? null, i]
          );
        }
      }

      const todo = await getTodoWithItems(todoId, userId);
      return `Created todo list:\n\n${formatTodoList(todo!)}\n\nTodo ID: \`${todoId}\``;
    },
  },

  todo_update: {
    description: "Update an existing todo list by replacing all its items. Use this when the user wants to add new tasks, remove tasks, reorder tasks, or modify task details. You need the todo ID (from todo_list or todo_create) and the complete new list of items.",
    schema: UpdateTodoSchema,
    handler: async (args: z.infer<typeof UpdateTodoSchema>, userId: number) => {
      const existing = await getTodoWithItems(args.todoId, userId);
      if (!existing) {
        return `Todo list not found: ${args.todoId}`;
      }

      const asyncDb = getAsyncDatabase();
      if (asyncDb) {
        await asyncDb.run("DELETE FROM todo_items WHERE todo_id = $1", [args.todoId]);

        for (let i = 0; i < args.items.length; i++) {
          const item = args.items[i]!;
          await asyncDb.run(
            "INSERT INTO todo_items (todo_id, task, priority, estimated_effort, completed, item_order) VALUES ($1, $2, $3, $4, $5, $6)",
            [args.todoId, item.task, item.priority, item.estimatedEffort ?? null, item.completed ? 1 : 0, i]
          );
        }

        await asyncDb.run("UPDATE todos SET updated_at = $1 WHERE id = $2", [
          Math.floor(Date.now() / 1000),
          args.todoId,
        ]);
      } else {
        const db = getDatabase();
        db.run("DELETE FROM todo_items WHERE todo_id = ?", [args.todoId]);

        for (let i = 0; i < args.items.length; i++) {
          const item = args.items[i]!;
          db.run(
            "INSERT INTO todo_items (todo_id, task, priority, estimated_effort, completed, item_order) VALUES (?, ?, ?, ?, ?, ?)",
            [args.todoId, item.task, item.priority, item.estimatedEffort ?? null, item.completed ? 1 : 0, i]
          );
        }

        db.run("UPDATE todos SET updated_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000), args.todoId]);
      }

      const todo = await getTodoWithItems(args.todoId, userId);
      return `Updated todo list:\n\n${formatTodoList(todo!)}`;
    },
  },

  todo_list: {
    description: "Show all todo lists the user has created. Use this when the user asks to see their todos, check what tasks they have, or when you need to find a todo ID for other operations. Returns list titles, progress, and IDs.",
    schema: z.object({}),
    handler: async (_args: unknown, userId: number) => {
      const asyncDb = getAsyncDatabase();

      if (asyncDb) {
        const todos = await asyncDb.all<{ id: string; title: string }>(
          "SELECT id, title FROM todos WHERE user_id = $1",
          userId
        );

        if (todos.length === 0) {
          return "No todo lists found. Create one with todo_create!";
        }

        const lists: string[] = [];
        for (const t of todos) {
          const items = await asyncDb.all<{ completed: number }>(
            "SELECT completed FROM todo_items WHERE todo_id = $1",
            t.id
          );
          const completedCount = items.filter((i) => i.completed === 1).length;
          lists.push(`- ${t.title} (${completedCount}/${items.length}) - \`${t.id}\``);
        }

        return `Your todo lists:\n\n${lists.join("\n")}`;
      }

      const db = getDatabase();
      const todos = db
        .query<{ id: string; title: string }>("SELECT id, title FROM todos WHERE user_id = ?")
        .all(userId);

      if (todos.length === 0) {
        return "No todo lists found. Create one with todo_create!";
      }

      const lists = todos
        .map((t) => {
          const items = db
            .query<{ completed: number }>("SELECT completed FROM todo_items WHERE todo_id = ?")
            .all(t.id);
          const completedCount = items.filter((i) => i.completed === 1).length;
          return `- ${t.title} (${completedCount}/${items.length}) - \`${t.id}\``;
        })
        .join("\n");

      return `Your todo lists:\n\n${lists}`;
    },
  },

  todo_show: {
    description: "Display the full details of a specific todo list including all items, their priorities, completion status, and progress. Use this when the user asks about a specific list or when you need to see the current state before making updates.",
    schema: z.object({
      todoId: z.string().describe("ID of the todo list to show"),
    }),
    handler: async (args: { todoId: string }, userId: number) => {
      const todo = await getTodoWithItems(args.todoId, userId);

      if (!todo) {
        return `Todo list not found: ${args.todoId}`;
      }

      return formatTodoList(todo);
    },
  },

  todo_complete: {
    description: "Mark a single task as done/completed in a todo list. Use this when the user says they finished a task, completed something, or wants to check off an item. Requires the todo ID and the item index (1-based, so first item is index 0).",
    schema: MarkCompleteSchema,
    handler: async (args: z.infer<typeof MarkCompleteSchema>, userId: number) => {
      const todo = await getTodoWithItems(args.todoId, userId);

      if (!todo) {
        return `Todo list not found: ${args.todoId}`;
      }

      if (args.itemIndex < 0 || args.itemIndex >= todo.items.length) {
        return `Invalid item index. This list has ${todo.items.length} items.`;
      }

      const item = todo.items[args.itemIndex];
      if (!item) {
        return `Could not find item at index ${args.itemIndex}`;
      }

      const asyncDb = getAsyncDatabase();
      if (asyncDb) {
        await asyncDb.run("UPDATE todo_items SET completed = 1 WHERE todo_id = $1 AND item_order = $2", [
          args.todoId,
          args.itemIndex,
        ]);
        await asyncDb.run("UPDATE todos SET updated_at = $1 WHERE id = $2", [
          Math.floor(Date.now() / 1000),
          args.todoId,
        ]);
      } else {
        const db = getDatabase();
        db.run("UPDATE todo_items SET completed = 1 WHERE todo_id = ? AND item_order = ?", [
          args.todoId,
          args.itemIndex,
        ]);
        db.run("UPDATE todos SET updated_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000), args.todoId]);
      }

      const updated = await getTodoWithItems(args.todoId, userId);
      return `done: "${item.task}"\n\n${formatTodoList(updated!)}`;
    },
  },

  todo_delete: {
    description: "Permanently delete a todo list and all its items. Use this when the user wants to remove, clear, or get rid of an entire todo list. This action cannot be undone.",
    schema: z.object({
      todoId: z.string().describe("ID of the todo list to delete"),
    }),
    handler: async (args: { todoId: string }, userId: number) => {
      const existing = await getTodoWithItems(args.todoId, userId);
      if (!existing) {
        return `Todo list not found: ${args.todoId}`;
      }

      const asyncDb = getAsyncDatabase();
      if (asyncDb) {
        await asyncDb.run("DELETE FROM todos WHERE id = $1 AND user_id = $2", [args.todoId, userId]);
      } else {
        const db = getDatabase();
        db.run("DELETE FROM todos WHERE id = ? AND user_id = ?", [args.todoId, userId]);
      }
      return `done: deleted todo list`;
    },
  },
};

// cleanup function
export async function cleanupTodos(): Promise<void> {
  // nothing to clean up since db handles persistence
  debug("[todo] cleanup called (no-op for sqlite)");
}

export type TodoTools = typeof todoTools;
