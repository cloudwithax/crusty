import { getDueReminders, markReminderSent } from "../tools/reminder.ts";
import { debug } from "../utils/debug.ts";

// reminder check interval (every 30 seconds)
const CHECK_INTERVAL_MS = 30 * 1000;

// scheduler state
let reminderInterval: Timer | null = null;
let isRunning = false;

// callback type for sending reminder notifications
type SendReminderCallback = (userId: number, message: string) => Promise<void>;

// check for due reminders and trigger them
async function checkReminders(sendReminder: SendReminderCallback): Promise<void> {
  try {
    const dueReminders = await getDueReminders();

    if (dueReminders.length === 0) {
      return;
    }

    debug(`[reminders] found ${dueReminders.length} due reminder(s)`);

    for (const reminder of dueReminders) {
      try {
        // format the reminder message
        const message = `*reminder:* ${reminder.message}`;

        // send the notification
        await sendReminder(reminder.userId, message);

        // mark as sent
        await markReminderSent(reminder.id);

        debug(`[reminders] sent: ${reminder.id} to user ${reminder.userId}`);
      } catch (error) {
        console.error(`[reminders] failed to send ${reminder.id}:`, error);
        // dont mark as sent so it will retry on next check
      }
    }
  } catch (error) {
    console.error("[reminders] error checking reminders:", error);
  }
}

// start the reminder scheduler
export function startReminderScheduler(sendReminder: SendReminderCallback): void {
  if (isRunning) {
    debug("[reminders] scheduler already running");
    return;
  }

  debug("[reminders] starting scheduler");

  // run immediately on start
  checkReminders(sendReminder).catch((error) => {
    console.error("[reminders] initial check error:", error);
  });

  // schedule recurring checks
  reminderInterval = setInterval(() => {
    checkReminders(sendReminder).catch((error) => {
      console.error("[reminders] check error:", error);
    });
  }, CHECK_INTERVAL_MS);

  isRunning = true;
}

// stop the reminder scheduler
export function stopReminderScheduler(): void {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
  isRunning = false;
  debug("[reminders] scheduler stopped");
}

// check if scheduler is running
export function isReminderSchedulerRunning(): boolean {
  return isRunning;
}

// cleanup function for graceful shutdown
export function cleanupReminderScheduler(): void {
  stopReminderScheduler();
}
