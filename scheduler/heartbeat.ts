import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { initSelfReview, selfReviewCycle, cleanupSelfReview } from "./self-review.ts";

// Environment configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required for heartbeat");
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 10 * 1000,
});

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
    console.log(`[heartbeat] invalid duration format: ${duration}, disabling`);
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

// Path to HEARTBEAT.md file
const HEARTBEAT_MD_PATH = join(import.meta.dir, "cogs", "HEARTBEAT.md");
const AUDIT_LOG_PATH = join(import.meta.dir, "heartbeat.log");

// Template content that indicates no actionable items
const TEMPLATE_INDICATORS = [
  "<!-- add your actionable items here -->",
  "# Heartbeat",
  "this file controls automated heartbeat behavior",
];

// Check if content is template-only (no actionable items)
function isTemplateOnly(content: string): boolean {
  const normalized = content.toLowerCase().trim();

  // If it's just the header and placeholder, it's template-only
  const lines = normalized.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Check if all non-empty lines are template indicators
  for (const line of lines) {
    const isTemplateLine = TEMPLATE_INDICATORS.some((indicator) =>
      line.includes(indicator.toLowerCase())
    );
    if (!isTemplateLine) {
      // This line has actual content
      return false;
    }
  }

  return true;
}

// Read and validate HEARTBEAT.md
// Returns null if file doesn't exist, is empty, or is template-only
function readHeartbeatFile(): string | null {
  if (!existsSync(HEARTBEAT_MD_PATH)) {
    return null;
  }

  const content = readFileSync(HEARTBEAT_MD_PATH, "utf-8");
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (isTemplateOnly(trimmed)) {
    return null;
  }

  return trimmed;
}

// Write audit log entry
function writeAuditLog(entry: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${entry}\n`;

  try {
    appendFileSync(AUDIT_LOG_PATH, logLine);
  } catch (error) {
    console.error("[heartbeat] failed to write audit log:", error);
  }
}

// recent context buffer for self-review (stores last few interactions)
let recentContextBuffer: string[] = [];
const MAX_CONTEXT_ENTRIES = 10;

// add context to the buffer (call this from agent after interactions)
export function addRecentContext(context: string): void {
  recentContextBuffer.push(context);
  if (recentContextBuffer.length > MAX_CONTEXT_ENTRIES) {
    recentContextBuffer.shift();
  }
}

// get the recent context as a single string
function getRecentContext(): string {
  return recentContextBuffer.join("\n\n---\n\n");
}

// clear recent context buffer
export function clearRecentContext(): void {
  recentContextBuffer = [];
}

// Heartbeat tick function
// Called on each interval to process heartbeat
export async function heartbeatTick(
  sendMessage: (text: string, isHeartbeat?: boolean) => Promise<void>,
  config: HeartbeatConfig = loadConfig()
): Promise<void> {
  // Check if within active hours
  if (!isWithinActiveHours(config.activeHours)) {
    console.log("[heartbeat] outside active hours, skipping");
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

  // Read and validate HEARTBEAT.md
  const heartbeatContent = readHeartbeatFile();

  if (!heartbeatContent) {
    console.log("[heartbeat] skipped (empty or template-only)");
    return;
  }

  console.log("[heartbeat] processing...");

  try {
    // Build system prompt for heartbeat
    const systemPrompt = `You are an automated heartbeat processor. Your task is to review the following instructions and determine if any action is needed.

Instructions from HEARTBEAT.md:
${heartbeatContent}

If no action is needed, respond with exactly: HEARTBEAT_OK
If action is needed, provide a brief summary of what should be done.

Be concise. Only respond with HEARTBEAT_OK if there are truly no pending tasks or actions required.`;

    // Call the model
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Process heartbeat tick" },
      ],
      temperature: 0.3,
    });

    const output = response.choices[0]?.message?.content?.trim() || "";

    console.log("[heartbeat] model output:", output.substring(0, 100));

    // Check if output is HEARTBEAT_OK
    if (output === "HEARTBEAT_OK") {
      // Suppress outbound delivery and write audit log
      writeAuditLog("HEARTBEAT_OK - no action needed");
      console.log("[heartbeat] HEARTBEAT_OK - suppressed delivery");
      return;
    }

    // Check if output exceeds maxAckChars for HEARTBEAT_OK
    // This shouldn't happen since we checked exact match, but handle edge cases
    if (output.length <= config.maxAckChars && output.toUpperCase() === "HEARTBEAT_OK") {
      writeAuditLog("HEARTBEAT_OK (case variant) - no action needed");
      console.log("[heartbeat] HEARTBEAT_OK variant - suppressed delivery");
      return;
    }

    // Deliver via normal outbound channel
    await sendMessage(output, true);
    writeAuditLog(`DELIVERED: ${output.substring(0, 100)}${output.length > 100 ? "..." : ""}`);
    console.log("[heartbeat] delivered message");

  } catch (error) {
    console.error("[heartbeat] error during tick:", error);
    writeAuditLog(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Scheduler state
let heartbeatInterval: Timer | null = null;
let isRunning = false;

// Start the heartbeat scheduler
export function startHeartbeat(
  sendMessage: (text: string, isHeartbeat?: boolean) => Promise<void>,
  config?: HeartbeatConfig
): void {
  if (isRunning) {
    console.log("[heartbeat] already running");
    return;
  }

  // initialize self-review system on heartbeat start
  initSelfReview();

  const effectiveConfig = config || loadConfig();
  const intervalMs = parseDuration(effectiveConfig.every);

  if (intervalMs === 0) {
    console.log("[heartbeat] disabled (interval is 0 or invalid)");
    return;
  }

  console.log(`[heartbeat] starting with interval: ${effectiveConfig.every} (${intervalMs}ms)`);

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
  console.log("[heartbeat] stopped");
}

// Cleanup function for graceful shutdown
export function cleanupHeartbeat(): void {
  stopHeartbeat();
  cleanupSelfReview();
  clearRecentContext();
}

// Check if heartbeat is currently running
export function isHeartbeatRunning(): boolean {
  return isRunning;
}
