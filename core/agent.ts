import { OpenAI } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  getOpenAITools,
  getAvailableTools,
  executeTool,
  cleanupTools,
} from "../tools/registry.ts";
import { loadBootstrapSystem } from "./bootstrap.ts";
import { addRecentContext } from "../scheduler/context-buffer.ts";
import { memoryService } from "../memory/service.ts";
import { debug } from "../utils/debug.ts";
import { stripReasoningTags } from "../utils/reasoning.ts";
import { ContextManager } from "./context-manager";
import { conversationStore } from "./conversation-store";
import { withRetry, isRetryableError } from "../utils/retry.ts";
import { compressToolOutput } from "../utils/compress.ts";
import {
  shouldStoreMemory,
  shouldSuppressRandomRecall,
} from "../memory/gating.ts";
import { createPlan, classifyIntent, type TaskPlan } from "./planner.ts";
import { learningsService } from "../memory/learnings.ts";
import {
  formatLearningsForContext,
  captureToolFailure,
} from "../tools/learnings.ts";

// environment configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const SUMMARIZE_MODEL = process.env.SUMMARIZE_MODEL || OPENAI_MODEL || "gpt-4o";
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
  timeout: 60 * 1000,
});

// simple rate limiter with iterative wait loop (avoids stack growth)
class RateLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter(
        (ts) => now - ts < this.windowMs,
      );

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      const oldestTimestamp = this.timestamps[0]!;
      const waitTime = this.windowMs - (now - oldestTimestamp) + 10;
      debug(`[rate limit] waiting ${waitTime}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
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

// status phrases for different stages of task execution
const BEGINNING_OF_TASK_PHRASES = [
  "cracking my knuckles...",
  "ooh let me see...",
  "hmm interesting...",
  "flexing my claws...",
  "dusting off the cobwebs...",
  "time to get crabby with it...",
  "scuttling over to check...",
  "pinching into this one...",
];

const MIDDLE_OF_TASK_PHRASES = [
  "still scuttling along...",
  "deeper into the reef...",
  "claws deep in the sand now...",
  "following the current...",
  "piecing this together...",
  "the plot thickens...",
  "ooh this is getting interesting...",
  "hold my seaweed...",
];

const WRAPPING_UP_PHRASES = [
  "putting a bow on it...",
  "just polishing these shells...",
  "coming up for air...",
  "surfacing with answers...",
  "tying up loose tentacles...",
  "final pinch of magic...",
];

const TOOL_SPECIFIC_PHRASES: Record<string, string[]> = {
  browser: [
    "surfing the seas...",
    "diving into that page...",
    "casting my net across the ocean...",
    "following the digital current...",
  ],
  bash: [
    "whispering to the terminal...",
    "poking the shell... ",
    "summoning the command spirits...",
  ],
  read_file: [
    "squinting at these runes...",
    "deciphering the ancient texts...",
    "reading between the lines...",
  ],
  write_file: [
    "scribbling furiously...",
    "carving this into stone...",
    "leaving my mark...",
  ],
  search: [
    "hunting for treasure...",
    "combing through the sand...",
    "following the scent...",
  ],
  memory: [
    "consulting my shell collection...",
    "what did i stash here...",
    "ah yes i remember this...",
  ],
};

type TaskPhase = "beginning" | "middle" | "wrapping_up";

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function getPhaseFromProgress(
  iteration: number,
  maxIterations: number,
): TaskPhase {
  const progress = iteration / maxIterations;
  if (iteration === 0 || progress < 0.2) return "beginning";
  if (progress > 0.7) return "wrapping_up";
  return "middle";
}

function getStatusMessage(phase: TaskPhase, toolName?: string): string {
  // check for tool-specific phrase first
  if (toolName) {
    for (const [key, phrases] of Object.entries(TOOL_SPECIFIC_PHRASES)) {
      if (toolName.toLowerCase().includes(key)) {
        return pickRandom(phrases);
      }
    }
  }

  // fall back to phase-based phrases
  switch (phase) {
    case "beginning":
      return pickRandom(BEGINNING_OF_TASK_PHRASES);
    case "wrapping_up":
      return pickRandom(WRAPPING_UP_PHRASES);
    case "middle":
    default:
      return pickRandom(MIDDLE_OF_TASK_PHRASES);
  }
}

// convenience function for initial thinking state
function getThinkingMessage(): string {
  return pickRandom(BEGINNING_OF_TASK_PHRASES);
}

const MAX_TOOL_ITERATIONS = 50;
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
  abortSignal?: AbortSignal;
}

// error thrown when agent loop is interrupted by a new user message
export class AgentInterruptedError extends Error {
  constructor() {
    super("agent interrupted by user");
    this.name = "AgentInterruptedError";
  }
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

  // enhanced agentic loop with planning, retry, and compression
  async chat(
    userMessage: string,
    callbacks?: AgentCallbacks,
    replyContext?: string,
  ): Promise<string> {
    await this.initialize();

    // helper to check if we should abort
    const checkAbort = () => {
      if (callbacks?.abortSignal?.aborted) {
        debug(`[agent] interrupted by user`);
        throw new AgentInterruptedError();
      }
    };

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

    // selective memory integration with gating
    const suppressRandomRecall = shouldSuppressRandomRecall(userMessage);
    let memoryContext = "";
    if (!suppressRandomRecall) {
      memoryContext = await memoryService.buildMemoryContext(
        this.userId,
        userMessage,
      );
    }

    // learning machine: retrieve relevant learnings for context
    let learningContext = "";
    const relevantLearnings = await learningsService.searchLearnings(
      this.userId,
      userMessage,
      3,
    );
    if (relevantLearnings.length > 0) {
      learningContext = formatLearningsForContext(relevantLearnings);
      debug(
        `[agent] injected ${relevantLearnings.length} learnings into context`,
      );
    }

    // gated memory storage - only store durable facts
    const gatingResult = shouldStoreMemory({
      content: userMessage,
      role: "user",
      hasToolContext: false,
    });
    if (gatingResult.shouldStore) {
      await memoryService.storeMemory(
        this.userId,
        gatingResult.cleanedContent || userMessage,
      );
    }

    // build the user message with optional reply context
    let messageContent = userMessage;
    if (replyContext) {
      messageContent = `[replying to your previous message: "${replyContext}"]\n\n${userMessage}`;
      debug(`[agent] reply context attached`);
    }

    this._messages.push({ role: "user", content: messageContent });
    this.scheduleSave();

    // optional planning for complex tasks
    const intent = classifyIntent(userMessage);
    let taskPlan: TaskPlan | null = null;

    if (intent === "task" || intent === "command") {
      // build recent context for planning
      const recentContext = this._messages
        .slice(-6)
        .filter((m) => m.role !== "system")
        .map((m) => `${m.role}: ${String(m.content).slice(0, 200)}`)
        .join("\n");

      taskPlan = await createPlan(
        userMessage,
        recentContext,
        getAvailableTools(),
      );

      // if planner says clarification needed, ask before proceeding
      if (taskPlan?.needs_clarification && taskPlan.clarifying_question) {
        this._messages.push({
          role: "assistant",
          content: taskPlan.clarifying_question,
        });
        this.scheduleSave();
        return taskPlan.clarifying_question;
      }
    }

    const tools = getOpenAITools();
    let lastTextResponse = "";
    let toolIterationCount = 0;
    let lastAssistantText = "";
    let repeatAssistantCount = 0;
    let lastToolSignature = "";
    let repeatToolCount = 0;
    let loopGuardMessage: string | null = null;
    const toolResults: string[] = []; // track for verification

    // agentic loop: keep calling api until no more tool calls
    while (true) {
      // check for interrupt at start of each iteration
      checkAbort();

      if (callbacks?.onTyping) await callbacks.onTyping();

      // build messages with context window management
      // combine memory and learning contexts
      const combinedContext =
        [memoryContext, learningContext].filter(Boolean).join("\n\n") ||
        undefined;
      const messagesForModel = this.contextManager.buildMessagesForModel(
        this._messages,
        combinedContext,
      );

      // status update for slow api calls with phase-aware messaging
      const currentPhase = getPhaseFromProgress(
        toolIterationCount,
        MAX_TOOL_ITERATIONS,
      );
      let statusSent = false;
      const statusTimeout = setTimeout(async () => {
        if (callbacks?.onStatusUpdate) {
          await callbacks.onStatusUpdate(getStatusMessage(currentPhase));
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
        // api call with automatic retry for transient errors
        response = await withRetry(
          () =>
            openai.chat.completions.create({
              model: OPENAI_MODEL,
              messages: validMessages,
              tools: tools.length > 0 ? tools : undefined,
              tool_choice: tools.length > 0 ? "auto" : undefined,
            }),
          { maxRetries: 2, baseDelayMs: 1000 },
        );
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

      // check for interrupt after api call completes
      checkAbort();

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

      // add assistant message to history (strip reasoning tags to reduce context bloat)
      const cleanedContent = stripReasoningTags(content);
      this._messages.push({
        role: "assistant",
        content: cleanedContent,
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
        // check for interrupt before each tool execution
        checkAbort();

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

        // show tool execution status with tool-aware messaging
        if (callbacks?.onStatusUpdate) {
          const phase = getPhaseFromProgress(
            toolIterationCount,
            MAX_TOOL_ITERATIONS,
          );
          const statusMsg = getStatusMessage(phase, name);
          await callbacks.onStatusUpdate(statusMsg);
        }

        let result: string;
        try {
          result = await executeTool(name, args, this.userId, content);
          debug(`[result]: ${result.slice(0, 200)}...`);
        } catch (error) {
          // capture tool failure for learning machine
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result = `[Error] ${errorMessage}`;
          debug(`[tool error]: ${errorMessage}`);

          // auto-capture the failure (fire and forget)
          captureToolFailure(
            this.userId,
            name,
            errorMessage,
            args.slice(0, 200),
          ).catch(() => {});
        }

        // track results for potential verification
        toolResults.push(result.slice(0, 500));

        // compress large tool outputs before storing in context
        const compressedResult = compressToolOutput(result, name);
        this._messages.push({
          role: "tool",
          content: compressedResult,
          tool_call_id: toolCall.id,
        });
      }
    }

    if (loopGuardMessage) {
      this._messages.push({ role: "assistant", content: loopGuardMessage });
    }

    // log plan outcome for future reference
    if (taskPlan) {
      debug(
        `[planner] completed: ${taskPlan.intent} (${toolResults.length} tool results)`,
      );
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
