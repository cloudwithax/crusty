import { createHash } from "crypto";

export const DEFAULT_CONVERSATION_THREAD_ID = "default";
const DEFAULT_ACTIVE_THREAD_WINDOW_MINUTES = 30;

export type ConversationPlatform = "telegram" | "imessage";

export interface ConversationThreadRecord {
  threadId: string;
  updatedAt: number;
}

export function getActiveThreadWindowMs(): number {
  const configuredMinutes = parseInt(
    process.env.CONVERSATION_THREAD_ACTIVE_WINDOW_MINUTES ||
      String(DEFAULT_ACTIVE_THREAD_WINDOW_MINUTES),
    10,
  );

  if (!Number.isFinite(configuredMinutes) || configuredMinutes <= 0) {
    return DEFAULT_ACTIVE_THREAD_WINDOW_MINUTES * 60 * 1000;
  }

  return configuredMinutes * 60 * 1000;
}

export function shouldReuseActiveThread(
  updatedAt: number,
  now: number = Date.now(),
): boolean {
  return now - updatedAt <= getActiveThreadWindowMs();
}

export function buildTelegramMessageReference(
  chatId: number,
  messageId: number,
): string {
  return `telegram:${chatId}:${messageId}`;
}

export function buildTelegramThreadId(
  chatId: number,
  messageId: number,
): string {
  return buildTelegramMessageReference(chatId, messageId);
}

export function buildImessageThreadId(
  phoneNumber: string,
  messageHandle: string,
): string {
  const normalizedPhone = phoneNumber.replace(/\D/g, "");
  const digest = createHash("sha1")
    .update(`${normalizedPhone}:${messageHandle}`)
    .digest("hex")
    .slice(0, 24);

  return `imessage:${digest}`;
}
