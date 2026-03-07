import {
  existsSync,
  readdirSync,
  readFileSync,
  appendFileSync,
  statSync,
} from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { debug } from "../utils/debug.ts";
import {
  loadAllHooks as loadAllHooksFromDb,
  type HookRecord,
  type HookSourceType,
} from "../data/hooks.ts";
import { Agent } from "../core/agent.ts";

// hook configuration parsed from frontmatter
export interface HookConfig {
  name: string;
  description?: string;
  every: string; // duration string like "30m", "1h", "5m"
  enabled: boolean;
  timeout?: string; // duration string for per-hook timeout (e.g. "30s", "2m")
  activeHours?: {
    timezone: string;
    days: number[]; // 0 = Sunday, 1 = Monday, etc.
    start: string; // HH:MM format
    end: string; // HH:MM format
  };
}

// hook definition with file path and parsed config
export interface Hook {
  id: string;
  filePath: string;
  config: HookConfig;
  content: string; // the markdown content after frontmatter
  intervalMs: number;
  timeoutMs: number; // per-hook timeout for AI requests (falls back to DEFAULT_HOOK_TIMEOUT_MS)
  scope: "project" | "global";
  sourceType: HookSourceType;
}

// hook discovery locations in priority order (project takes precedence)
const HOOK_LOCATIONS = [
  // project-local locations
  { path: ".crusty/hooks", scope: "project" as const },
  { path: "cogs/hooks", scope: "project" as const },
  { path: ".claude/hooks", scope: "project" as const },
  // global locations
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

// re-export the source type
export type { HookSourceType } from "../data/hooks.ts";

interface HookRuntime {
  hook: Hook;
  timer: Timer | null;
  lastRun: Date | null;
}

// legacy path for backwards compatibility
const LEGACY_HOOKS_DIR = join(process.cwd(), "cogs", "hooks");
const HOOKS_LOG_PATH = join(process.cwd(), "hooks.log");

// default hook timeout: 60s (configurable via HOOK_TIMEOUT env var, e.g. "60s", "2m")
// individual hooks can override this with a `timeout` field in their config
const DEFAULT_HOOK_TIMEOUT_MS =
  parseHookDuration(process.env.HOOK_TIMEOUT || "60s") || 60 * 1000;

// parse duration string to milliseconds
// supports: Xm (minutes), Xh (hours), Xd (days), Xs (seconds)
function parseHookDuration(duration: string): number {
  const trimmed = duration.trim().toLowerCase();

  if (
    trimmed === "0m" ||
    trimmed === "0h" ||
    trimmed === "0d" ||
    trimmed === "0s" ||
    trimmed === "0"
  ) {
    return 0;
  }

  const match = trimmed.match(/^(\d+)([smhd])$/);
  if (!match) {
    debug(`[hooks] invalid duration format: ${duration}, disabling`);
    return 0;
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2];

  if (value <= 0) {
    return 0;
  }

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

// parse time string (HH:MM) to minutes since midnight
function parseTime(timeStr: string): number {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid time format: ${timeStr}, expected HH:MM`);
  }
  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  return hours * 60 + minutes;
}

// get day of week in a specific timezone
function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const parts = formatter.formatToParts(date);
  const year = parseInt(parts.find((p) => p.type === "year")?.value || "0", 10);
  const month = parseInt(
    parts.find((p) => p.type === "month")?.value || "0",
    10,
  );
  const day = parseInt(parts.find((p) => p.type === "day")?.value || "0", 10);

  const targetDate = new Date(Date.UTC(year, month - 1, day));
  return targetDate.getUTCDay();
}

// check if current time is within active hours for a hook
function isWithinHookActiveHours(
  activeHours: HookConfig["activeHours"],
): boolean {
  if (!activeHours) {
    return true; // no restrictions
  }

  try {
    const now = new Date();

    const timeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: activeHours.timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });

    const timeParts = timeFormatter.formatToParts(now);
    const hour = parseInt(
      timeParts.find((p) => p.type === "hour")?.value || "0",
      10,
    );
    const minute = parseInt(
      timeParts.find((p) => p.type === "minute")?.value || "0",
      10,
    );

    const dayOfWeek = getDayOfWeekInTimezone(now, activeHours.timezone);

    if (!activeHours.days.includes(dayOfWeek)) {
      return false;
    }

    const currentMinutes = hour * 60 + minute;
    const startMinutes = parseTime(activeHours.start);
    const endMinutes = parseTime(activeHours.end);

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
      // overnight range
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
  } catch (error) {
    console.error("[hooks] error checking active hours:", error);
    return true; // fail open
  }
}

// parse yaml-like frontmatter from markdown content
// expects format:
// ---
// name: my-hook
// every: 30m
// enabled: true
// ---
function parseFrontmatter(content: string): {
  config: Partial<HookConfig>;
  body: string;
} {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { config: {}, body: content };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { config: {}, body: content };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const body = lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();

  const config: Partial<HookConfig> = {};

  for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    switch (key) {
      case "name":
        config.name = value;
        break;
      case "description":
        config.description = value;
        break;
      case "every":
        config.every = value;
        break;
      case "enabled":
        config.enabled = value.toLowerCase() === "true";
        break;
      case "timeout":
        config.timeout = value;
        break;
      case "timezone":
        if (!config.activeHours) {
          config.activeHours = {
            timezone: value,
            days: [0, 1, 2, 3, 4, 5, 6],
            start: "00:00",
            end: "23:59",
          };
        } else {
          config.activeHours.timezone = value;
        }
        break;
      case "days":
        // parse comma-separated list of day numbers
        const days = value
          .split(",")
          .map((d) => parseInt(d.trim(), 10))
          .filter((d) => !isNaN(d));
        if (!config.activeHours) {
          config.activeHours = {
            timezone: "UTC",
            days,
            start: "00:00",
            end: "23:59",
          };
        } else {
          config.activeHours.days = days;
        }
        break;
      case "start":
        if (!config.activeHours) {
          config.activeHours = {
            timezone: "UTC",
            days: [0, 1, 2, 3, 4, 5, 6],
            start: value,
            end: "23:59",
          };
        } else {
          config.activeHours.start = value;
        }
        break;
      case "end":
        if (!config.activeHours) {
          config.activeHours = {
            timezone: "UTC",
            days: [0, 1, 2, 3, 4, 5, 6],
            start: "00:00",
            end: value,
          };
        } else {
          config.activeHours.end = value;
        }
        break;
    }
  }

  return { config, body };
}

// load a single hook from a markdown file
function loadHook(
  filePath: string,
  scope: "project" | "global" = "project",
): Hook | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { config, body } = parseFrontmatter(content);

    // validate required fields
    if (!config.every) {
      debug(`[hooks] skipping ${filePath}: missing 'every' field`);
      return null;
    }

    const intervalMs = parseHookDuration(config.every);
    if (intervalMs === 0) {
      debug(`[hooks] skipping ${filePath}: interval is 0 or invalid`);
      return null;
    }

    // generate id from filename
    const id = basename(filePath, ".md")
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-");

    const hook: Hook = {
      id,
      filePath,
      config: {
        name: config.name || id,
        description: config.description,
        every: config.every,
        enabled: config.enabled !== false, // default to true
        timeout: config.timeout,
        activeHours: config.activeHours,
      },
      content: body,
      intervalMs,
      timeoutMs: config.timeout
        ? parseHookDuration(config.timeout) || DEFAULT_HOOK_TIMEOUT_MS
        : DEFAULT_HOOK_TIMEOUT_MS,
      scope,
      sourceType: "filesystem",
    };

    return hook;
  } catch (error) {
    console.error(`[hooks] failed to load hook from ${filePath}:`, error);
    return null;
  }
}

// discover all hooks from filesystem locations
function discoverFilesystemHooks(): Hook[] {
  const hooks: Hook[] = [];
  const seenIds = new Set<string>();

  for (const location of HOOK_LOCATIONS) {
    const dirPath = location.absolute
      ? location.path
      : join(process.cwd(), location.path);

    if (!existsSync(dirPath)) {
      continue;
    }

    try {
      const stat = statSync(dirPath);
      if (!stat.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const files = readdirSync(dirPath);

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      if (file.toUpperCase() === "EXAMPLE.MD") continue;

      const filePath = join(dirPath, file);
      const hook = loadHook(filePath, location.scope);

      // skip if already found (project takes precedence over global)
      if (hook && hook.config.enabled && !seenIds.has(hook.id)) {
        hooks.push(hook);
        seenIds.add(hook.id);
      }
    }
  }

  return hooks;
}

// convert database record to hook object
function hookRecordToHook(record: HookRecord): Hook | null {
  const intervalMs = parseHookDuration(record.every);
  if (intervalMs === 0) {
    debug(`[hooks] skipping db hook ${record.name}: interval is 0 or invalid`);
    return null;
  }

  let activeHours: HookConfig["activeHours"] | undefined;
  if (record.timezone || record.days || record.start_time || record.end_time) {
    const days = record.days
      ? record.days
          .split(",")
          .map((d) => parseInt(d.trim(), 10))
          .filter((d) => !isNaN(d))
      : [0, 1, 2, 3, 4, 5, 6];

    activeHours = {
      timezone: record.timezone || "UTC",
      days,
      start: record.start_time || "00:00",
      end: record.end_time || "23:59",
    };
  }

  const timeoutStr = record.timeout || undefined;

  return {
    id: record.name,
    filePath: `db:${record.name}`, // virtual path for database hooks
    config: {
      name: record.name,
      description: record.description || undefined,
      every: record.every,
      enabled: record.enabled === 1,
      timeout: timeoutStr,
      activeHours,
    },
    content: record.content,
    intervalMs,
    timeoutMs: timeoutStr
      ? parseHookDuration(timeoutStr) || DEFAULT_HOOK_TIMEOUT_MS
      : DEFAULT_HOOK_TIMEOUT_MS,
    scope: "project", // db hooks are always project-scoped
    sourceType: record.source_type,
  };
}

// discover all hooks from both filesystem and database
export async function discoverHooks(): Promise<Hook[]> {
  const filesystemHooks = discoverFilesystemHooks();
  const seenIds = new Set(filesystemHooks.map((h) => h.id));

  // load hooks from database (only add if not already found in filesystem)
  let dbHooks: Hook[] = [];
  try {
    const records = await loadAllHooksFromDb();
    dbHooks = records
      .filter((r) => r.enabled === 1)
      .map(hookRecordToHook)
      .filter((h): h is Hook => h !== null && !seenIds.has(h.id));
  } catch (error) {
    debug("[hooks] error loading hooks from database:", error);
  }

  const allHooks = [...filesystemHooks, ...dbHooks];
  debug(
    `[hooks] discovered ${allHooks.length} enabled hooks (${filesystemHooks.length} filesystem, ${dbHooks.length} database)`,
  );

  return allHooks;
}

// write audit log entry
function writeHookLog(hookId: string, entry: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${hookId}] ${entry}\n`;

  try {
    appendFileSync(HOOKS_LOG_PATH, logLine);
  } catch (error) {
    console.error("[hooks] failed to write log:", error);
  }
}

// one agent per hook id, persistent across ticks so context accumulates
const hookAgents: Map<string, Agent> = new Map();

function getHookAgent(hookId: string): Agent {
  let agent = hookAgents.get(hookId);
  if (!agent) {
    // use a negative user id range to avoid collisions with real users
    // hooks start at -1000 to distinguish from heartbeat (userId 0) and real users (positive)
    const userId = -(1000 + hookAgents.size + 1);
    agent = new Agent(userId);
    hookAgents.set(hookId, agent);
  }
  return agent;
}

// execute a single hook using the full agent loop so hooks have access to all tools
async function executeHook(
  hook: Hook,
  sendMessage: (text: string, isHook?: boolean) => Promise<void>,
): Promise<void> {
  // check active hours
  if (!isWithinHookActiveHours(hook.config.activeHours)) {
    debug(`[hooks] ${hook.id}: outside active hours, skipping`);
    return;
  }

  if (!hook.content.trim()) {
    debug(`[hooks] ${hook.id}: no content, skipping`);
    return;
  }

  debug(`[hooks] ${hook.id}: executing...`);

  try {
    const agent = getHookAgent(hook.id);

    // build the prompt that gives the agent its hook context and instructions
    const prompt = `You are running as an automated hook: "${hook.config.name}".
${hook.config.description ? `Hook description: ${hook.config.description}` : ""}

Current time: ${new Date().toISOString()}

Your instructions for this run:
${hook.content}

If no action is needed right now, respond with exactly: HOOK_OK
Otherwise, carry out the instructions. You have access to all tools including send_message to proactively notify the user.`;

    const output = await agent.chat(prompt);

    debug(`[hooks] ${hook.id}: output: ${output.substring(0, 100)}`);

    if (output.trim() === "HOOK_OK" || output.trim().toUpperCase() === "HOOK_OK") {
      writeHookLog(hook.id, "HOOK_OK - no action needed");
      debug(`[hooks] ${hook.id}: HOOK_OK - suppressed delivery`);
      // clear memory after a no-op tick to avoid unbounded context growth
      agent.clearMemory();
      return;
    }

    // deliver the agent's response to the user unless it used send_message itself
    const formattedOutput = `**[${hook.config.name}]**\n${output}`;
    await sendMessage(formattedOutput, true);
    writeHookLog(
      hook.id,
      `DELIVERED: ${output.substring(0, 100)}${output.length > 100 ? "..." : ""}`,
    );
    debug(`[hooks] ${hook.id}: delivered message`);

    // clear memory after each active tick to keep hooks stateless between runs
    agent.clearMemory();
  } catch (error) {
    console.error(`[hooks] ${hook.id}: error during execution:`, error);
    writeHookLog(
      hook.id,
      `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// hook scheduler state
const hookRuntimes: Map<string, HookRuntime> = new Map();
let isRunning = false;

// start a single hook's scheduler
function startHookScheduler(
  hook: Hook,
  sendMessage: (text: string, isHook?: boolean) => Promise<void>,
): void {
  if (hookRuntimes.has(hook.id)) {
    debug(`[hooks] ${hook.id}: already running`);
    return;
  }

  debug(
    `[hooks] ${hook.id}: starting with interval ${hook.config.every} (${hook.intervalMs}ms)`,
  );

  // run immediately
  executeHook(hook, sendMessage).catch((error) => {
    console.error(`[hooks] ${hook.id}: initial execution error:`, error);
  });

  // schedule recurring executions
  const timer = setInterval(() => {
    executeHook(hook, sendMessage).catch((error) => {
      console.error(`[hooks] ${hook.id}: execution error:`, error);
    });
  }, hook.intervalMs);

  hookRuntimes.set(hook.id, {
    hook,
    timer,
    lastRun: new Date(),
  });
}

// stop a single hook's scheduler
function stopHookScheduler(hookId: string): void {
  const runtime = hookRuntimes.get(hookId);
  if (runtime?.timer) {
    clearInterval(runtime.timer);
  }
  hookRuntimes.delete(hookId);
  debug(`[hooks] ${hookId}: stopped`);
}

// start all hooks
export async function startHooks(
  sendMessage: (text: string, isHook?: boolean) => Promise<void>,
): Promise<void> {
  if (isRunning) {
    debug("[hooks] already running");
    return;
  }

  const hooks = await discoverHooks();

  if (hooks.length === 0) {
    debug("[hooks] no hooks to start");
    return;
  }

  for (const hook of hooks) {
    startHookScheduler(hook, sendMessage);
  }

  isRunning = true;
  debug(`[hooks] started ${hooks.length} hooks`);
}

// stop all hooks
export function stopHooks(): void {
  for (const hookId of hookRuntimes.keys()) {
    stopHookScheduler(hookId);
  }
  // clear agent instances so they don't leak memory between reloads
  hookAgents.clear();
  isRunning = false;
  debug("[hooks] all hooks stopped");
}

// reload hooks (stop all, rediscover, start)
export async function reloadHooks(
  sendMessage: (text: string, isHook?: boolean) => Promise<void>,
): Promise<void> {
  stopHooks();
  await startHooks(sendMessage);
}

// get list of running hooks
export function getRunningHooks(): {
  id: string;
  name: string;
  interval: string;
}[] {
  return Array.from(hookRuntimes.values()).map((runtime) => ({
    id: runtime.hook.id,
    name: runtime.hook.config.name,
    interval: runtime.hook.config.every,
  }));
}

// check if hooks system is running
export function isHooksRunning(): boolean {
  return isRunning;
}

// cleanup for graceful shutdown
export function cleanupHooks(): void {
  stopHooks();
}
