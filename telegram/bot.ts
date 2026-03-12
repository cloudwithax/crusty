import {
  Agent,
  AgentInterruptedError,
  type AgentCallbacks,
  getCurrentModel,
  setCurrentModel,
} from "../core/agent.ts";
import { nativeChatCompletion } from "../core/api.ts";
import { persistModelToEnv } from "../core/model-state.ts";
import { initializeContextLimits } from "../core/context-config.ts";
import { cleanupTools } from "../tools/registry.ts";
import {
  isValidPairingCodeAsync,
  markPairedAsync,
  isUserPairedAsync,
  isSystemPairedAsync,
  loadPairingData,
  loadPairingDataAsync,
  generatePairingCode,
  savePairingCodeAsync,
} from "../cli/pairing.ts";
import { memoryService } from "../memory/service.ts";
import { getUserReminders } from "../tools/reminder.ts";
import { join } from "path";
import {
  startWizard,
  hasActiveWizard,
  cancelWizard,
  processWizardInput,
  writeSkill,
  generateSkillContent,
} from "../core/skill-wizard.ts";
import { skillRegistry } from "../core/skills.ts";
import {
  fetchAndValidateSkillUrl,
  detectInjection,
} from "../core/skill-url.ts";
import { getRunningHooks } from "../scheduler/hooks.ts";
import { getDatabase, getAsyncDatabase } from "../data/db.ts";
import { debug } from "../utils/debug.ts";
import { learningsService } from "../memory/learnings.ts";
import { getHeartbeatConfig } from "../data/heartbeat-config.ts";
import {
  getRecentSessions,
  getSessionStats,
} from "../memory/session-memory.ts";
import {
  DEFAULT_CONVERSATION_THREAD_ID,
  buildTelegramMessageReference,
  buildTelegramThreadId,
} from "../core/conversation-threading.ts";
import { conversationStore } from "../core/conversation-store";
import { conversationThreadStore } from "../core/thread-store.ts";
import { chooseThread } from "../core/thread-router.ts";

// Environment configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
}

const API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Types
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  message_thread_id?: number;
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

// session management - one agent per user thread
const userSessions = new Map<string, Agent>();

// track which users are currently being processed with their abort controllers
const processingUsers = new Map<number, AbortController>();

// queue for interrupt messages (new message while processing)
const interruptQueue = new Map<number, TelegramMessage>();

// force the next non-command message to start a fresh thread
const forceFreshThreadUsers = new Set<number>();

// track users awaiting soul content input
const awaitingSoulInput = new Set<number>();

// Get the paired user ID for heartbeat messages
export function getPairedUserId(): number | null {
  const pairingData = loadPairingData();
  if (pairingData?.used && pairingData?.pairedUserId) {
    return pairingData.pairedUserId;
  }
  return null;
}

export async function getPairedUserIdAsync(): Promise<number | null> {
  const pairingData = await loadPairingDataAsync();
  if (pairingData?.used && pairingData?.pairedUserId) {
    return pairingData.pairedUserId;
  }
  return null;
}

function getSessionKey(userId: number, threadId: string): string {
  return `${userId}:${threadId}`;
}

function getOrCreateAgent(userId: number, threadId: string): Agent {
  const sessionKey = getSessionKey(userId, threadId);
  if (!userSessions.has(sessionKey)) {
    userSessions.set(sessionKey, new Agent(userId, { threadId }));
  }

  return userSessions.get(sessionKey)!;
}

async function clearUserSessions(userId: number): Promise<void> {
  const prefix = `${userId}:`;
  for (const [sessionKey, agent] of userSessions) {
    if (!sessionKey.startsWith(prefix)) {
      continue;
    }

    await agent.clearMemoryAndPersist();
    userSessions.delete(sessionKey);
  }
}

async function resetUserThreads(userId: number): Promise<void> {
  await clearUserSessions(userId);
  await conversationStore().clearAll(userId);
  await conversationThreadStore().clearUserThreads("telegram", userId);
}

async function getActiveThreadId(userId: number): Promise<string> {
  return (
    (await conversationThreadStore().getLatestThreadId("telegram", userId)) ||
    DEFAULT_CONVERSATION_THREAD_ID
  );
}

async function getActiveAgent(userId: number): Promise<Agent> {
  const threadId = await getActiveThreadId(userId);
  return getOrCreateAgent(userId, threadId);
}

async function resolveTelegramThreadId(
  userId: number,
  message: TelegramMessage,
): Promise<string> {
  if (forceFreshThreadUsers.delete(userId)) {
    const forcedThreadId = buildTelegramThreadId(
      message.chat.id,
      message.message_id,
    );
    await conversationThreadStore().touchThread(
      "telegram",
      userId,
      forcedThreadId,
    );
    return forcedThreadId;
  }

  if (message.reply_to_message?.from?.is_bot) {
    const replyReference = buildTelegramMessageReference(
      message.reply_to_message.chat.id,
      message.reply_to_message.message_id,
    );
    const existingThreadId =
      await conversationThreadStore().resolveMessageReference(
        "telegram",
        userId,
        replyReference,
      );

    if (existingThreadId) {
      await conversationThreadStore().touchThread(
        "telegram",
        userId,
        existingThreadId,
      );
      return existingThreadId;
    }
  }

  if (message.text?.trim()) {
    const decision = await chooseThread("telegram", userId);
    if (decision.kind === "existing") {
      await conversationThreadStore().touchThread(
        "telegram",
        userId,
        decision.threadId,
      );
      return decision.threadId;
    }
  }

  const threadId = buildTelegramThreadId(message.chat.id, message.message_id);
  await conversationThreadStore().touchThread("telegram", userId, threadId);
  return threadId;
}

async function bindTelegramBotMessage(
  userId: number,
  threadId: string,
  message: TelegramMessage | null,
): Promise<void> {
  if (!message) {
    return;
  }

  await conversationThreadStore().bindMessageReference(
    "telegram",
    userId,
    buildTelegramMessageReference(message.chat.id, message.message_id),
    threadId,
  );
}

// Telegram API helpers
async function makeRequest<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${API_BASE}/${method}`;
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  const result = (await response.json()) as {
    ok: boolean;
    result: T;
    description?: string;
  };
  if (!result.ok) {
    throw new Error(
      `Telegram API error: ${result.description || "Unknown error"}`,
    );
  }

  return result.result;
}

// Delivery gate helper - checks if message should be suppressed
// Returns true if message was suppressed (heartbeat tick with HEARTBEAT_OK)
export function shouldSuppressDelivery(
  text: string,
  isHeartbeatTick?: boolean,
): boolean {
  if (!isHeartbeatTick) {
    return false;
  }
  return text.trim() === "HEARTBEAT_OK";
}

// Exported sendMessage for use by heartbeat module
export async function sendMessage(
  chatId: number,
  text: string,
  options?: {
    reply_markup?: unknown;
    message_thread_id?: number;
    parse_mode?: string;
    isHeartbeat?: boolean;
  },
): Promise<TelegramMessage | null> {
  // Check delivery gate for heartbeat messages
  if (shouldSuppressDelivery(text, options?.isHeartbeat)) {
    debug("[telegram] suppressed HEARTBEAT_OK delivery");
    return null;
  }

  const messageText = truncateMessage(text);
  const parseMode = options?.parse_mode || "Markdown";

  try {
    return await makeRequest("sendMessage", {
      chat_id: chatId,
      text: messageText,
      parse_mode: parseMode,
      message_thread_id: options?.message_thread_id,
      ...options,
    });
  } catch (error) {
    // if markdown parsing fails, retry without parse_mode
    if (error instanceof Error && error.message.includes("400")) {
      debug(`[Markdown parse failed, retrying as plain text]`);
      return makeRequest("sendMessage", {
        chat_id: chatId,
        text: messageText,
        message_thread_id: options?.message_thread_id,
        reply_markup: options?.reply_markup,
      });
    }
    throw error;
  }
}

async function sendChatAction(
  chatId: number,
  action: "typing" | "upload_photo" | "upload_document",
  options?: { message_thread_id?: number },
): Promise<void> {
  await makeRequest("sendChatAction", {
    chat_id: chatId,
    action,
    message_thread_id: options?.message_thread_id,
  });
}

const maxTelegramMessageLength = 4096;

function truncateMessage(text: string): string {
  if (text.length <= maxTelegramMessageLength) return text;
  return text.slice(0, maxTelegramMessageLength - 3) + "...";
}

// Command handlers
const commands: Record<
  string,
  (
    userId: number,
    chatId: number,
    messageThreadId: number | undefined,
    args: string,
  ) => Promise<void>
> = {
  async start(userId, chatId, messageThreadId) {
    if (!(await isSystemPairedAsync())) {
      await sendMessage(
        chatId,
        "🔐 *Pairing Required*\n\n" +
          "This bot requires a pairing code to start.\n\n" +
          'Please run `bun run setup` on the server and select "Generate Pairing Code"\n' +
          "Then send the code here as your first message.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 *Already Paired*\n\n" +
          "This bot is already paired with another user.\n" +
          "Contact the administrator if you need access.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    await sendMessage(
      chatId,
      "Hey there! I'm Crusty, your friendly neighborhood crab assistant.\n\n" +
        "I can help you:\n" +
        "• Scuttle across websites and dig up information\n" +
        "• Answer questions with fresh data from the web\n" +
        "• Help with research - I love a good treasure hunt\n\n" +
        "top-level messages stay in the latest active thread while we're still working. reply to one of my messages to jump back to that exact thread, or use /new before your next message to start clean.\n\n" +
        "Just send me a message or ask me to visit a website!\n\n" +
        "Type /help for all available commands.",
      { message_thread_id: messageThreadId },
    );
  },

  async help(userId, chatId, messageThreadId) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
          "Please provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    await sendMessage(
      chatId,
      "*Crusty's Commands*\n\n" +
        "*general:*\n" +
        "/start - Wake up the crab\n" +
        "/new - Force the next message into a fresh thread\n" +
        "/clear - Clean the shell (clear conversation)\n" +
        "/model - View or change the AI model\n" +
        "/context - View context window stats\n" +
        "/help - Show this message\n\n" +
        "*memory & knowledge:*\n" +
        "/memory - View memory stats\n" +
        "/memory clear - Wipe long-term memory\n" +
        "/forget <keyword> - Search memories by keyword\n" +
        "/learnings - View learning stats\n" +
        "/sessions - View recent conversation sessions\n\n" +
        "*tasks & reminders:*\n" +
        "/todos - View all todo lists\n" +
        "/reminders - View pending reminders\n\n" +
        "*personality & skills:*\n" +
        "/soul - View current persona\n" +
        "/soul new - Define a new persona\n" +
        "/skill - List available skills\n" +
        "/skill new - Create a new skill\n\n" +
        "*system:*\n" +
        "/hooks - View running hooks\n" +
        "/heartbeat - View heartbeat config\n" +
        "/export - Export memories, learnings, or conversation\n\n" +
        "top-level messages keep using the latest active thread while you're still working. reply to one of my messages to jump back to that exact thread. use /new to force a fresh thread.",
      { message_thread_id: messageThreadId },
    );
  },

  async new(userId, chatId, messageThreadId) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
          "Please provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    forceFreshThreadUsers.add(userId);
    await sendMessage(
      chatId,
      "next non-command message will start a fresh thread. your existing threads are still preserved if you reply to them later.",
      { message_thread_id: messageThreadId },
    );
  },

  async clear(userId, chatId, messageThreadId) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
          "Please provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    await resetUserThreads(userId);
    await sendMessage(
      chatId,
      "Shell cleaned! Starting fresh with a blank tide pool.",
      { message_thread_id: messageThreadId },
    );
  },

  async memory(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
          "Please provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const arg = args.trim().toLowerCase();

    if (arg === "clear") {
      await memoryService.clearUserMemories(userId);
      await sendMessage(chatId, "memory banks wiped clean.", {
        message_thread_id: messageThreadId,
      });
      return;
    }

    // show memory stats
    const stats = await memoryService.getStats(userId);
    await sendMessage(
      chatId,
      `*Memory Stats*\n\n` + `total memories: ${stats.total}`,
      { message_thread_id: messageThreadId },
    );
  },

  async context(userId, chatId, messageThreadId, _args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
          "Please provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const agent = await getActiveAgent(userId);
    await agent.initialize();
    const stats = agent.getContextStats();

    const tokenLine =
      stats.smartTokenCount.source === "tiktoken"
        ? `tokens: ~${stats.smartTokenCount.tokens} (tiktoken)`
        : stats.smartTokenCount.source === "actual"
          ? `tokens: ${stats.smartTokenCount.tokens} (actual)`
          : `tokens: ~${stats.smartTokenCount.tokens} (actual+delta)`;

    const usageLine = stats.actualUsage
      ? `\nlast api usage: ${stats.actualUsage.promptTokens} prompt / ${stats.actualUsage.completionTokens} completion`
      : "";

    await sendMessage(
      chatId,
      `*Context Stats*\n\n` +
        `messages in context: ${stats.messageCount}\n` +
        `${tokenLine}${usageLine}\n` +
        `has summary: ${stats.hasSummary ? "yes" : "no"}\n` +
        `summary length: ${stats.summaryLength} chars`,
      { message_thread_id: messageThreadId },
    );
  },

  async soul(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
          "Please provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const soulPath = join(process.cwd(), "cogs", "SOUL.md");
    const arg = args.trim().toLowerCase();

    // /soul new - start the flow
    if (arg === "new") {
      awaitingSoulInput.add(userId);
      await sendMessage(
        chatId,
        "okay, what would you like your new soul to be?\n\n(send your persona content as the next message)",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    // /soul cancel - abort if waiting
    if (arg === "cancel") {
      if (awaitingSoulInput.has(userId)) {
        awaitingSoulInput.delete(userId);
        await sendMessage(chatId, "soul update cancelled.", {
          message_thread_id: messageThreadId,
        });
      } else {
        await sendMessage(chatId, "nothing to cancel.", {
          message_thread_id: messageThreadId,
        });
      }
      return;
    }

    // /soul (no args) = show current soul
    try {
      const content = await Bun.file(soulPath).text();
      const truncated =
        content.length > 3500
          ? content.slice(0, 3500) + "\n\n... [truncated]"
          : content;
      await sendMessage(chatId, `*Current Soul:*\n\n${truncated}`, {
        message_thread_id: messageThreadId,
      });
    } catch {
      await sendMessage(chatId, "no soul file found.", {
        message_thread_id: messageThreadId,
      });
    }
  },

  async reminders(userId, chatId, messageThreadId) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\n" +
          "Please provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const reminders = await getUserReminders(userId);

    if (reminders.length === 0) {
      await sendMessage(
        chatId,
        'no pending reminders.\n\njust tell me something like "remind me in 10 minutes to take a break"',
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const formatted = reminders
      .map((r) => {
        const now = Date.now();
        const remindAtMs = r.remindAt.getTime();
        const diffMs = remindAtMs - now;

        let relativeTime: string;
        if (diffMs < 0) {
          relativeTime = "overdue";
        } else if (diffMs < 60000) {
          relativeTime = "in less than a minute";
        } else if (diffMs < 3600000) {
          const mins = Math.round(diffMs / 60000);
          relativeTime = `in ${mins} min`;
        } else if (diffMs < 86400000) {
          const hours = Math.round(diffMs / 3600000);
          relativeTime = `in ${hours}h`;
        } else {
          const days = Math.round(diffMs / 86400000);
          relativeTime = `in ${days}d`;
        }

        return `- ${r.message} (${relativeTime})`;
      })
      .join("\n");

    await sendMessage(
      chatId,
      `*pending reminders (${reminders.length}):*\n\n${formatted}\n\nto cancel, just ask me to cancel a reminder`,
      { message_thread_id: messageThreadId },
    );
  },

  async skill(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\n" +
          "Please provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const arg = args.trim();
    const argLower = arg.toLowerCase();

    // /skill new or /skill create - start wizard
    if (argLower === "new" || argLower === "create") {
      const firstQuestion = startWizard(userId);
      await sendMessage(
        chatId,
        `*creating new skill*\n\n${firstQuestion}\n\n(type 'cancel' at any time to abort)`,
        { message_thread_id: messageThreadId },
      );
      return;
    }

    // /skill cancel - abort wizard
    if (argLower === "cancel") {
      if (cancelWizard(userId)) {
        await sendMessage(chatId, "skill creation cancelled.", {
          message_thread_id: messageThreadId,
        });
      } else {
        await sendMessage(chatId, "no skill wizard active.", {
          message_thread_id: messageThreadId,
        });
      }
      return;
    }

    // /skill list - show available skills
    if (argLower === "list" || argLower === "") {
      const skills = skillRegistry.listSkills();
      if (skills.length === 0) {
        await sendMessage(
          chatId,
          "no skills found.\n\nuse `/skill new` to create one.",
          { message_thread_id: messageThreadId },
        );
      } else {
        await sendMessage(
          chatId,
          `*available skills (${skills.length}):*\n\n${skills.map((s) => `• ${s}`).join("\n")}\n\nuse \`/skill new\` to create a new one.`,
          { message_thread_id: messageThreadId },
        );
      }
      return;
    }

    // /skill <url> - load skill from url
    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      await sendMessage(chatId, "validating skill url...", {
        message_thread_id: messageThreadId,
      });

      const result = await fetchAndValidateSkillUrl(arg);

      if (!result.success) {
        await sendMessage(chatId, `failed to load skill: ${result.error}`, {
          message_thread_id: messageThreadId,
        });
        return;
      }

      // check if skill already exists
      if (skillRegistry.hasSkill(result.skill!.name)) {
        await sendMessage(
          chatId,
          `skill "${result.skill!.name}" already exists. remove it first or use a different name.`,
          { message_thread_id: messageThreadId },
        );
        return;
      }

      // add the skill to the registry and persist to database
      const added = await skillRegistry.addUrlSkill(
        result.skill!.name,
        result.skill!.description,
        result.skill!.content,
        arg,
      );

      if (added) {
        // clear session so agent picks up new skill on next message
        await resetUserThreads(userId);

        await sendMessage(
          chatId,
          `skill "${result.skill!.name}" loaded successfully.\n\n` +
            `description: ${result.skill!.description}\n\n` +
            `the agent now has access to this skill.`,
          { message_thread_id: messageThreadId },
        );
      } else {
        await sendMessage(chatId, `failed to add skill to registry.`, {
          message_thread_id: messageThreadId,
        });
      }
      return;
    }

    // /skill <name> - show skill details
    const skill = skillRegistry.getSkill(argLower);
    if (skill) {
      const truncated =
        skill.content.length > 3000
          ? skill.content.slice(0, 3000) + "\n\n... [truncated]"
          : skill.content;
      await sendMessage(
        chatId,
        `*skill: ${skill.meta.name}*\n\n${skill.meta.description}\n\n---\n\n${truncated}`,
        { message_thread_id: messageThreadId },
      );
    } else {
      await sendMessage(
        chatId,
        `skill "${argLower}" not found.\n\nuse \`/skill list\` to see available skills.`,
        { message_thread_id: messageThreadId },
      );
    }
  },

  async model(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const arg = args.trim();
    const currentModel = getCurrentModel();

    // /model (no args) - show current model and try to show selection menu
    if (!arg) {
      // try to fetch available models from the OpenAI-compatible API
      const models = await fetchAvailableModels();

      if (models && models.length > 0) {
        // build inline keyboard with available models (max 40 to fit telegram limits)
        const displayModels = models.slice(0, 40);
        const keyboard = displayModels.map((m) => {
          const label = m.id === currentModel ? `${m.id} (current)` : m.id;
          return [{ text: label, callback_data: `model:${m.id}` }];
        });

        await sendMessage(
          chatId,
          `*Current model:* \`${currentModel}\`\n\nSelect a model from the list below, or use \`/model <model-id>\` to set one directly.`,
          {
            message_thread_id: messageThreadId,
            reply_markup: { inline_keyboard: keyboard },
          },
        );
      } else {
        await sendMessage(
          chatId,
          `*Current model:* \`${currentModel}\`\n\nCouldn't fetch model list from the API. Use \`/model <model-id>\` to change the model directly.`,
          { message_thread_id: messageThreadId },
        );
      }
      return;
    }

    // /model <model-id> - set model directly
    await switchModel(chatId, messageThreadId, arg, userId);
  },

  async todos(userId, chatId, messageThreadId, _args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const asyncDb = getAsyncDatabase();

    if (asyncDb) {
      const todos = await asyncDb.all<{ id: string; title: string }>(
        "SELECT id, title FROM todos WHERE user_id = $1",
        userId,
      );

      if (todos.length === 0) {
        await sendMessage(
          chatId,
          "no todo lists found.\n\njust ask me to create one for you.",
          { message_thread_id: messageThreadId },
        );
        return;
      }

      const lines: string[] = [];
      for (const t of todos) {
        const items = await asyncDb.all<{ completed: number }>(
          "SELECT completed FROM todo_items WHERE todo_id = $1",
          t.id,
        );
        const done = items.filter((i) => i.completed === 1).length;
        lines.push(`- ${t.title} (${done}/${items.length})`);
      }

      await sendMessage(
        chatId,
        `*Todo Lists (${todos.length}):*\n\n${lines.join("\n")}`,
        { message_thread_id: messageThreadId },
      );
    } else {
      const db = getDatabase();
      const todos = db
        .query<{
          id: string;
          title: string;
        }>("SELECT id, title FROM todos WHERE user_id = ?")
        .all(userId);

      if (todos.length === 0) {
        await sendMessage(
          chatId,
          "no todo lists found.\n\njust ask me to create one for you.",
          { message_thread_id: messageThreadId },
        );
        return;
      }

      const lines = todos.map((t) => {
        const items = db
          .query<{
            completed: number;
          }>("SELECT completed FROM todo_items WHERE todo_id = ?")
          .all(t.id);
        const done = items.filter((i) => i.completed === 1).length;
        return `- ${t.title} (${done}/${items.length})`;
      });

      await sendMessage(
        chatId,
        `*Todo Lists (${todos.length}):*\n\n${lines.join("\n")}`,
        { message_thread_id: messageThreadId },
      );
    }
  },

  async learnings(userId, chatId, messageThreadId, _args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const stats = await learningsService.getStats(userId);

    if (stats.total === 0) {
      await sendMessage(
        chatId,
        "no learnings stored yet.\n\nthe agent discovers patterns, fixes, and gotchas automatically over time.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    // build category breakdown
    const categories = Object.entries(stats.byCategory)
      .filter(([, count]) => count > 0)
      .map(([cat, count]) => `  ${cat}: ${count}`)
      .join("\n");

    await sendMessage(
      chatId,
      `*Learning Stats*\n\n` +
        `total: ${stats.total}\n` +
        `avg confidence: ${(stats.avgConfidence * 100).toFixed(0)}%\n` +
        `total applications: ${stats.totalApplications}\n\n` +
        `*by category:*\n${categories}`,
      { message_thread_id: messageThreadId },
    );
  },

  async hooks(userId, chatId, messageThreadId, _args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const running = getRunningHooks();

    if (running.length === 0) {
      await sendMessage(
        chatId,
        "no hooks running.\n\nadd hook files to `cogs/hooks/` to get started.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const lines = running.map((h) => `- *${h.name}* (every ${h.interval})`);

    await sendMessage(
      chatId,
      `*Running Hooks (${running.length}):*\n\n${lines.join("\n")}`,
      { message_thread_id: messageThreadId },
    );
  },

  async heartbeat(userId, chatId, messageThreadId, _args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const dbConfig = await getHeartbeatConfig();

    // fall back to env vars for defaults
    const every = dbConfig?.every ?? process.env.HEARTBEAT_EVERY ?? "30m";
    const timezone =
      dbConfig?.timezone ?? process.env.HEARTBEAT_TIMEZONE ?? "not set";
    const days = dbConfig?.days ?? process.env.HEARTBEAT_DAYS ?? "not set";
    const start =
      dbConfig?.start_time ?? process.env.HEARTBEAT_START ?? "not set";
    const end = dbConfig?.end_time ?? process.env.HEARTBEAT_END ?? "not set";
    const source = dbConfig ? "database override" : "env defaults";

    await sendMessage(
      chatId,
      `*Heartbeat Config*\n\n` +
        `interval: ${every}\n` +
        `timezone: ${timezone}\n` +
        `active days: ${days}\n` +
        `active hours: ${start} - ${end}\n` +
        `source: ${source}`,
      { message_thread_id: messageThreadId },
    );
  },

  async sessions(userId, chatId, messageThreadId, _args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const sessions = await getRecentSessions(userId, 10);
    const stats = await getSessionStats(userId);

    if (sessions.length === 0) {
      await sendMessage(chatId, "no past sessions found.", {
        message_thread_id: messageThreadId,
      });
      return;
    }

    const lines = sessions.map((s) => {
      const date = new Date(s.startTime).toISOString().split("T")[0];
      const duration = Math.round((s.endTime - s.startTime) / (1000 * 60));
      return `- ${s.title} (${date}, ${s.messageCount} msgs, ~${duration}min)`;
    });

    await sendMessage(
      chatId,
      `*Sessions* (${stats.totalSessions} total, ${stats.totalMessages} msgs)\n\n` +
        `*recent:*\n${lines.join("\n")}`,
      { message_thread_id: messageThreadId },
    );
  },

  async forget(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const query = args.trim();

    if (!query) {
      await sendMessage(
        chatId,
        "usage: `/forget <keyword>`\n\nsearches your memories and shows matches.\nuse `/memory clear` to wipe all memories.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const results = await memoryService.searchMemories(userId, query, 10);

    if (results.length === 0) {
      await sendMessage(chatId, `no memories found matching "${query}".`, {
        message_thread_id: messageThreadId,
      });
      return;
    }

    const lines = results.map(
      (r) =>
        `- "${(r.memory.rawContent || r.memory.content).substring(0, 80)}..."`,
    );

    await sendMessage(
      chatId,
      `*Found ${results.length} memories matching "${query}":*\n\n${lines.join("\n")}\n\n` +
        `individual deletion not yet supported.\nuse \`/memory clear\` to wipe all memories.`,
      { message_thread_id: messageThreadId },
    );
  },

  async export(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    const arg = args.trim().toLowerCase();

    if (!arg || arg === "help") {
      await sendMessage(
        chatId,
        "*Export Data*\n\n" +
          "`/export memories` - export all saved memories\n" +
          "`/export learnings` - export all learnings\n" +
          "`/export conversation` - export current conversation",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    if (arg === "memories") {
      const asyncDb = getAsyncDatabase();
      let rows: {
        content: string;
        timestamp: number;
      }[];

      if (asyncDb) {
        rows = await asyncDb.all<{
          content: string;
          timestamp: number;
        }>(
          "SELECT COALESCE(raw_content, content) as content, timestamp FROM memories WHERE user_id = $1 ORDER BY timestamp DESC",
          userId,
        );
      } else {
        const db = getDatabase();
        rows = db
          .query<{
            content: string;
            timestamp: number;
          }>(
            "SELECT COALESCE(raw_content, content) as content, timestamp FROM memories WHERE user_id = ? ORDER BY timestamp DESC",
          )
          .all(userId);
      }

      if (rows.length === 0) {
        await sendMessage(chatId, "no memories to export.", {
          message_thread_id: messageThreadId,
        });
        return;
      }

      const lines = rows.map((r) => {
        const date = new Date(r.timestamp).toISOString().split("T")[0];
        return `[${date}] ${r.content}`;
      });

      const text = lines.join("\n");
      const truncated =
        text.length > 3800 ? text.slice(0, 3800) + "\n\n... [truncated]" : text;

      await sendMessage(
        chatId,
        `*Memories Export (${rows.length}):*\n\n${truncated}`,
        { message_thread_id: messageThreadId },
      );
      return;
    }

    if (arg === "learnings") {
      const asyncDb = getAsyncDatabase();
      let rows: {
        title: string;
        category: string;
        content: string;
        confidence: number;
        application_count: number;
      }[];

      if (asyncDb) {
        rows = await asyncDb.all<{
          title: string;
          category: string;
          content: string;
          confidence: number;
          application_count: number;
        }>(
          "SELECT title, category, content, confidence, application_count FROM learnings WHERE user_id = $1 ORDER BY confidence DESC",
          userId,
        );
      } else {
        const db = getDatabase();
        rows = db
          .query<{
            title: string;
            category: string;
            content: string;
            confidence: number;
            application_count: number;
          }>(
            "SELECT title, category, content, confidence, application_count FROM learnings WHERE user_id = ? ORDER BY confidence DESC",
          )
          .all(userId);
      }

      if (rows.length === 0) {
        await sendMessage(chatId, "no learnings to export.", {
          message_thread_id: messageThreadId,
        });
        return;
      }

      const lines = rows.map(
        (r) =>
          `[${r.category}] ${r.title} (conf: ${(r.confidence * 100).toFixed(0)}%, applied: ${r.application_count}x)\n  ${r.content.substring(0, 120)}`,
      );

      const text = lines.join("\n\n");
      const truncated =
        text.length > 3800 ? text.slice(0, 3800) + "\n\n... [truncated]" : text;

      await sendMessage(
        chatId,
        `*Learnings Export (${rows.length}):*\n\n${truncated}`,
        { message_thread_id: messageThreadId },
      );
      return;
    }

    if (arg === "conversation") {
      const agent = await getActiveAgent(userId);
      await agent.initialize();
      const messages = agent.messages;

      // skip system message, format user/assistant turns
      const turns = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const role = m.role === "user" ? "You" : "Bot";
          const content =
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content);
          return `[${role}] ${content.substring(0, 200)}`;
        });

      if (turns.length === 0) {
        await sendMessage(chatId, "no conversation to export.", {
          message_thread_id: messageThreadId,
        });
        return;
      }

      const text = turns.join("\n\n");
      const truncated =
        text.length > 3800 ? text.slice(0, 3800) + "\n\n... [truncated]" : text;

      await sendMessage(
        chatId,
        `*Conversation Export (${turns.length} turns):*\n\n${truncated}`,
        { message_thread_id: messageThreadId },
      );
      return;
    }

    await sendMessage(
      chatId,
      `unknown export type "${arg}".\n\nuse \`/export memories\`, \`/export learnings\`, or \`/export conversation\`.`,
      { message_thread_id: messageThreadId },
    );
  },
};

// fetch available models from the OpenAI-compatible API's /models endpoint
async function fetchAvailableModels(): Promise<
  { id: string; owned_by?: string }[] | null
> {
  const baseURL = (
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const apiKey = process.env.OPENAI_API_KEY;

  try {
    const modelsUrl = `${baseURL.replace(/\/$/, "")}/models`;
    const response = await fetch(modelsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      debug(`[model] /models endpoint returned ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      data?: { id: string; owned_by?: string }[];
    };
    if (!data.data || !Array.isArray(data.data)) {
      debug("[model] /models response missing data array");
      return null;
    }

    // sort alphabetically
    return data.data.sort((a, b) => a.id.localeCompare(b.id));
  } catch (err) {
    debug("[model] failed to fetch /models:", err);
    return null;
  }
}

// verify a model works by streaming a quick "who are you" test with 10s timeout
async function verifyModel(modelId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await nativeChatCompletion(
      {
        model: modelId,
        messages: [
          { role: "user", content: "who are you? reply in one sentence." },
        ],
        max_tokens: 100,
      },
      controller.signal,
    );

    clearTimeout(timeout);
    return !!response.choices[0]?.message?.content?.trim();
  } catch (err) {
    debug(`[model] verification failed for ${modelId}:`, err);
    return false;
  }
}

// switch to a new model with verification
async function switchModel(
  chatId: number,
  messageThreadId: number | undefined,
  modelId: string,
  userId: number,
): Promise<void> {
  const currentModel = getCurrentModel();

  if (modelId === currentModel) {
    await sendMessage(chatId, `already using \`${modelId}\`.`, {
      message_thread_id: messageThreadId,
    });
    return;
  }

  await sendMessage(chatId, `verifying \`${modelId}\`...`, {
    message_thread_id: messageThreadId,
  });

  const works = await verifyModel(modelId);

  if (works) {
    setCurrentModel(modelId);
    persistModelToEnv(modelId);

    // reinitialize context limits for the new model
    await initializeContextLimits(modelId);

    // clear session so agent picks up new model context limits
    await resetUserThreads(userId);

    await sendMessage(
      chatId,
      `model switched to \`${modelId}\`. conversation has been reset.`,
      { message_thread_id: messageThreadId },
    );
  } else {
    await sendMessage(
      chatId,
      `model \`${modelId}\` failed verification (no response within 10s). keeping \`${currentModel}\`.`,
      { message_thread_id: messageThreadId },
    );
  }
}

// handle callback queries (inline keyboard responses)
async function handleCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat.id;
  const messageThreadId = callbackQuery.message?.message_thread_id;
  const data = callbackQuery.data || "";

  // acknowledge the callback to remove loading state
  try {
    await makeRequest("answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
    });
  } catch {
    // ignore errors from answering callback
  }

  if (!chatId) return;

  // check if user is paired
  const userPaired = await isUserPairedAsync(userId);
  if (!userPaired) return;

  // handle model selection callbacks
  if (data.startsWith("model:")) {
    const modelId = data.slice("model:".length);
    await switchModel(chatId, messageThreadId, modelId, userId);
  }
}

// handle soul content input (called when user is in awaiting state)
async function handleSoulInput(
  userId: number,
  chatId: number,
  messageThreadId: number | undefined,
  content: string,
): Promise<boolean> {
  if (!awaitingSoulInput.has(userId)) {
    return false;
  }

  awaitingSoulInput.delete(userId);
  const soulPath = join(process.cwd(), "cogs", "SOUL.md");

  try {
    await Bun.write(soulPath, content);
    debug(`[soul] updated by user ${userId} (${content.length} chars)`);

    // clear session so agent picks up new soul on next message
    await resetUserThreads(userId);

    await sendMessage(
      chatId,
      `done! new soul has been set (${content.length} chars). further messages will use the new persona.`,
      { message_thread_id: messageThreadId },
    );
  } catch (error) {
    console.error("[soul] write failed:", error);
    await sendMessage(chatId, "failed to update soul file.", {
      message_thread_id: messageThreadId,
    });
  }

  return true;
}

// handle skill wizard input (called when user has active wizard)
async function handleSkillWizardInput(
  userId: number,
  chatId: number,
  messageThreadId: number | undefined,
  content: string,
): Promise<boolean> {
  if (!hasActiveWizard(userId)) {
    return false;
  }

  const result = processWizardInput(userId, content);

  if (result.done) {
    if (result.skill) {
      // scan wizard output for injection before persisting
      const skillContent = generateSkillContent(result.skill);
      const injectionCheck = detectInjection(skillContent);
      if (injectionCheck.detected) {
        await sendMessage(
          chatId,
          `skill blocked: suspicious content detected in skill definition (${injectionCheck.patterns.length} pattern(s) matched)`,
          { message_thread_id: messageThreadId },
        );
        return true;
      }

      // wizard completed successfully, write the skill to filesystem
      const writeResult = await writeSkill(result.skill);

      // also persist to database for docker container restarts
      const dbSaved = await skillRegistry.addWizardSkill(
        result.skill.name,
        result.skill.description,
        skillContent,
        "MIT",
      );

      if (writeResult.success || dbSaved) {
        // refresh skill registry to pick up new skill
        await skillRegistry.refresh();

        // clear session so agent picks up new skill on next message
        await resetUserThreads(userId);

        await sendMessage(
          chatId,
          `skill "${result.skill.name}" created!\n\nthe agent will now have access to this skill. you can view it with \`/skill ${result.skill.name}\``,
          { message_thread_id: messageThreadId },
        );
      } else {
        await sendMessage(
          chatId,
          `failed to create skill: ${writeResult.error}`,
          { message_thread_id: messageThreadId },
        );
      }
    } else if (result.response) {
      // wizard aborted or error
      await sendMessage(chatId, result.response, {
        message_thread_id: messageThreadId,
      });
    }
  } else {
    // wizard continues, send next question
    await sendMessage(chatId, result.response, {
      message_thread_id: messageThreadId,
    });
  }

  return true;
}

// Process incoming message
async function processMessage(message: TelegramMessage): Promise<void> {
  if (!message.text) return;

  const chatId = message.chat.id;
  const userId = message.from?.id || chatId;
  const messageThreadId = message.message_thread_id;
  const text = message.text;

  // Check if system is paired (use async for postgres support)
  const systemPaired = await isSystemPairedAsync();
  if (!systemPaired) {
    // Check if message is a valid pairing code
    const validCode = await isValidPairingCodeAsync(text);
    if (validCode) {
      await markPairedAsync(userId);
      await sendMessage(
        chatId,
        "*Successfully Paired!*\n\n" +
          "Welcome to the tide pool! You can now start chatting with me.\n" +
          "Type /start to see what this crab can do!",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    // Not paired and message is not a valid code
    await sendMessage(
      chatId,
      "🔐 *Pairing Required*\n\n" +
        "Please provide the pairing code to continue.\n" +
        "Run `bun run setup` on the server to generate a code.",
      { message_thread_id: messageThreadId },
    );
    return;
  }

  // System is paired - check if this user is the paired user (use async for postgres)
  const userPaired = await isUserPairedAsync(userId);
  if (!userPaired) {
    await sendMessage(
      chatId,
      "🔐 *Access Denied*\n\n" +
        "This bot is already paired with another user.\n" +
        "Contact the administrator if you need access.",
      { message_thread_id: messageThreadId },
    );
    return;
  }

  // check if user is awaiting soul input
  if (await handleSoulInput(userId, chatId, messageThreadId, text)) {
    return;
  }

  // check if user has active skill wizard
  if (await handleSkillWizardInput(userId, chatId, messageThreadId, text)) {
    return;
  }

  // User is paired - process commands and messages
  if (text.startsWith("/")) {
    const parts = text.slice(1).split(" ");
    const commandName = parts[0] || "";
    const args = parts.slice(1).join(" ");
    const command = commands[commandName.toLowerCase()];

    if (command) {
      await command(userId, chatId, messageThreadId, args);
    } else {
      await sendMessage(
        chatId,
        "❓ Unknown command. Type /help for available commands.",
        { message_thread_id: messageThreadId },
      );
    }
    return;
  }

  // Regular message - process with agent
  const threadId = await resolveTelegramThreadId(userId, message);
  const agent = getOrCreateAgent(userId, threadId);

  // check if this is a reply to an assistant message
  let replyContext: string | undefined;
  if (message.reply_to_message?.text && message.reply_to_message.from?.is_bot) {
    // user is replying to a bot message, use it as context
    replyContext = message.reply_to_message.text.slice(0, 500);
    debug(`[bot] reply context: ${replyContext.slice(0, 100)}...`);
  }

  // create abort controller for this request
  const abortController = new AbortController();
  processingUsers.set(userId, abortController);

  // set up continuous typing indicator polling
  // telegram typing indicator lasts ~5 seconds, so we refresh every 4 seconds
  const typingInterval = setInterval(async () => {
    try {
      await sendChatAction(chatId, "typing", {
        message_thread_id: messageThreadId,
      });
    } catch {
      // ignore errors from typing indicator
    }
  }, 4000);

  // send initial typing indicator
  await sendChatAction(chatId, "typing", {
    message_thread_id: messageThreadId,
  });

  // callbacks for the agent
  const callbacks: AgentCallbacks = {
    onPlanReady: async (intent: string) => {
      const sentMessage = await sendMessage(chatId, intent, {
        message_thread_id: messageThreadId,
      });
      await bindTelegramBotMessage(userId, threadId, sentMessage);
      await sendChatAction(chatId, "typing", {
        message_thread_id: messageThreadId,
      });
    },
    onTyping: async () => {
      await sendChatAction(chatId, "typing", {
        message_thread_id: messageThreadId,
      });
    },
    abortSignal: abortController.signal,
  };

  try {
    const response = await agent.chat(text, callbacks, replyContext);
    clearInterval(typingInterval);
    processingUsers.delete(userId);

    // check if there was an interrupt queued while we finished
    const queuedMessage = interruptQueue.get(userId);
    if (queuedMessage) {
      interruptQueue.delete(userId);
      // process the queued message now
      await processMessage(queuedMessage);
      return;
    }

    const sentMessage = await sendMessage(chatId, response, {
      message_thread_id: messageThreadId,
    });
    await bindTelegramBotMessage(userId, threadId, sentMessage);
  } catch (error) {
    clearInterval(typingInterval);
    processingUsers.delete(userId);

    // if interrupted, the new message handler will take over
    if (error instanceof AgentInterruptedError) {
      debug(
        `[bot] agent interrupted for user ${userId}, handing off to new message`,
      );
      const queuedMessage = interruptQueue.get(userId);
      if (queuedMessage) {
        interruptQueue.delete(userId);
        await processMessage(queuedMessage);
      }
      return;
    }

    console.error("Error processing message:", error);
    const sentMessage = await sendMessage(
      chatId,
      "Sorry, I encountered an error processing your message. Please try again.",
      { message_thread_id: messageThreadId },
    );
    await bindTelegramBotMessage(userId, threadId, sentMessage);
  }
}

// Long polling for updates
async function getUpdates(offset?: number): Promise<TelegramUpdate[]> {
  return makeRequest("getUpdates", {
    offset,
    limit: 100,
    timeout: 30,
  });
}

// Main bot loop
export async function startBot(): Promise<void> {
  console.log("Starting Crusty...");

  // Verify bot token
  try {
    const me = await makeRequest<{ username: string }>("getMe");
    console.log(`connected as @${me.username}`);
  } catch (error) {
    console.error("failed to connect to telegram:", error);
    process.exit(1);
  }

  // ensure database is initialized before any commands run
  getDatabase();

  // initialize skill registry so /skills works before any agent is created
  await skillRegistry.initialize();

  // verify hooks are running (they should already be started from index.ts)
  const runningHooks = getRunningHooks();
  if (runningHooks.length > 0) {
    console.log(`[hooks] ${runningHooks.length} hook(s) running`);
  }

  // check pairing status
  if (await isSystemPairedAsync()) {
    console.log("bot is paired");
  } else {
    // in non-interactive mode (docker, piped output, etc), auto-generate a pairing code
    const isNonInteractive = !process.stdout.isTTY;
    if (isNonInteractive) {
      const code = generatePairingCode();
      await savePairingCodeAsync(code, 60);
      console.log("----------------------------------------");
      console.log("PAIRING CODE: " + code);
      console.log("----------------------------------------");
      console.log("send this code to the bot on telegram to pair");
      console.log("code expires in 60 minutes");
    } else {
      console.log(
        "bot is not paired - run `bun run setup` to generate pairing code",
      );
    }
  }

  // Set bot commands
  await makeRequest("setMyCommands", {
    commands: [
      { command: "start", description: "Start the bot" },
      { command: "new", description: "Start a fresh thread on next message" },
      { command: "clear", description: "Clear conversation history" },
      { command: "model", description: "View or change the AI model" },
      { command: "reminders", description: "View pending reminders" },
      { command: "soul", description: "View or set the bot's persona" },
      { command: "help", description: "Show help message" },
    ],
  });

  console.log("commands registered");
  console.log("crusty is scuttling! press ctrl+c to stop.\n");

  let offset: number | undefined;

  // Main polling loop
  while (true) {
    try {
      const updates = await getUpdates(offset);

      for (const update of updates) {
        offset = update.update_id + 1;

        // handle callback queries (inline keyboard buttons)
        if (update.callback_query) {
          handleCallbackQuery(update.callback_query).catch((error) =>
            console.error(
              `[Error handling callback from ${update.callback_query!.from.id}]:`,
              error,
            ),
          );
        }

        if (update.message) {
          const userId = update.message.from?.id || update.message.chat.id;
          const text = update.message.text || "";
          debug(
            `[Message from ${userId}]: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`,
          );

          // check if user is already being processed
          const existingController = processingUsers.get(userId);
          if (existingController) {
            // interrupt the current processing and queue new message
            debug(
              `[User ${userId} is busy, interrupting and queuing new message]`,
            );
            interruptQueue.set(userId, update.message);
            existingController.abort();
            continue;
          }

          // process message without blocking the polling loop
          processMessage(update.message).catch((error) =>
            console.error(`[Error processing message from ${userId}]:`, error),
          );
        }
      }
    } catch (error) {
      console.error("Error in polling loop:", error);
      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Cleanup function
export async function cleanupBot(): Promise<void> {
  console.log("\ncrusty is retreating to the shell...");

  // Cleanup all user sessions
  for (const [, agent] of userSessions) {
    await agent.cleanup();
  }
  userSessions.clear();

  // Cleanup tools
  await cleanupTools();

  console.log("cleanup complete. goodbye!");
}
