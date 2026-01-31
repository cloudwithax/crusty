import { z } from "zod";
import { existsSync, unlinkSync, readdirSync } from "fs";
import { join, basename } from "path";
import {
  discoverHooks,
  getRunningHooks,
  reloadHooks,
  type Hook,
} from "../scheduler/hooks.ts";
import { debug } from "../utils/debug.ts";

// paths
const HOOKS_DIR = join(process.cwd(), "cogs", "hooks");

// ensure hooks directory exists
function ensureHooksDir(): void {
  if (!existsSync(HOOKS_DIR)) {
    const fs = require("fs");
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
  }
}

// schema for creating a hook
const createHookSchema = z.object({
  name: z.string().describe("unique identifier for the hook (lowercase, no spaces, use hyphens)"),
  description: z.string().optional().describe("brief description of what this hook does"),
  every: z.string().describe("how often to run: Xs (seconds), Xm (minutes), Xh (hours), Xd (days). examples: 5m, 1h, 30s"),
  instructions: z.string().describe("the instructions for what the hook should do when it runs. be specific and actionable."),
  timezone: z.string().optional().describe("timezone for active hours (e.g. America/New_York). omit for always active."),
  days: z.string().optional().describe("comma-separated days to run (0=Sunday, 6=Saturday). e.g. 1,2,3,4,5 for weekdays. omit for all days."),
  start: z.string().optional().describe("start time in 24h format (e.g. 09:00). omit for always active."),
  end: z.string().optional().describe("end time in 24h format (e.g. 17:00). omit for always active."),
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
  enabled: z.boolean().describe("true to enable, false to disable"),
});

// message sender reference - will be set by bot on startup
let hookMessageSender: ((text: string, isHook?: boolean) => Promise<void>) | null = null;

// set the message sender for hook reload
export function setHookMessageSender(sender: (text: string, isHook?: boolean) => Promise<void>): void {
  hookMessageSender = sender;
}

// generate hook file content from parameters
function generateHookContent(args: {
  name: string;
  description?: string;
  every: string;
  instructions: string;
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
async function handleCreateHook(args: z.infer<typeof createHookSchema>): Promise<string> {
  ensureHooksDir();
  
  // sanitize name for filename
  const safeName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  
  if (!safeName) {
    return `[Error] Invalid hook name. Use lowercase letters, numbers, and hyphens.`;
  }
  
  const filePath = join(HOOKS_DIR, `${safeName}.md`);
  
  // check if hook already exists
  if (existsSync(filePath)) {
    return `[Error] A hook named "${safeName}" already exists. Remove it first or use a different name.`;
  }
  
  // validate interval format
  const intervalMatch = args.every.match(/^(\d+)([smhd])$/);
  if (!intervalMatch) {
    return `[Error] Invalid interval format "${args.every}". Use format like: 5m, 1h, 30s, 1d`;
  }
  
  // generate and write hook file
  const content = generateHookContent({
    name: safeName,
    description: args.description,
    every: args.every,
    instructions: args.instructions,
    timezone: args.timezone,
    days: args.days,
    start: args.start,
    end: args.end,
  });
  
  try {
    await Bun.write(filePath, content);
    debug(`[hooks] created hook: ${safeName}`);
    
    // reload hooks to pick up the new one
    if (hookMessageSender) {
      await reloadHooks(hookMessageSender);
    }
    
    return `Hook "${safeName}" created successfully. It will run every ${args.every}.${args.description ? ` Description: ${args.description}` : ""}`;
  } catch (error) {
    return `[Error] Failed to create hook: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// handler for removing a hook
async function handleRemoveHook(args: z.infer<typeof removeHookSchema>): Promise<string> {
  const safeName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  
  const filePath = join(HOOKS_DIR, `${safeName}.md`);
  
  if (!existsSync(filePath)) {
    // try exact name as fallback
    const exactPath = join(HOOKS_DIR, `${args.name}.md`);
    if (existsSync(exactPath)) {
      try {
        unlinkSync(exactPath);
        debug(`[hooks] removed hook: ${args.name}`);
        
        if (hookMessageSender) {
          await reloadHooks(hookMessageSender);
        }
        
        return `Hook "${args.name}" has been removed.`;
      } catch (error) {
        return `[Error] Failed to remove hook: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return `[Error] Hook "${args.name}" not found.`;
  }
  
  try {
    unlinkSync(filePath);
    debug(`[hooks] removed hook: ${safeName}`);
    
    if (hookMessageSender) {
      await reloadHooks(hookMessageSender);
    }
    
    return `Hook "${safeName}" has been removed.`;
  } catch (error) {
    return `[Error] Failed to remove hook: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// handler for listing hooks
async function handleListHooks(): Promise<string> {
  if (!existsSync(HOOKS_DIR)) {
    return "No hooks directory found. No hooks are configured.";
  }
  
  const files = readdirSync(HOOKS_DIR).filter(f => f.endsWith(".md") && f !== "EXAMPLE.md");
  
  if (files.length === 0) {
    return "No hooks configured. Use create_hook to add one.";
  }
  
  const hooks = discoverHooks();
  const running = getRunningHooks();
  const runningIds = new Set(running.map(r => r.id));
  
  const lines: string[] = ["**Configured Hooks:**", ""];
  
  for (const file of files) {
    const id = basename(file, ".md").toLowerCase();
    const hook = hooks.find(h => h.id === id);
    const isRunning = runningIds.has(id);
    
    if (hook) {
      const status = isRunning ? "running" : (hook.config.enabled ? "enabled" : "disabled");
      lines.push(`- **${hook.config.name}** (${hook.config.every}) - ${status}`);
      if (hook.config.description) {
        lines.push(`  ${hook.config.description}`);
      }
    } else {
      lines.push(`- **${id}** - not loaded (check file for errors)`);
    }
  }
  
  return lines.join("\n");
}

// handler for toggling hook enabled state
async function handleToggleHook(args: z.infer<typeof toggleHookSchema>): Promise<string> {
  const safeName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  
  let filePath = join(HOOKS_DIR, `${safeName}.md`);
  
  if (!existsSync(filePath)) {
    filePath = join(HOOKS_DIR, `${args.name}.md`);
    if (!existsSync(filePath)) {
      return `[Error] Hook "${args.name}" not found.`;
    }
  }
  
  try {
    const content = await Bun.file(filePath).text();
    
    // update the enabled field in frontmatter
    const updatedContent = content.replace(
      /^enabled:\s*(true|false)\s*$/m,
      `enabled: ${args.enabled}`
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
    
    debug(`[hooks] ${args.enabled ? "enabled" : "disabled"} hook: ${args.name}`);
    
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
};
