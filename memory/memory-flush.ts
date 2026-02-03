// memory-flush.ts
// automatic memory extraction before context compaction
// ensures important information is persisted before being summarized out

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { debug } from "../utils/debug";
import { memoryService } from "./service";
import { saveSession, type SessionMessage } from "./session-memory";
import {
  getMaxContextTokens,
  RESERVED_COMPLETION_TOKENS,
  estimateTotalTokens,
} from "../core/context-config";

// flush config
export interface MemoryFlushConfig {
  enabled: boolean;
  // flush triggers when: currentTokens >= contextWindow - reserveFloor - softThreshold
  reserveTokensFloor: number;
  softThresholdTokens: number;
  // system prompt for the flush turn
  systemPrompt: string;
  // user prompt to trigger memory save
  userPrompt: string;
}

// default config
const DEFAULT_FLUSH_CONFIG: MemoryFlushConfig = {
  enabled: true,
  reserveTokensFloor: 20000,
  softThresholdTokens: 4000,
  systemPrompt:
    "Session nearing context compaction. Review the conversation and save any important durable information to memory before it gets summarized.",
  userPrompt:
    "The conversation is approaching its context limit. Please save any important lasting information using save_memory. Reply with MEMORY_FLUSH_COMPLETE when done, or NO_REPLY if nothing important to save.",
};

// get config from env
export function getMemoryFlushConfig(): MemoryFlushConfig {
  const enabled =
    process.env.MEMORY_FLUSH_ENABLED !== "false" &&
    process.env.MEMORY_FLUSH_ENABLED !== "0";

  return {
    enabled,
    reserveTokensFloor: parseInt(
      process.env.MEMORY_FLUSH_RESERVE_FLOOR || "20000",
      10,
    ),
    softThresholdTokens: parseInt(
      process.env.MEMORY_FLUSH_SOFT_THRESHOLD || "4000",
      10,
    ),
    systemPrompt:
      process.env.MEMORY_FLUSH_SYSTEM_PROMPT ||
      DEFAULT_FLUSH_CONFIG.systemPrompt,
    userPrompt:
      process.env.MEMORY_FLUSH_USER_PROMPT || DEFAULT_FLUSH_CONFIG.userPrompt,
  };
}

// flush state tracking per user
interface FlushState {
  lastFlushAt: number;
  flushCount: number;
  lastTokenCount: number;
}

const flushStates = new Map<number, FlushState>();

// get or create flush state for a user
function getFlushState(userId: number): FlushState {
  let state = flushStates.get(userId);
  if (!state) {
    state = {
      lastFlushAt: 0,
      flushCount: 0,
      lastTokenCount: 0,
    };
    flushStates.set(userId, state);
  }
  return state;
}

// check if we should trigger a memory flush
export function shouldTriggerFlush(
  userId: number,
  messages: ChatCompletionMessageParam[],
  config?: MemoryFlushConfig,
): boolean {
  const cfg = config || getMemoryFlushConfig();
  if (!cfg.enabled) return false;

  const state = getFlushState(userId);
  const currentTokens = estimateTotalTokens(messages);
  const contextWindow = getMaxContextTokens();

  // calculate threshold
  // flush when: tokens >= contextWindow - reserve - softThreshold
  const flushThreshold =
    contextWindow - cfg.reserveTokensFloor - cfg.softThresholdTokens;

  // only trigger once per compaction cycle
  // reset after tokens drop significantly (post-compaction)
  const tokensDropped = state.lastTokenCount - currentTokens > 5000;
  if (tokensDropped) {
    state.lastFlushAt = 0; // reset, allow new flush
  }

  // already flushed this cycle?
  if (state.lastFlushAt > 0 && !tokensDropped) {
    debug(
      `[memory-flush] already flushed this cycle (last: ${state.lastFlushAt})`,
    );
    return false;
  }

  // check threshold
  const shouldFlush = currentTokens >= flushThreshold;

  if (shouldFlush) {
    debug(
      `[memory-flush] threshold reached: ${currentTokens} >= ${flushThreshold} (window: ${contextWindow})`,
    );
  }

  state.lastTokenCount = currentTokens;
  return shouldFlush;
}

// mark that a flush was performed
export function markFlushPerformed(userId: number): void {
  const state = getFlushState(userId);
  state.lastFlushAt = Date.now();
  state.flushCount++;
  debug(`[memory-flush] marked flush completed for user ${userId}`);
}

// reset flush state (e.g., after session clear)
export function resetFlushState(userId: number): void {
  flushStates.delete(userId);
  debug(`[memory-flush] reset state for user ${userId}`);
}

// extract important information from messages
// this is a heuristic approach - the agent will do better with the flush prompt
export interface ExtractedMemory {
  content: string;
  importance: "high" | "medium" | "low";
  category: "decision" | "preference" | "fact" | "task" | "general";
}

// patterns for extracting important information
const IMPORTANCE_PATTERNS = {
  high: [
    // explicit memory requests
    /\b(remember|don't forget|important|critical|always|never)\b/i,
    // decisions
    /\b(decided|chose|going with|the plan is|we('ll| will))\b/i,
    // preferences
    /\b(prefer|like|love|hate|favorite)\b/i,
  ],
  medium: [
    // project context
    /\b(working on|building|project|developing)\b/i,
    // facts
    /\b(my name|i work|i live|my job)\b/i,
    // schedules
    /\b(tomorrow|next week|deadline|due date)\b/i,
  ],
};

// heuristic extraction of important content from messages
export function extractImportantContent(
  messages: ChatCompletionMessageParam[],
): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .map((p) =>
                typeof p === "string" ? p : "text" in p ? p.text : "",
              )
              .join("")
          : "";

    if (content.length < 20) continue;

    // check for high importance patterns
    let importance: "high" | "medium" | "low" = "low";
    for (const pattern of IMPORTANCE_PATTERNS.high) {
      if (pattern.test(content)) {
        importance = "high";
        break;
      }
    }

    // check for medium importance if not high
    if (importance === "low") {
      for (const pattern of IMPORTANCE_PATTERNS.medium) {
        if (pattern.test(content)) {
          importance = "medium";
          break;
        }
      }
    }

    // only include medium+ importance
    if (importance !== "low") {
      // categorize
      let category: ExtractedMemory["category"] = "general";
      if (/\b(decided|chose|going with)\b/i.test(content)) {
        category = "decision";
      } else if (/\b(prefer|like|love|hate)\b/i.test(content)) {
        category = "preference";
      } else if (/\b(my name|i work|i live)\b/i.test(content)) {
        category = "fact";
      } else if (/\b(todo|task|deadline|reminder)\b/i.test(content)) {
        category = "task";
      }

      memories.push({
        content: content.substring(0, 500),
        importance,
        category,
      });
    }
  }

  return memories;
}

// automatic memory save from extracted content
export async function autoSaveExtractedMemories(
  userId: number,
  memories: ExtractedMemory[],
): Promise<number> {
  let savedCount = 0;

  for (const memory of memories) {
    // only auto-save high importance
    if (memory.importance !== "high") continue;

    const result = await memoryService.storeMemory(
      userId,
      `[auto-extracted:${memory.category}] ${memory.content}`,
    );

    if (result) savedCount++;
  }

  debug(`[memory-flush] auto-saved ${savedCount} high-importance memories`);
  return savedCount;
}

// convert chat messages to session messages for archival
export function convertToSessionMessages(
  messages: ChatCompletionMessageParam[],
): SessionMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const content =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((p) =>
                  typeof p === "string" ? p : "text" in p ? p.text : "",
                )
                .join("")
            : "";

      // check for tool calls in assistant messages
      const hasToolCalls =
        m.role === "assistant" &&
        "tool_calls" in m &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0;

      return {
        role: m.role as "user" | "assistant",
        content,
        timestamp: Date.now(),
        toolCalls: hasToolCalls,
      };
    });
}

// archive current conversation to session memory before compaction
export async function archiveConversation(
  userId: number,
  messages: ChatCompletionMessageParam[],
  title?: string,
): Promise<boolean> {
  const sessionMessages = convertToSessionMessages(messages);

  if (sessionMessages.length < 4) {
    debug("[memory-flush] conversation too short to archive");
    return false;
  }

  const session = await saveSession(userId, sessionMessages, title);

  if (session) {
    debug(
      `[memory-flush] archived conversation as session: ${session.id} (${session.messageCount} messages)`,
    );
    return true;
  }

  return false;
}

// get flush statistics
export function getFlushStats(userId: number): {
  flushCount: number;
  lastFlushAt: number;
  lastTokenCount: number;
} {
  const state = getFlushState(userId);
  return {
    flushCount: state.flushCount,
    lastFlushAt: state.lastFlushAt,
    lastTokenCount: state.lastTokenCount,
  };
}

// check if a response should suppress delivery (flush response)
export function isFlushResponse(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return (
    normalized === "memory_flush_complete" ||
    normalized === "no_reply" ||
    normalized.startsWith("memory_flush_complete")
  );
}
