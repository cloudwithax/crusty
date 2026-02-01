import { OpenAI } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
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
import { stripReasoningTags } from "../utils/reasoning.ts";
import { ContextManager } from "./context-manager";
import { conversationStore } from "./conversation-store";

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

// combined cleanup for model responses
function cleanModelResponse(text: string): string {
  return stripEmojis(stripReasoningTags(text));
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

const MAX_TOOL_ITERATIONS = 25;
const MAX_REPEAT_ASSISTANT_MESSAGES = 2;
const MAX_REPEAT_TOOL_SIGNATURES = 2;

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const sorted: Record<string, unknown> = {};

    for (const [key, val] of entries) {
      sorted[key] = sortObjectKeys(val);
    }

    return sorted;
  }

  return value;
}

function normalizeToolArgs(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(sortObjectKeys(parsed));
  } catch {
    return trimmed;
  }
}

function buildToolSignature(
  toolCalls: ChatCompletionMessageToolCall[],
): string {
  return toolCalls
    .map((toolCall) => {
      if (toolCall.type === "function" && "function" in toolCall) {
        const name = toolCall.function?.name ?? "unknown";
        const args = toolCall.function?.arguments ?? "";
        return `${name}:${normalizeToolArgs(args)}`;
      }

      if (toolCall.type === "custom" && "custom" in toolCall) {
        const name = toolCall.custom?.name ?? "custom";
        const input = toolCall.custom?.input ?? "";
        return `${name}:${normalizeToolArgs(input)}`;
      }

      return "unknown:";
    })
    .join("|");
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
    let toolIterationCount = 0;
    let lastAssistantText = "";
    let repeatAssistantCount = 0;
    let lastToolSignature = "";
    let repeatToolCount = 0;
    let loopGuardMessage: string | null = null;

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

      // validate and fix messages before sending to api
      const validMessages = messagesForModel
        .map((msg) => {
          // fix assistant messages with missing content
          if (msg.role === "assistant") {
            const hasToolCalls =
              (msg as any).tool_calls && (msg as any).tool_calls.length > 0;
            const hasContent =
              msg.content &&
              (typeof msg.content === "string" ? msg.content.trim() : true);

            // assistant must have content or tool_calls
            if (!hasContent && !hasToolCalls) {
              return null; // drop invalid message
            }

            // if has tool_calls but no content, set empty string
            if (hasToolCalls && !msg.content) {
              return { ...msg, content: "" };
            }
          }

          // ensure tool messages have content
          if (msg.role === "tool" && msg.content === undefined) {
            return null;
          }

          return msg;
        })
        .filter((msg): msg is ChatCompletionMessageParam => msg !== null);

      if (validMessages.length === 0) {
        debug("[api] no valid messages to send");
        break;
      }

      let response;
      try {
        response = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: validMessages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? "auto" : undefined,
        });
      } catch (apiError) {
        clearTimeout(statusTimeout);

        // extract detailed error info from openai sdk
        let errorDetails = "unknown error";
        if (apiError instanceof Error) {
          errorDetails = apiError.message;

          // openai sdk errors have additional properties
          const anyError = apiError as any;
          if (anyError.status) {
            errorDetails = `${anyError.status} status code`;
          }
          if (anyError.error) {
            // detailed error from api response body
            const errorBody =
              typeof anyError.error === "string"
                ? anyError.error
                : JSON.stringify(anyError.error);
            errorDetails += ` - ${errorBody}`;
          }
        }

        debug(`[api error: ${errorDetails}]`);
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
        lastTextResponse = cleanModelResponse(content);
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

      toolIterationCount += 1;

      const normalizedContent = cleanModelResponse(content).toLowerCase();
      if (normalizedContent) {
        if (normalizedContent === lastAssistantText) {
          repeatAssistantCount += 1;
        } else {
          lastAssistantText = normalizedContent;
          repeatAssistantCount = 0;
        }
      }

      const toolSignature = buildToolSignature(toolCalls);
      if (toolSignature) {
        if (toolSignature === lastToolSignature) {
          repeatToolCount += 1;
        } else {
          lastToolSignature = toolSignature;
          repeatToolCount = 0;
        }
      }

      let loopReason: string | null = null;
      if (toolIterationCount > MAX_TOOL_ITERATIONS) {
        loopReason = "too many tool iterations";
      } else if (repeatAssistantCount >= MAX_REPEAT_ASSISTANT_MESSAGES) {
        loopReason = "repeating assistant response";
      } else if (repeatToolCount >= MAX_REPEAT_TOOL_SIGNATURES) {
        loopReason = "repeating tool calls";
      }

      if (loopReason) {
        loopGuardMessage =
          "i got stuck in a tool loop and stopped to avoid repeating myself. please try again.";
        lastTextResponse = loopGuardMessage;
        debug(`[tool loop guard] ${loopReason}`);

        for (const toolCall of toolCalls) {
          this._messages.push({
            role: "tool",
            content: `error: tool call stopped to avoid loop (${loopReason})`,
            tool_call_id: toolCall.id,
          });
        }

        break;
      }

      // execute tools and collect results
      for (const toolCall of toolCalls) {
        if (callbacks?.onTyping) await callbacks.onTyping();

        // handle both standard function type and custom/alternative formats
        let name: string;
        let args: string;

        if (toolCall.type === "function" && toolCall.function) {
          name = toolCall.function.name;
          args = toolCall.function.arguments ?? "";
        } else {
          // fallback for non-standard tool call formats (some providers use different structures)
          const anyCall = toolCall as unknown as Record<string, unknown>;
          const fn = anyCall.function as
            | { name?: string; arguments?: string }
            | undefined;
          const custom = anyCall.custom as
            | { name?: string; input?: string }
            | undefined;

          name = fn?.name ?? custom?.name ?? String(anyCall.name ?? "unknown");
          args =
            fn?.arguments ??
            custom?.input ??
            String(anyCall.arguments ?? anyCall.input ?? "{}");
        }

        debug(`[tool: ${name}]`);
        debug(`[args raw]: ${args.slice(0, 500)}`);

        // show tool execution to user
        if (callbacks?.onStatusUpdate && content.trim()) {
          await callbacks.onStatusUpdate(cleanModelResponse(content));
        }

        const result = await executeTool(name, args, this.userId, content);
        debug(`[result]: ${result.slice(0, 200)}...`);

        this._messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        });
      }
    }

    if (loopGuardMessage) {
      this._messages.push({ role: "assistant", content: loopGuardMessage });
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
}
