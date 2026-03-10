// context management configuration
// controls how conversation history is managed to stay within model limits
// uses tiktoken for accurate token counting, with actual api usage data
// as source of truth when available

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  getModelContextLength,
  getModelContextLengthSync,
  prefetchModelInfo,
} from "./model-info";
import {
  countTokens,
  countMessageTokens,
  countAllTokens,
} from "./tokenizer";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// reserved tokens for completion (response)
export const RESERVED_COMPLETION_TOKENS = parseInt(
  process.env.RESERVED_COMPLETION_TOKENS || "4000",
  10
);

// dynamic context limit - fetched from openrouter or fallback
let _maxContextTokens: number | null = null;

export function getMaxContextTokens(): number {
  // if env var is set, use that as override
  if (process.env.MAX_CONTEXT_TOKENS) {
    return parseInt(process.env.MAX_CONTEXT_TOKENS, 10);
  }

  // use cached value if available
  if (_maxContextTokens !== null) {
    return _maxContextTokens;
  }

  // sync fallback until async fetch completes
  return getModelContextLengthSync(OPENAI_MODEL);
}

export async function initializeContextLimits(modelId?: string): Promise<void> {
  if (process.env.MAX_CONTEXT_TOKENS) {
    _maxContextTokens = parseInt(process.env.MAX_CONTEXT_TOKENS, 10);
    return;
  }

  _maxContextTokens = await getModelContextLength(modelId || OPENAI_MODEL);
}

// prefetch on module load (non-blocking)
prefetchModelInfo(OPENAI_MODEL).then((len) => {
  if (!process.env.MAX_CONTEXT_TOKENS && len !== undefined) {
    // already handled by getModelContextLength
  }
});

// backwards compat export (use getMaxContextTokens() for dynamic value)
export const MAX_CONTEXT_TOKENS = getModelContextLengthSync(OPENAI_MODEL);

// message count limits (backup when token estimation fails)
export const MAX_TURNS = parseInt(process.env.MAX_TURNS || "40", 10);

// summarization thresholds (dynamic based on model context)
export function getSummarizeTriggerTokens(): number {
  return Math.floor(getMaxContextTokens() * 0.75);
}

export function getSummarizeTargetTokens(): number {
  return Math.floor(getMaxContextTokens() * 0.45);
}

// backwards compat static exports (deprecated, use functions above)
export const SUMMARIZE_TRIGGER_TOKENS = Math.floor(MAX_CONTEXT_TOKENS * 0.75);
export const SUMMARIZE_TARGET_TOKENS = Math.floor(MAX_CONTEXT_TOKENS * 0.45);

// minimum messages to keep unsummarized (recent context)
export const MIN_RECENT_MESSAGES = 8;

// --- token counting (delegates to tiktoken-based tokenizer) ---

// count tokens in a string using bpe tokenization
export function estimateTokens(text: string): number {
  return countTokens(text);
}

// count tokens for a chat message including role overhead
export function estimateMessageTokens(message: ChatCompletionMessageParam): number {
  return countMessageTokens(message);
}

// count total tokens for an array of messages
export function estimateTotalTokens(messages: ChatCompletionMessageParam[]): number {
  return countAllTokens(messages);
}

// --- actual token usage tracking from api responses ---

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: number;
  // how many messages were in the conversation when this was recorded
  messageCount: number;
}

// per-user actual usage from the most recent api response
const usageByUser = new Map<number, TokenUsage>();

// record actual token counts from an api response
export function recordTokenUsage(
  userId: number,
  usage: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
  } | null | undefined,
  messageCount: number,
): void {
  if (!usage?.prompt_tokens) return;

  usageByUser.set(userId, {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    timestamp: Date.now(),
    messageCount,
  });
}

// get last known actual usage for a user
export function getLastTokenUsage(userId: number): TokenUsage | null {
  return usageByUser.get(userId) || null;
}

// clear usage tracking (on session clear)
export function clearTokenUsage(userId: number): void {
  usageByUser.delete(userId);
}

// get the best available token count for a conversation
// prefers actual usage from the last api response when messages havent changed,
// uses actual + tiktoken delta when new messages were added since last response,
// falls back to full tiktoken count otherwise
export function getSmartTokenCount(
  userId: number,
  messages: ChatCompletionMessageParam[],
): { tokens: number; source: "actual" | "actual+delta" | "tiktoken" } {
  const lastUsage = usageByUser.get(userId);

  if (lastUsage) {
    // exact match: no new messages since last api call
    if (messages.length === lastUsage.messageCount) {
      return { tokens: lastUsage.promptTokens, source: "actual" };
    }

    // messages were added since last call, use actual as baseline + tiktoken for the delta
    if (messages.length > lastUsage.messageCount) {
      const newMessages = messages.slice(lastUsage.messageCount);
      const delta = countAllTokens(newMessages);
      return {
        tokens: lastUsage.promptTokens + lastUsage.completionTokens + delta,
        source: "actual+delta",
      };
    }
  }

  // no actual data or messages were pruned, full tiktoken estimate
  return { tokens: countAllTokens(messages), source: "tiktoken" };
}
