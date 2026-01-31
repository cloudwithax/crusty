import { z } from "zod";
import { getDatabase, getAsyncDatabase } from "../data/db";
import { debug } from "../utils/debug.ts";

// base schema for type inference - the actual schema with current time is generated dynamically
const CreateReminderSchema = z.object({
  message: z.string(),
  remind_at: z.string(),
});

// generate schema with current time embedded in description
// this is called each time tools are generated so the model always knows "now"
export function createReminderSchemaWithTime() {
  const now = new Date().toISOString();
  return z.object({
    message: z.string().describe("What to remind the user about"),
    remind_at: z.string().describe(
      `ISO 8601 timestamp for when to send the reminder. ` +
      `The current time is ${now}. ` +
      `Convert relative times like 'in 5 minutes', 'tomorrow at 3pm', 'next monday' to absolute timestamps in the future. ` +
      `Always use UTC timezone.`
    ),
  });
}

const CancelReminderSchema = z.object({
  reminder_id: z.string().describe("ID of the reminder to cancel"),
});

interface Reminder {
  id: string;
  userId: number;
  message: string;
  remindAt: Date;
  createdAt: Date;
  status: "pending" | "sent" | "cancelled";
}

interface ReminderRow {
  id: string;
  user_id: number;
  message: string;
  remind_at: number;
  created_at: number;
  status: string;
}

function generateReminderId(): string {
  return `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function rowToReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    userId: row.user_id,
    message: row.message,
    remindAt: new Date(row.remind_at * 1000),
    createdAt: new Date(row.created_at * 1000),
    status: row.status as "pending" | "sent" | "cancelled",
  };
}

function formatReminder(reminder: Reminder): string {
  const now = Date.now();
  const remindAtMs = reminder.remindAt.getTime();
  const diffMs = remindAtMs - now;

  // format relative time
  let relativeTime: string;
  if (diffMs < 0) {
    relativeTime = "overdue";
  } else if (diffMs < 60000) {
    relativeTime = "in less than a minute";
  } else if (diffMs < 3600000) {
    const mins = Math.round(diffMs / 60000);
    relativeTime = `in ${mins} minute${mins === 1 ? "" : "s"}`;
  } else if (diffMs < 86400000) {
    const hours = Math.round(diffMs / 3600000);
    relativeTime = `in ${hours} hour${hours === 1 ? "" : "s"}`;
  } else {
    const days = Math.round(diffMs / 86400000);
    relativeTime = `in ${days} day${days === 1 ? "" : "s"}`;
  }

  const dateStr = reminder.remindAt.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `[${reminder.status}] ${reminder.message}\n  ${dateStr} (${relativeTime})\n  ID: \`${reminder.id}\``;
}

// get all pending reminders for a user
export async function getUserReminders(userId: number): Promise<Reminder[]> {
  const asyncDb = getAsyncDatabase();

  if (asyncDb) {
    const rows = await asyncDb.all<ReminderRow>(
      "SELECT id, user_id, message, remind_at, created_at, status FROM reminders WHERE user_id = $1 AND status = 'pending' ORDER BY remind_at ASC",
      userId
    );
    return rows.map(rowToReminder);
  }

  const db = getDatabase();
  const rows = db
    .query<ReminderRow>(
      "SELECT id, user_id, message, remind_at, created_at, status FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY remind_at ASC"
    )
    .all(userId);

  return rows.map(rowToReminder);
}

// get due reminders (for scheduler)
export async function getDueReminders(): Promise<Reminder[]> {
  const now = Math.floor(Date.now() / 1000);
  const asyncDb = getAsyncDatabase();

  if (asyncDb) {
    const rows = await asyncDb.all<ReminderRow>(
      "SELECT id, user_id, message, remind_at, created_at, status FROM reminders WHERE status = 'pending' AND remind_at <= $1 ORDER BY remind_at ASC",
      now
    );
    return rows.map(rowToReminder);
  }

  const db = getDatabase();
  const rows = db
    .query<ReminderRow>(
      "SELECT id, user_id, message, remind_at, created_at, status FROM reminders WHERE status = 'pending' AND remind_at <= ? ORDER BY remind_at ASC"
    )
    .all(now);

  return rows.map(rowToReminder);
}

// mark reminder as sent
export async function markReminderSent(reminderId: string): Promise<void> {
  const asyncDb = getAsyncDatabase();

  if (asyncDb) {
    await asyncDb.run("UPDATE reminders SET status = 'sent' WHERE id = $1", [reminderId]);
    return;
  }

  const db = getDatabase();
  db.run("UPDATE reminders SET status = 'sent' WHERE id = ?", [reminderId]);
}

// cancel a reminder
async function cancelReminder(reminderId: string, userId: number): Promise<boolean> {
  const asyncDb = getAsyncDatabase();

  if (asyncDb) {
    const existing = await asyncDb.get<ReminderRow>(
      "SELECT id FROM reminders WHERE id = $1 AND user_id = $2 AND status = 'pending'",
      reminderId,
      userId
    );

    if (!existing) return false;

    await asyncDb.run("UPDATE reminders SET status = 'cancelled' WHERE id = $1", [reminderId]);
    return true;
  }

  const db = getDatabase();
  const existing = db
    .query<ReminderRow>(
      "SELECT id FROM reminders WHERE id = ? AND user_id = ? AND status = 'pending'"
    )
    .get(reminderId, userId);

  if (!existing) return false;

  db.run("UPDATE reminders SET status = 'cancelled' WHERE id = ?", [reminderId]);
  return true;
}

export const reminderTools = {
  reminder_create: {
    description:
      "Create a reminder to notify the user at a specific time. Use this when the user says things like " +
      "'remind me in 5 minutes', 'remind me tomorrow at 3pm', 'remind me on March 15th', " +
      "'set a reminder for next monday', etc. Parse the natural language time and convert to an ISO timestamp.",
    schema: CreateReminderSchema,
    handler: async (args: z.infer<typeof CreateReminderSchema>, userId: number) => {
      const reminderId = generateReminderId();

      // parse the iso timestamp
      let remindAtDate: Date;
      try {
        remindAtDate = new Date(args.remind_at);
        if (isNaN(remindAtDate.getTime())) {
          return `[Error] Invalid timestamp: ${args.remind_at}. Please provide a valid ISO 8601 timestamp.`;
        }
      } catch {
        return `[Error] Could not parse timestamp: ${args.remind_at}`;
      }

      // check if time is in the past
      const now = Date.now();
      if (remindAtDate.getTime() < now) {
        return `[Error] Cannot set a reminder in the past. The time ${args.remind_at} has already passed.`;
      }

      const remindAtUnix = Math.floor(remindAtDate.getTime() / 1000);
      const createdAtUnix = Math.floor(now / 1000);

      const asyncDb = getAsyncDatabase();
      if (asyncDb) {
        await asyncDb.run(
          "INSERT INTO reminders (id, user_id, message, remind_at, created_at, status) VALUES ($1, $2, $3, $4, $5, 'pending')",
          [reminderId, userId, args.message, remindAtUnix, createdAtUnix]
        );
      } else {
        const db = getDatabase();
        db.run(
          "INSERT INTO reminders (id, user_id, message, remind_at, created_at, status) VALUES (?, ?, ?, ?, ?, 'pending')",
          [reminderId, userId, args.message, remindAtUnix, createdAtUnix]
        );
      }

      const reminder: Reminder = {
        id: reminderId,
        userId,
        message: args.message,
        remindAt: remindAtDate,
        createdAt: new Date(now),
        status: "pending",
      };

      debug(`[reminder] created: ${reminderId} for user ${userId} at ${remindAtDate.toISOString()}`);

      return `reminder set!\n\n${formatReminder(reminder)}`;
    },
  },

  reminder_list: {
    description:
      "List all pending reminders for the user. Use this when the user asks to see their reminders, " +
      "check what reminders they have, or when you need to find a reminder ID to cancel.",
    schema: z.object({}),
    handler: async (_args: unknown, userId: number) => {
      const reminders = await getUserReminders(userId);

      if (reminders.length === 0) {
        return "no pending reminders. use reminder_create to set one!";
      }

      const formatted = reminders.map(formatReminder).join("\n\n");
      return `*pending reminders (${reminders.length}):*\n\n${formatted}`;
    },
  },

  reminder_cancel: {
    description:
      "Cancel a pending reminder. Use this when the user wants to delete, remove, or cancel a reminder. " +
      "Requires the reminder ID which can be found using reminder_list.",
    schema: CancelReminderSchema,
    handler: async (args: z.infer<typeof CancelReminderSchema>, userId: number) => {
      const success = await cancelReminder(args.reminder_id, userId);

      if (!success) {
        return `reminder not found or already completed: ${args.reminder_id}`;
      }

      debug(`[reminder] cancelled: ${args.reminder_id} for user ${userId}`);
      return `reminder cancelled: ${args.reminder_id}`;
    },
  },
};

// cleanup function (no-op for now, db handles persistence)
export async function cleanupReminders(): Promise<void> {
  debug("[reminder] cleanup called (no-op for sqlite)");
}

export type ReminderTools = typeof reminderTools;
