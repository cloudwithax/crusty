// session-memory.ts
// indexes conversation sessions for searchable long-term memory
// enables recall of past conversations via hybrid search

import { getDatabase, isUsingPostgres } from "../data/db";
import { debug } from "../utils/debug";
import { createHash } from "crypto";
import { getHybridConfig } from "./hybrid-search";
import { estimateTokens } from "../core/context-config";

// session message format
export interface SessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: boolean;
}

// session entry
export interface SessionEntry {
  id: string;
  userId: number;
  title: string;
  slug: string;
  messages: SessionMessage[];
  startTime: number;
  endTime: number;
  messageCount: number;
  tokenEstimate: number;
}

// session search result
export interface SessionSearchResult {
  sessionId: string;
  title: string;
  slug: string;
  snippet: string;
  score: number;
  timestamp: number;
  startLine: number;
  endLine: number;
}

// delta thresholds before triggering background sync
const DELTA_BYTES_THRESHOLD = parseInt(
  process.env.SESSION_DELTA_BYTES || "100000",
  10,
); // 100kb
const DELTA_MESSAGES_THRESHOLD = parseInt(
  process.env.SESSION_DELTA_MESSAGES || "50",
  10,
);

let sessionTablesInitialized = false;

// ensure session tables exist
async function ensureSessionTables(): Promise<boolean> {
  if (sessionTablesInitialized) return true;

  if (isUsingPostgres()) {
    sessionTablesInitialized = true;
    return false;
  }

  const db = getDatabase();
  if (!db) return false;

  try {
    // sessions table for session metadata
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // session messages for individual messages
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        has_tool_calls INTEGER DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);

    // delta tracking for incremental indexing
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_deltas (
        session_id TEXT PRIMARY KEY,
        last_indexed_bytes INTEGER DEFAULT 0,
        last_indexed_messages INTEGER DEFAULT 0,
        last_indexed_at INTEGER NOT NULL
      )
    `);

    // fts5 index for session content
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        content,
        message_id UNINDEXED,
        session_id UNINDEXED,
        role UNINDEXED
      )
    `);

    // indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_slug ON sessions(slug)
    `);

    sessionTablesInitialized = true;
    debug("[session-memory] tables initialized");
    return true;
  } catch (err) {
    debug("[session-memory] table initialization failed:", err);
    return false;
  }
}

// generate a slug for a session (could be enhanced with llm later)
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

// format date for session naming
function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toISOString().split("T")[0] ?? d.toISOString().substring(0, 10);
}

// save a session for indexing
export async function saveSession(
  userId: number,
  messages: SessionMessage[],
  title?: string,
): Promise<SessionEntry | null> {
  const available = await ensureSessionTables();
  if (!available) return null;

  if (messages.length < 2) {
    debug("[session-memory] session too short to save");
    return null;
  }

  const db = getDatabase();
  if (!db) return null;

  // generate session id from timestamp and hash
  const startTime = messages[0]?.timestamp || Date.now();
  const endTime = messages[messages.length - 1]?.timestamp || Date.now();
  const contentHash = createHash("sha256")
    .update(messages.map((m) => m.content).join(""))
    .digest("hex")
    .substring(0, 8);

  const sessionId = `${formatDate(startTime)}-${contentHash}`;

  // generate title from first user message or use provided
  const firstUserMsg = messages.find((m) => m.role === "user");
  const autoTitle =
    title ||
    (firstUserMsg?.content.substring(0, 100) || "untitled session").trim();
  const slug = generateSlug(autoTitle);

  // calculate total tokens
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );

  try {
    // insert or update session
    db.run(
      `INSERT OR REPLACE INTO sessions 
       (id, user_id, title, slug, start_time, end_time, message_count, token_estimate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        userId,
        autoTitle,
        slug,
        startTime,
        endTime,
        messages.length,
        totalTokens,
        Date.now(),
        Date.now(),
      ],
    );

    // insert messages
    for (const msg of messages) {
      const msgId = `${sessionId}-${msg.timestamp}`;
      db.run(
        `INSERT OR IGNORE INTO session_messages 
         (id, session_id, role, content, timestamp, has_tool_calls)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          msgId,
          sessionId,
          msg.role,
          msg.content,
          msg.timestamp,
          msg.toolCalls ? 1 : 0,
        ],
      );

      // add to fts5 index
      db.run(
        `INSERT OR IGNORE INTO session_messages_fts 
         (content, message_id, session_id, role)
         VALUES (?, ?, ?, ?)`,
        [msg.content, msgId, sessionId, msg.role],
      );
    }

    debug(
      `[session-memory] saved session: ${sessionId} (${messages.length} messages)`,
    );

    return {
      id: sessionId,
      userId,
      title: autoTitle,
      slug,
      messages,
      startTime,
      endTime,
      messageCount: messages.length,
      tokenEstimate: totalTokens,
    };
  } catch (err) {
    debug("[session-memory] session save failed:", err);
    return null;
  }
}

// check if a session needs reindexing based on delta
export async function needsReindex(sessionId: string): Promise<boolean> {
  const available = await ensureSessionTables();
  if (!available) return false;

  const db = getDatabase();
  if (!db) return false;

  // get current session size
  const session = db
    .query<{
      message_count: number;
      token_estimate: number;
    }>(`SELECT message_count, token_estimate FROM sessions WHERE id = ?`)
    .get(sessionId);

  if (!session) return false;

  // get delta tracking
  const delta = db
    .query<{
      last_indexed_bytes: number;
      last_indexed_messages: number;
    }>(
      `SELECT last_indexed_bytes, last_indexed_messages FROM session_deltas WHERE session_id = ?`,
    )
    .get(sessionId);

  if (!delta) return true; // never indexed

  const newBytes = session.token_estimate * 4 - delta.last_indexed_bytes;
  const newMessages = session.message_count - delta.last_indexed_messages;

  return (
    newBytes >= DELTA_BYTES_THRESHOLD || newMessages >= DELTA_MESSAGES_THRESHOLD
  );
}

// update delta tracking after indexing
export async function updateDelta(sessionId: string): Promise<void> {
  const available = await ensureSessionTables();
  if (!available) return;

  const db = getDatabase();
  if (!db) return;

  const session = db
    .query<{
      message_count: number;
      token_estimate: number;
    }>(`SELECT message_count, token_estimate FROM sessions WHERE id = ?`)
    .get(sessionId);

  if (!session) return;

  db.run(
    `INSERT OR REPLACE INTO session_deltas 
     (session_id, last_indexed_bytes, last_indexed_messages, last_indexed_at)
     VALUES (?, ?, ?, ?)`,
    [sessionId, session.token_estimate * 4, session.message_count, Date.now()],
  );
}

// search sessions using hybrid search
export async function searchSessions(
  userId: number,
  query: string,
  limit: number = 5,
): Promise<SessionSearchResult[]> {
  const available = await ensureSessionTables();
  if (!available) return [];

  const db = getDatabase();
  if (!db) return [];

  const config = getHybridConfig();

  try {
    // bm25 search on session messages
    const ftsRows = db
      .query<{
        message_id: string;
        session_id: string;
        content: string;
        rank: number;
      }>(
        `SELECT message_id, session_id, content, bm25(session_messages_fts) as rank
         FROM session_messages_fts
         WHERE session_messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit * config.candidateMultiplier);

    // get session info for each result
    const results: SessionSearchResult[] = [];
    const seenSessions = new Set<string>();

    for (const row of ftsRows) {
      if (seenSessions.has(row.session_id)) continue;
      seenSessions.add(row.session_id);

      const session = db
        .query<{
          title: string;
          slug: string;
          start_time: number;
        }>(
          `SELECT title, slug, start_time FROM sessions WHERE id = ? AND user_id = ?`,
        )
        .get(row.session_id, userId);

      if (session) {
        // create snippet (first 200 chars)
        const snippet =
          row.content.length > 200
            ? row.content.substring(0, 200) + "..."
            : row.content;

        results.push({
          sessionId: row.session_id,
          title: session.title,
          slug: session.slug,
          snippet,
          score: 1 / (1 + Math.abs(row.rank)),
          timestamp: session.start_time,
          startLine: 0,
          endLine: 0,
        });
      }
    }

    // sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  } catch (err) {
    debug("[session-memory] search failed:", err);
    return [];
  }
}

// get recent sessions for a user
export async function getRecentSessions(
  userId: number,
  limit: number = 10,
): Promise<SessionEntry[]> {
  const available = await ensureSessionTables();
  if (!available) return [];

  const db = getDatabase();
  if (!db) return [];

  try {
    const rows = db
      .query<{
        id: string;
        title: string;
        slug: string;
        start_time: number;
        end_time: number;
        message_count: number;
        token_estimate: number;
      }>(
        `SELECT id, title, slug, start_time, end_time, message_count, token_estimate
         FROM sessions
         WHERE user_id = ?
         ORDER BY end_time DESC
         LIMIT ?`,
      )
      .all(userId, limit);

    return rows.map((row) => ({
      id: row.id,
      userId,
      title: row.title,
      slug: row.slug,
      messages: [], // not loading messages for list view
      startTime: row.start_time,
      endTime: row.end_time,
      messageCount: row.message_count,
      tokenEstimate: row.token_estimate,
    }));
  } catch (err) {
    debug("[session-memory] get recent sessions failed:", err);
    return [];
  }
}

// get full session with messages
export async function getSession(
  sessionId: string,
): Promise<SessionEntry | null> {
  const available = await ensureSessionTables();
  if (!available) return null;

  const db = getDatabase();
  if (!db) return null;

  try {
    const session = db
      .query<{
        id: string;
        user_id: number;
        title: string;
        slug: string;
        start_time: number;
        end_time: number;
        message_count: number;
        token_estimate: number;
      }>(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId);

    if (!session) return null;

    const messages = db
      .query<{
        role: string;
        content: string;
        timestamp: number;
        has_tool_calls: number;
      }>(
        `SELECT role, content, timestamp, has_tool_calls
         FROM session_messages
         WHERE session_id = ?
         ORDER BY timestamp ASC`,
      )
      .all(sessionId);

    return {
      id: session.id,
      userId: session.user_id,
      title: session.title,
      slug: session.slug,
      messages: messages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        timestamp: m.timestamp,
        toolCalls: m.has_tool_calls === 1,
      })),
      startTime: session.start_time,
      endTime: session.end_time,
      messageCount: session.message_count,
      tokenEstimate: session.token_estimate,
    };
  } catch (err) {
    debug("[session-memory] get session failed:", err);
    return null;
  }
}

// get session memory stats
export async function getSessionStats(userId: number): Promise<{
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  oldestSession: number | null;
  newestSession: number | null;
}> {
  const available = await ensureSessionTables();
  if (!available) {
    return {
      totalSessions: 0,
      totalMessages: 0,
      totalTokens: 0,
      oldestSession: null,
      newestSession: null,
    };
  }

  const db = getDatabase();
  if (!db) {
    return {
      totalSessions: 0,
      totalMessages: 0,
      totalTokens: 0,
      oldestSession: null,
      newestSession: null,
    };
  }

  try {
    const row = db
      .query<{
        total: number;
        msg_count: number;
        token_sum: number;
        oldest: number | null;
        newest: number | null;
      }>(
        `SELECT 
          COUNT(*) as total,
          SUM(message_count) as msg_count,
          SUM(token_estimate) as token_sum,
          MIN(start_time) as oldest,
          MAX(end_time) as newest
         FROM sessions WHERE user_id = ?`,
      )
      .get(userId);

    return {
      totalSessions: row?.total || 0,
      totalMessages: row?.msg_count || 0,
      totalTokens: row?.token_sum || 0,
      oldestSession: row?.oldest || null,
      newestSession: row?.newest || null,
    };
  } catch (err) {
    debug("[session-memory] stats query failed:", err);
    return {
      totalSessions: 0,
      totalMessages: 0,
      totalTokens: 0,
      oldestSession: null,
      newestSession: null,
    };
  }
}
