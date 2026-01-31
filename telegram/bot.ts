import { Agent, type AgentCallbacks } from "../core/agent.ts";
import { cleanupTools } from "../tools/registry.ts";
import {
  isValidPairingCodeAsync,
  markPairedAsync,
  isUserPairedAsync,
  isSystemPairedAsync,
  loadPairingData,
  generatePairingCode,
  savePairingCode,
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
  listSkillNames,
} from "../core/skill-wizard.ts";
import { skillRegistry } from "../core/skills.ts";
import { fetchAndValidateSkillUrl } from "../core/skill-url.ts";
import { debug } from "../utils/debug.ts";

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

// Session management - one agent per user (only for paired users)
const userSessions = new Map<number, Agent>();

// track which users are currently being processed to prevent race conditions
const processingUsers = new Set<number>();

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

function getOrCreateAgent(userId: number): Agent {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, new Agent(userId));
  }
  return userSessions.get(userId)!;
}

async function clearUserSession(userId: number): Promise<void> {
  const agent = userSessions.get(userId);
  if (agent) {
    await agent.clearMemoryAndPersist();
    userSessions.delete(userId);
  }
}

// Telegram API helpers
async function makeRequest<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${API_BASE}/${method}`;
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json() as { ok: boolean; result: T; description?: string };
  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description || "Unknown error"}`);
  }

  return result.result;
}

// Delivery gate helper - checks if message should be suppressed
// Returns true if message was suppressed (heartbeat tick with HEARTBEAT_OK)
export function shouldSuppressDelivery(text: string, isHeartbeatTick?: boolean): boolean {
  if (!isHeartbeatTick) {
    return false;
  }
  return text.trim() === "HEARTBEAT_OK";
}

// Exported sendMessage for use by heartbeat module
export async function sendMessage(
  chatId: number,
  text: string,
  options?: { reply_markup?: unknown; message_thread_id?: number; parse_mode?: string; isHeartbeat?: boolean }
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
  options?: { message_thread_id?: number }
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
  (userId: number, chatId: number, messageThreadId: number | undefined, args: string) => Promise<void>
> = {
  async start(userId, chatId, messageThreadId) {
    if (!(await isSystemPairedAsync())) {
      await sendMessage(
        chatId,
        "🔐 *Pairing Required*\n\n" +
        "This bot requires a pairing code to start.\n\n" +
        "Please run `bun run setup` on the server and select \"Generate Pairing Code\"\n" +
        "Then send the code here as your first message.",
        { message_thread_id: messageThreadId }
      );
      return;
    }

    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 *Already Paired*\n\n" +
        "This bot is already paired with another user.\n" +
        "Contact the administrator if you need access.",
        { message_thread_id: messageThreadId }
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
      "Just send me a message or ask me to visit a website!\n\n" +
      "Available commands:\n" +
      "/clear - Clear our conversation history\n" +
      "/help - Show this help message",
      { message_thread_id: messageThreadId }
    );
  },

  async help(userId, chatId, messageThreadId) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
        "Please provide the pairing code first.",
        { message_thread_id: messageThreadId }
      );
      return;
    }

    await sendMessage(
      chatId,
      "*Crusty's Commands*\n\n" +
      "/start - Wake up the crab\n" +
      "/clear - Clean the shell (clear conversation)\n" +
      "/memory - View memory stats\n" +
      "/memory clear - Wipe long-term memory\n" +
      "/reminders - View pending reminders\n" +
      "/soul - View current persona\n" +
      "/soul new - Define a new persona\n" +
      "/skill - List available skills\n" +
      "/skill new - Create a new skill\n" +
      "/skill <name> - View skill details\n" +
      "/skill <url> - Load skill from URL\n" +
      "/help - Show this message\n\n" +
      "You can also just chat with me naturally. I can:\n" +
      "• Scuttle across websites and summarize content\n" +
      "• Set reminders (try: \"remind me in 10 minutes to...\")\n" +
      "• Answer questions with my claws on the keyboard\n" +
      "• Help with research - digging is my specialty\n\n" +
      "Try asking: \"What's on example.com?\"",
      { message_thread_id: messageThreadId }
    );
  },

  async clear(userId, chatId, messageThreadId) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
        "Please provide the pairing code first.",
        { message_thread_id: messageThreadId }
      );
      return;
    }

    await clearUserSession(userId);
    await sendMessage(chatId, "Shell cleaned! Starting fresh with a blank tide pool.", { message_thread_id: messageThreadId });
  },

  async memory(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
        "Please provide the pairing code first.",
        { message_thread_id: messageThreadId }
      );
      return;
    }

    const arg = args.trim().toLowerCase();

    if (arg === "clear") {
      await memoryService.clearUserMemories(userId);
      await sendMessage(chatId, "memory banks wiped clean.", { message_thread_id: messageThreadId });
      return;
    }

    // show memory stats
    const stats = await memoryService.getStats(userId);
    await sendMessage(
      chatId,
      `*Memory Stats*\n\n` +
      `total memories: ${stats.total}\n` +
      `avg emotional weight: ${stats.avgWeight.toFixed(1)}/10`,
      { message_thread_id: messageThreadId }
    );
  },

  async context(userId, chatId, messageThreadId, _args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
        "Please provide the pairing code first.",
        { message_thread_id: messageThreadId }
      );
      return;
    }

    const agent = getOrCreateAgent(userId);
    await agent.initialize();
    const stats = agent.getContextStats();

    await sendMessage(
      chatId,
      `*Context Stats*\n\n` +
      `messages in context: ${stats.messageCount}\n` +
      `estimated tokens: ${stats.estimatedTokens}\n` +
      `has summary: ${stats.hasSummary ? "yes" : "no"}\n` +
      `summary length: ${stats.summaryLength} chars`,
      { message_thread_id: messageThreadId }
    );
  },

  async soul(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "🔐 This bot is not paired with you.\n" +
        "Please provide the pairing code first.",
        { message_thread_id: messageThreadId }
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
        { message_thread_id: messageThreadId }
      );
      return;
    }

    // /soul cancel - abort if waiting
    if (arg === "cancel") {
      if (awaitingSoulInput.has(userId)) {
        awaitingSoulInput.delete(userId);
        await sendMessage(chatId, "soul update cancelled.", { message_thread_id: messageThreadId });
      } else {
        await sendMessage(chatId, "nothing to cancel.", { message_thread_id: messageThreadId });
      }
      return;
    }

    // /soul (no args) = show current soul
    try {
      const content = await Bun.file(soulPath).text();
      const truncated = content.length > 3500 ? content.slice(0, 3500) + "\n\n... [truncated]" : content;
      await sendMessage(chatId, `*Current Soul:*\n\n${truncated}`, { message_thread_id: messageThreadId });
    } catch {
      await sendMessage(chatId, "no soul file found.", { message_thread_id: messageThreadId });
    }
  },

  async reminders(userId, chatId, messageThreadId) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\n" +
        "Please provide the pairing code first.",
        { message_thread_id: messageThreadId }
      );
      return;
    }

    const reminders = await getUserReminders(userId);

    if (reminders.length === 0) {
      await sendMessage(
        chatId,
        "no pending reminders.\n\njust tell me something like \"remind me in 10 minutes to take a break\"",
        { message_thread_id: messageThreadId }
      );
      return;
    }

    const formatted = reminders.map((r) => {
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
    }).join("\n");

    await sendMessage(
      chatId,
      `*pending reminders (${reminders.length}):*\n\n${formatted}\n\nto cancel, just ask me to cancel a reminder`,
      { message_thread_id: messageThreadId }
    );
  },

  async skill(userId, chatId, messageThreadId, args) {
    if (!(await isUserPairedAsync(userId))) {
      await sendMessage(
        chatId,
        "This bot is not paired with you.\n" +
        "Please provide the pairing code first.",
        { message_thread_id: messageThreadId }
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
        { message_thread_id: messageThreadId }
      );
      return;
    }

    // /skill cancel - abort wizard
    if (argLower === "cancel") {
      if (cancelWizard(userId)) {
        await sendMessage(chatId, "skill creation cancelled.", { message_thread_id: messageThreadId });
      } else {
        await sendMessage(chatId, "no skill wizard active.", { message_thread_id: messageThreadId });
      }
      return;
    }

    // /skill list - show available skills
    if (argLower === "list" || argLower === "") {
      const skills = listSkillNames();
      if (skills.length === 0) {
        await sendMessage(
          chatId,
          "no skills found.\n\nuse `/skill new` to create one.",
          { message_thread_id: messageThreadId }
        );
      } else {
        await sendMessage(
          chatId,
          `*available skills (${skills.length}):*\n\n${skills.map(s => `• ${s}`).join("\n")}\n\nuse \`/skill new\` to create a new one.`,
          { message_thread_id: messageThreadId }
        );
      }
      return;
    }

    // /skill <url> - load skill from url
    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      await sendMessage(chatId, "validating skill url...", { message_thread_id: messageThreadId });

      const result = await fetchAndValidateSkillUrl(arg);

      if (!result.success) {
        await sendMessage(
          chatId,
          `failed to load skill: ${result.error}`,
          { message_thread_id: messageThreadId }
        );
        return;
      }

      // check if skill already exists
      if (skillRegistry.hasSkill(result.skill!.name)) {
        await sendMessage(
          chatId,
          `skill "${result.skill!.name}" already exists. remove it first or use a different name.`,
          { message_thread_id: messageThreadId }
        );
        return;
      }

      // add the skill to the registry
      const added = skillRegistry.addUrlSkill(
        result.skill!.name,
        result.skill!.description,
        result.skill!.content,
        arg
      );

      if (added) {
        // clear session so agent picks up new skill on next message
        await clearUserSession(userId);

        await sendMessage(
          chatId,
          `skill "${result.skill!.name}" loaded successfully.\n\n` +
          `description: ${result.skill!.description}\n\n` +
          `the agent now has access to this skill.`,
          { message_thread_id: messageThreadId }
        );
      } else {
        await sendMessage(
          chatId,
          `failed to add skill to registry.`,
          { message_thread_id: messageThreadId }
        );
      }
      return;
    }

    // /skill <name> - show skill details
    const skill = skillRegistry.getSkill(argLower);
    if (skill) {
      const truncated = skill.content.length > 3000
        ? skill.content.slice(0, 3000) + "\n\n... [truncated]"
        : skill.content;
      await sendMessage(
        chatId,
        `*skill: ${skill.meta.name}*\n\n${skill.meta.description}\n\n---\n\n${truncated}`,
        { message_thread_id: messageThreadId }
      );
    } else {
      await sendMessage(
        chatId,
        `skill "${argLower}" not found.\n\nuse \`/skill list\` to see available skills.`,
        { message_thread_id: messageThreadId }
      );
    }
  },
};

// handle soul content input (called when user is in awaiting state)
async function handleSoulInput(
  userId: number,
  chatId: number,
  messageThreadId: number | undefined,
  content: string
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
    await clearUserSession(userId);

    await sendMessage(
      chatId,
      `done! new soul has been set (${content.length} chars). further messages will use the new persona.`,
      { message_thread_id: messageThreadId }
    );
  } catch (error) {
    console.error("[soul] write failed:", error);
    await sendMessage(chatId, "failed to update soul file.", { message_thread_id: messageThreadId });
  }

  return true;
}

// handle skill wizard input (called when user has active wizard)
async function handleSkillWizardInput(
  userId: number,
  chatId: number,
  messageThreadId: number | undefined,
  content: string
): Promise<boolean> {
  if (!hasActiveWizard(userId)) {
    return false;
  }

  const result = processWizardInput(userId, content);

  if (result.done) {
    if (result.skill) {
      // wizard completed successfully, write the skill
      const writeResult = await writeSkill(result.skill);

      if (writeResult.success) {
        // refresh skill registry to pick up new skill
        await skillRegistry.refresh();

        // clear session so agent picks up new skill on next message
        await clearUserSession(userId);

        await sendMessage(
          chatId,
          `skill "${result.skill.name}" created!\n\nthe agent will now have access to this skill. you can view it with \`/skill ${result.skill.name}\``,
          { message_thread_id: messageThreadId }
        );
      } else {
        await sendMessage(
          chatId,
          `failed to create skill: ${writeResult.error}`,
          { message_thread_id: messageThreadId }
        );
      }
    } else if (result.response) {
      // wizard aborted or error
      await sendMessage(chatId, result.response, { message_thread_id: messageThreadId });
    }
  } else {
    // wizard continues, send next question
    await sendMessage(chatId, result.response, { message_thread_id: messageThreadId });
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
        { message_thread_id: messageThreadId }
      );
      return;
    }

    // Not paired and message is not a valid code
    await sendMessage(
      chatId,
      "🔐 *Pairing Required*\n\n" +
      "Please provide the pairing code to continue.\n" +
      "Run `bun run setup` on the server to generate a code.",
      { message_thread_id: messageThreadId }
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
      { message_thread_id: messageThreadId }
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
      await sendMessage(chatId, "❓ Unknown command. Type /help for available commands.", { message_thread_id: messageThreadId });
    }
    return;
  }

  // Regular message - process with agent
  const agent = getOrCreateAgent(userId);

  // set up continuous typing indicator polling
  // telegram typing indicator lasts ~5 seconds, so we refresh every 4 seconds
  const typingInterval = setInterval(async () => {
    try {
      await sendChatAction(chatId, "typing", { message_thread_id: messageThreadId });
    } catch {
      // ignore errors from typing indicator
    }
  }, 4000);

  // send initial typing indicator
  await sendChatAction(chatId, "typing", { message_thread_id: messageThreadId });

  // callbacks for the agent to send real-time updates
  const callbacks: AgentCallbacks = {
    onStatusUpdate: async (message: string) => {
      await sendMessage(chatId, message, { message_thread_id: messageThreadId });
      // refresh typing after sending a status message
      await sendChatAction(chatId, "typing", { message_thread_id: messageThreadId });
    },
    onTyping: async () => {
      await sendChatAction(chatId, "typing", { message_thread_id: messageThreadId });
    },
  };

  try {
    const response = await agent.chat(text, callbacks);
    clearInterval(typingInterval);
    await sendMessage(chatId, response, { message_thread_id: messageThreadId });
  } catch (error) {
    clearInterval(typingInterval);
    console.error("Error processing message:", error);
    await sendMessage(
      chatId,
      "Sorry, I encountered an error processing your message. Please try again.",
      { message_thread_id: messageThreadId }
    );
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

  // check pairing status
  if (await isSystemPairedAsync()) {
    console.log("bot is paired");
  } else {
    // in non-interactive mode (docker, piped output, etc), auto-generate a pairing code
    const isNonInteractive = !process.stdout.isTTY;
    if (isNonInteractive) {
      const code = generatePairingCode();
      savePairingCode(code, 60);
      console.log("----------------------------------------");
      console.log("PAIRING CODE: " + code);
      console.log("----------------------------------------");
      console.log("send this code to the bot on telegram to pair");
      console.log("code expires in 60 minutes");
    } else {
      console.log("bot is not paired - run `bun run setup` to generate pairing code");
    }
  }

  // Set bot commands
  await makeRequest("setMyCommands", {
    commands: [
      { command: "start", description: "Start the bot" },
      { command: "clear", description: "Clear conversation history" },
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

        if (update.message) {
          const userId = update.message.from?.id || update.message.chat.id;
          const text = update.message.text || "";
          debug(`[Message from ${userId}]: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`);

          // skip if user is already being processed
          if (processingUsers.has(userId)) {
            debug(`[User ${userId} is busy, queuing will happen on next poll]`);
            continue;
          }

          // process message without blocking the polling loop
          processingUsers.add(userId);
          processMessage(update.message)
            .catch((error) => console.error(`[Error processing message from ${userId}]:`, error))
            .finally(() => processingUsers.delete(userId));
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
  for (const [userId, agent] of userSessions) {
    await agent.cleanup();
  }
  userSessions.clear();

  // Cleanup tools
  await cleanupTools();

  console.log("cleanup complete. goodbye!");
}
