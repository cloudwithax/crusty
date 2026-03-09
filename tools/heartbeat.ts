import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getDatabase, getAsyncDatabase } from "../data/db.ts";
import {
  getHeartbeatConfig,
  saveHeartbeatConfig,
  deleteHeartbeatConfig,
} from "../data/heartbeat-config.ts";

// heartbeat customization tools
// stores actionable items in database for docker persistence
// base heartbeat instructions come from filesystem, customizations from db

const HEARTBEAT_PATH = join(import.meta.dir, "..", "cogs", "HEARTBEAT.md");

// ensure table exists
async function ensureTableAsync(): Promise<void> {
  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    await asyncDb.run(`
      CREATE TABLE IF NOT EXISTS heartbeat_items (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
      )
    `);
  } else {
    const db = getDatabase();
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
async function getBaseContent(): Promise<string> {
  if (!existsSync(HEARTBEAT_PATH)) {
    return "";
  }
  return readFileSync(HEARTBEAT_PATH, "utf-8");
}

// get all actionable items from database
export async function getActionableItems(): Promise<string[]> {
  await ensureTableAsync();
  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    const rows = await asyncDb.all<{ content: string }>(
      "SELECT content FROM heartbeat_items ORDER BY created_at ASC"
    );
    return rows.map((r) => r.content);
  } else {
    const db = getDatabase();
    const rows = db
      .query<{ content: string }>(
        "SELECT content FROM heartbeat_items ORDER BY created_at ASC"
      )
      .all();
    return rows.map((r) => r.content);
  }
}

// get combined heartbeat content (base + db items)
export async function getFullHeartbeatContent(): Promise<string> {
  const base = await getBaseContent();
  const items = await getActionableItems();

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
    return await getFullHeartbeatContent();
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
    await ensureTableAsync();
    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      await asyncDb.run("INSERT INTO heartbeat_items (content) VALUES ($1)", [args.content]);
    } else {
      const db = getDatabase();
      db.run("INSERT INTO heartbeat_items (content) VALUES (?)", [args.content]);
    }
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
    await ensureTableAsync();
    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      await asyncDb.run("DELETE FROM heartbeat_items WHERE id = $1", [args.id]);
    } else {
      const db = getDatabase();
      db.run("DELETE FROM heartbeat_items WHERE id = ?", [args.id]);
    }
    return "ok";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const ListHeartbeatItemsSchema = z.object({});

async function listHeartbeatItems(): Promise<string> {
  try {
    await ensureTableAsync();
    const asyncDb = getAsyncDatabase();
    let rows: { id: number; content: string; created_at: number }[];
    if (asyncDb) {
      rows = await asyncDb.all<{
          id: number;
          content: string;
          created_at: number;
        }>("SELECT id, content, created_at FROM heartbeat_items ORDER BY created_at ASC");
    } else {
      const db = getDatabase();
      rows = db
        .query<{
          id: number;
          content: string;
          created_at: number;
        }>("SELECT id, content, created_at FROM heartbeat_items ORDER BY created_at ASC")
        .all();
    }

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
    await ensureTableAsync();
    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      await asyncDb.run("DELETE FROM heartbeat_items");
    } else {
      const db = getDatabase();
      db.run("DELETE FROM heartbeat_items");
    }
    return "ok";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// heartbeat scheduler reference - set by bot on startup for runtime restarts
let heartbeatRestartFn: (() => Promise<void>) | null = null;

export function setHeartbeatRestartFn(
  fn: () => Promise<void>,
): void {
  heartbeatRestartFn = fn;
}

// schema and handler for reading heartbeat config
const ReadHeartbeatConfigSchema = z.object({});

async function readHeartbeatConfig(): Promise<string> {
  try {
    const dbConfig = await getHeartbeatConfig();

    // show env defaults for reference
    const envEvery = process.env.HEARTBEAT_EVERY || "30m";
    const envTimezone = process.env.HEARTBEAT_TIMEZONE || "not set";
    const envDays = process.env.HEARTBEAT_DAYS || "not set";
    const envStart = process.env.HEARTBEAT_START || "not set";
    const envEnd = process.env.HEARTBEAT_END || "not set";

    const lines: string[] = ["**Heartbeat Configuration:**", ""];

    if (dbConfig) {
      lines.push("*Active (database override):*");
      lines.push(`- Interval: ${dbConfig.every}`);
      lines.push(`- Timezone: ${dbConfig.timezone || "not set"}`);
      lines.push(`- Days: ${dbConfig.days || "all"}`);
      lines.push(`- Start: ${dbConfig.start_time || "00:00"}`);
      lines.push(`- End: ${dbConfig.end_time || "23:59"}`);
      lines.push("");
      lines.push("*Environment defaults (overridden):*");
    } else {
      lines.push("*Active (from environment):*");
    }

    lines.push(`- HEARTBEAT_EVERY: ${envEvery}`);
    lines.push(`- HEARTBEAT_TIMEZONE: ${envTimezone}`);
    lines.push(`- HEARTBEAT_DAYS: ${envDays}`);
    lines.push(`- HEARTBEAT_START: ${envStart}`);
    lines.push(`- HEARTBEAT_END: ${envEnd}`);

    return lines.join("\n");
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// schema and handler for updating heartbeat config
const UpdateHeartbeatConfigSchema = z.object({
  every: z
    .string()
    .optional()
    .describe("new interval like 5m, 1h, 30m (omit to keep current)"),
  timezone: z
    .string()
    .optional()
    .describe("timezone for active hours (e.g. America/New_York)"),
  days: z
    .string()
    .optional()
    .describe("comma-separated days (0=Sunday, 6=Saturday). e.g. 1,2,3,4,5"),
  start: z
    .string()
    .optional()
    .describe("start time in 24h format (e.g. 09:00)"),
  end: z
    .string()
    .optional()
    .describe("end time in 24h format (e.g. 17:00)"),
});

async function updateHeartbeatConfig(
  args: z.infer<typeof UpdateHeartbeatConfigSchema>,
): Promise<string> {
  try {
    // validate interval format if provided
    if (args.every) {
      const match = args.every.match(/^(\d+)([smhd])$/);
      if (!match) {
        return `[Error] Invalid interval format "${args.every}". Use format like: 5m, 1h, 30s, 1d`;
      }
    }

    const saved = await saveHeartbeatConfig({
      every: args.every,
      timezone: args.timezone,
      days: args.days,
      startTime: args.start,
      endTime: args.end,
    });

    if (!saved) {
      return "[Error] Failed to save heartbeat config.";
    }

    // restart heartbeat with new config if restart function is available
    if (heartbeatRestartFn) {
      await heartbeatRestartFn();
    }

    const parts: string[] = ["Heartbeat config updated."];
    if (args.every) parts.push(`Interval: ${args.every}`);
    if (args.timezone) parts.push(`Timezone: ${args.timezone}`);
    if (args.days) parts.push(`Days: ${args.days}`);
    if (args.start) parts.push(`Start: ${args.start}`);
    if (args.end) parts.push(`End: ${args.end}`);

    return parts.join(" ");
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// schema and handler for resetting heartbeat config to env defaults
const ResetHeartbeatConfigSchema = z.object({});

async function resetHeartbeatConfig(): Promise<string> {
  try {
    const deleted = await deleteHeartbeatConfig();
    if (!deleted) {
      return "[Error] Failed to reset heartbeat config.";
    }

    // restart heartbeat with env defaults
    if (heartbeatRestartFn) {
      await heartbeatRestartFn();
    }

    return "Heartbeat config reset to environment defaults.";
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
  heartbeat_get_config: {
    description:
      "read the current heartbeat configuration including interval, active hours, and whether a database override is active",
    schema: ReadHeartbeatConfigSchema,
    handler: readHeartbeatConfig,
  },
  heartbeat_update_config: {
    description: `Update the heartbeat scheduler configuration at runtime. Changes are persisted to the database and take effect immediately by restarting the scheduler.

WHEN TO USE:
- User wants to change how often the heartbeat runs
- User wants to restrict heartbeat to certain hours or days
- User wants to change the heartbeat timezone

PARAMETERS:
- every (optional): New interval like "5m", "1h", "30m"
- timezone (optional): e.g. "America/New_York"
- days (optional): "1,2,3,4,5" for weekdays
- start/end (optional): Active hours like "09:00" to "17:00"`,
    schema: UpdateHeartbeatConfigSchema,
    handler: updateHeartbeatConfig,
  },
  heartbeat_reset_config: {
    description:
      "reset heartbeat config to environment variable defaults, removing any database overrides",
    schema: ResetHeartbeatConfigSchema,
    handler: resetHeartbeatConfig,
  },
};
