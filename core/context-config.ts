// context management configuration
// controls how conversation history is managed to stay within model limits

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// model context limits (conservative defaults for gpt-4o class models)
export const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || "24000", 10);
export const RESERVED_COMPLETION_TOKENS = parseInt(process.env.RESERVED_COMPLETION_TOKENS || "2000", 10);

// message count limits (backup when token estimation fails)
export const MAX_TURNS = parseInt(process.env.MAX_TURNS || "40", 10);

// summarization thresholds
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
