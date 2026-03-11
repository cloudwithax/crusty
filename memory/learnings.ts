// learning machine - self-improving knowledge system
// inspired by agno-agi/dash, stores discovered patterns, gotchas, and fixes
// separate from general memories to maintain a focused knowledge base

import { getDatabase, getAsyncDatabase } from "../data/db";
import { v4 as uuidv4 } from "uuid";
import { debug } from "../utils/debug.ts";
import {
  isEmbeddingsAvailable,
  storeLearningWithEmbedding,
  searchLearningsByEmbedding,
  getLearningEmbeddingStats,
  backfillLearningEmbeddings,
} from "./embeddings";

// learning categories for better organization and retrieval
export type LearningCategory =
  | "error_pattern" // tool failures, api errors
  | "gotcha" // non-obvious quirks discovered during use
  | "fix" // solutions that worked
  | "preference" // user preferences and corrections
  | "workflow" // successful patterns and approaches
  | "context"; // domain-specific knowledge

export interface Learning {
  id: string;
  userId: number;
  title: string;
  content: string;
  category: LearningCategory;
  toolName?: string; // relevant tool if applicable
  errorType?: string; // error classification if from failure
  keywords: string[];
  confidence: number; // 0-1, increases with successful applications
  applicationCount: number; // times this learning was applied
  timestamp: number;
  lastApplied?: number;
}

export interface LearningSearchResult {
  learning: Learning;
  relevanceScore: number;
  isRecent: boolean;
}

// stop words for keyword extraction
const STOP_WORDS = new Set([
  "i",
  "me",
  "my",
  "myself",
  "we",
  "our",
  "ours",
  "ourselves",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "he",
  "him",
  "his",
  "himself",
  "she",
  "her",
  "hers",
  "herself",
  "it",
  "its",
  "itself",
  "they",
  "them",
  "their",
  "theirs",
  "themselves",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "am",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "do",
  "does",
  "did",
  "doing",
  "a",
  "an",
  "the",
  "and",
  "but",
  "if",
  "or",
  "because",
  "as",
  "until",
  "while",
  "of",
  "at",
  "by",
  "for",
  "with",
  "about",
  "against",
  "between",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "to",
  "from",
  "up",
  "down",
  "in",
  "out",
  "on",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "s",
  "t",
  "can",
  "will",
  "just",
  "don",
  "should",
  "now",
  "use",
  "using",
  "used",
]);

export class LearningsService {
  private initialized = false;

  private ensureTable(): void {
    if (this.initialized) return;
    // tables are initialized in db.ts
    this.initialized = true;
    debug("[learnings] service initialized");
  }

  // extract keywords from text
  extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s'_-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .filter((w) => !STOP_WORDS.has(w));

    const unique = [...new Set(words)];

    // extract technical terms that might have underscores or hyphens
    const technicalTerms = text.match(/[\w_-]{4,}/g) || [];
    const techUnique = [...new Set(technicalTerms.map((t) => t.toLowerCase()))];

    return [...unique, ...techUnique].slice(0, 15);
  }

  // store a new learning
  async storeLearning(
    userId: number,
    title: string,
    content: string,
    category: LearningCategory,
    options?: {
      toolName?: string;
      errorType?: string;
      confidence?: number;
    },
  ): Promise<Learning | null> {
    this.ensureTable();

    // validate content length
    if (content.length < 10) {
      debug(
        `[learnings] skipped (too short): "${content.substring(0, 40)}..."`,
      );
      return null;
    }

    // check for duplicate or very similar learning
    const existing = await this.searchLearnings(
      userId,
      `${title} ${content}`,
      3,
    );
    for (const result of existing) {
      if (result.relevanceScore > 8) {
        debug(`[learnings] skipped (duplicate): "${title}"`);
        // boost confidence of existing learning instead
        await this.markApplied(result.learning.id);
        return result.learning;
      }
    }

    const keywords = this.extractKeywords(`${title} ${content}`);

    const learning: Learning = {
      id: uuidv4(),
      userId,
      title: title.substring(0, 200),
      content: content.substring(0, 1000),
      category,
      toolName: options?.toolName,
      errorType: options?.errorType,
      keywords,
      confidence: options?.confidence ?? 0.5,
      applicationCount: 0,
      timestamp: Date.now(),
    };

    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      await asyncDb.run(
        `INSERT INTO learnings (id, user_id, title, content, category, tool_name, error_type, keywords, confidence, application_count, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          learning.id,
          learning.userId,
          learning.title,
          learning.content,
          learning.category,
          learning.toolName || null,
          learning.errorType || null,
          JSON.stringify(learning.keywords),
          learning.confidence,
          learning.applicationCount,
          learning.timestamp,
        ],
      );
    } else {
      const db = getDatabase();
      db.run(
        `INSERT INTO learnings (id, user_id, title, content, category, tool_name, error_type, keywords, confidence, application_count, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          learning.id,
          learning.userId,
          learning.title,
          learning.content,
          learning.category,
          learning.toolName || null,
          learning.errorType || null,
          JSON.stringify(learning.keywords),
          learning.confidence,
          learning.applicationCount,
          learning.timestamp,
        ],
      );
    }

    // store embedding if pgvector is available
    const embeddingsAvailable = await isEmbeddingsAvailable();
    if (embeddingsAvailable) {
      // combine title and content for richer semantic representation
      await storeLearningWithEmbedding(
        learning.id,
        `${learning.title}\n${learning.content}`,
      );
    }

    debug(`[learnings] stored: "${title}" (category: ${category})`);

    return learning;
  }

  // search for relevant learnings
  async searchLearnings(
    userId: number,
    queryText: string,
    limit: number = 5,
    category?: LearningCategory,
  ): Promise<LearningSearchResult[]> {
    this.ensureTable();

    // try embedding-based search first if available
    const embeddingsAvailable = await isEmbeddingsAvailable();
    if (embeddingsAvailable) {
      debug(`[learnings] using embedding search`);
      const embeddingResults = await searchLearningsByEmbedding(
        userId,
        queryText,
        limit,
        category,
      );

      if (embeddingResults.length > 0) {
        // convert embedding results to LearningSearchResult format
        const results: LearningSearchResult[] = [];
        for (const result of embeddingResults) {
          const learning = await this.getLearningById(result.id);
          if (learning) {
            const hoursSince =
              (Date.now() - learning.timestamp) / (1000 * 60 * 60);
            results.push({
              learning,
              // scale similarity (0-1) to score comparable with keyword search
              relevanceScore: result.similarity * 10,
              isRecent: hoursSince < 24,
            });
          }
        }
        return results;
      }
    }

    // fallback to keyword-based search
    debug(`[learnings] using keyword search`);

    const queryKeywords = this.extractKeywords(queryText);
    if (queryKeywords.length === 0) return [];

    let rows: any[];
    const asyncDb = getAsyncDatabase();

    const categoryFilter = category ? ` AND category = '${category}'` : "";

    if (asyncDb) {
      rows = await asyncDb.all(
        `SELECT * FROM learnings WHERE user_id = $1${categoryFilter} ORDER BY timestamp DESC LIMIT 100`,
        userId,
      );
    } else {
      const db = getDatabase();
      rows = db
        .query(
          `SELECT * FROM learnings WHERE user_id = ?${categoryFilter} ORDER BY timestamp DESC LIMIT 100`,
        )
        .all(userId) as any[];
    }

    const learnings: Learning[] = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      title: row.title,
      content: row.content,
      category: row.category as LearningCategory,
      toolName: row.tool_name || undefined,
      errorType: row.error_type || undefined,
      keywords: JSON.parse(row.keywords),
      confidence: row.confidence,
      applicationCount: row.application_count,
      timestamp: row.timestamp,
      lastApplied: row.last_applied || undefined,
    }));

    // score each learning based on keyword overlap and confidence
    const scored: LearningSearchResult[] = learnings.map((learning) => {
      let score = 0;

      const learningKeywordSet = new Set(learning.keywords);
      for (const qk of queryKeywords) {
        if (learningKeywordSet.has(qk)) {
          score += 2;
        }
        for (const lk of learning.keywords) {
          if (lk.includes(qk) || qk.includes(lk)) {
            score += 0.5;
          }
        }
      }

      // boost by confidence
      score *= 0.5 + learning.confidence;

      // boost by application count (proven learnings)
      if (learning.applicationCount > 0) {
        score *= 1 + Math.min(learning.applicationCount * 0.1, 0.5);
      }

      // recency boost
      const hoursSince = (Date.now() - learning.timestamp) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        score *= 1.2;
      }

      return {
        learning,
        relevanceScore: score,
        isRecent: hoursSince < 24,
      };
    });

    return scored
      .filter((s) => s.relevanceScore > 1)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }

  // get a learning by id
  async getLearningById(id: string): Promise<Learning | null> {
    this.ensureTable();

    const asyncDb = getAsyncDatabase();
    let row: any;

    if (asyncDb) {
      row = await asyncDb.get(`SELECT * FROM learnings WHERE id = $1`, id);
    } else {
      const db = getDatabase();
      row = db.query(`SELECT * FROM learnings WHERE id = ?`).get(id);
    }

    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      content: row.content,
      category: row.category as LearningCategory,
      toolName: row.tool_name || undefined,
      errorType: row.error_type || undefined,
      keywords: JSON.parse(row.keywords),
      confidence: row.confidence,
      applicationCount: row.application_count,
      timestamp: row.timestamp,
      lastApplied: row.last_applied || undefined,
    };
  }

  // mark a learning as applied (increases confidence)
  async markApplied(learningId: string): Promise<void> {
    this.ensureTable();

    const asyncDb = getAsyncDatabase();
    const now = Date.now();

    if (asyncDb) {
      await asyncDb.run(
        `UPDATE learnings 
         SET application_count = application_count + 1, 
             confidence = LEAST(confidence + 0.1, 1.0),
             last_applied = $1
         WHERE id = $2`,
        [now, learningId],
      );
    } else {
      const db = getDatabase();
      db.run(
        `UPDATE learnings 
         SET application_count = application_count + 1, 
             confidence = MIN(confidence + 0.1, 1.0),
             last_applied = ?
         WHERE id = ?`,
        [now, learningId],
      );
    }

    debug(`[learnings] marked applied: ${learningId.substring(0, 8)}`);
  }

  // get learnings for a specific tool
  async getLearningsForTool(
    userId: number,
    toolName: string,
  ): Promise<Learning[]> {
    this.ensureTable();

    const asyncDb = getAsyncDatabase();
    let rows: any[];

    if (asyncDb) {
      rows = await asyncDb.all(
        `SELECT * FROM learnings WHERE user_id = $1 AND tool_name = $2 ORDER BY confidence DESC, timestamp DESC LIMIT 10`,
        userId,
        toolName,
      );
    } else {
      const db = getDatabase();
      rows = db
        .query(
          `SELECT * FROM learnings WHERE user_id = ? AND tool_name = ? ORDER BY confidence DESC, timestamp DESC LIMIT 10`,
        )
        .all(userId, toolName) as any[];
    }

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      title: row.title,
      content: row.content,
      category: row.category as LearningCategory,
      toolName: row.tool_name || undefined,
      errorType: row.error_type || undefined,
      keywords: JSON.parse(row.keywords),
      confidence: row.confidence,
      applicationCount: row.application_count,
      timestamp: row.timestamp,
      lastApplied: row.last_applied || undefined,
    }));
  }

  // get top learnings by confidence
  async getTopLearnings(
    userId: number,
    limit: number = 10,
  ): Promise<Learning[]> {
    this.ensureTable();

    const asyncDb = getAsyncDatabase();
    let rows: any[];

    if (asyncDb) {
      rows = await asyncDb.all(
        `SELECT * FROM learnings WHERE user_id = $1 ORDER BY confidence DESC, application_count DESC, timestamp DESC LIMIT $2`,
        userId,
        limit,
      );
    } else {
      const db = getDatabase();
      rows = db
        .query(
          `SELECT * FROM learnings WHERE user_id = ? ORDER BY confidence DESC, application_count DESC, timestamp DESC LIMIT ?`,
        )
        .all(userId, limit) as any[];
    }

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      title: row.title,
      content: row.content,
      category: row.category as LearningCategory,
      toolName: row.tool_name || undefined,
      errorType: row.error_type || undefined,
      keywords: JSON.parse(row.keywords),
      confidence: row.confidence,
      applicationCount: row.application_count,
      timestamp: row.timestamp,
      lastApplied: row.last_applied || undefined,
    }));
  }

  // get learning stats
  async getStats(userId: number): Promise<{
    total: number;
    byCategory: Record<LearningCategory, number>;
    avgConfidence: number;
    totalApplications: number;
  }> {
    this.ensureTable();

    const asyncDb = getAsyncDatabase();
    let rows: any[];
    let statsRow: any;

    if (asyncDb) {
      rows = await asyncDb.all(
        `SELECT category, COUNT(*) as count FROM learnings WHERE user_id = $1 GROUP BY category`,
        userId,
      );
      statsRow = await asyncDb.get(
        `SELECT COUNT(*) as total, AVG(confidence) as avg_confidence, SUM(application_count) as total_apps FROM learnings WHERE user_id = $1`,
        userId,
      );
    } else {
      const db = getDatabase();
      rows = db
        .query(
          `SELECT category, COUNT(*) as count FROM learnings WHERE user_id = ? GROUP BY category`,
        )
        .all(userId) as any[];
      statsRow = db
        .query(
          `SELECT COUNT(*) as total, AVG(confidence) as avg_confidence, SUM(application_count) as total_apps FROM learnings WHERE user_id = ?`,
        )
        .get(userId) as any;
    }

    const byCategory: Record<LearningCategory, number> = {
      error_pattern: 0,
      gotcha: 0,
      fix: 0,
      preference: 0,
      workflow: 0,
      context: 0,
    };

    for (const row of rows) {
      byCategory[row.category as LearningCategory] = row.count;
    }

    return {
      total: statsRow?.total || 0,
      byCategory,
      avgConfidence: statsRow?.avg_confidence || 0,
      totalApplications: statsRow?.total_apps || 0,
    };
  }

  // prune low-confidence, unused learnings
  async pruneStale(
    userId: number,
    maxAge: number = 30 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    this.ensureTable();

    const cutoff = Date.now() - maxAge;
    const asyncDb = getAsyncDatabase();

    // delete learnings that are old, low confidence, and never applied
    if (asyncDb) {
      await asyncDb.run(
        `DELETE FROM learnings WHERE user_id = $1 AND timestamp < $2 AND confidence < 0.3 AND application_count = 0`,
        [userId, cutoff],
      );
    } else {
      const db = getDatabase();
      const countRow = db
        .query(
          `SELECT COUNT(*) as count FROM learnings WHERE user_id = ? AND timestamp < ? AND confidence < 0.3 AND application_count = 0`,
        )
        .get(userId, cutoff) as any;

      db.run(
        `DELETE FROM learnings WHERE user_id = ? AND timestamp < ? AND confidence < 0.3 AND application_count = 0`,
        [userId, cutoff],
      );

      return countRow?.count || 0;
    }

    debug(`[learnings] pruned stale entries`);
    return 0;
  }

  // backfill embeddings for existing learnings
  async backfillEmbeddings(
    userId?: number,
    batchSize: number = 50,
  ): Promise<number> {
    return backfillLearningEmbeddings(userId, batchSize);
  }

  // get embedding stats
  async getEmbeddingStats(userId: number): Promise<{
    total: number;
    withEmbedding: number;
    coverage: number;
  }> {
    return getLearningEmbeddingStats(userId);
  }
}

// singleton instance
export const learningsService = new LearningsService();
