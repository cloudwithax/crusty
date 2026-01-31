import { startBot, cleanupBot, sendMessage, getPairedUserId } from "./telegram/bot.ts";
import { startHeartbeat, cleanupHeartbeat } from "./scheduler/heartbeat.ts";
import { startHooks, cleanupHooks } from "./scheduler/hooks.ts";
import { setHookMessageSender } from "./tools/hooks.ts";
import { closeDatabase } from "./data/db.ts";
import { debug } from "./utils/debug.ts";

// Handle graceful shutdown
process.on("SIGINT", async () => {
  cleanupHeartbeat();
  cleanupHooks();
  await cleanupBot();
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  cleanupHeartbeat();
  cleanupHooks();
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

// Start the Telegram bot and heartbeat
async function main(): Promise<void> {
  // Start heartbeat scheduler
  await startHeartbeat(sendHeartbeatMessage);

  // Set hook message sender for tools to use when reloading
  setHookMessageSender(sendHookMessage);

  // Start hooks scheduler
  await startHooks(sendHookMessage);

  // Start the bot
  await startBot();
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  cleanupHeartbeat();
  cleanupHooks();
  await cleanupBot();
  closeDatabase();
  process.exit(1);
});
