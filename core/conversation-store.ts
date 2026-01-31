// conversation persistence layer
// stores and retrieves conversation history from database

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getDatabase, getAsyncDatabase, isUsingPostgres } from "../data/db";
import { debug } from "../utils/debug";

export interface StoredConversation {
  messages: ChatCompletionMessageParam[];
  summary?: string;
  updatedAt: number;
}

export interface ConversationStore {
  load(userId: number): Promise<StoredConversation | null>;
  save(userId: number, messages: ChatCompletionMessageParam[], summary?: string): Promise<void>;
  clear(userId: number): Promise<void>;
}

// ensure tables exist
let tablesInitialized = false;

async function ensureTables(): Promise<void> {
  if (tablesInitialized) return;

  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    await asyncDb.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        user_id BIGINT PRIMARY KEY,
        messages_json JSONB NOT NULL,
        summary TEXT,
        updated_at BIGINT NOT NULL
      )
    `);
  } else {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        user_id INTEGER PRIMARY KEY,
        messages_json TEXT NOT NULL,
        summary TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  tablesInitialized = true;
  debug("[conversation-store] tables initialized");
}

// sqlite implementation
class SqliteConversationStore implements ConversationStore {
  async load(userId: number): Promise<StoredConversation | null> {
    await ensureTables();
    const db = getDatabase();
    
    const row = db.query<{
      messages_json: string;
      summary: string | null;
      updated_at: number;
    }>(`SELECT messages_json, summary, updated_at FROM conversations WHERE user_id = ?`).get(userId);

    if (!row) return null;

    try {
      const messages = JSON.parse(row.messages_json) as ChatCompletionMessageParam[];
      return {
        messages,
        summary: row.summary || undefined,
        updatedAt: row.updated_at,
      };
    } catch (err) {
      debug(`[conversation-store] failed to parse messages for user ${userId}:`, err);
      return null;
    }
  }

  async save(userId: number, messages: ChatCompletionMessageParam[], summary?: string): Promise<void> {
    await ensureTables();
    const db = getDatabase();
    const messagesJson = JSON.stringify(messages);
    const now = Date.now();

    db.run(
      `INSERT INTO conversations (user_id, messages_json, summary, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         messages_json = excluded.messages_json,
         summary = excluded.summary,
         updated_at = excluded.updated_at`,
      [userId, messagesJson, summary || null, now]
    );

    debug(`[conversation-store] saved ${messages.length} messages for user ${userId}`);
  }

  async clear(userId: number): Promise<void> {
    await ensureTables();
    const db = getDatabase();
    db.run(`DELETE FROM conversations WHERE user_id = ?`, [userId]);
    debug(`[conversation-store] cleared conversation for user ${userId}`);
  }
}

// postgres implementation
class PostgresConversationStore implements ConversationStore {
  async load(userId: number): Promise<StoredConversation | null> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return null;

    const row = await asyncDb.get<{
      messages_json: unknown;
      summary: string | null;
      updated_at: number;
    }>(`SELECT messages_json, summary, updated_at FROM conversations WHERE user_id = $1`, userId);

    if (!row) return null;

    try {
      // postgres returns jsonb as object, not string
      const messages = (typeof row.messages_json === "string"
        ? JSON.parse(row.messages_json)
        : row.messages_json) as ChatCompletionMessageParam[];
      
      return {
        messages,
        summary: row.summary || undefined,
        updatedAt: row.updated_at,
      };
    } catch (err) {
      debug(`[conversation-store] failed to parse messages for user ${userId}:`, err);
      return null;
    }
  }

  async save(userId: number, messages: ChatCompletionMessageParam[], summary?: string): Promise<void> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return;

    const messagesJson = JSON.stringify(messages);
    const now = Date.now();

    await asyncDb.run(
      `INSERT INTO conversations (user_id, messages_json, summary, updated_at)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT(user_id) DO UPDATE SET
         messages_json = EXCLUDED.messages_json,
         summary = EXCLUDED.summary,
         updated_at = EXCLUDED.updated_at`,
      [userId, messagesJson, summary || null, now]
    );

    debug(`[conversation-store] saved ${messages.length} messages for user ${userId}`);
  }

  async clear(userId: number): Promise<void> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return;

    await asyncDb.run(`DELETE FROM conversations WHERE user_id = $1`, [userId]);
    debug(`[conversation-store] cleared conversation for user ${userId}`);
  }
}

// factory function to get the appropriate store
export function getConversationStore(): ConversationStore {
  if (isUsingPostgres()) {
    return new PostgresConversationStore();
  }
  return new SqliteConversationStore();
}

// singleton instance
let storeInstance: ConversationStore | null = null;

export function conversationStore(): ConversationStore {
  if (!storeInstance) {
    storeInstance = getConversationStore();
  }
  return storeInstance;
}
