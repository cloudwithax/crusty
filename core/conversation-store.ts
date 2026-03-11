// conversation persistence layer
// stores and retrieves conversation history from database

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getDatabase, getAsyncDatabase, isUsingPostgres } from "../data/db";
import { debug } from "../utils/debug";
import { DEFAULT_CONVERSATION_THREAD_ID } from "./conversation-threading.ts";

export interface StoredConversation {
  messages: ChatCompletionMessageParam[];
  summary?: string;
  updatedAt: number;
}

export interface ConversationStore {
  load(userId: number, threadId?: string): Promise<StoredConversation | null>;
  save(
    userId: number,
    threadId: string,
    messages: ChatCompletionMessageParam[],
    summary?: string,
  ): Promise<void>;
  clear(userId: number, threadId?: string): Promise<void>;
  clearAll(userId: number): Promise<void>;
}

// ensure tables exist
let tablesInitialized = false;

async function ensureTables(): Promise<void> {
  if (tablesInitialized) return;

  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    // suppress postgres NOTICE messages for "already exists, skipping"
    await asyncDb.run(`SET client_min_messages TO WARNING`);
    await asyncDb.run(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        user_id BIGINT NOT NULL,
        thread_id TEXT NOT NULL,
        messages_json JSONB NOT NULL,
        summary TEXT,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, thread_id)
      )
    `);
    await asyncDb.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        user_id BIGINT PRIMARY KEY,
        messages_json JSONB NOT NULL,
        summary TEXT,
        updated_at BIGINT NOT NULL
      )
    `);
    // restore default message level
    await asyncDb.run(`SET client_min_messages TO NOTICE`);
  } else {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        user_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        summary TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, thread_id)
      )
    `);
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
  async load(
    userId: number,
    threadId: string = DEFAULT_CONVERSATION_THREAD_ID,
  ): Promise<StoredConversation | null> {
    await ensureTables();
    const db = getDatabase();

    const row = db
      .query<{
        messages_json: string;
        summary: string | null;
        updated_at: number;
      }>(
        `SELECT messages_json, summary, updated_at FROM conversation_threads WHERE user_id = ? AND thread_id = ?`,
      )
      .get(userId, threadId);

    if (!row && threadId === DEFAULT_CONVERSATION_THREAD_ID) {
      const legacyRow = db
        .query<{
          messages_json: string;
          summary: string | null;
          updated_at: number;
        }>(
          `SELECT messages_json, summary, updated_at FROM conversations WHERE user_id = ?`,
        )
        .get(userId);

      if (!legacyRow) {
        return null;
      }

      return this.parseStoredConversation(userId, threadId, legacyRow);
    }

    if (!row) return null;

    return this.parseStoredConversation(userId, threadId, row);
  }

  private parseStoredConversation(
    userId: number,
    threadId: string,
    row: {
      messages_json: string;
      summary: string | null;
      updated_at: number;
    },
  ): StoredConversation | null {
    try {
      const messages = JSON.parse(
        row.messages_json,
      ) as ChatCompletionMessageParam[];
      return {
        messages,
        summary: row.summary || undefined,
        updatedAt: row.updated_at,
      };
    } catch (err) {
      debug(
        `[conversation-store] failed to parse messages for user ${userId} thread ${threadId}:`,
        err,
      );
      return null;
    }
  }

  async save(
    userId: number,
    threadId: string,
    messages: ChatCompletionMessageParam[],
    summary?: string,
  ): Promise<void> {
    await ensureTables();
    const db = getDatabase();
    const messagesJson = JSON.stringify(messages);
    const now = Date.now();

    db.run(
      `INSERT INTO conversation_threads (user_id, thread_id, messages_json, summary, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, thread_id) DO UPDATE SET
         messages_json = excluded.messages_json,
         summary = excluded.summary,
         updated_at = excluded.updated_at`,
      [userId, threadId, messagesJson, summary || null, now],
    );

    debug(
      `[conversation-store] saved ${messages.length} messages for user ${userId} thread ${threadId}`,
    );
  }

  async clear(
    userId: number,
    threadId: string = DEFAULT_CONVERSATION_THREAD_ID,
  ): Promise<void> {
    await ensureTables();
    const db = getDatabase();
    db.run(
      `DELETE FROM conversation_threads WHERE user_id = ? AND thread_id = ?`,
      [userId, threadId],
    );

    if (threadId === DEFAULT_CONVERSATION_THREAD_ID) {
      db.run(`DELETE FROM conversations WHERE user_id = ?`, [userId]);
    }

    debug(
      `[conversation-store] cleared conversation for user ${userId} thread ${threadId}`,
    );
  }

  async clearAll(userId: number): Promise<void> {
    await ensureTables();
    const db = getDatabase();
    db.run(`DELETE FROM conversation_threads WHERE user_id = ?`, [userId]);
    db.run(`DELETE FROM conversations WHERE user_id = ?`, [userId]);
    debug(`[conversation-store] cleared all conversations for user ${userId}`);
  }
}

// postgres implementation
class PostgresConversationStore implements ConversationStore {
  async load(
    userId: number,
    threadId: string = DEFAULT_CONVERSATION_THREAD_ID,
  ): Promise<StoredConversation | null> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return null;

    const row = await asyncDb.get<{
      messages_json: unknown;
      summary: string | null;
      updated_at: number;
    }>(
      `SELECT messages_json, summary, updated_at FROM conversation_threads WHERE user_id = $1 AND thread_id = $2`,
      userId,
      threadId,
    );

    if (!row && threadId === DEFAULT_CONVERSATION_THREAD_ID) {
      const legacyRow = await asyncDb.get<{
        messages_json: unknown;
        summary: string | null;
        updated_at: number;
      }>(
        `SELECT messages_json, summary, updated_at FROM conversations WHERE user_id = $1`,
        userId,
      );

      if (!legacyRow) {
        return null;
      }

      return this.parseStoredConversation(userId, threadId, legacyRow);
    }

    if (!row) return null;

    return this.parseStoredConversation(userId, threadId, row);
  }

  private parseStoredConversation(
    userId: number,
    threadId: string,
    row: {
      messages_json: unknown;
      summary: string | null;
      updated_at: number;
    },
  ): StoredConversation | null {
    try {
      // postgres returns jsonb as object, not string
      const messages = (
        typeof row.messages_json === "string"
          ? JSON.parse(row.messages_json)
          : row.messages_json
      ) as ChatCompletionMessageParam[];

      return {
        messages,
        summary: row.summary || undefined,
        updatedAt: row.updated_at,
      };
    } catch (err) {
      debug(
        `[conversation-store] failed to parse messages for user ${userId} thread ${threadId}:`,
        err,
      );
      return null;
    }
  }

  async save(
    userId: number,
    threadId: string,
    messages: ChatCompletionMessageParam[],
    summary?: string,
  ): Promise<void> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return;

    const messagesJson = JSON.stringify(messages);
    const now = Date.now();

    await asyncDb.run(
      `INSERT INTO conversation_threads (user_id, thread_id, messages_json, summary, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT(user_id, thread_id) DO UPDATE SET
         messages_json = EXCLUDED.messages_json,
         summary = EXCLUDED.summary,
         updated_at = EXCLUDED.updated_at`,
      [userId, threadId, messagesJson, summary || null, now],
    );

    debug(
      `[conversation-store] saved ${messages.length} messages for user ${userId} thread ${threadId}`,
    );
  }

  async clear(
    userId: number,
    threadId: string = DEFAULT_CONVERSATION_THREAD_ID,
  ): Promise<void> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return;

    await asyncDb.run(
      `DELETE FROM conversation_threads WHERE user_id = $1 AND thread_id = $2`,
      [userId, threadId],
    );

    if (threadId === DEFAULT_CONVERSATION_THREAD_ID) {
      await asyncDb.run(`DELETE FROM conversations WHERE user_id = $1`, [
        userId,
      ]);
    }

    debug(
      `[conversation-store] cleared conversation for user ${userId} thread ${threadId}`,
    );
  }

  async clearAll(userId: number): Promise<void> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return;

    await asyncDb.run(`DELETE FROM conversation_threads WHERE user_id = $1`, [
      userId,
    ]);
    await asyncDb.run(`DELETE FROM conversations WHERE user_id = $1`, [userId]);
    debug(`[conversation-store] cleared all conversations for user ${userId}`);
  }
}

// factory function to get the appropriate store
function createConversationStore(): ConversationStore {
  if (isUsingPostgres()) {
    return new PostgresConversationStore();
  }
  return new SqliteConversationStore();
}

// singleton instance
let storeInstance: ConversationStore | null = null;

export function conversationStore(): ConversationStore {
  if (!storeInstance) {
    storeInstance = createConversationStore();
  }
  return storeInstance;
}
