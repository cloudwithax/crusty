import { OpenAI } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  generateOpenAITools,
  executeTool,
  cleanupTools,
} from "../tools/registry.ts";
import { loadBootstrapSystem } from "./bootstrap.ts";
import { addRecentContext } from "../scheduler/heartbeat.ts";
import { memoryService } from "../memory/service.ts";
import { debug } from "../utils/debug.ts";
import { ContextManager } from "./context-manager";
import { conversationStore } from "./conversation-store";
import { CodingAgent, isCodingTask } from "./coding-agent.ts";

// environment configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const INFERENCE_RPM_LIMIT = parseInt(
  process.env.INFERENCE_RPM_LIMIT || "40",
  10,
);

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 30 * 1000,
});

// simple rate limiter
class RateLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((ts) => now - ts < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const oldestTimestamp = this.timestamps[0]!;
      const waitTime = this.windowMs - (now - oldestTimestamp) + 10;
      debug(`[rate limit] waiting ${waitTime}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.acquire();
    }

    this.timestamps.push(now);
  }
}

const rateLimiter = new RateLimiter(INFERENCE_RPM_LIMIT);

// build system prompt from bootstrap
async function getSystemPrompt(): Promise<string> {
  const now = new Date();
  const timeString = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const coreInstructions = `Current time: ${timeString}\nWorking directory: ${process.cwd()}`;
  const { prompt } = await loadBootstrapSystem(coreInstructions);
  return prompt;
}

// strip emojis from responses
function stripEmojis(text: string): string {
  return text
    .replace(
      /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]/gu,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

// whimsical status messages
const thinkingMessages = [
  "still crunching on this one...",
  "the gears are turning...",
  "hold tight, almost there....",
  "one sec, gathering my thoughts...",
  "my claws are typing furiously...",
  "just a moment, connecting the dots...",
  "pontificating...",
  "let me chew on that for a bit...",
  "hmm... interesting...",
  "analyzing the bits and bytes...",
];

function getRandomMessage(messages: string[]): string {
  return messages[Math.floor(Math.random() * messages.length)] || messages[0]!;
}

export interface AgentCallbacks {
  onStatusUpdate?: (message: string) => Promise<void>;
  onTyping?: () => Promise<void>;
}

export class Agent {
  private _messages: ChatCompletionMessageParam[];
  private userId: number;
  private initialized: boolean = false;
  private contextManager: ContextManager;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  get messages(): ChatCompletionMessageParam[] {
    return this._messages;
  }

  constructor(userId: number = 0) {
    this.userId = userId;
    this._messages = [];
    this.contextManager = new ContextManager();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const systemPrompt = await getSystemPrompt();
    const stored = await conversationStore().load(this.userId);

    if (stored && stored.messages.length > 0) {
      debug(`[agent] restored ${stored.messages.length} messages`);
      const firstIsSystem = stored.messages[0]?.role === "system";
      this._messages = firstIsSystem
        ? [
            { role: "system", content: systemPrompt },
            ...stored.messages.slice(1),
          ]
        : [{ role: "system", content: systemPrompt }, ...stored.messages];

      if (stored.summary) {
        this.contextManager = new ContextManager(stored.summary);
      }
    } else {
      this._messages = [{ role: "system", content: systemPrompt }];
    }

    this.initialized = true;
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      this.saveConversation().catch((err) =>
        debug(`[agent] save failed:`, err),
      );
    }, 1000);
  }

  async saveConversation(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    await conversationStore().save(
      this.userId,
      this._messages,
      this.contextManager.summary,
    );
  }

  // nanocode-style agentic loop: call api until no more tools
  async chat(userMessage: string, callbacks?: AgentCallbacks): Promise<string> {
    await this.initialize();

    // detect coding tasks and delegate to coding agent
    if (await isCodingTask(userMessage)) {
      debug("[agent] detected coding task, delegating to coding agent");
      return this.handleCodingTask(userMessage, callbacks);
    }

    // context management
    const { summarized, messagesToDrop } =
      await this.contextManager.maybeSummarize(this._messages);
    if (summarized && messagesToDrop > 0) {
      this._messages = this.contextManager.pruneMessages(
        this._messages,
        messagesToDrop,
      );
      debug(`[agent] context pruned`);
    }

    // memory integration
    const memoryContext = await memoryService.buildMemoryContext(
      this.userId,
      userMessage,
    );
    await memoryService.storeMemory(this.userId, userMessage);

    this._messages.push({ role: "user", content: userMessage });
    this.scheduleSave();

    const tools = generateOpenAITools();
    let lastTextResponse = "";

    // agentic loop: keep calling api until no more tool calls
    while (true) {
      if (callbacks?.onTyping) await callbacks.onTyping();

      // build messages with context window management
      const messagesForModel = this.contextManager.buildMessagesForModel(
        this._messages,
        memoryContext || undefined,
      );

      // status update for slow api calls
      let statusSent = false;
      const statusTimeout = setTimeout(async () => {
        if (callbacks?.onStatusUpdate) {
          await callbacks.onStatusUpdate(getRandomMessage(thinkingMessages));
          statusSent = true;
        }
      }, 3000);

      await rateLimiter.acquire();

      let response;
      try {
        response = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: messagesForModel,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? "auto" : undefined,
        });
      } catch (apiError) {
        clearTimeout(statusTimeout);
        const msg =
          apiError instanceof Error ? apiError.message : "Unknown error";
        debug(`[api error: ${msg}]`);
        return (
          lastTextResponse || "i ran into a connection issue. please try again."
        );
      }

      clearTimeout(statusTimeout);
      if (statusSent && callbacks?.onTyping) await callbacks.onTyping();

      const choice = response.choices[0];
      if (!choice) {
        debug("[no choice in response]");
        break;
      }

      const message = choice.message;
      const content = message.content || "";
      const toolCalls = message.tool_calls || [];

      // collect text response
      if (content.trim()) {
        lastTextResponse = stripEmojis(content.trim());
        debug(`[text]: ${lastTextResponse.slice(0, 100)}...`);
      }

      // add assistant message to history
      this._messages.push({
        role: "assistant",
        content: content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      // no tools = done
      if (toolCalls.length === 0) {
        break;
      }

      // execute tools and collect results
      for (const toolCall of toolCalls) {
        if (callbacks?.onTyping) await callbacks.onTyping();

        const fn = (toolCall as { function: { name: string; arguments: string } }).function;
        const name = fn.name;
        const args = fn.arguments;

        debug(`[tool: ${name}]`);

        // show tool execution to user
        if (callbacks?.onStatusUpdate && content.trim()) {
          await callbacks.onStatusUpdate(stripEmojis(content.trim()));
        }

        const result = await executeTool(name, args, this.userId);
        debug(`[result]: ${result.slice(0, 200)}...`);

        this._messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        });
      }
    }

    // log for self-review
    addRecentContext(`user: ${userMessage}\n\nassistant: ${lastTextResponse}`);
    this.scheduleSave();

    return (
      lastTextResponse || "i couldn't complete that request. please try again."
    );
  }

  getMemory(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  getContextStats(): {
    messageCount: number;
    estimatedTokens: number;
    hasSummary: boolean;
    summaryLength: number;
  } {
    return this.contextManager.getStats(this._messages);
  }

  clearMemory(): void {
    const systemMessage = this._messages[0];
    this._messages = systemMessage ? [systemMessage] : [];
    this.contextManager = new ContextManager();
  }

  async clearMemoryAndPersist(): Promise<void> {
    this.clearMemory();
    await conversationStore().clear(this.userId);
  }

  async cleanup(): Promise<void> {
    await this.saveConversation();
    await cleanupTools();
  }

  // handle coding tasks with plan-then-execute react loop
  private async handleCodingTask(
    userMessage: string,
    callbacks?: AgentCallbacks,
  ): Promise<string> {
    const codingAgent = new CodingAgent();
    const responses: string[] = [];

    // notify user we're starting a coding task
    if (callbacks?.onStatusUpdate) {
      await callbacks.onStatusUpdate("analyzing your coding request...");
    }

    try {
      const { plan, result } = await codingAgent.run(userMessage, {
        onTyping: callbacks?.onTyping,

        onPlanReady: async (plan) => {
          if (callbacks?.onStatusUpdate) {
            // send plan summary (first ~500 chars)
            const planPreview =
              plan.length > 500
                ? plan.slice(0, 500) + "...\n\n[executing plan]"
                : plan;
            await callbacks.onStatusUpdate(`**plan:**\n${planPreview}`);
          }
          responses.push(`## plan\n${plan}`);
        },

        onThought: async (thought) => {
          debug(`[coding thought]: ${thought}`);
          // optionally surface thoughts to user
        },

        onAction: async (tool, preview) => {
          if (callbacks?.onStatusUpdate) {
            await callbacks.onStatusUpdate(`${tool}(${preview}...)`);
          }
        },

        onObservation: async (result) => {
          debug(`[coding observation]: ${result.slice(0, 100)}`);
        },

        onComplete: async (summary) => {
          responses.push(`## result\n${summary}`);
        },
      });

      // store in conversation history
      this._messages.push({ role: "user", content: userMessage });
      this._messages.push({ role: "assistant", content: result });
      this.scheduleSave();

      // log for self-review
      addRecentContext(`user: ${userMessage}\n\nassistant: ${result}`);

      return result || "coding task completed.";
    } catch (err) {
      const errorMsg = `coding agent error: ${err instanceof Error ? err.message : String(err)}`;
      debug(`[coding error]: ${errorMsg}`);
      return errorMsg;
    } finally {
      await codingAgent.cleanup();
    }
  }
}
