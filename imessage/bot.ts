// imessage bot adapter using sendblue
// receives messages via webhook server, sends via sendblue api
// mirrors the telegram bot architecture with session management and pairing

import {
  Agent,
  AgentInterruptedError,
  type AgentCallbacks,
} from "../core/agent.ts";
import { cleanupTools } from "../tools/registry.ts";
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
import { getDatabase } from "../data/db.ts";
import { debug } from "../utils/debug.ts";
import { SendBlueClient, type InboundMessage } from "./sendblue.ts";
import {
  isImessagePairedAsync,
  isImessageSystemPairedAsync,
  markImessagePairedAsync,
  isValidImessagePairingCode,
  loadImessagePairingData,
  loadImessagePairingDataAsync,
  generateImessagePairingCode,
  saveImessagePairingCodeAsync,
} from "./pairing";

// environment configuration
const SENDBLUE_API_KEY = process.env.SENDBLUE_API_KEY;
const SENDBLUE_API_SECRET = process.env.SENDBLUE_API_SECRET;
const SENDBLUE_FROM_NUMBER = process.env.SENDBLUE_FROM_NUMBER;
const SENDBLUE_WEBHOOK_PORT = parseInt(
  process.env.SENDBLUE_WEBHOOK_PORT || "3847",
  10,
);
const SENDBLUE_WEBHOOK_SECRET = process.env.SENDBLUE_WEBHOOK_SECRET;

// convert a phone number to a stable numeric user id for the agent system
// uses a simple hash so the same phone always maps to the same id
function phoneToUserId(phone: string): number {
  const cleaned = phone.replace(/\D/g, "");
  let hash = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // convert to 32bit int
  }
  // ensure positive and avoid collision with telegram user ids (which are large positive ints)
  // prefix with 2 billion range to separate from telegram id space
  return Math.abs(hash) + 2_000_000_000;
}

// max imessage length before we need to split
// sendblue supports up to 18996 chars but practical limit is lower for readability
const MAX_MESSAGE_LENGTH = 4000;

function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
}

// session management - one agent per phone number
const userSessions = new Map<number, Agent>();

// track which users are currently being processed with their abort controllers
const processingUsers = new Map<number, AbortController>();

// queue for interrupt messages
const interruptQueue = new Map<number, InboundMessage>();

// track users awaiting soul content input
const awaitingSoulInput = new Set<number>();

// deduplication set for message handles (sendblue may retry)
const processedMessages = new Set<string>();
const DEDUP_TTL = 60_000; // 1 minute

let client: SendBlueClient | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

function getClient(): SendBlueClient {
  if (!client) {
    throw new Error("sendblue client not initialized");
  }
  return client;
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

// get the paired phone number for heartbeat/hook messages
export function getPairedPhoneNumber(): string | null {
  const data = loadImessagePairingData();
  if (data?.used && data?.pairedPhone) {
    return data.pairedPhone;
  }
  return null;
}

export async function getPairedPhoneNumberAsync(): Promise<string | null> {
  const data = await loadImessagePairingDataAsync();
  if (data?.used && data?.pairedPhone) {
    return data.pairedPhone;
  }
  return null;
}

// get the paired user id (numeric hash) for heartbeat routing
export function getImessagePairedUserId(): number | null {
  const phone = getPairedPhoneNumber();
  if (!phone) return null;
  return phoneToUserId(phone);
}

export async function getImessagePairedUserIdAsync(): Promise<number | null> {
  const phone = await getPairedPhoneNumberAsync();
  if (!phone) return null;
  return phoneToUserId(phone);
}

// delivery gate - suppress heartbeat/hook ack messages
function shouldSuppressDelivery(
  text: string,
  isHeartbeatTick?: boolean,
): boolean {
  if (!isHeartbeatTick) return false;
  return text.trim() === "HEARTBEAT_OK" || text.trim() === "HOOK_OK";
}

// send a message via sendblue
export async function sendMessage(
  phoneNumber: string,
  text: string,
  options?: { isHeartbeat?: boolean },
): Promise<void> {
  if (shouldSuppressDelivery(text, options?.isHeartbeat)) {
    debug("[imessage] suppressed heartbeat/hook ack delivery");
    return;
  }

  const messageText = truncateMessage(text);

  try {
    await getClient().sendMessage({
      to: phoneNumber,
      content: messageText,
    });
  } catch (error) {
    console.error("[imessage] send failed:", error);
    throw error;
  }
}

// send a message using the numeric user id (for heartbeat compatibility)
export async function sendMessageToUser(
  _userId: number,
  text: string,
  options?: { isHeartbeat?: boolean },
): Promise<void> {
  const phone = await getPairedPhoneNumberAsync();
  if (!phone) {
    debug("[imessage] no paired phone, cannot send");
    return;
  }
  await sendMessage(phone, text, options);
}

async function sendTypingIndicator(phoneNumber: string): Promise<void> {
  try {
    await getClient().sendTypingIndicator(phoneNumber);
  } catch {
    // non-critical, swallow errors
  }
}

// command handlers - mirror telegram bot commands
const commands: Record<
  string,
  (userId: number, phone: string, args: string) => Promise<void>
> = {
  async start(userId, phone) {
    if (!await isImessageSystemPairedAsync()) {
      await sendMessage(
        phone,
        "Pairing Required\n\n" +
          "This bot requires a pairing code to start.\n\n" +
          'Run "bun run setup" on the server and select "Generate iMessage Pairing Code"\n' +
          "Then send the code here as your first message.",
      );
      return;
    }

    if (!await isImessagePairedAsync(phone)) {
      await sendMessage(
        phone,
        "Already Paired\n\n" +
          "This bot is already paired with another number.\n" +
          "Contact the administrator if you need access.",
      );
      return;
    }

    await sendMessage(
      phone,
      "Hey there! I'm Crusty, your friendly neighborhood crab assistant.\n\n" +
        "I can help you:\n" +
        "- Scuttle across websites and dig up information\n" +
        "- Answer questions with fresh data from the web\n" +
        "- Help with research - I love a good treasure hunt\n\n" +
        "Just send me a message or ask me to visit a website!\n\n" +
        "Available commands:\n" +
        "/clear - Clear our conversation history\n" +
        "/help - Show this help message",
    );
  },

  async help(userId, phone) {
    if (!await isImessagePairedAsync(phone)) {
      await sendMessage(
        phone,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
      );
      return;
    }

    await sendMessage(
      phone,
      "Crusty's Commands\n\n" +
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
        "- Scuttle across websites and summarize content\n" +
        '- Set reminders (try: "remind me in 10 minutes to...")\n' +
        "- Answer questions with my claws on the keyboard\n" +
        "- Help with research - digging is my specialty",
    );
  },

  async clear(userId, phone) {
    if (!await isImessagePairedAsync(phone)) {
      await sendMessage(
        phone,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
      );
      return;
    }

    await clearUserSession(userId);
    await sendMessage(
      phone,
      "Shell cleaned! Starting fresh with a blank tide pool.",
    );
  },

  async memory(userId, phone, args) {
    if (!await isImessagePairedAsync(phone)) {
      await sendMessage(
        phone,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
      );
      return;
    }

    const arg = args.trim().toLowerCase();

    if (arg === "clear") {
      await memoryService.clearUserMemories(userId);
      await sendMessage(phone, "memory banks wiped clean.");
      return;
    }

    const stats = await memoryService.getStats(userId);
    await sendMessage(
      phone,
      `Memory Stats\n\n` +
        `total memories: ${stats.total}\n` +
        `avg emotional weight: ${stats.avgWeight.toFixed(1)}/10`,
    );
  },

  async context(userId, phone) {
    if (!await isImessagePairedAsync(phone)) {
      await sendMessage(
        phone,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
      );
      return;
    }

    const agent = getOrCreateAgent(userId);
    await agent.initialize();
    const stats = agent.getContextStats();

    const tokenLine = stats.smartTokenCount.source === "tiktoken"
      ? `tokens: ~${stats.smartTokenCount.tokens} (tiktoken)`
      : stats.smartTokenCount.source === "actual"
        ? `tokens: ${stats.smartTokenCount.tokens} (actual)`
        : `tokens: ~${stats.smartTokenCount.tokens} (actual+delta)`;

    const usageLine = stats.actualUsage
      ? `\nlast api usage: ${stats.actualUsage.promptTokens} prompt / ${stats.actualUsage.completionTokens} completion`
      : "";

    await sendMessage(
      phone,
      `Context Stats\n\n` +
        `messages in context: ${stats.messageCount}\n` +
        `${tokenLine}${usageLine}\n` +
        `has summary: ${stats.hasSummary ? "yes" : "no"}\n` +
        `summary length: ${stats.summaryLength} chars`,
    );
  },

  async soul(userId, phone, args) {
    if (!await isImessagePairedAsync(phone)) {
      await sendMessage(
        phone,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
      );
      return;
    }

    const soulPath = join(process.cwd(), "cogs", "SOUL.md");
    const arg = args.trim().toLowerCase();

    if (arg === "new") {
      awaitingSoulInput.add(userId);
      await sendMessage(
        phone,
        "okay, what would you like your new soul to be?\n\n(send your persona content as the next message)",
      );
      return;
    }

    if (arg === "cancel") {
      if (awaitingSoulInput.has(userId)) {
        awaitingSoulInput.delete(userId);
        await sendMessage(phone, "soul update cancelled.");
      } else {
        await sendMessage(phone, "nothing to cancel.");
      }
      return;
    }

    try {
      const content = await Bun.file(soulPath).text();
      const truncated =
        content.length > 3500
          ? content.slice(0, 3500) + "\n\n... [truncated]"
          : content;
      await sendMessage(phone, `Current Soul:\n\n${truncated}`);
    } catch {
      await sendMessage(phone, "no soul file found.");
    }
  },

  async reminders(userId, phone) {
    if (!await isImessagePairedAsync(phone)) {
      await sendMessage(
        phone,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
      );
      return;
    }

    const reminders = await getUserReminders(userId);

    if (reminders.length === 0) {
      await sendMessage(
        phone,
        'no pending reminders.\n\njust tell me something like "remind me in 10 minutes to take a break"',
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
      phone,
      `pending reminders (${reminders.length}):\n\n${formatted}\n\nto cancel, just ask me to cancel a reminder`,
    );
  },

  async skill(userId, phone, args) {
    if (!await isImessagePairedAsync(phone)) {
      await sendMessage(
        phone,
        "This bot is not paired with you.\nPlease provide the pairing code first.",
      );
      return;
    }

    const arg = args.trim();
    const argLower = arg.toLowerCase();

    if (argLower === "new" || argLower === "create") {
      const firstQuestion = startWizard(userId);
      await sendMessage(
        phone,
        `creating new skill\n\n${firstQuestion}\n\n(type 'cancel' at any time to abort)`,
      );
      return;
    }

    if (argLower === "cancel") {
      if (cancelWizard(userId)) {
        await sendMessage(phone, "skill creation cancelled.");
      } else {
        await sendMessage(phone, "no skill wizard active.");
      }
      return;
    }

    if (argLower === "list" || argLower === "") {
      const skills = skillRegistry.listSkills();
      if (skills.length === 0) {
        await sendMessage(
          phone,
          "no skills found.\n\nuse /skill new to create one.",
        );
      } else {
        await sendMessage(
          phone,
          `available skills (${skills.length}):\n\n${skills.map((s) => `- ${s}`).join("\n")}\n\nuse /skill new to create a new one.`,
        );
      }
      return;
    }

    // /skill <url>
    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      await sendMessage(phone, "validating skill url...");

      const result = await fetchAndValidateSkillUrl(arg);

      if (!result.success) {
        await sendMessage(phone, `failed to load skill: ${result.error}`);
        return;
      }

      if (skillRegistry.hasSkill(result.skill!.name)) {
        await sendMessage(
          phone,
          `skill "${result.skill!.name}" already exists. remove it first or use a different name.`,
        );
        return;
      }

      const added = await skillRegistry.addUrlSkill(
        result.skill!.name,
        result.skill!.description,
        result.skill!.content,
        arg,
      );

      if (added) {
        await clearUserSession(userId);
        await sendMessage(
          phone,
          `skill "${result.skill!.name}" loaded successfully.\n\n` +
            `description: ${result.skill!.description}\n\n` +
            `the agent now has access to this skill.`,
        );
      } else {
        await sendMessage(phone, `failed to add skill to registry.`);
      }
      return;
    }

    // /skill <name>
    const skill = skillRegistry.getSkill(argLower);
    if (skill) {
      const truncated =
        skill.content.length > 3000
          ? skill.content.slice(0, 3000) + "\n\n... [truncated]"
          : skill.content;
      await sendMessage(
        phone,
        `skill: ${skill.meta.name}\n\n${skill.meta.description}\n\n---\n\n${truncated}`,
      );
    } else {
      await sendMessage(
        phone,
        `skill "${argLower}" not found.\n\nuse /skill list to see available skills.`,
      );
    }
  },
};

// handle soul content input
async function handleSoulInput(
  userId: number,
  phone: string,
  content: string,
): Promise<boolean> {
  if (!awaitingSoulInput.has(userId)) return false;

  awaitingSoulInput.delete(userId);
  const soulPath = join(process.cwd(), "cogs", "SOUL.md");

  try {
    await Bun.write(soulPath, content);
    debug(
      `[soul] updated by imessage user ${userId} (${content.length} chars)`,
    );
    await clearUserSession(userId);
    await sendMessage(
      phone,
      `done! new soul has been set (${content.length} chars). further messages will use the new persona.`,
    );
  } catch (error) {
    console.error("[soul] write failed:", error);
    await sendMessage(phone, "failed to update soul file.");
  }

  return true;
}

// handle skill wizard input
async function handleSkillWizardInput(
  userId: number,
  phone: string,
  content: string,
): Promise<boolean> {
  if (!hasActiveWizard(userId)) return false;

  const result = processWizardInput(userId, content);

  if (result.done) {
    if (result.skill) {
      const skillContent = generateSkillContent(result.skill);
      const injectionCheck = detectInjection(skillContent);
      if (injectionCheck.detected) {
        await sendMessage(
          phone,
          `skill blocked: suspicious content detected in skill definition (${injectionCheck.patterns.length} pattern(s) matched)`,
        );
        return true;
      }

      const writeResult = await writeSkill(result.skill);
      const dbSaved = await skillRegistry.addWizardSkill(
        result.skill.name,
        result.skill.description,
        skillContent,
        "MIT",
      );

      if (writeResult.success || dbSaved) {
        await skillRegistry.refresh();
        await clearUserSession(userId);
        await sendMessage(
          phone,
          `skill "${result.skill.name}" created!\n\nthe agent will now have access to this skill.`,
        );
      } else {
        await sendMessage(
          phone,
          `failed to create skill: ${writeResult.error}`,
        );
      }
    } else if (result.response) {
      await sendMessage(phone, result.response);
    }
  } else {
    await sendMessage(phone, result.response);
  }

  return true;
}

// process an inbound imessage
async function processInboundMessage(message: InboundMessage): Promise<void> {
  // skip outbound messages and empty content
  if (message.is_outbound || !message.content) return;

  const phone = message.from_number;
  const text = message.content;
  const userId = phoneToUserId(phone);

  // deduplicate webhook retries
  if (processedMessages.has(message.message_handle)) {
    debug(`[imessage] duplicate message ${message.message_handle}, skipping`);
    return;
  }
  processedMessages.add(message.message_handle);
  setTimeout(() => processedMessages.delete(message.message_handle), DEDUP_TTL);

  debug(
    `[imessage] from ${phone}: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`,
  );

  // pairing flow
  const systemPaired = await isImessageSystemPairedAsync();
  if (!systemPaired) {
    if (isValidImessagePairingCode(text)) {
      await markImessagePairedAsync(phone);
      await sendMessage(
        phone,
        "Successfully Paired!\n\n" +
          "Welcome to the tide pool! You can now start chatting with me.\n" +
          "Send /start to see what this crab can do!",
      );
      return;
    }

    await sendMessage(
      phone,
      "Pairing Required\n\n" +
        "Please provide the pairing code to continue.\n" +
        'Run "bun run setup" on the server to generate a code.',
    );
    return;
  }

  // check if this phone is the paired one
  if (!await isImessagePairedAsync(phone)) {
    await sendMessage(
      phone,
      "Access Denied\n\n" +
        "This bot is already paired with another number.\n" +
        "Contact the administrator if you need access.",
    );
    return;
  }

  // soul input handler
  if (await handleSoulInput(userId, phone, text)) return;

  // skill wizard handler
  if (await handleSkillWizardInput(userId, phone, text)) return;

  // command handling
  if (text.startsWith("/")) {
    const parts = text.slice(1).split(" ");
    const commandName = parts[0] || "";
    const args = parts.slice(1).join(" ");
    const command = commands[commandName.toLowerCase()];

    if (command) {
      await command(userId, phone, args);
    } else {
      await sendMessage(
        phone,
        "Unknown command. Send /help for available commands.",
      );
    }
    return;
  }

  // regular message - process with agent
  const agent = getOrCreateAgent(userId);

  const abortController = new AbortController();
  processingUsers.set(userId, abortController);

  // typing indicator polling - sendblue typing lasts a few seconds
  const typingInterval = setInterval(async () => {
    try {
      await sendTypingIndicator(phone);
    } catch {
      // ignore typing indicator errors
    }
  }, 4000);

  // send initial typing indicator
  await sendTypingIndicator(phone);

  const callbacks: AgentCallbacks = {
    onPlanReady: async (intent: string) => {
      await sendMessage(phone, intent);
      await sendTypingIndicator(phone);
    },
    onTyping: async () => {
      await sendTypingIndicator(phone);
    },
    abortSignal: abortController.signal,
  };

  try {
    const response = await agent.chat(text, callbacks);
    clearInterval(typingInterval);
    processingUsers.delete(userId);

    // check for queued interrupt message
    const queuedMessage = interruptQueue.get(userId);
    if (queuedMessage) {
      interruptQueue.delete(userId);
      await processInboundMessage(queuedMessage);
      return;
    }

    await sendMessage(phone, response);
  } catch (error) {
    clearInterval(typingInterval);
    processingUsers.delete(userId);

    if (error instanceof AgentInterruptedError) {
      debug(`[imessage] agent interrupted for ${phone}, handing off`);
      const queuedMessage = interruptQueue.get(userId);
      if (queuedMessage) {
        interruptQueue.delete(userId);
        await processInboundMessage(queuedMessage);
      }
      return;
    }

    console.error("[imessage] error processing message:", error);
    await sendMessage(
      phone,
      "Sorry, I encountered an error processing your message. Please try again.",
    );
  }
}

// webhook request handler for bun.serve
function handleWebhookRequest(req: Request): Response {
  const url = new URL(req.url);

  // health check endpoint
  if (url.pathname === "/health" && req.method === "GET") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // webhook endpoint for inbound messages
  if (url.pathname === "/webhook/receive" && req.method === "POST") {
    // verify webhook secret (mandatory for security)
    const reqSecret = req.headers.get("x-webhook-secret");
    if (!SENDBLUE_WEBHOOK_SECRET || reqSecret !== SENDBLUE_WEBHOOK_SECRET) {
      debug("[imessage] webhook secret mismatch or not configured, rejecting");
      return new Response("Unauthorized", { status: 401 });
    }

    // parse body and process asynchronously, respond 200 immediately
    req
      .json()
      .then((body: unknown) => {
        const message = body as InboundMessage;
        const userId = phoneToUserId(message.from_number);

        // check if user is already being processed (interrupt handling)
        const existingController = processingUsers.get(userId);
        if (existingController) {
          debug(`[imessage] user busy, interrupting and queuing`);
          interruptQueue.set(userId, message);
          existingController.abort();
          return;
        }

        processInboundMessage(message).catch((error) =>
          console.error("[imessage] webhook handler error:", error),
        );
      })
      .catch((error) => {
        console.error("[imessage] webhook parse error:", error);
      });

    // always respond 200 immediately to prevent sendblue retries
    return new Response("OK", { status: 200 });
  }

  return new Response("Not Found", { status: 404 });
}

// check if imessage integration is configured in environment
export function isImessageConfigured(): boolean {
  return !!(SENDBLUE_API_KEY && SENDBLUE_API_SECRET);
}

// start the imessage webhook server and sendblue client
export async function startImessageBot(): Promise<void> {
  if (!SENDBLUE_API_KEY || !SENDBLUE_API_SECRET) {
    debug(
      "[imessage] SENDBLUE_API_KEY or SENDBLUE_API_SECRET not set, skipping",
    );
    return;
  }

  if (!SENDBLUE_WEBHOOK_SECRET) {
    console.error("[imessage] CRITICAL: SENDBLUE_WEBHOOK_SECRET is required to secure the webhook endpoint.");
    console.error("[imessage] Without it, an attacker could spoof messages and gain remote code execution.");
    process.exit(1);
  }

  console.log("[imessage] starting imessage integration...");

  // initialize sendblue client
  client = new SendBlueClient({
    apiKey: SENDBLUE_API_KEY,
    apiSecret: SENDBLUE_API_SECRET,
    fromNumber: SENDBLUE_FROM_NUMBER,
  });

  // ensure database tables exist
  getDatabase();

  // initialize skill registry
  await skillRegistry.initialize();

  // start webhook server
  server = Bun.serve({
    port: SENDBLUE_WEBHOOK_PORT,
    fetch: handleWebhookRequest,
  });

  console.log(
    `[imessage] webhook server listening on port ${SENDBLUE_WEBHOOK_PORT}`,
  );

  // check pairing status
  if (await isImessageSystemPairedAsync()) {
    const data = await loadImessagePairingDataAsync();
    console.log(`[imessage] paired with ${data?.pairedPhone}`);
  } else {
    // auto-generate pairing code in non-interactive mode
    const isNonInteractive = !process.stdout.isTTY;
    if (isNonInteractive) {
      const code = generateImessagePairingCode();
      await saveImessagePairingCodeAsync(code, 60);
      console.log("----------------------------------------");
      console.log("IMESSAGE PAIRING CODE: " + code);
      console.log("----------------------------------------");
      console.log("send this code via imessage to the sendblue number to pair");
      console.log("code expires in 60 minutes");
    } else {
      console.log(
        '[imessage] not paired - run "bun run setup" to generate imessage pairing code',
      );
    }
  }

  // verify hooks are running
  const runningHooks = getRunningHooks();
  if (runningHooks.length > 0) {
    debug(`[imessage] ${runningHooks.length} hook(s) running`);
  }

  console.log("[imessage] ready to receive messages");
}

// cleanup function
export async function cleanupImessageBot(): Promise<void> {
  console.log("[imessage] shutting down...");

  if (server) {
    server.stop();
    server = null;
  }

  // cleanup all user sessions
  for (const [_userId, agent] of userSessions) {
    await agent.cleanup();
  }
  userSessions.clear();

  client = null;
  console.log("[imessage] cleanup complete");
}
