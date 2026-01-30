import { startBot, cleanupBot, sendMessage, getPairedUserId } from "./telegram/bot.ts";
import { startHeartbeat, cleanupHeartbeat } from "./scheduler/heartbeat.ts";
import { closeDatabase } from "./data/db.ts";
import { debug } from "./utils/debug.ts";

// Handle graceful shutdown
process.on("SIGINT", async () => {
  cleanupHeartbeat();
  await cleanupBot();
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  cleanupHeartbeat();
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

// Start the Telegram bot and heartbeat
async function main(): Promise<void> {
  // Start heartbeat scheduler
  startHeartbeat(sendHeartbeatMessage);

  // Start the bot
  await startBot();
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  cleanupHeartbeat();
  await cleanupBot();
  closeDatabase();
  process.exit(1);
});
