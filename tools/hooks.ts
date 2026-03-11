import { z } from "zod";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  discoverHooks,
  getRunningHooks,
  reloadHooks,
} from "../scheduler/hooks.ts";
import {
  saveHook,
  deleteHook as deleteHookFromDb,
  updateHookEnabled,
  getHookByName,
} from "../data/hooks.ts";
import { debug } from "../utils/debug.ts";

// hook discovery locations matching scheduler/hooks.ts
const HOOK_LOCATIONS = [
  { path: ".crusty/hooks", scope: "project" as const },
  { path: "cogs/hooks", scope: "project" as const },
  { path: ".claude/hooks", scope: "project" as const },
  {
    path: join(homedir(), ".config", "crusty", "hooks"),
    scope: "global" as const,
    absolute: true,
  },
  {
    path: join(homedir(), ".claude", "hooks"),
    scope: "global" as const,
    absolute: true,
  },
];

// primary hooks directory for creating new hooks
const PRIMARY_HOOKS_DIR = join(process.cwd(), "cogs", "hooks");

// ensure hooks directory exists
function ensureHooksDir(): void {
  if (!existsSync(PRIMARY_HOOKS_DIR)) {
    const fs = require("fs");
    fs.mkdirSync(PRIMARY_HOOKS_DIR, { recursive: true });
  }
}

// schema for creating a hook
const createHookSchema = z.object({
  name: z
    .string()
    .describe(
      "unique identifier for the hook (lowercase, no spaces, use hyphens)",
    ),
  description: z
    .string()
    .optional()
    .describe("brief description of what this hook does"),
  every: z
    .string()
    .describe(
      "how often to run: Xs (seconds), Xm (minutes), Xh (hours), Xd (days). examples: 5m, 1h, 30s",
    ),
  instructions: z
    .string()
    .describe(
      "the instructions for what the hook should do when it runs. be specific and actionable.",
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      "timezone for active hours (e.g. America/New_York). omit for always active.",
    ),
  days: z
    .string()
    .optional()
    .describe(
      "comma-separated days to run (0=Sunday, 6=Saturday). e.g. 1,2,3,4,5 for weekdays. omit for all days.",
    ),
  start: z
    .string()
    .optional()
    .describe("start time in 24h format (e.g. 09:00). omit for always active."),
  end: z
    .string()
    .optional()
    .describe("end time in 24h format (e.g. 17:00). omit for always active."),
  timeout: z
    .string()
    .optional()
    .describe(
      "timeout for the hook's AI request (e.g. '30s', '2m'). hooks that generate long content should use longer timeouts. default: env HOOK_TIMEOUT or 60s",
    ),
  storage: z
    .enum(["filesystem", "database"])
    .optional()
    .describe(
      "where to store the hook. 'filesystem' creates a markdown file, 'database' stores in db. default: database",
    ),
});

// schema for reading a hook
const readHookSchema = z.object({
  name: z.string().describe("the name/id of the hook to inspect"),
});

// schema for updating a hook
const updateHookSchema = z.object({
  name: z.string().describe("the name/id of the existing hook to update"),
  description: z
    .string()
    .optional()
    .describe("new description (omit to keep current)"),
  every: z
    .string()
    .optional()
    .describe("new interval like 5m, 1h, 30s (omit to keep current)"),
  instructions: z
    .string()
    .optional()
    .describe("new instructions content (omit to keep current)"),
  timezone: z
    .string()
    .optional()
    .describe("new timezone (omit to keep current)"),
  days: z.string().optional().describe("new days (omit to keep current)"),
  start: z
    .string()
    .optional()
    .describe("new start time in 24h format (omit to keep current)"),
  end: z
    .string()
    .optional()
    .describe("new end time in 24h format (omit to keep current)"),
  timeout: z.string().optional().describe("new timeout (omit to keep current)"),
});

// schema for removing a hook
const removeHookSchema = z.object({
  name: z.string().describe("the name/id of the hook to remove"),
});

// schema for listing hooks
const listHooksSchema = z.object({});

// schema for enabling/disabling a hook
const toggleHookSchema = z.object({
  name: z.string().describe("the name/id of the hook to enable or disable"),
  enabled: z.coerce.boolean().describe("true to enable, false to disable"),
});

// message sender reference - will be set by bot on startup
let hookMessageSender:
  | ((text: string, isHook?: boolean) => Promise<void>)
  | null = null;

// set the message sender for hook reload
export function setHookMessageSender(
  sender: (text: string, isHook?: boolean) => Promise<void>,
): void {
  hookMessageSender = sender;
}

// generate hook file content from parameters
function generateHookContent(args: {
  name: string;
  description?: string;
  every: string;
  instructions: string;
  timeout?: string;
  timezone?: string;
  days?: string;
  start?: string;
  end?: string;
}): string {
  const lines: string[] = ["---"];

  lines.push(`name: ${args.name}`);
  if (args.description) {
    lines.push(`description: ${args.description}`);
  }
  lines.push(`every: ${args.every}`);
  lines.push(`enabled: true`);
  if (args.timeout) {
    lines.push(`timeout: ${args.timeout}`);
  }

  if (args.timezone) {
    lines.push(`timezone: ${args.timezone}`);
  }
  if (args.days) {
    lines.push(`days: ${args.days}`);
  }
  if (args.start) {
    lines.push(`start: ${args.start}`);
  }
  if (args.end) {
    lines.push(`end: ${args.end}`);
  }

  lines.push("---");
  lines.push("");
  lines.push(args.instructions);

  return lines.join("\n");
}

// handler for creating a hook
async function handleCreateHook(
  args: z.infer<typeof createHookSchema>,
): Promise<string> {
  // sanitize name for id
  const safeName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!safeName) {
    return `[Error] Invalid hook name. Use lowercase letters, numbers, and hyphens.`;
  }

  // validate interval format
  const intervalMatch = args.every.match(/^(\d+)([smhd])$/);
  if (!intervalMatch) {
    return `[Error] Invalid interval format "${args.every}". Use format like: 5m, 1h, 30s, 1d`;
  }

  // check if hook already exists in any location
  const existingHooks = await discoverHooks();
  if (existingHooks.some((h) => h.id === safeName)) {
    return `[Error] A hook named "${safeName}" already exists. Remove it first or use a different name.`;
  }

  // default to database storage for new hooks
  const useDatabase = args.storage !== "filesystem";

  if (useDatabase) {
    // save to database
    try {
      const saved = await saveHook({
        name: safeName,
        description: args.description,
        content: args.instructions,
        every: args.every,
        enabled: true,
        timeout: args.timeout,
        timezone: args.timezone,
        days: args.days,
        startTime: args.start,
        endTime: args.end,
        sourceType: "wizard",
      });

      if (!saved) {
        return `[Error] Failed to save hook to database.`;
      }

      debug(`[hooks] created hook in database: ${safeName}`);

      // reload hooks to pick up the new one
      if (hookMessageSender) {
        await reloadHooks(hookMessageSender);
      }

      return `Hook "${safeName}" created successfully (stored in database). It will run every ${args.every}.${args.description ? ` Description: ${args.description}` : ""}`;
    } catch (error) {
      return `[Error] Failed to create hook: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    // filesystem storage (legacy behavior)
    ensureHooksDir();

    const filePath = join(PRIMARY_HOOKS_DIR, `${safeName}.md`);

    // check if file already exists
    if (existsSync(filePath)) {
      return `[Error] A hook file named "${safeName}.md" already exists. Remove it first or use a different name.`;
    }

    // generate and write hook file
    const content = generateHookContent({
      name: safeName,
      description: args.description,
      every: args.every,
      instructions: args.instructions,
      timeout: args.timeout,
      timezone: args.timezone,
      days: args.days,
      start: args.start,
      end: args.end,
    });

    try {
      await Bun.write(filePath, content);
      debug(`[hooks] created hook file: ${safeName}`);

      // reload hooks to pick up the new one
      if (hookMessageSender) {
        await reloadHooks(hookMessageSender);
      }

      return `Hook "${safeName}" created successfully (stored as file). It will run every ${args.every}.${args.description ? ` Description: ${args.description}` : ""}`;
    } catch (error) {
      return `[Error] Failed to create hook: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

// handler for reading a single hook's full details
async function handleReadHook(
  args: z.infer<typeof readHookSchema>,
): Promise<string> {
  const safeName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const hooks = await discoverHooks();
  const hook = hooks.find((h) => h.id === safeName);

  if (!hook) {
    return `[Error] Hook "${args.name}" not found. Use list_hooks to see available hooks.`;
  }

  const running = getRunningHooks();
  const isRunning = running.some((r) => r.id === hook.id);
  const status = isRunning
    ? "running"
    : hook.config.enabled
      ? "enabled"
      : "disabled";

  const lines: string[] = [
    `**Hook: ${hook.config.name}**`,
    "",
    `- Status: ${status}`,
    `- Interval: ${hook.config.every}`,
    `- Scope: ${hook.scope}`,
    `- Source: ${hook.sourceType}`,
  ];

  if (hook.config.description) {
    lines.push(`- Description: ${hook.config.description}`);
  }
  if (hook.config.timeout) {
    lines.push(`- Timeout: ${hook.config.timeout}`);
  }
  if (hook.config.activeHours) {
    const ah = hook.config.activeHours;
    lines.push(`- Timezone: ${ah.timezone}`);
    lines.push(`- Days: ${ah.days.join(",")}`);
    lines.push(`- Active: ${ah.start} - ${ah.end}`);
  }

  lines.push("", "**Instructions:**", "", hook.content);

  return lines.join("\n");
}

// handler for updating an existing hook
async function handleUpdateHook(
  args: z.infer<typeof updateHookSchema>,
): Promise<string> {
  const safeName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // validate interval format if provided
  if (args.every) {
    const intervalMatch = args.every.match(/^(\d+)([smhd])$/);
    if (!intervalMatch) {
      return `[Error] Invalid interval format "${args.every}". Use format like: 5m, 1h, 30s, 1d`;
    }
  }

  // check database first
  const dbHook = await getHookByName(safeName);
  if (dbHook) {
    try {
      await saveHook({
        name: safeName,
        description: args.description ?? dbHook.description ?? undefined,
        content: args.instructions ?? dbHook.content,
        every: args.every ?? dbHook.every,
        enabled: dbHook.enabled === 1,
        timeout: args.timeout ?? dbHook.timeout ?? undefined,
        timezone: args.timezone ?? dbHook.timezone ?? undefined,
        days: args.days ?? dbHook.days ?? undefined,
        startTime: args.start ?? dbHook.start_time ?? undefined,
        endTime: args.end ?? dbHook.end_time ?? undefined,
        sourceType: dbHook.source_type,
        sourceUrl: dbHook.source_url ?? undefined,
      });

      debug(`[hooks] updated db hook: ${safeName}`);

      if (hookMessageSender) {
        await reloadHooks(hookMessageSender);
      }

      return `Hook "${safeName}" updated successfully.`;
    } catch (error) {
      return `[Error] Failed to update hook: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // check filesystem
  const filePath = findHookFile(args.name);
  if (!filePath) {
    return `[Error] Hook "${args.name}" not found in filesystem or database.`;
  }

  try {
    const content = await Bun.file(filePath).text();
    let updated = content;

    // update frontmatter fields
    if (args.description !== undefined) {
      if (updated.match(/^description:\s*.+$/m)) {
        updated = updated.replace(
          /^description:\s*.+$/m,
          `description: ${args.description}`,
        );
      } else {
        // add after name line
        updated = updated.replace(
          /^(name:\s*.+)$/m,
          `$1\ndescription: ${args.description}`,
        );
      }
    }

    if (args.every) {
      updated = updated.replace(/^every:\s*.+$/m, `every: ${args.every}`);
    }

    if (args.timeout !== undefined) {
      if (updated.match(/^timeout:\s*.+$/m)) {
        updated = updated.replace(
          /^timeout:\s*.+$/m,
          `timeout: ${args.timeout}`,
        );
      } else {
        updated = updated.replace(
          /^(every:\s*.+)$/m,
          `$1\ntimeout: ${args.timeout}`,
        );
      }
    }

    if (args.timezone !== undefined) {
      if (updated.match(/^timezone:\s*.+$/m)) {
        updated = updated.replace(
          /^timezone:\s*.+$/m,
          `timezone: ${args.timezone}`,
        );
      } else {
        updated = updated.replace(
          /^---\n/,
          `---\ntimezone: ${args.timezone}\n`,
        );
      }
    }

    if (args.days !== undefined) {
      if (updated.match(/^days:\s*.+$/m)) {
        updated = updated.replace(/^days:\s*.+$/m, `days: ${args.days}`);
      } else {
        updated = updated.replace(/^---\n/, `---\ndays: ${args.days}\n`);
      }
    }

    if (args.start !== undefined) {
      if (updated.match(/^start:\s*.+$/m)) {
        updated = updated.replace(/^start:\s*.+$/m, `start: ${args.start}`);
      } else {
        updated = updated.replace(/^---\n/, `---\nstart: ${args.start}\n`);
      }
    }

    if (args.end !== undefined) {
      if (updated.match(/^end:\s*.+$/m)) {
        updated = updated.replace(/^end:\s*.+$/m, `end: ${args.end}`);
      } else {
        updated = updated.replace(/^---\n/, `---\nend: ${args.end}\n`);
      }
    }

    // update instructions (body content after frontmatter)
    if (args.instructions) {
      const parts = updated.split("---");
      if (parts.length >= 3) {
        updated = `---${parts[1]}---\n\n${args.instructions}`;
      }
    }

    await Bun.write(filePath, updated);
    debug(`[hooks] updated hook file: ${filePath}`);

    if (hookMessageSender) {
      await reloadHooks(hookMessageSender);
    }

    return `Hook "${args.name}" updated successfully.`;
  } catch (error) {
    return `[Error] Failed to update hook: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// find a hook file across all locations
function findHookFile(name: string): string | null {
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  for (const location of HOOK_LOCATIONS) {
    const dirPath = location.absolute
      ? location.path
      : join(process.cwd(), location.path);

    // try sanitized name
    const filePath = join(dirPath, `${safeName}.md`);
    if (existsSync(filePath)) {
      return filePath;
    }

    // try original name as fallback
    const exactPath = join(dirPath, `${name}.md`);
    if (existsSync(exactPath)) {
      return exactPath;
    }
  }

  return null;
}

// handler for removing a hook
async function handleRemoveHook(
  args: z.infer<typeof removeHookSchema>,
): Promise<string> {
  const safeName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // check if hook exists in database
  const dbHook = await getHookByName(safeName);
  if (dbHook) {
    try {
      await deleteHookFromDb(safeName);
      debug(`[hooks] removed hook from database: ${safeName}`);

      if (hookMessageSender) {
        await reloadHooks(hookMessageSender);
      }

      return `Hook "${safeName}" has been removed from the database.`;
    } catch (error) {
      return `[Error] Failed to remove hook: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // check filesystem locations
  const filePath = findHookFile(args.name);

  if (!filePath) {
    return `[Error] Hook "${args.name}" not found in filesystem or database.`;
  }

  try {
    unlinkSync(filePath);
    debug(`[hooks] removed hook file: ${filePath}`);

    if (hookMessageSender) {
      await reloadHooks(hookMessageSender);
    }

    return `Hook "${args.name}" has been removed.`;
  } catch (error) {
    return `[Error] Failed to remove hook: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// handler for listing hooks
async function handleListHooks(): Promise<string> {
  const hooks = await discoverHooks();
  const running = getRunningHooks();
  const runningIds = new Set(running.map((r) => r.id));

  if (hooks.length === 0) {
    return "No hooks configured. Use create_hook to add one.";
  }

  const lines: string[] = ["**Configured Hooks:**", ""];

  // group by source type
  const filesystemHooks = hooks.filter((h) => h.sourceType === "filesystem");
  const dbHooks = hooks.filter((h) => h.sourceType !== "filesystem");

  if (filesystemHooks.length > 0) {
    lines.push("*Filesystem:*");
    for (const hook of filesystemHooks) {
      const isRunning = runningIds.has(hook.id);
      const status = isRunning
        ? "running"
        : hook.config.enabled
          ? "enabled"
          : "disabled";
      const scope = hook.scope === "global" ? " (global)" : "";
      lines.push(
        `- **${hook.config.name}** (${hook.config.every}) - ${status}${scope}`,
      );
      if (hook.config.description) {
        lines.push(`  ${hook.config.description}`);
      }
    }
    lines.push("");
  }

  if (dbHooks.length > 0) {
    lines.push("*Database:*");
    for (const hook of dbHooks) {
      const isRunning = runningIds.has(hook.id);
      const status = isRunning
        ? "running"
        : hook.config.enabled
          ? "enabled"
          : "disabled";
      const sourceLabel =
        hook.sourceType === "wizard"
          ? " (created)"
          : hook.sourceType === "url"
            ? " (url)"
            : hook.sourceType === "imported"
              ? " (imported)"
              : "";
      lines.push(
        `- **${hook.config.name}** (${hook.config.every}) - ${status}${sourceLabel}`,
      );
      if (hook.config.description) {
        lines.push(`  ${hook.config.description}`);
      }
    }
  }

  return lines.join("\n");
}

// handler for toggling hook enabled state
async function handleToggleHook(
  args: z.infer<typeof toggleHookSchema>,
): Promise<string> {
  const safeName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // check if hook exists in database
  const dbHook = await getHookByName(safeName);
  if (dbHook) {
    try {
      await updateHookEnabled(safeName, args.enabled);
      debug(
        `[hooks] ${args.enabled ? "enabled" : "disabled"} db hook: ${safeName}`,
      );

      if (hookMessageSender) {
        await reloadHooks(hookMessageSender);
      }

      return `Hook "${safeName}" has been ${args.enabled ? "enabled" : "disabled"}.`;
    } catch (error) {
      return `[Error] Failed to update hook: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // check filesystem locations
  const filePath = findHookFile(args.name);

  if (!filePath) {
    return `[Error] Hook "${args.name}" not found.`;
  }

  try {
    const content = await Bun.file(filePath).text();

    // update the enabled field in frontmatter
    const updatedContent = content.replace(
      /^enabled:\s*(true|false)\s*$/m,
      `enabled: ${args.enabled}`,
    );

    // if no enabled field found, add it after the first ---
    if (updatedContent === content && !content.includes("enabled:")) {
      const parts = content.split("---");
      if (parts.length >= 3 && parts[1]) {
        parts[1] = parts[1].trimEnd() + `\nenabled: ${args.enabled}\n`;
        await Bun.write(filePath, parts.join("---"));
      }
    } else {
      await Bun.write(filePath, updatedContent);
    }

    debug(
      `[hooks] ${args.enabled ? "enabled" : "disabled"} hook: ${args.name}`,
    );

    if (hookMessageSender) {
      await reloadHooks(hookMessageSender);
    }

    return `Hook "${args.name}" has been ${args.enabled ? "enabled" : "disabled"}.`;
  } catch (error) {
    return `[Error] Failed to update hook: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// export tool definitions
export const hookTools = {
  create_hook: {
    description: `Create a new scheduled hook that runs automatically at a defined interval. Use this when a task would benefit from recurring automated checks or actions.

WHEN TO CREATE A HOOK:
- User asks for recurring reminders (e.g., "remind me every hour to stretch")
- User wants periodic checks (e.g., "check the weather every morning")
- User needs scheduled monitoring (e.g., "alert me if site goes down")
- Any task that should happen repeatedly on a schedule

PARAMETERS:
- name (required): Unique identifier, lowercase with hyphens (e.g., "morning-weather")
- every (required): Interval like "5m", "1h", "30s", "1d"
- instructions (required): What the hook should do when it runs
- description (optional): Brief summary of the hook's purpose
- timezone (optional): e.g., "America/New_York" for time-restricted hooks
- days (optional): "1,2,3,4,5" for weekdays, "0,6" for weekends
- start/end (optional): Active hours like "09:00" to "17:00"

The hook will be created and start running immediately.`,
    schema: createHookSchema,
    handler: handleCreateHook,
  },

  remove_hook: {
    description: `Remove/delete a scheduled hook. Use when a hook is no longer needed.

PARAMETERS:
- name (required): The name/id of the hook to remove`,
    schema: removeHookSchema,
    handler: handleRemoveHook,
  },

  list_hooks: {
    description: `List all configured hooks and their status. Shows which hooks exist, their intervals, and whether they're running.`,
    schema: listHooksSchema,
    handler: handleListHooks,
  },

  toggle_hook: {
    description: `Enable or disable a hook without deleting it. Disabled hooks won't run but can be re-enabled later.

PARAMETERS:
- name (required): The name/id of the hook
- enabled (required): true to enable, false to disable`,
    schema: toggleHookSchema,
    handler: handleToggleHook,
  },

  read_hook: {
    description: `Read the full details and instructions of a specific hook. Shows status, interval, active hours, and the complete instructions content.

PARAMETERS:
- name (required): The name/id of the hook to inspect`,
    schema: readHookSchema,
    handler: handleReadHook,
  },

  update_hook: {
    description: `Update an existing hook's configuration or instructions. Only the fields you provide will be changed; omitted fields keep their current values.

WHEN TO USE:
- User wants to change how often a hook runs
- User wants to modify what a hook does
- User wants to adjust active hours or timezone

PARAMETERS:
- name (required): The hook to update
- every (optional): New interval like "5m", "1h"
- instructions (optional): New instructions content
- description (optional): New description
- timezone/days/start/end (optional): New active hours config
- timeout (optional): New timeout for the hook's AI request`,
    schema: updateHookSchema,
    handler: handleUpdateHook,
  },
};
