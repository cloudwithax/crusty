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
import { getCurrentModel, setCurrentModel } from "./model-state.ts";
import { loadBootstrapSystem } from "./bootstrap.ts";
import { addRecentContext } from "../scheduler/context-buffer.ts";
import { memoryService } from "../memory/service.ts";
import { debug } from "../utils/debug.ts";
import { stripReasoningTags, stripProviderArtifacts } from "../utils/reasoning.ts";
import { ContextManager } from "./context-manager";
import { conversationStore } from "./conversation-store";
import { withRetry, isRetryableError } from "../utils/retry.ts";
import { compressToolOutput } from "../utils/compress.ts";
import {
  shouldStoreMemory,
  shouldSuppressRandomRecall,
} from "../memory/gating.ts";
import { createPlan, classifyIntent, type TaskPlan } from "./planner.ts";
import { skillRegistry } from "./skills.ts";
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
  isFlushResponse,
} from "../memory/memory-flush.ts";

// environment configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const SUMMARIZE_MODEL =
  process.env.SUMMARIZE_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4o";

// re-export model accessors so callers (telegram/bot.ts) don't need to know about model-state
export { getCurrentModel, setCurrentModel } from "./model-state.ts";

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

export function getOpenAIClient(): OpenAI {
  return openai;
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
  return stripEmojis(stripReasoningTags(stripProviderArtifacts(text)));
}

// step tracking for dynamic status updates
interface AgentStep {
  tool: string;
  summary: string;
  timestamp: number;
}

class StepTracker {
  private steps: AgentStep[] = [];

  addStep(tool: string, args: string, result: string): void {
    const summary = this.summarizeStep(tool, args, result);
    this.steps.push({ tool, summary, timestamp: Date.now() });
  }

  private summarizeStep(tool: string, args: string, result: string): string {
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

const MAX_TOOL_ITERATIONS = 50;
const ITERATION_WARNING_THRESHOLD = 40; // warn when this many iterations used
const ITERATION_EXTENSION_AMOUNT = 25; // how many extra iterations to grant
const MAX_EXTENSIONS = 3; // max times agent can extend
const MAX_REPEAT_ASSISTANT_MESSAGES = 2;
const MAX_REPEAT_TOOL_SIGNATURES = 2;

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

export interface AgentCallbacks {
  onPlanReady?: (intent: string) => Promise<void>;
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

    const tools = getOpenAITools();
    let lastTextResponse = "";
    let toolIterationCount = 0;
    let lastAssistantText = "";
    let repeatAssistantCount = 0;
    let lastToolSignature = "";
    let repeatToolCount = 0;
    let loopGuardMessage: string | null = null;
    const toolResults: string[] = []; // track for verification
    const stepTracker = new StepTracker();

    // iteration extension tracking
    let currentMaxIterations = MAX_TOOL_ITERATIONS;
    let extensionCount = 0;
    let warningInjected = false;

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
      const combinedContext =
        [memoryContext, learningContext].filter(Boolean).join("\n\n") ||
        undefined;
      const messagesForModel = this.contextManager.buildMessagesForModel(
        this._messages,
        combinedContext,
      );

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
              model: getCurrentModel(),
              messages: validMessages,
              tools: tools.length > 0 ? tools : undefined,
              tool_choice: tools.length > 0 ? "auto" : undefined,
            }),
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

        debug(`[api error after 10 retries: ${errorDetails}]`);
        return (
          lastTextResponse ||
          "the inference endpoint is not responding after multiple retries. this could be a provider outage or network issue - give it a few minutes and try again."
        );
      }

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
        const warningContent = ITERATION_WARNING_MESSAGE.replace(
          "{{USED}}",
          String(toolIterationCount),
        )
          .replace("{{MAX}}", String(currentMaxIterations))
          .replace("{{REMAINING}}", String(iterationsRemaining));

        this._messages.push({
          role: "system",
          content: warningContent,
        });
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
          args =
            fn?.arguments ??
            custom?.input ??
            String(anyCall.arguments ?? anyCall.input ?? "{}");
        }

        debug(`[tool: ${name}]`);
        debug(`[args raw]: ${args.slice(0, 500)}`);

        let result: string;
        try {
          result = await executeTool(name, args, this.userId, content);
          debug(`[result]: ${result.slice(0, 200)}...`);

          // track step for status summarization
          stepTracker.addStep(name, args, result);
        } catch (error) {
          // capture tool failure for learning machine
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result = `[Error] ${errorMessage}`;
          debug(`[tool error]: ${errorMessage}`);

          // track failed step too
          stepTracker.addStep(name, args, result);

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
