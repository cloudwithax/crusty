import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getDatabase } from "../data/db.ts";

// heartbeat customization tools
// stores actionable items in database for docker persistence
// base heartbeat instructions come from filesystem, customizations from db

const HEARTBEAT_PATH = join(import.meta.dir, "..", "cogs", "HEARTBEAT.md");

// ensure table exists
function ensureTable(): void {
  const db = getDatabase();
  if (db.type === "postgres") {
    db.exec(`
      CREATE TABLE IF NOT EXISTS heartbeat_items (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
      )
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS heartbeat_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
  }
}

// get base heartbeat content from filesystem
function getBaseContent(): string {
  if (!existsSync(HEARTBEAT_PATH)) {
    return "";
  }
  return readFileSync(HEARTBEAT_PATH, "utf-8");
}

// get all actionable items from database
export function getActionableItems(): string[] {
  ensureTable();
  const db = getDatabase();
  const rows = db
    .query<{
      content: string;
    }>("SELECT content FROM heartbeat_items ORDER BY created_at ASC")
    .all();
  return rows.map((r) => r.content);
}

// get combined heartbeat content (base + db items)
export function getFullHeartbeatContent(): string {
  const base = getBaseContent();
  const items = getActionableItems();

  if (items.length === 0) {
    return base;
  }

  // find actionable items section and inject db items
  const actionableMarker = "## Actionable Items";
  const markerIndex = base.indexOf(actionableMarker);

  if (markerIndex === -1) {
    // no section found, append at end
    return (
      base.trimEnd() + "\n\n## Actionable Items\n\n" + items.join("\n\n") + "\n"
    );
  }

  // inject items after the marker
  const beforeMarker = base.slice(0, markerIndex + actionableMarker.length);
  const afterMarker = base.slice(markerIndex + actionableMarker.length);

  // preserve any static content after marker, then add db items
  return (
    beforeMarker + afterMarker.trimEnd() + "\n\n" + items.join("\n\n") + "\n"
  );
}

const ReadHeartbeatSchema = z.object({});

async function readHeartbeat(): Promise<string> {
  try {
    return getFullHeartbeatContent();
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const AddHeartbeatItemSchema = z.object({
  content: z.string().describe("actionable item content to add"),
});

async function addHeartbeatItem(
  args: z.infer<typeof AddHeartbeatItemSchema>,
): Promise<string> {
  try {
    ensureTable();
    const db = getDatabase();
    db.run("INSERT INTO heartbeat_items (content) VALUES (?)", [args.content]);
    return "ok";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const RemoveHeartbeatItemSchema = z.object({
  id: z.coerce
    .number()
    .describe("id of the item to remove (use heartbeat_list to see ids)"),
});

async function removeHeartbeatItem(
  args: z.infer<typeof RemoveHeartbeatItemSchema>,
): Promise<string> {
  try {
    ensureTable();
    const db = getDatabase();
    db.run("DELETE FROM heartbeat_items WHERE id = ?", [args.id]);
    return "ok";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const ListHeartbeatItemsSchema = z.object({});

async function listHeartbeatItems(): Promise<string> {
  try {
    ensureTable();
    const db = getDatabase();
    const rows = db
      .query<{
        id: number;
        content: string;
        created_at: number;
      }>("SELECT id, content, created_at FROM heartbeat_items ORDER BY created_at ASC")
      .all();

    if (rows.length === 0) {
      return "no actionable items configured";
    }

    return rows
      .map((r) => {
        const date = new Date(r.created_at * 1000).toISOString().split("T")[0];
        return `[${r.id}] (${date}) ${r.content.slice(0, 100)}${r.content.length > 100 ? "..." : ""}`;
      })
      .join("\n");
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const ClearHeartbeatItemsSchema = z.object({});

async function clearHeartbeatItems(): Promise<string> {
  try {
    ensureTable();
    const db = getDatabase();
    db.run("DELETE FROM heartbeat_items");
    return "ok";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const heartbeatTools = {
  heartbeat_read: {
    description:
      "read the full heartbeat instructions including base config and actionable items",
    schema: ReadHeartbeatSchema,
    handler: readHeartbeat,
  },
  heartbeat_add: {
    description:
      "add an actionable item to the heartbeat (persisted in database)",
    schema: AddHeartbeatItemSchema,
    handler: addHeartbeatItem,
  },
  heartbeat_remove: {
    description: "remove an actionable item by id",
    schema: RemoveHeartbeatItemSchema,
    handler: removeHeartbeatItem,
  },
  heartbeat_list: {
    description: "list all actionable items with their ids",
    schema: ListHeartbeatItemsSchema,
    handler: listHeartbeatItems,
  },
  heartbeat_clear: {
    description: "remove all actionable items from the heartbeat",
    schema: ClearHeartbeatItemsSchema,
    handler: clearHeartbeatItems,
  },
};
