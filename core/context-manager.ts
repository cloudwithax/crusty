// context manager
// handles rolling window, summarization, and prompt building

import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  MAX_CONTEXT_TOKENS,
  RESERVED_COMPLETION_TOKENS,
  MAX_TURNS,
  SUMMARIZE_TRIGGER_TOKENS,
  SUMMARIZE_TARGET_TOKENS,
  MIN_RECENT_MESSAGES,
  estimateMessageTokens,
  estimateTotalTokens,
} from "./context-config";
import { debug } from "../utils/debug";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// smaller/faster model for summarization to reduce cost
const SUMMARIZE_MODEL = process.env.SUMMARIZE_MODEL || "gpt-4o-mini";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 30 * 1000,
});

export interface ContextState {
  messages: ChatCompletionMessageParam[];
  summary?: string;
}

export class ContextManager {
  private _summary?: string;

  constructor(summary?: string) {
    this._summary = summary;
  }

  get summary(): string | undefined {
    return this._summary;
  }

  // build messages for model call with rolling window
  // returns a pruned list that fits within token budget
  buildMessagesForModel(
    allMessages: ChatCompletionMessageParam[],
    memoryContext?: string
  ): ChatCompletionMessageParam[] {
    if (allMessages.length === 0) return [];

    const budget = MAX_CONTEXT_TOKENS - RESERVED_COMPLETION_TOKENS;

    // identify system message (always first)
    const systemMessage = allMessages[0]?.role === "system" ? allMessages[0] : null;
    const historyMessages = systemMessage ? allMessages.slice(1) : allMessages;

    // build pinned prefix (system + summary + memory)
    const pinnedPrefix: ChatCompletionMessageParam[] = [];

    if (systemMessage) {
      pinnedPrefix.push(systemMessage);
    }

    // inject summary as a system message if present
    if (this._summary) {
      pinnedPrefix.push({
        role: "system",
        content: `<conversation_summary>\n${this._summary}\n</conversation_summary>`,
      });
    }

    // inject memory context if present
    if (memoryContext) {
      pinnedPrefix.push({
        role: "system",
        content: memoryContext,
      });
    }

    const prefixTokens = estimateTotalTokens(pinnedPrefix);
    const remainingBudget = budget - prefixTokens;

    // walk backwards from end, accumulating messages until budget exhausted
    const recentMessages: ChatCompletionMessageParam[] = [];
    let accumulatedTokens = 0;

    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const msg = historyMessages[i];
      if (!msg) continue;

      const msgTokens = estimateMessageTokens(msg);

      // check both token budget and turn limit
      if (accumulatedTokens + msgTokens > remainingBudget) break;
      if (recentMessages.length >= MAX_TURNS) break;

      recentMessages.unshift(msg);
      accumulatedTokens += msgTokens;
    }

    const result = [...pinnedPrefix, ...recentMessages];

    debug(
      `[context-manager] built ${result.length} messages (${prefixTokens + accumulatedTokens} estimated tokens, budget: ${budget})`
    );

    return result;
  }

  // check if summarization is needed and perform it if so
  // returns true if summarization occurred
  async maybeSummarize(
    messages: ChatCompletionMessageParam[]
  ): Promise<{ summarized: boolean; messagesToDrop: number }> {
    // skip if too few messages
    if (messages.length < MIN_RECENT_MESSAGES * 2) {
      return { summarized: false, messagesToDrop: 0 };
    }

    // identify non-system messages
    const systemMessage = messages[0]?.role === "system" ? messages[0] : null;
    const historyMessages = systemMessage ? messages.slice(1) : messages;

    const totalTokens = estimateTotalTokens(messages);

    if (totalTokens < SUMMARIZE_TRIGGER_TOKENS) {
      return { summarized: false, messagesToDrop: 0 };
    }

    debug(
      `[context-manager] triggering summarization (${totalTokens} tokens > ${SUMMARIZE_TRIGGER_TOKENS} trigger)`
    );

    // figure out how many messages to summarize
    // keep the most recent MIN_RECENT_MESSAGES unsummarized
    const keepCount = Math.min(MIN_RECENT_MESSAGES, historyMessages.length);
    const toSummarize = historyMessages.slice(0, -keepCount);

    if (toSummarize.length < 4) {
      // not enough to summarize meaningfully
      return { summarized: false, messagesToDrop: 0 };
    }

    // build summarization prompt
    const existingSummary = this._summary
      ? `Previous summary:\n${this._summary}\n\n`
      : "";

    const messagesToSummarizeText = toSummarize
      .map((m) => {
        const role = m.role === "assistant" ? "Assistant" : m.role === "user" ? "User" : m.role;
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${role}: ${content?.substring(0, 500) || "[no content]"}`;
      })
      .join("\n\n");

    const prompt = `${existingSummary}New messages to incorporate:
${messagesToSummarizeText}

Create a concise running summary of this conversation. Preserve:
- User preferences and decisions
- Important facts, names, and commitments
- Key topics discussed
- Any TODOs or action items

Keep it under 500 words. Focus on information that would be useful for continuing the conversation.`;

    try {
      const response = await openai.chat.completions.create({
        model: SUMMARIZE_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a summarizer. Create concise, factual summaries of conversations. Preserve important details and context.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 800,
      });

      const newSummary = response.choices[0]?.message?.content;

      if (newSummary) {
        this._summary = newSummary;
        debug(
          `[context-manager] summarized ${toSummarize.length} messages into ${newSummary.length} chars`
        );
        return { summarized: true, messagesToDrop: toSummarize.length };
      }
    } catch (err) {
      debug(`[context-manager] summarization failed:`, err);
    }

    return { summarized: false, messagesToDrop: 0 };
  }

  // prune messages after summarization
  // keeps system message + recent messages, drops summarized ones
  pruneMessages(
    messages: ChatCompletionMessageParam[],
    dropCount: number
  ): ChatCompletionMessageParam[] {
    if (dropCount === 0) return messages;

    const systemMessage = messages[0]?.role === "system" ? messages[0] : null;
    const historyMessages = systemMessage ? messages.slice(1) : messages;

    // drop the oldest messages that were summarized
    const remaining = historyMessages.slice(dropCount);

    const result = systemMessage ? [systemMessage, ...remaining] : remaining;

    debug(
      `[context-manager] pruned ${dropCount} messages, ${result.length} remaining`
    );

    return result;
  }

  // get current context statistics
  getStats(messages: ChatCompletionMessageParam[]): {
    messageCount: number;
    estimatedTokens: number;
    hasSummary: boolean;
    summaryLength: number;
  } {
    return {
      messageCount: messages.length,
      estimatedTokens: estimateTotalTokens(messages),
      hasSummary: !!this._summary,
      summaryLength: this._summary?.length || 0,
    };
  }
}
