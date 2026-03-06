// context management configuration
// controls how conversation history is managed to stay within model limits

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  getModelContextLength,
  getModelContextLengthSync,
  prefetchModelInfo,
} from "./model-info";

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

// approximate token count for a string
// uses a conservative heuristic (english average ~4 chars per token)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// extract string content from message (handles various content types)
function getMessageContentString(message: ChatCompletionMessageParam): string {
  if (!("content" in message) || message.content === null || message.content === undefined) {
    return "";
  }
  
  if (typeof message.content === "string") {
    return message.content;
  }
  
  // handle array content (ChatCompletionContentPart[])
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if ("text" in part) return part.text;
        return "";
      })
      .join("");
  }
  
  return "";
}

// estimate tokens for a chat message including role overhead
export function estimateMessageTokens(message: ChatCompletionMessageParam): number {
  let tokens = 4; // base overhead per message (role, formatting)
  
  tokens += estimateTokens(getMessageContentString(message));
  
  if ("tool_calls" in message && message.tool_calls) {
    tokens += estimateTokens(JSON.stringify(message.tool_calls));
  }
  
  return tokens;
}

// estimate total tokens for an array of messages
export function estimateTotalTokens(messages: ChatCompletionMessageParam[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}
