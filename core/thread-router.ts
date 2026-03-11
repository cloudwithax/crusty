import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { nativeChatCompletion } from "./api.ts";
import { conversationStore } from "./conversation-store";
import { conversationThreadStore } from "./thread-store.ts";
import type { ConversationPlatform } from "./conversation-threading.ts";
import { debug } from "../utils/debug.ts";
import { withRetry } from "../utils/retry.ts";

const THREAD_ROUTER_MODEL =
  process.env.THREAD_ROUTER_MODEL ||
  process.env.SUMMARIZE_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

const THREAD_ROUTER_CANDIDATE_LIMIT = parseInt(
  process.env.CONVERSATION_THREAD_ROUTER_CANDIDATES || "4",
  10,
);

const THREAD_ROUTER_TIMEOUT_MS = parseInt(
  process.env.CONVERSATION_THREAD_ROUTER_TIMEOUT_MS || "6000",
  10,
);

const THREAD_ROUTER_MIN_CONFIDENCE = parseFloat(
  process.env.CONVERSATION_THREAD_ROUTER_MIN_CONFIDENCE || "0.6",
);

interface ThreadPreview {
  threadId: string;
  updatedAt: number;
  preview: string;
}

type ThreadRouteDecision =
  | { kind: "existing"; threadId: string; confidence: number; reason: string }
  | { kind: "new"; confidence: number; reason: string }
  | { kind: "undecided"; reason: string };

function extractJson(raw: string): string | null {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart === -1 || braceEnd === -1 || braceEnd < braceStart) {
    return null;
  }

  return text.slice(braceStart, braceEnd + 1);
}

function sanitizeContent(
  content: ChatCompletionMessageParam["content"],
): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if ("text" in part && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("");
  }

  return "";
}

function trimInline(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatTimeAgo(updatedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function buildThreadPreview(
  threadId: string,
  updatedAt: number,
  messages: ChatCompletionMessageParam[],
  summary?: string,
): ThreadPreview {
  const recentMessages = messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .slice(-4);

  const lines: string[] = [];
  if (summary) {
    lines.push(`summary: ${trimInline(summary, 220)}`);
  }

  for (const message of recentMessages) {
    const role = message.role === "user" ? "user" : "assistant";
    const content = trimInline(sanitizeContent(message.content), 140);
    if (content) {
      lines.push(`${role}: ${content}`);
    }
  }

  if (lines.length === 0) {
    lines.push("no recent content available");
  }

  return {
    threadId,
    updatedAt,
    preview: `updated ${formatTimeAgo(updatedAt)}\n${lines.join("\n")}`,
  };
}

function parseDecision(
  raw: string,
  candidates: ThreadPreview[],
): ThreadRouteDecision {
  const json = extractJson(raw);
  if (!json) {
    return {
      kind: "undecided",
      reason: "router response did not contain json",
    };
  }

  try {
    const parsed = JSON.parse(json) as {
      action?: string;
      thread_id?: string | null;
      confidence?: number;
      reason?: string;
    };

    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reason = parsed.reason || "no reason provided";

    if (parsed.action === "new") {
      if (confidence >= THREAD_ROUTER_MIN_CONFIDENCE) {
        return { kind: "new", confidence, reason };
      }
      return { kind: "undecided", reason };
    }

    if (parsed.action === "existing" && parsed.thread_id) {
      const match = candidates.find(
        (candidate) => candidate.threadId === parsed.thread_id,
      );
      if (match && confidence >= THREAD_ROUTER_MIN_CONFIDENCE) {
        return {
          kind: "existing",
          threadId: match.threadId,
          confidence,
          reason,
        };
      }
    }

    return { kind: "undecided", reason };
  } catch (error) {
    return {
      kind: "undecided",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function chooseThreadWithModel(
  platform: ConversationPlatform,
  userId: number,
  incomingMessage: string,
): Promise<ThreadRouteDecision> {
  const recentThreads = await conversationThreadStore().listRecentThreads(
    platform,
    userId,
    THREAD_ROUTER_CANDIDATE_LIMIT,
  );

  if (recentThreads.length === 0) {
    return { kind: "undecided", reason: "no recent threads found" };
  }

  const candidates: ThreadPreview[] = [];
  for (const thread of recentThreads) {
    const stored = await conversationStore().load(userId, thread.threadId);
    if (!stored) {
      continue;
    }

    candidates.push(
      buildThreadPreview(
        thread.threadId,
        thread.updatedAt,
        stored.messages,
        stored.summary,
      ),
    );
  }

  if (candidates.length === 0) {
    return { kind: "undecided", reason: "no candidate previews available" };
  }

  const systemPrompt = `you decide whether an incoming user message belongs to an existing conversation thread or should start a new one.

respond with valid json only:
{
  "action": "existing" | "new",
  "thread_id": "candidate thread id or null",
  "confidence": 0.0 to 1.0,
  "reason": "short explanation"
}

rules:
- choose "existing" only when the message clearly continues one of the candidate threads
- choose "new" when the message starts a new topic, request, or context
- references like "that", "it", "continue", "fix this", follow-up questions, or iterative edits usually mean existing
- unrelated questions or topic shifts usually mean new
- only return a thread_id that appears in the candidates list
- if unsure, prefer low confidence rather than guessing`;

  const userPrompt = `platform: ${platform}
incoming message:
${incomingMessage}

candidates:
${candidates
  .map(
    (candidate, index) =>
      `${index + 1}. thread_id=${candidate.threadId}\n${candidate.preview}`,
  )
  .join("\n\n")}`;

  try {
    const response = await withRetry(
      () =>
        nativeChatCompletion(
          {
            model: THREAD_ROUTER_MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            max_tokens: 180,
            temperature: 0.1,
          },
          AbortSignal.timeout(THREAD_ROUTER_TIMEOUT_MS),
        ),
      { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 1000 },
    );

    const raw = response.choices[0]?.message?.content?.trim() || "";
    const decision = parseDecision(raw, candidates);
    debug(
      `[thread-router] ${platform} decision: ${decision.kind} (${decision.reason})`,
    );
    return decision;
  } catch (error) {
    debug("[thread-router] failed:", error);
    return {
      kind: "undecided",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
