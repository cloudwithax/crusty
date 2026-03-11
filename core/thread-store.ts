import { getDatabase, getAsyncDatabase, isUsingPostgres } from "../data/db.ts";
import { debug } from "../utils/debug.ts";
import type {
  ConversationPlatform,
  ConversationThreadRecord,
} from "./conversation-threading.ts";

export interface ConversationThreadStore {
  touchThread(
    platform: ConversationPlatform,
    userId: number,
    threadId: string,
  ): Promise<void>;
  bindMessageReference(
    platform: ConversationPlatform,
    userId: number,
    messageReference: string,
    threadId: string,
  ): Promise<void>;
  resolveMessageReference(
    platform: ConversationPlatform,
    userId: number,
    messageReference: string,
  ): Promise<string | null>;
  getLatestThreadId(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<string | null>;
  getLatestThread(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<ConversationThreadRecord | null>;
  listRecentThreads(
    platform: ConversationPlatform,
    userId: number,
    limit: number,
  ): Promise<ConversationThreadRecord[]>;
  clearUserThreads(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<void>;
}

let tablesInitialized = false;

async function ensureTables(): Promise<void> {
  if (tablesInitialized) {
    return;
  }

  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    await asyncDb.run(`SET client_min_messages TO WARNING`);
    await asyncDb.run(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        platform TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (platform, user_id, thread_id)
      )
    `);
    await asyncDb.run(`
      CREATE TABLE IF NOT EXISTS conversation_thread_refs (
        platform TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        message_reference TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (platform, user_id, message_reference)
      )
    `);
    await asyncDb.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_threads_latest
      ON conversation_threads (platform, user_id, updated_at DESC)
    `);
    await asyncDb.run(`
      CREATE INDEX IF NOT EXISTS idx_conversation_thread_refs_thread
      ON conversation_thread_refs (platform, user_id, thread_id)
    `);
    await asyncDb.run(`SET client_min_messages TO NOTICE`);
  } else {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        platform TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, user_id, thread_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_thread_refs (
        platform TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        message_reference TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, user_id, message_reference)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversation_threads_latest
      ON conversation_threads (platform, user_id, updated_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversation_thread_refs_thread
      ON conversation_thread_refs (platform, user_id, thread_id)
    `);
  }

  tablesInitialized = true;
  debug("[thread-store] tables initialized");
}

class SqliteConversationThreadStore implements ConversationThreadStore {
  async touchThread(
    platform: ConversationPlatform,
    userId: number,
    threadId: string,
  ): Promise<void> {
    await ensureTables();
    const db = getDatabase();
    const now = Date.now();

    db.run(
      `INSERT INTO conversation_threads (platform, user_id, thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(platform, user_id, thread_id) DO UPDATE SET
         updated_at = excluded.updated_at`,
      [platform, userId, threadId, now, now],
    );
  }

  async bindMessageReference(
    platform: ConversationPlatform,
    userId: number,
    messageReference: string,
    threadId: string,
  ): Promise<void> {
    await ensureTables();
    const db = getDatabase();
    const now = Date.now();

    db.run(
      `INSERT INTO conversation_thread_refs (platform, user_id, message_reference, thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, user_id, message_reference) DO UPDATE SET
         thread_id = excluded.thread_id,
         updated_at = excluded.updated_at`,
      [platform, userId, messageReference, threadId, now, now],
    );

    await this.touchThread(platform, userId, threadId);
  }

  async resolveMessageReference(
    platform: ConversationPlatform,
    userId: number,
    messageReference: string,
  ): Promise<string | null> {
    await ensureTables();
    const db = getDatabase();
    const row = db
      .query<{ thread_id: string }>(
        `SELECT thread_id FROM conversation_thread_refs
         WHERE platform = ? AND user_id = ? AND message_reference = ?`,
      )
      .get(platform, userId, messageReference);

    return row?.thread_id ?? null;
  }

  async getLatestThreadId(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<string | null> {
    const latestThread = await this.getLatestThread(platform, userId);
    return latestThread?.threadId ?? null;
  }

  async getLatestThread(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<ConversationThreadRecord | null> {
    await ensureTables();
    const db = getDatabase();
    const row = db
      .query<{ thread_id: string; updated_at: number }>(
        `SELECT thread_id, updated_at FROM conversation_threads
         WHERE platform = ? AND user_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(platform, userId);

    if (!row) {
      return null;
    }

    return {
      threadId: row.thread_id,
      updatedAt: row.updated_at,
    };
  }

  async listRecentThreads(
    platform: ConversationPlatform,
    userId: number,
    limit: number,
  ): Promise<ConversationThreadRecord[]> {
    await ensureTables();
    const db = getDatabase();
    const rows = db
      .query<{ thread_id: string; updated_at: number }>(
        `SELECT thread_id, updated_at FROM conversation_threads
         WHERE platform = ? AND user_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(platform, userId, limit);

    return rows.map((row) => ({
      threadId: row.thread_id,
      updatedAt: row.updated_at,
    }));
  }

  async clearUserThreads(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<void> {
    await ensureTables();
    const db = getDatabase();

    db.run(
      `DELETE FROM conversation_thread_refs WHERE platform = ? AND user_id = ?`,
      [platform, userId],
    );
    db.run(
      `DELETE FROM conversation_threads WHERE platform = ? AND user_id = ?`,
      [platform, userId],
    );
  }
}

class PostgresConversationThreadStore implements ConversationThreadStore {
  async touchThread(
    platform: ConversationPlatform,
    userId: number,
    threadId: string,
  ): Promise<void> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) {
      return;
    }

    const now = Date.now();
    await asyncDb.run(
      `INSERT INTO conversation_threads (platform, user_id, thread_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(platform, user_id, thread_id) DO UPDATE SET
         updated_at = EXCLUDED.updated_at`,
      [platform, userId, threadId, now, now],
    );
  }

  async bindMessageReference(
    platform: ConversationPlatform,
    userId: number,
    messageReference: string,
    threadId: string,
  ): Promise<void> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) {
      return;
    }

    const now = Date.now();
    await asyncDb.run(
      `INSERT INTO conversation_thread_refs (platform, user_id, message_reference, thread_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(platform, user_id, message_reference) DO UPDATE SET
         thread_id = EXCLUDED.thread_id,
         updated_at = EXCLUDED.updated_at`,
      [platform, userId, messageReference, threadId, now, now],
    );

    await this.touchThread(platform, userId, threadId);
  }

  async resolveMessageReference(
    platform: ConversationPlatform,
    userId: number,
    messageReference: string,
  ): Promise<string | null> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) {
      return null;
    }

    const row = await asyncDb.get<{ thread_id: string }>(
      `SELECT thread_id FROM conversation_thread_refs
       WHERE platform = $1 AND user_id = $2 AND message_reference = $3`,
      platform,
      userId,
      messageReference,
    );

    return row?.thread_id ?? null;
  }

  async getLatestThreadId(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<string | null> {
    const latestThread = await this.getLatestThread(platform, userId);
    return latestThread?.threadId ?? null;
  }

  async getLatestThread(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<ConversationThreadRecord | null> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) {
      return null;
    }

    const row = await asyncDb.get<{ thread_id: string; updated_at: number }>(
      `SELECT thread_id, updated_at FROM conversation_threads
       WHERE platform = $1 AND user_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      platform,
      userId,
    );

    if (!row) {
      return null;
    }

    return {
      threadId: row.thread_id,
      updatedAt: row.updated_at,
    };
  }

  async listRecentThreads(
    platform: ConversationPlatform,
    userId: number,
    limit: number,
  ): Promise<ConversationThreadRecord[]> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) {
      return [];
    }

    const rows = await asyncDb.all<{ thread_id: string; updated_at: number }>(
      `SELECT thread_id, updated_at FROM conversation_threads
       WHERE platform = $1 AND user_id = $2
       ORDER BY updated_at DESC
       LIMIT $3`,
      platform,
      userId,
      limit,
    );

    return rows.map((row) => ({
      threadId: row.thread_id,
      updatedAt: row.updated_at,
    }));
  }

  async clearUserThreads(
    platform: ConversationPlatform,
    userId: number,
  ): Promise<void> {
    await ensureTables();
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) {
      return;
    }

    await asyncDb.run(
      `DELETE FROM conversation_thread_refs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    await asyncDb.run(
      `DELETE FROM conversation_threads WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
  }
}

function createConversationThreadStore(): ConversationThreadStore {
  if (isUsingPostgres()) {
    return new PostgresConversationThreadStore();
  }

  return new SqliteConversationThreadStore();
}

let storeInstance: ConversationThreadStore | null = null;

export function conversationThreadStore(): ConversationThreadStore {
  if (!storeInstance) {
    storeInstance = createConversationThreadStore();
  }

  return storeInstance;
}
