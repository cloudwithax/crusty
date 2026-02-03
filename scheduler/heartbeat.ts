import { appendFileSync } from "fs";
import { join } from "path";
import { initSelfReview, selfReviewCycle, cleanupSelfReview } from "./self-review.ts";
import { debug } from "../utils/debug.ts";
import { getFullHeartbeatContent, getActionableItems } from "../tools/heartbeat.ts";
import { Agent } from "../core/agent.ts";

// Heartbeat configuration types
export interface HeartbeatActiveHours {
  timezone: string;
  days: number[]; // 0 = Sunday, 1 = Monday, etc.
  start: string; // HH:MM format (24h)
  end: string; // HH:MM format (24h)
}

export interface HeartbeatConfig {
  every: string; // Duration string like "30m", "1h"
  activeHours?: HeartbeatActiveHours;
  maxAckChars: number;
}

// Default configuration
const DEFAULT_CONFIG: HeartbeatConfig = {
  every: "30m", // runs every 30 minutes by default
  maxAckChars: 20,
};

// Parse duration string to milliseconds
// Supports: Xm (minutes), Xh (hours), Xd (days)
// Returns 0 for invalid or "0m" to disable
export function parseDuration(duration: string): number {
  const trimmed = duration.trim().toLowerCase();

  if (trimmed === "0m" || trimmed === "0h" || trimmed === "0d" || trimmed === "0") {
    return 0;
  }

  const match = trimmed.match(/^(\d+)([mhd])$/);
  if (!match) {
    debug(`[heartbeat] invalid duration format: ${duration}, disabling`);
    return 0;
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2];

  if (value <= 0) {
    return 0;
  }

  switch (unit) {
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

// Parse time string (HH:MM) to minutes since midnight
function parseTime(timeStr: string): number {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid time format: ${timeStr}, expected HH:MM`);
  }
  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  return hours * 60 + minutes;
}

// Check if current time is within active hours
export function isWithinActiveHours(config: HeartbeatActiveHours | undefined): boolean {
  if (!config) {
    return true; // No restrictions
  }

  try {
    const now = new Date();

    // Get current time in the specified timezone
    const timeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });

    const timeParts = timeFormatter.formatToParts(now);
    const hour = parseInt(timeParts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(timeParts.find((p) => p.type === "minute")?.value || "0", 10);

    // Get the day of week in the target timezone
    const dayOfWeek = getDayOfWeekInTimezone(now, config.timezone);

    if (!config.days.includes(dayOfWeek)) {
      return false;
    }

    // Check if current time is within the range
    const currentMinutes = hour * 60 + minute;
    const startMinutes = parseTime(config.start);
    const endMinutes = parseTime(config.end);

    if (startMinutes <= endMinutes) {
      // Normal range (e.g., 09:00 to 17:00)
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
      // Overnight range (e.g., 22:00 to 06:00)
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
  } catch (error) {
    console.error("[heartbeat] error checking active hours:", error);
    return true; // Fail open
  }
}

// Get day of week (0 = Sunday, 1 = Monday, etc.) in a specific timezone
function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  // Create a formatter that gives us the date components in the target timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const parts = formatter.formatToParts(date);
  const year = parseInt(parts.find((p) => p.type === "year")?.value || "0", 10);
  const month = parseInt(parts.find((p) => p.type === "month")?.value || "0", 10);
  const day = parseInt(parts.find((p) => p.type === "day")?.value || "0", 10);

  // Create a date object for midnight in the target timezone
  // We use UTC to avoid double timezone conversion
  const targetDate = new Date(Date.UTC(year, month - 1, day));

  // Get the day of week (0 = Sunday)
  return targetDate.getUTCDay();
}

// Load heartbeat configuration from environment
function loadConfig(): HeartbeatConfig {
  const every = process.env.HEARTBEAT_EVERY || DEFAULT_CONFIG.every;
  const maxAckChars = parseInt(process.env.HEARTBEAT_MAX_ACK_CHARS || `${DEFAULT_CONFIG.maxAckChars}`, 10);

  let activeHours: HeartbeatActiveHours | undefined;

  const timezone = process.env.HEARTBEAT_TIMEZONE;
  const daysStr = process.env.HEARTBEAT_DAYS;
  const start = process.env.HEARTBEAT_START;
  const end = process.env.HEARTBEAT_END;

  if (timezone && daysStr && start && end) {
    try {
      const days = daysStr.split(",").map((d) => parseInt(d.trim(), 10));
      activeHours = { timezone, days, start, end };
    } catch (error) {
      console.error("[heartbeat] failed to parse active hours config:", error);
    }
  }

  return { every, maxAckChars, activeHours };
}

// Path to audit log
const AUDIT_LOG_PATH = join(import.meta.dir, "heartbeat.log");

// write audit log entry
function writeAuditLog(entry: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${entry}\n`;

  try {
    appendFileSync(AUDIT_LOG_PATH, logLine);
  } catch (error) {
    console.error("[heartbeat] failed to write audit log:", error);
  }
}

// re-export context buffer functions for backward compatibility
export { addRecentContext, clearRecentContext, getRecentContext } from "./context-buffer.ts";
import { getRecentContext, clearRecentContext } from "./context-buffer.ts";

// dedicated agent instance for heartbeat tasks (user id 0 = system)
let heartbeatAgent: Agent | null = null;

async function getHeartbeatAgent(): Promise<Agent> {
  if (!heartbeatAgent) {
    heartbeatAgent = new Agent(0);
    await heartbeatAgent.initialize();
  }
  return heartbeatAgent;
}

// heartbeat tick function
// runs actionable items through the agent silently in background
export async function heartbeatTick(
  _sendMessage: (text: string, isHeartbeat?: boolean) => Promise<void>,
  config: HeartbeatConfig = loadConfig()
): Promise<void> {
  // check if within active hours
  if (!isWithinActiveHours(config.activeHours)) {
    debug("[heartbeat] outside active hours, skipping");
    return;
  }

  // run self-review cycle with recent context
  const recentContext = getRecentContext();
  if (recentContext.length > 0) {
    try {
      await selfReviewCycle(recentContext);
    } catch (error) {
      console.error("[heartbeat] self-review cycle failed:", error);
      writeAuditLog(`SELF-REVIEW ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // get actionable items from database
  const items = getActionableItems();

  if (items.length === 0) {
    debug("[heartbeat] no actionable items, skipping");
    return;
  }

  debug(`[heartbeat] processing ${items.length} actionable items...`);

  try {
    const agent = await getHeartbeatAgent();

    // build task prompt from actionable items
    const taskPrompt = `You are running as a background heartbeat process. Execute the following actionable items silently. Do not message the user - just complete the tasks using your available tools. When finished, respond with HEARTBEAT_COMPLETE.

## Actionable Items

${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}

## Instructions

- Execute each item using the appropriate tools
- Work silently - no user notifications
- If a task cannot be completed, log the issue and continue
- When all tasks are done or attempted, respond with: HEARTBEAT_COMPLETE`;

    // run agent silently (no callbacks = no user notifications)
    const result = await agent.chat(taskPrompt);

    debug(`[heartbeat] agent result: ${result.slice(0, 100)}...`);
    writeAuditLog(`EXECUTED: ${items.length} items - ${result.slice(0, 100)}`);

    // clear agent memory after heartbeat to avoid context buildup
    agent.clearMemory();

  } catch (error) {
    console.error("[heartbeat] agent execution failed:", error);
    writeAuditLog(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Scheduler state
let heartbeatInterval: Timer | null = null;
let isRunning = false;

// Start the heartbeat scheduler
export async function startHeartbeat(
  sendMessage: (text: string, isHeartbeat?: boolean) => Promise<void>,
  config?: HeartbeatConfig
): Promise<void> {
  if (isRunning) {
    debug("[heartbeat] already running");
    return;
  }

  // initialize self-review system on heartbeat start
  await initSelfReview();

  const effectiveConfig = config || loadConfig();
  const intervalMs = parseDuration(effectiveConfig.every);

  if (intervalMs === 0) {
    debug("[heartbeat] disabled (interval is 0 or invalid)");
    return;
  }

  debug(`[heartbeat] starting with interval: ${effectiveConfig.every} (${intervalMs}ms)`);

  // Run immediately on start
  heartbeatTick(sendMessage, effectiveConfig).catch((error) => {
    console.error("[heartbeat] initial tick error:", error);
  });

  // Schedule recurring ticks
  heartbeatInterval = setInterval(() => {
    heartbeatTick(sendMessage, effectiveConfig).catch((error) => {
      console.error("[heartbeat] tick error:", error);
    });
  }, intervalMs);

  isRunning = true;
}

// Stop the heartbeat scheduler
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  isRunning = false;
  debug("[heartbeat] stopped");
}

// cleanup function for graceful shutdown
export async function cleanupHeartbeat(): Promise<void> {
  stopHeartbeat();
  cleanupSelfReview();
  clearRecentContext();

  // cleanup heartbeat agent if it exists
  if (heartbeatAgent) {
    await heartbeatAgent.cleanup();
    heartbeatAgent = null;
  }
}

// Check if heartbeat is currently running
export function isHeartbeatRunning(): boolean {
  return isRunning;
}
