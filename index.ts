import { startBot, cleanupBot, sendMessage, getPairedUserId } from "./telegram/bot.ts";
import { startHeartbeat, cleanupHeartbeat } from "./scheduler/heartbeat.ts";
import { startHooks, cleanupHooks } from "./scheduler/hooks.ts";
import { startReminderScheduler, cleanupReminderScheduler } from "./scheduler/reminders.ts";
import { setHookMessageSender } from "./tools/hooks.ts";
import { closeDatabase } from "./data/db.ts";
import { debug } from "./utils/debug.ts";

// Handle graceful shutdown
process.on("SIGINT", async () => {
  cleanupHeartbeat();
  cleanupHooks();
  cleanupReminderScheduler();
  await cleanupBot();
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  cleanupHeartbeat();
  cleanupHooks();
  cleanupReminderScheduler();
  await cleanupBot();
  closeDatabase();
  process.exit(0);
});

// Create heartbeat message sender
async function sendHeartbeatMessage(text: string, isHeartbeat?: boolean): Promise<void> {
  const userId = getPairedUserId();
  if (!userId) {
    debug("[heartbeat] no paired user, skipping delivery");
    return;
  }

  await sendMessage(userId, text, { isHeartbeat });
}

// Create hook message sender
async function sendHookMessage(text: string, isHook?: boolean): Promise<void> {
  const userId = getPairedUserId();
  if (!userId) {
    debug("[hooks] no paired user, skipping delivery");
    return;
  }

  await sendMessage(userId, text, { isHeartbeat: isHook });
}

// Create reminder message sender
async function sendReminderMessage(userId: number, text: string): Promise<void> {
  await sendMessage(userId, text);
}

// Start the Telegram bot and heartbeat
async function main(): Promise<void> {
  // Start heartbeat scheduler
  await startHeartbeat(sendHeartbeatMessage);

  // Set hook message sender for tools to use when reloading
  setHookMessageSender(sendHookMessage);

  // Start hooks scheduler
  await startHooks(sendHookMessage);

  // Start reminder scheduler
  startReminderScheduler(sendReminderMessage);

  // Start the bot
  await startBot();
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  cleanupHeartbeat();
  cleanupHooks();
  cleanupReminderScheduler();
  await cleanupBot();
  closeDatabase();
  process.exit(1);
});
