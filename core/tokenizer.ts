// accurate token counting using tiktoken bpe tokenization
// replaces the chars/4 heuristic with proper tokenizer
// falls back to heuristic if wasm fails to load

import { get_encoding, type Tiktoken } from "tiktoken";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getCurrentModel } from "./model-state";
import { debug } from "../utils/debug";

// encoder cache keyed by encoding name
const encoderCache = new Map<string, Tiktoken>();

// map model names to tiktoken encoding names
function resolveEncoding(model: string): string {
  const lower = model.toLowerCase();

  // o200k_base: gpt-4o family, o1, o3
  if (
    lower.includes("gpt-4o") ||
    lower.includes("o1") ||
    lower.includes("o3") ||
    lower.includes("o4")
  ) {
    return "o200k_base";
  }

  // cl100k_base: gpt-4, gpt-3.5-turbo
  if (lower.includes("gpt-4") || lower.includes("gpt-3.5")) {
    return "cl100k_base";
  }

  // default for unknown models (openrouter, local, etc)
  // o200k_base is the most modern and a reasonable approximation
  return "o200k_base";
}

function getEncoder(model?: string): Tiktoken | null {
  const encodingName = resolveEncoding(model || getCurrentModel());

  const cached = encoderCache.get(encodingName);
  if (cached) return cached;

  try {
    const encoder = get_encoding(encodingName as Parameters<typeof get_encoding>[0]);
    encoderCache.set(encodingName, encoder);
    return encoder;
  } catch (err) {
    debug(
      `[tokenizer] failed to load encoding ${encodingName}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// count tokens in a string using tiktoken
// falls back to chars/4 heuristic if encoder unavailable
export function countTokens(text: string, model?: string): number {
  if (!text) return 0;

  const encoder = getEncoder(model);
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch {
      // encoding failure, fall through to heuristic
    }
  }

  return Math.ceil(text.length / 4);
}

// extract string content from a chat message (handles all content types)
function getMessageContentString(message: ChatCompletionMessageParam): string {
  if (
    !("content" in message) ||
    message.content === null ||
    message.content === undefined
  ) {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

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

// count tokens for a single chat message including per-message overhead
// openai charges ~4 tokens per message for role/formatting tokens
export function countMessageTokens(
  message: ChatCompletionMessageParam,
  model?: string,
): number {
  let tokens = 4; // per-message overhead (role, separators)

  tokens += countTokens(getMessageContentString(message), model);

  if ("name" in message && message.name) {
    tokens += countTokens(message.name, model);
  }

  if ("tool_calls" in message && message.tool_calls) {
    for (const tc of message.tool_calls) {
      if ("function" in tc && tc.function) {
        tokens += countTokens(tc.function.name || "", model);
        tokens += countTokens(tc.function.arguments || "", model);
      } else {
        // custom tool call format, estimate from stringified content
        tokens += countTokens(JSON.stringify(tc), model);
      }
      tokens += 4; // per-tool-call overhead
    }
  }

  return tokens;
}

// count tokens for an array of messages
// includes the 3-token priming overhead for assistant reply
export function countAllTokens(
  messages: ChatCompletionMessageParam[],
  model?: string,
): number {
  let total = 3; // reply priming: <|start|>assistant<|message|>
  for (const msg of messages) {
    total += countMessageTokens(msg, model);
  }
  return total;
}

// free wasm encoder memory on shutdown
export function freeEncoders(): void {
  for (const [, encoder] of encoderCache) {
    encoder.free();
  }
  encoderCache.clear();
}
