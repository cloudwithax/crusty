import { nativeChatCompletion } from "./api.ts";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import {
  getOpenAITools,
  getAvailableTools,
  executeTool,
  cleanupTools,
} from "../tools/registry.ts";
import {
  consumePendingModelChangeNotice,
  getCurrentModel,
} from "./model-state.ts";
import { loadBootstrapSystem } from "./bootstrap.ts";
import { addRecentContext } from "../scheduler/context-buffer.ts";
import { memoryService } from "../memory/service.ts";
import { debug } from "../utils/debug.ts";
import {
  stripReasoningTags,
  stripProviderArtifacts,
} from "../utils/reasoning.ts";
import { ContextManager } from "./context-manager";
import { conversationStore } from "./conversation-store";
import { withRetry } from "../utils/retry.ts";
import { compressToolOutput } from "../utils/compress.ts";
import {
  shouldStoreMemory,
  shouldSuppressRandomRecall,
} from "../memory/gating.ts";
import { createPlan, classifyIntent, type TaskPlan } from "./planner.ts";
import { skillRegistry } from "./skills.ts";
import { getDefaultWorkspace } from "./workspace.ts";
import { learningsService } from "../memory/learnings.ts";
import {
  formatLearningsForContext,
  captureToolFailure,
} from "../tools/learnings.ts";
import {
  shouldTriggerFlush,
  markFlushPerformed,
  getMemoryFlushConfig,
  archiveConversation,
} from "../memory/memory-flush.ts";
import {
  recordTokenUsage,
  clearTokenUsage,
  getLastTokenUsage,
  getSmartTokenCount,
} from "./context-config";
import { parseToolCalls, logRawResponse } from "./tool-parser";

// environment configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// re-export model accessors so callers (telegram/bot.ts) don't need to know about model-state
export { getCurrentModel, setCurrentModel } from "./model-state.ts";

const INFERENCE_RPM_LIMIT = parseInt(
  process.env.INFERENCE_RPM_LIMIT || "40",
  10,
);

const DEFAULT_CONVERSATION_THREAD_ID = "default";

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

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
    let attempts = 0;
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter(
        (ts) => now - ts < this.windowMs,
      );

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      attempts++;
      const oldestTimestamp = this.timestamps[0]!;
      const baseWait = this.windowMs - (now - oldestTimestamp) + 10;
      // add exponential backoff/jitter based on attempts to prevent thundering herd
      const backoff = Math.min(100 * Math.pow(2, attempts - 1), 5000);
      const jitter = Math.random() * backoff;
      const waitTime = baseWait + jitter;

      debug(`[rate limit] waiting ${Math.round(waitTime)}ms`);
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

  const coreInstructions = `Current time: ${timeString}\nWorking directory: ${getDefaultWorkspace()}`;
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
  return stripEmojis(stripReasoningTags(stripProviderArtifacts(text)));
}

// normalize message.content which may be a string, null, or an array of content parts
// some providers (nvidia nim, etc) return structured content arrays instead of plain strings
function normalizeContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part: any) =>
          part && typeof part === "object" && part.type === "text" && part.text,
      )
      .map((part: any) => part.text)
      .join("");
  }
  // single content-part object
  if (
    typeof content === "object" &&
    (content as any).type === "text" &&
    (content as any).text
  ) {
    return (content as any).text;
  }
  return String(content);
}

// step tracking for dynamic status updates
interface AgentStep {
  tool: string;
  summary: string;
  timestamp: number;
}

class StepTracker {
  private steps: AgentStep[] = [];

  addStep(tool: string, args: string): void {
    const summary = this.summarizeStep(tool, args);
    this.steps.push({ tool, summary, timestamp: Date.now() });
  }

  private summarizeStep(tool: string, args: string): string {
    // extract key info from tool execution for human-readable summary
    try {
      const parsed = JSON.parse(args);

      switch (tool) {
        case "browser_navigate":
        case "browser_go_to_url":
          return `visited ${parsed.url || "a webpage"}`;
        case "browser_snapshot":
          return `scanned page structure`;
        case "browser_act":
          return `${parsed.action || "interacted with"} element [${parsed.ref || "?"}]`;
        case "browser_tabs":
          return `${parsed.action || "managed"} browser tabs`;
        case "browser_wait":
          return `waited for ${parsed.condition || "page"} to be ready`;
        case "browser_search":
        case "web_search":
          return `searched for "${parsed.query || "something"}"`;
        case "web_fetch":
          return `fetched ${parsed.url || "a page"}`;
        case "read_file":
          return `read ${this.extractFilename(parsed.path || parsed.file_path || "")}`;
        case "write_file":
        case "create_file":
          return `wrote to ${this.extractFilename(parsed.path || parsed.file_path || "")}`;
        case "bash":
        case "execute_command":
          return `ran command: ${(parsed.command || "").slice(0, 50)}`;
        case "search_files":
        case "grep":
          return `searched files for "${parsed.pattern || parsed.query || ""}"`;
        case "list_directory":
        case "list_dir":
          return `listed ${this.extractFilename(parsed.path || "") || "directory"}`;
        case "save_memory":
          return `saved a memory`;
        case "recall_memory":
        case "search_memory":
          return `searched memories`;
        case "save_learning":
          return `recorded a learning`;
        case "search_learnings":
          return `checked past learnings`;
        case "deep_research":
          return `running deep research on "${parsed.topic || "a topic"}"`;
        default:
          return `used ${tool.replace(/_/g, " ")}`;
      }
    } catch {
      return `used ${tool.replace(/_/g, " ")}`;
    }
  }

  private extractFilename(path: string): string {
    if (!path) return "";
    const parts = path.split(/[\/\\]/);
    return parts[parts.length - 1] || path;
  }

  generateStatus(): string {
    if (this.steps.length === 0) {
      return "thinking...";
    }

    // get recent steps (last 10 seconds worth, or last 5 steps max)
    const tenSecondsAgo = Date.now() - 10000;
    const recentSteps = this.steps
      .filter((s) => s.timestamp > tenSecondsAgo)
      .slice(-5);

    if (recentSteps.length === 0) {
      // no recent activity, summarize last step
      const lastStep = this.steps[this.steps.length - 1];
      return lastStep ? `last action: ${lastStep.summary}` : "working on it...";
    }

    if (recentSteps.length === 1) {
      return recentSteps[0]!.summary;
    }

    // combine recent steps into a summary
    const uniqueActions = [...new Set(recentSteps.map((s) => s.summary))];
    if (uniqueActions.length === 1) {
      return uniqueActions[0]!;
    }

    // group by type and summarize
    if (uniqueActions.length <= 3) {
      return uniqueActions.join(", then ");
    }

    return `${uniqueActions.slice(0, 2).join(", ")} and ${uniqueActions.length - 2} more steps`;
  }

  getStepCount(): number {
    return this.steps.length;
  }

  clear(): void {
    this.steps = [];
  }
}

function buildToolOnlyFallback(
  stepTracker: StepTracker,
  toolResults: string[],
): string {
  const recentSteps = stepTracker.generateStatus();
  const firstMeaningfulResult = toolResults
    .map((result) => result.trim())
    .find((result) => result.length > 0);

  if (firstMeaningfulResult) {
    return `i completed the tool work but the model did not produce a final write-up. recent action: ${recentSteps}

best available result:
${firstMeaningfulResult}`;
  }

  return `i completed the tool work but the model did not produce a final write-up. recent action: ${recentSteps}`;
}

const MAX_TOOL_ITERATIONS = 50;
const ITERATION_WARNING_THRESHOLD = 40; // warn when this many iterations used
const ITERATION_EXTENSION_AMOUNT = 25; // how many extra iterations to grant
const MAX_EXTENSIONS = 3; // max times agent can extend
const MAX_REPEAT_ASSISTANT_MESSAGES = 10;
const MAX_REPEAT_TOOL_SIGNATURES = 4;

// scary system message to inject when nearing iteration limit
const ITERATION_WARNING_MESSAGE = `
=======================================================================
                    CRITICAL: ITERATION LIMIT WARNING
=======================================================================

YOU ARE RUNNING OUT OF TOOL ITERATIONS.

Iterations used: {{USED}} / {{MAX}}
Remaining: {{REMAINING}}

IF YOU NEED MORE TIME TO COMPLETE THIS TASK, YOU MUST CALL THE
"request_more_iterations" TOOL IMMEDIATELY.

IF YOU DO NOT CALL THIS TOOL AND RUN OUT OF ITERATIONS:
- Your work will be TERMINATED
- The user will receive an INCOMPLETE response
- Any progress will be LOST

ONLY request more iterations if you genuinely need them to complete
the task. Do not request them just to be safe.

=======================================================================
`;

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

export function ensureToolCallIds(toolCalls: ChatCompletionMessageToolCall[]): {
  toolCalls: ChatCompletionMessageToolCall[];
  repairedCount: number;
} {
  const now = Date.now();
  let repairedCount = 0;
  const normalized = toolCalls.map((toolCall, idx) => {
    const id = (toolCall as { id?: string }).id;
    if (typeof id === "string" && id.trim()) {
      return toolCall;
    }

    repairedCount += 1;
    return {
      ...toolCall,
      id: `tc_${now}_${idx}`,
    };
  });

  return { toolCalls: normalized, repairedCount };
}

export interface AgentCallbacks {
  onPlanReady?: (intent: string) => Promise<void>;
  onTyping?: () => Promise<void>;
  abortSignal?: AbortSignal;
}

type UserImageContentPart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

type UserTextContentPart = {
  type: "text";
  text: string;
};

type UserMessageContent =
  | string
  | Array<UserTextContentPart | UserImageContentPart>;

interface ChatInputOptions {
  userContent?: UserMessageContent;
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
  private threadId: string;
  private initialized: boolean = false;
  private contextManager: ContextManager;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  get messages(): ChatCompletionMessageParam[] {
    return this._messages;
  }

  constructor(userId: number = 0, options?: { threadId?: string }) {
    this.userId = userId;
    this.threadId = options?.threadId || DEFAULT_CONVERSATION_THREAD_ID;
    this._messages = [];
    this.contextManager = new ContextManager();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const systemPrompt = await getSystemPrompt();
    const stored = await conversationStore().load(this.userId, this.threadId);

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
      this.threadId,
      this._messages,
      this.contextManager.summary,
    );
  }

  // enhanced agentic loop with planning, retry, and compression
  async chat(
    userMessage: string,
    callbacks?: AgentCallbacks,
    replyContext?: string,
    inputOptions?: ChatInputOptions,
  ): Promise<string> {
    await this.initialize();

    // pre-compaction memory flush
    // triggered when approaching context limit to preserve important information
    const flushConfig = getMemoryFlushConfig();
    if (
      flushConfig.enabled &&
      shouldTriggerFlush(this.userId, this._messages, flushConfig)
    ) {
      debug(`[agent] triggering pre-compaction memory flush`);

      // archive the current conversation before compaction
      await archiveConversation(this.userId, this._messages);
      markFlushPerformed(this.userId);
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

    const modelChangeNotice = await consumePendingModelChangeNotice();
    if (modelChangeNotice) {
      debug("[agent] injected one-time model change notice into context");
    }

    // build the user message with optional multimodal content and reply context
    let messageContent: UserMessageContent =
      inputOptions?.userContent ?? userMessage;
    if (replyContext) {
      const replyPrefix = `[replying to your previous message: "${replyContext}"]\n\n`;
      if (typeof messageContent === "string") {
        messageContent = `${replyPrefix}${messageContent}`;
      } else {
        messageContent = [
          { type: "text", text: replyPrefix },
          ...messageContent,
        ];
      }
      debug(`[agent] reply context attached`);
    }

    this._messages.push({ role: "user", content: messageContent as any });
    this.scheduleSave();

    // optional planning for complex tasks
    const intent = classifyIntent(userMessage);
    let taskPlan: TaskPlan | null = null;

    if (intent === "task" || intent === "command") {
      // build recent context for planning
      const recentContext = this._messages
        .slice(-6)
        .filter((m) => m.role !== "system")
        .map((m) => `${m.role}: ${normalizeContent(m.content).slice(0, 200)}`)
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

    // auto-inject coding agent skill when planner detects a coding project
    if (taskPlan?.work_mode === "coding_project") {
      const codingSkill = await skillRegistry.loadSkillContent("coding-agent");
      if (codingSkill) {
        this._messages.push({
          role: "system",
          content: codingSkill,
        });
        debug(`[agent] coding agent skill auto-injected`);
      }
    }

    // OUTER RUN LOOP
    const maxRunAttempts = 3;
    let runAttempt = 0;

    while (runAttempt < maxRunAttempts) {
      try {
        const combinedContext =
          [memoryContext, learningContext, modelChangeNotice]
            .filter(Boolean)
            .join("\n\n") || undefined;
        return await this.executeAttempt(
          combinedContext,
          taskPlan,
          userMessage,
          callbacks,
        );
      } catch (error: any) {
        if (this.isContextOverflowError(error)) {
          debug(
            `[agent] Caught context overflow, summarizing and retrying attempt (${runAttempt + 1}/${maxRunAttempts})`,
          );
          this.truncateOversizedToolResults();
          const { summarized, messagesToDrop } =
            await this.contextManager.maybeSummarize(this._messages, true);
          if (summarized && messagesToDrop > 0) {
            this._messages = this.contextManager.pruneMessages(
              this._messages,
              messagesToDrop,
            );
          }
          runAttempt++;
          if (runAttempt >= maxRunAttempts) {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }

    return "i couldn't complete that request. please try again.";
  }

  private isContextOverflowError(error: any): boolean {
    if (!error) return false;
    const msg = error.message?.toLowerCase() || String(error).toLowerCase();
    return (
      msg.includes("context_length_exceeded") ||
      msg.includes("maximum context length") ||
      msg.includes("too many tokens") ||
      msg.includes("context window")
    );
  }

  private truncateOversizedToolResults(): void {
    let truncated = false;
    for (const msg of this._messages) {
      if (
        msg.role === "tool" &&
        typeof msg.content === "string" &&
        msg.content.length > 50000
      ) {
        msg.content =
          msg.content.substring(0, 50000) + "\n...[truncated due to length]...";
        truncated = true;
      }
    }
    if (truncated) {
      debug(
        "[agent] Truncated oversized tool results to help with context overflow",
      );
    }
  }

  private buildValidMessages(
    messagesForModel: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const systemMessages: ChatCompletionMessageParam[] = [];
    const otherMessages: ChatCompletionMessageParam[] = [];

    for (const msg of messagesForModel) {
      let processedMsg: ChatCompletionMessageParam | null = msg;

      // validate and normalize
      if (msg.role === "assistant") {
        const hasToolCalls =
          (msg as any).tool_calls && (msg as any).tool_calls.length > 0;
        const hasContent =
          msg.content &&
          (typeof msg.content === "string" ? msg.content.trim() : true);

        if (!hasContent && !hasToolCalls) {
          continue; // skip invalid assistant message
        }

        if (hasToolCalls && !msg.content) {
          processedMsg = { ...msg, content: "" };
        }
      }

      if (processedMsg.role === "tool" && processedMsg.content === undefined) {
        continue;
      }

      // separate system messages to ensure they all appear first
      if (processedMsg.role === "system") {
        systemMessages.push(processedMsg);
      } else {
        otherMessages.push(processedMsg);
      }
    }

    // combine: all system messages first, then everything else in original order
    return [...systemMessages, ...otherMessages];
  }

  private async generateFinalToolResponse(
    combinedContext: string | undefined,
    callbacks?: AgentCallbacks,
  ): Promise<string> {
    const finalPrompt: ChatCompletionMessageParam = {
      role: "user",
      content:
        "you have already finished using tools. now answer the user directly in plain text using the tool results already in context. do not call tools. if the results are incomplete, say what you were able to find.",
    };

    const messagesForModel = this.contextManager.buildMessagesForModel(
      [...this._messages, finalPrompt],
      combinedContext,
    );
    const validMessages = this.buildValidMessages(messagesForModel);

    if (validMessages.length === 0) {
      debug("[agent] finalization skipped - no valid messages");
      return "";
    }

    await rateLimiter.acquire();

    try {
      const response = await withRetry(
        () =>
          nativeChatCompletion(
            {
              model: getCurrentModel(),
              messages: validMessages,
            },
            callbacks?.abortSignal,
          ),
        { maxRetries: 10, baseDelayMs: 1000, maxDelayMs: 60000 },
      );

      const finalMessage = response.choices[0]?.message;
      const finalContent = cleanModelResponse(
        normalizeContent(finalMessage?.content),
      );

      if (!finalContent) {
        debug("[agent] finalization returned empty content");
        return "";
      }

      this._messages.push({
        role: "user",
        content: finalPrompt.content,
      });
      this._messages.push({
        role: "assistant",
        content: stripReasoningTags(normalizeContent(finalMessage?.content)),
      });

      debug("[agent] finalized response after tool execution");
      return finalContent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debug(`[agent] finalization failed: ${errorMessage}`);
      return "";
    }
  }

  private async executeAttempt(
    combinedContext: string | undefined,
    taskPlan: TaskPlan | null,
    userMessage: string,
    callbacks?: AgentCallbacks,
  ): Promise<string> {
    // helper to check if we should abort
    const checkAbort = () => {
      if (callbacks?.abortSignal?.aborted) {
        debug(`[agent] interrupted by user`);
        throw new AgentInterruptedError();
      }
    };
    const tools = getOpenAITools();
    let lastTextResponse = "";
    let toolIterationCount = 0;
    let lastAssistantText = "";
    let repeatAssistantCount = 0;
    let lastToolSignature = "";
    let repeatToolCount = 0;
    let loopGuardMessage: string | null = null;
    const toolResults: string[] = []; // track for verification
    let hadToolError = false;
    let actionNudgeSent = false; // ensure we only nudge once per conversation turn
    const stepTracker = new StepTracker();

    // iteration extension tracking
    let currentMaxIterations = MAX_TOOL_ITERATIONS;
    let extensionCount = 0;
    let warningInjected = false;
    let pendingIterationWarning: string | null = null;
    let loopRecoveryAttempts = 0;

    // send plan intent once if planner produced one
    if (callbacks?.onPlanReady && taskPlan?.intent) {
      await callbacks.onPlanReady(taskPlan.intent);
    }

    // agentic loop: keep calling api until no more tool calls
    while (true) {
      // check for interrupt at start of each iteration
      checkAbort();

      if (callbacks?.onTyping) await callbacks.onTyping();

      // build messages with context window management
      // combine memory and learning contexts
      const messagesForModel = this.contextManager.buildMessagesForModel(
        this._messages,
        combinedContext,
      );

      await rateLimiter.acquire();

      // validate and fix messages before sending to api
      const validMessages = this.buildValidMessages(messagesForModel);

      if (validMessages.length === 0) {
        debug("[api] no valid messages to send");
        break;
      }

      let response;
      try {
        // api call with automatic retry for transient errors
        response = await withRetry(
          () =>
            nativeChatCompletion(
              {
                model: getCurrentModel(),
                messages: validMessages,
                tools: tools.length > 0 ? tools : undefined,
                tool_choice: tools.length > 0 ? "auto" : undefined,
              },
              callbacks?.abortSignal,
            ),
          { maxRetries: 10, baseDelayMs: 1000, maxDelayMs: 60000 },
        );
      } catch (apiError) {
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

        debug(`[api error after retries: ${errorDetails}]`);
        return (
          lastTextResponse ||
          "the inference endpoint is not responding after multiple retries. this could be a provider outage or network issue - give it a few minutes and try again."
        );
      }

      // check for interrupt after api call completes
      checkAbort();

      // capture actual token usage from api response
      if (response.usage) {
        recordTokenUsage(this.userId, response.usage, validMessages.length);
      }

      const choice = response.choices[0];
      if (!choice) {
        debug("[no choice in response]");
        break;
      }

      const message = choice.message;
      let content = normalizeContent(message.content);
      let toolCalls = message.tool_calls || [];

      // some providers embed tool calls as plain text rather than the structured
      // tool_calls field — detect and translate into standard format
      if (toolCalls.length === 0) {
        const parsed = parseToolCalls(content, getCurrentModel());
        if (parsed && parsed.toolCalls.length > 0) {
          toolCalls = parsed.toolCalls;
          content = parsed.textContent;
          debug(
            `[tool-parser] parsed ${toolCalls.length} text-embedded tool call(s) from ${parsed.format}`,
          );
        }
      }

      const normalizedToolCalls = ensureToolCallIds(toolCalls);
      if (normalizedToolCalls.repairedCount > 0) {
        debug(
          `[agent] repaired ${normalizedToolCalls.repairedCount} tool call id(s)`,
        );
      }
      toolCalls = normalizedToolCalls.toolCalls;

      // collect text response - only from final (non-tool) iterations.
      // text produced alongside tool calls is intermediate reasoning (e.g. "let me
      // think about how to do this...") and should NOT be shown to the user.
      // only the model's final text (when it stops calling tools) is the real answer.
      if (content.trim() && toolCalls.length === 0) {
        const cleaned = cleanModelResponse(content);
        if (cleaned) {
          lastTextResponse = cleaned;
        }
        debug(`[text]: ${(cleaned || lastTextResponse).slice(0, 100)}...`);
      } else if (content.trim() && toolCalls.length > 0) {
        debug(
          `[intermediate text suppressed]: ${cleanModelResponse(content).slice(0, 100)}...`,
        );
      }

      // add assistant message to history (strip reasoning tags to reduce context bloat)
      const cleanedContent = stripReasoningTags(content);
      const rawReasoningContent = (message as any).reasoning_content;
      const assistantMessage: any = {
        role: "assistant",
        content: cleanedContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };

      // some providers require reasoning_content on assistant tool-call turns when
      // thinking/reasoning mode is enabled so preserve it when available and backfill
      // with visible content as a compatibility fallback when absent
      if (
        typeof rawReasoningContent === "string" &&
        rawReasoningContent.trim()
      ) {
        assistantMessage.reasoning_content = rawReasoningContent;
      } else if (toolCalls.length > 0) {
        assistantMessage.reasoning_content = cleanedContent || content || " ";
      }

      this._messages.push({
        ...assistantMessage,
      });

      // no tools = done, but nudge the model once if it talked instead of acting on a task
      if (toolCalls.length === 0) {
        const isTask = taskPlan !== null;
        const nothingDoneYet = toolResults.length === 0;
        if (isTask && nothingDoneYet && !actionNudgeSent) {
          actionNudgeSent = true;
          this._messages.push({
            role: "user",
            content:
              "stop planning in text. start executing right now using your tools. do not explain what you're going to do - just do it.",
          });
          debug(
            "[agent] model returned text-only on first task turn - nudging to use tools",
          );
          continue;
        }
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

      // check if agent requested more iterations
      const extensionRequest = toolCalls.find(
        (tc) =>
          tc.type === "function" &&
          tc.function?.name === "request_more_iterations",
      );

      if (extensionRequest) {
        if (extensionCount < MAX_EXTENSIONS) {
          extensionCount += 1;
          currentMaxIterations += ITERATION_EXTENSION_AMOUNT;
          warningInjected = false; // reset warning flag for next threshold
          debug(
            `[agent] iteration extension granted (${extensionCount}/${MAX_EXTENSIONS}), new max: ${currentMaxIterations}`,
          );

          // respond to the tool call
          this._messages.push({
            role: "tool",
            content: `granted ${ITERATION_EXTENSION_AMOUNT} additional iterations. new limit: ${currentMaxIterations}. extensions remaining: ${MAX_EXTENSIONS - extensionCount}`,
            tool_call_id: extensionRequest.id,
          });

          // skip this tool call in the execution loop below
        } else {
          debug(`[agent] iteration extension denied - max extensions reached`);
          this._messages.push({
            role: "tool",
            content: `denied. you have already used all ${MAX_EXTENSIONS} extensions. wrap up your work now.`,
            tool_call_id: extensionRequest.id,
          });
        }
      }

      // inject warning when approaching limit (only once per threshold)
      const iterationsRemaining = currentMaxIterations - toolIterationCount;
      const shouldWarn =
        !warningInjected &&
        toolIterationCount >= ITERATION_WARNING_THRESHOLD &&
        iterationsRemaining <= 10;

      if (shouldWarn) {
        warningInjected = true;
        pendingIterationWarning = ITERATION_WARNING_MESSAGE.replace(
          "{{USED}}",
          String(toolIterationCount),
        )
          .replace("{{MAX}}", String(currentMaxIterations))
          .replace("{{REMAINING}}", String(iterationsRemaining));

        debug(
          `[agent] iteration warning injected at ${toolIterationCount}/${currentMaxIterations}`,
        );
      }

      let loopReason: string | null = null;
      if (toolIterationCount > currentMaxIterations) {
        loopReason = "too many tool iterations";
      } else if (repeatAssistantCount >= MAX_REPEAT_ASSISTANT_MESSAGES) {
        loopReason = "repeating assistant response";
      } else if (repeatToolCount >= MAX_REPEAT_TOOL_SIGNATURES) {
        loopReason = "repeating tool calls";
      }

      if (loopReason) {
        if (
          loopRecoveryAttempts < 3 &&
          loopReason !== "too many tool iterations"
        ) {
          loopRecoveryAttempts += 1;
          repeatAssistantCount = 0;
          repeatToolCount = 0;

          debug(
            `[tool loop guard] caught loop (${loopReason}), forcing recovery attempt ${loopRecoveryAttempts}/3`,
          );

          for (const toolCall of toolCalls) {
            this._messages.push({
              role: "tool",
              content: `SYSTEM ERROR: Blocked repeating tool call (${loopReason}). Fix your arguments or try a different approach.`,
              tool_call_id: toolCall.id,
            });
          }

          this._messages.push({
            role: "user",
            content: `CRITICAL SYSTEM INTERVENTION: You are stuck in a loop (${loopReason}). You are repeating the exact same failed tool calls or responses. STOP doing this. Read any tool error messages carefully. Fix your syntax, change your arguments, use a completely different tool, or ask the user for help. DO NOT repeat your previous action.`,
          });

          continue;
        }

        loopGuardMessage =
          "i got stuck in a tool loop and stopped to avoid repeating myself. please try again.";
        lastTextResponse = loopGuardMessage;
        debug(`[tool loop guard] ${loopReason} (final)`);

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
        // skip iteration extension tool - already handled above
        if (
          toolCall.type === "function" &&
          toolCall.function?.name === "request_more_iterations"
        ) {
          continue;
        }

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

          const rawArgs =
            fn?.arguments ??
            custom?.input ??
            anyCall.arguments ??
            anyCall.input ??
            "{}";
          args =
            typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
        }

        debug(`[tool: ${name}]`);
        debug(`[args raw]: ${args.slice(0, 500)}`);

        let result: string;
        try {
          result = await executeTool(name, args, this.userId, content);
          debug(`[result]: ${result.slice(0, 200)}...`);

          // track step for status summarization
          stepTracker.addStep(name, args);
        } catch (error) {
          // capture tool failure for learning machine
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result = `[Error] ${errorMessage}`;
          debug(`[tool error]: ${errorMessage}`);
          hadToolError = true;

          // track failed step too
          stepTracker.addStep(name, args);

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

        // flag any error result so we can nudge the ai to self-correct after the loop
        if (result.startsWith("error:") || result.startsWith("[Error]")) {
          hadToolError = true;
        }

        // compress large tool outputs before storing in context
        const compressedResult = compressToolOutput(result, name);
        this._messages.push({
          role: "tool",
          content: compressedResult,
          tool_call_id: toolCall.id,
        });
      }

      // immediately surface errors back to the ai so it fixes them in the next turn
      if (hadToolError) {
        hadToolError = false;
        this._messages.push({
          role: "user",
          content:
            "one or more tool calls returned errors. review each error message above, fix your arguments, and retry the failed calls now.",
        });
        debug("[agent] tool error detected - injecting fix prompt");
      }

      if (pendingIterationWarning) {
        this._messages.push({
          role: "system",
          content: pendingIterationWarning,
        });
        pendingIterationWarning = null;
      }
    }

    if (loopGuardMessage) {
      this._messages.push({ role: "assistant", content: loopGuardMessage });
    }

    if (!lastTextResponse && toolResults.length > 0 && !loopGuardMessage) {
      lastTextResponse = await this.generateFinalToolResponse(
        combinedContext,
        callbacks,
      );

      if (!lastTextResponse) {
        lastTextResponse = buildToolOnlyFallback(stepTracker, toolResults);
        this._messages.push({
          role: "assistant",
          content: lastTextResponse,
        });
        debug("[agent] used synthesized fallback after empty finalization");
      }
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
    actualUsage: import("./context-config").TokenUsage | null;
    smartTokenCount: {
      tokens: number;
      source: "actual" | "actual+delta" | "tiktoken";
    };
  } {
    const base = this.contextManager.getStats(this._messages);
    return {
      ...base,
      actualUsage: getLastTokenUsage(this.userId),
      smartTokenCount: getSmartTokenCount(this.userId, this._messages),
    };
  }

  clearMemory(): void {
    const systemMessage = this._messages[0];
    this._messages = systemMessage ? [systemMessage] : [];
    this.contextManager = new ContextManager();
    clearTokenUsage(this.userId);
  }

  async clearMemoryAndPersist(): Promise<void> {
    this.clearMemory();
    await conversationStore().clear(this.userId, this.threadId);
  }

  async cleanup(): Promise<void> {
    await this.saveConversation();
    await cleanupTools();
  }
}
