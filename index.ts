import {
  startBot,
  cleanupBot,
  sendMessage,
  getPairedUserIdAsync,
} from "./telegram/bot.ts";
import {
  startImessageBot,
  cleanupImessageBot,
  sendImessageMessage,
  getPairedPhoneNumberAsync,
  isImessageConfigured,
} from "./imessage/index.ts";
import { startHeartbeat, cleanupHeartbeat, restartHeartbeat } from "./scheduler/heartbeat.ts";
import { startHooks, cleanupHooks } from "./scheduler/hooks.ts";
import {
  startReminderScheduler,
  cleanupReminderScheduler,
} from "./scheduler/reminders.ts";
import { setHookMessageSender } from "./tools/hooks.ts";
import { setHeartbeatRestartFn } from "./tools/heartbeat.ts";
import { setMessagingSender } from "./tools/messaging.ts";
import { closeDatabase } from "./data/db.ts";
import { preloadEmbeddingModel } from "./memory/embeddings.ts";
import { debug } from "./utils/debug.ts";
import { freeEncoders } from "./core/tokenizer.ts";

// handle graceful shutdown
process.on("SIGINT", async () => {
  await cleanupHeartbeat();
  cleanupHooks();
  cleanupReminderScheduler();
  await cleanupBot();
  await cleanupImessageBot();
  freeEncoders();
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await cleanupHeartbeat();
  cleanupHooks();
  cleanupReminderScheduler();
  await cleanupBot();
  await cleanupImessageBot();
  freeEncoders();
  closeDatabase();
  process.exit(0);
});

// Create heartbeat message sender - delivers to all configured channels
async function sendHeartbeatMessage(
  text: string,
  isHeartbeat?: boolean,
): Promise<void> {
  // deliver to telegram if paired
  const userId = await getPairedUserIdAsync();
  if (userId) {
    await sendMessage(userId, text, { isHeartbeat });
  }

  // deliver to imessage if paired
  const phone = await getPairedPhoneNumberAsync();
  if (phone) {
    await sendImessageMessage(phone, text, { isHeartbeat });
  }

  if (!userId && !phone) {
    debug("[heartbeat] no paired user on any channel, skipping delivery");
  }
}

// Create hook message sender - delivers to all configured channels
async function sendHookMessage(text: string, isHook?: boolean): Promise<void> {
  const userId = await getPairedUserIdAsync();
  if (userId) {
    await sendMessage(userId, text, { isHeartbeat: isHook });
  }

  const phone = await getPairedPhoneNumberAsync();
  if (phone) {
    await sendImessageMessage(phone, text, { isHeartbeat: isHook });
  }

  if (!userId && !phone) {
    debug("[hooks] no paired user on any channel, skipping delivery");
  }
}

// Create reminder message sender
async function sendReminderMessage(
  userId: number,
  text: string,
): Promise<void> {
  await sendMessage(userId, text);
}

// start all bot adapters and schedulers
async function main(): Promise<void> {
  // preload embedding model for faster first chat
  preloadEmbeddingModel().then((loaded) => {
    if (loaded) debug("[startup] embedding model preloaded");
  });

  // start heartbeat scheduler
  await startHeartbeat(sendHeartbeatMessage);

  // set hook message sender for tools to use when reloading
  setHookMessageSender(sendHookMessage);

  // set heartbeat restart function for runtime config changes
  setHeartbeatRestartFn(restartHeartbeat);

  // wire the send_message and set_model tools to deliver through all channels
  setMessagingSender(sendHookMessage);

  // start hooks scheduler
  await startHooks(sendHookMessage);

  // start reminder scheduler
  startReminderScheduler(sendReminderMessage);

  // start imessage bot if configured
  if (isImessageConfigured()) {
    await startImessageBot();
  }

  // start telegram bot (this blocks on long polling)
  await startBot();
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  await cleanupHeartbeat();
  cleanupHooks();
  cleanupReminderScheduler();
  await cleanupBot();
  await cleanupImessageBot();
  freeEncoders();
  closeDatabase();
  process.exit(1);
});
