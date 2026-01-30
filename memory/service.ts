import { getDatabase } from "../data/db";
import { v4 as uuidv4 } from "uuid";

export interface Memory {
  id: string;
  userId: number;
  content: string;
  rawContent?: string;
  keywords: string[];
  emotionalWeight: number;
  timestamp: number;
  lastRecalled?: number;
  recallCount: number;
}

export interface MemorySearchResult {
  memory: Memory;
  relevanceScore: number;
  isRecent: boolean;
}

// stop words to filter out common words that don't carry meaning
const STOP_WORDS = new Set([
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself",
  "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
  "what", "which", "who", "whom", "this", "that", "these", "those",
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing",
  "a", "an", "the", "and", "but", "if", "or", "because", "as",
  "until", "while", "of", "at", "by", "for", "with", "about",
  "against", "between", "into", "through", "during", "before", "after",
  "above", "below", "to", "from", "up", "down", "in", "out", "on", "off",
  "over", "under", "again", "further", "then", "once", "here", "there",
  "when", "where", "why", "how", "all", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "s", "t", "can", "will", "just", "don",
  "should", "now", "d", "ll", "m", "o", "re", "ve", "y", "ain",
  "aren", "couldn", "didn", "doesn", "hadn", "hasn", "haven", "isn",
  "ma", "mightn", "mustn", "needn", "shan", "shouldn", "wasn", "weren",
  "won", "wouldn", "yeah", "yes", "oh", "um", "uh", "like", "really",
  "actually", "gonna", "wanna", "gotta", "kinda", "sorta", "maybe",
  "probably", "definitely", "lol", "haha", "hmm", "okay", "ok", "well",
  "hey", "hi", "hello", "bye",
]);

// emotional indicators that boost memory importance
const EMOTIONAL_MARKERS = [
  "love", "hate", "fear", "scared", "happy", "sad", "angry", "excited",
  "worried", "anxious", "proud", "ashamed", "guilty", "jealous", "hurt",
  "painful", "amazing", "terrible", "wonderful", "awful", "best", "worst",
  "favorite", "remember", "forgot", "miss", "wish", "hope", "dream",
  "nightmare", "secret", "confession", "admit", "honestly", "truth",
  "never", "always", "forever", "first", "last", "only", "important",
];

export class MemoryService {
  private initialized = false;

  private ensureTable(): void {
    if (this.initialized) return;

    const db = getDatabase();

    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        raw_content TEXT,
        keywords TEXT NOT NULL,
        emotional_weight INTEGER DEFAULT 5,
        timestamp INTEGER NOT NULL,
        last_recalled INTEGER,
        recall_count INTEGER DEFAULT 0
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_keywords ON memories(keywords)`);

    this.initialized = true;
    console.log("[memory] table initialized");
  }

  // extract meaningful keywords from text
  extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s']/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .filter((w) => !STOP_WORDS.has(w));

    const unique = [...new Set(words)];

    // extract 2-word phrases for better matching
    const phrases: string[] = [];
    const wordArray = text.toLowerCase().split(/\s+/);
    for (let i = 0; i < wordArray.length - 1; i++) {
      const word1 = wordArray[i];
      const word2 = wordArray[i + 1];
      if (!word1 || !word2) continue;

      const w1 = word1.replace(/[^\w']/g, "");
      const w2 = word2.replace(/[^\w']/g, "");
      if (w1.length > 2 && w2.length > 2 && !STOP_WORDS.has(w1) && !STOP_WORDS.has(w2)) {
        phrases.push(`${w1}_${w2}`);
      }
    }

    // limit to 20 keywords to prevent bloat
    return [...unique, ...phrases].slice(0, 20);
  }

  // calculate emotional weight of content (1-10 scale)
  calculateEmotionalWeight(text: string): number {
    const lowerText = text.toLowerCase();
    let weight = 5;

    for (const marker of EMOTIONAL_MARKERS) {
      if (lowerText.includes(marker)) {
        weight += 1;
      }
    }

    if (text.includes("?")) weight += 1;

    const exclamations = (text.match(/!/g) || []).length;
    weight += Math.min(exclamations, 2);

    return Math.min(weight, 10);
  }

  // store a new memory
  storeMemory(userId: number, content: string): Memory {
    this.ensureTable();
    const db = getDatabase();

    // skip trivially short content
    if (content.length < 20) {
      console.log(`[memory] skipped (too short): "${content.substring(0, 40)}..."`);
      return null as any;
    }

    const keywords = this.extractKeywords(content);
    const emotionalWeight = this.calculateEmotionalWeight(content);

    const memory: Memory = {
      id: uuidv4(),
      userId,
      content: content.substring(0, 500),
      rawContent: content.substring(0, 500),
      keywords,
      emotionalWeight,
      timestamp: Date.now(),
      recallCount: 0,
    };

    db.run(
      `INSERT INTO memories (id, user_id, content, raw_content, keywords, emotional_weight, timestamp, recall_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.id,
        memory.userId,
        memory.content,
        memory.rawContent || null,
        JSON.stringify(memory.keywords),
        memory.emotionalWeight,
        memory.timestamp,
        memory.recallCount,
      ]
    );

    console.log(`[memory] stored for user ${userId}: "${content.substring(0, 40)}..." (weight: ${emotionalWeight})`);
    return memory;
  }

  // search for relevant memories based on query text
  searchMemories(userId: number, queryText: string, limit: number = 5): MemorySearchResult[] {
    this.ensureTable();
    const db = getDatabase();

    const queryKeywords = this.extractKeywords(queryText);
    if (queryKeywords.length === 0) return [];

    const rows = db
      .query(`SELECT * FROM memories WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100`)
      .all(userId) as any[];

    const memories: Memory[] = rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      content: row.content,
      rawContent: row.raw_content || undefined,
      keywords: JSON.parse(row.keywords),
      emotionalWeight: row.emotional_weight,
      timestamp: row.timestamp,
      lastRecalled: row.last_recalled,
      recallCount: row.recall_count,
    }));

    // score each memory based on keyword overlap
    const scored: MemorySearchResult[] = memories.map((memory) => {
      let score = 0;

      const memoryKeywordSet = new Set(memory.keywords);
      for (const qk of queryKeywords) {
        if (memoryKeywordSet.has(qk)) {
          score += 2; // direct match
        }
        // partial match for phrases
        for (const mk of memory.keywords) {
          if (mk.includes(qk) || qk.includes(mk)) {
            score += 0.5;
          }
        }
      }

      // recency boost (last 24 hours)
      const hoursSince = (Date.now() - memory.timestamp) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        score *= 1.2;
      }

      // penalty for frequently recalled memories (encourage variety)
      if (memory.recallCount > 3) {
        score *= 0.8;
      }

      return {
        memory,
        relevanceScore: score,
        isRecent: hoursSince < 1,
      };
    });

    return scored
      .filter((s) => s.relevanceScore > 1)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }

  // mark a memory as recalled
  markRecalled(memoryId: string): void {
    this.ensureTable();
    const db = getDatabase();
    db.run(
      `UPDATE memories SET last_recalled = ?, recall_count = recall_count + 1 WHERE id = ?`,
      [Date.now(), memoryId]
    );
  }

  // get a random memory that hasn't been recalled recently
  getRandomMemory(userId: number): Memory | null {
    this.ensureTable();
    const db = getDatabase();

    const row = db
      .query(
        `SELECT * FROM memories 
         WHERE user_id = ? 
         AND (last_recalled IS NULL OR last_recalled < ?)
         ORDER BY RANDOM()
         LIMIT 1`
      )
      .get(userId, Date.now() - 1000 * 60 * 30) as any;

    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      content: row.content,
      rawContent: row.raw_content || undefined,
      keywords: JSON.parse(row.keywords),
      emotionalWeight: row.emotional_weight,
      timestamp: row.timestamp,
      lastRecalled: row.last_recalled,
      recallCount: row.recall_count,
    };
  }

  // build memory context for agent prompt
  buildMemoryContext(userId: number, currentMessage: string): string {
    const results = this.searchMemories(userId, currentMessage, 3);

    if (results.length === 0) {
      // occasionally surface a random memory
      if (Math.random() < 0.15) {
        const randomMemory = this.getRandomMemory(userId);
        if (randomMemory) {
          this.markRecalled(randomMemory.id);
          return `\n<memory type="random-recall">
Something from a while back just popped into your head: "${randomMemory.rawContent || randomMemory.content}"
Use this to subtly influence your response, but don't quote it directly.
</memory>`;
        }
      }
      return "";
    }

    const relevantMemories = results.filter((r) => r.relevanceScore > 2);
    if (relevantMemories.length === 0) return "";

    const memoryLines = relevantMemories.map((r) => {
      this.markRecalled(r.memory.id);
      const timeAgo = this.formatTimeAgo(r.memory.timestamp);
      return `- "${r.memory.rawContent || r.memory.content}" (${timeAgo})`;
    });

    return `\n<memory type="relevant-recall">
Things you remember that relate to what they just said:
${memoryLines.join("\n")}
Use this context to inform your response naturally, without explicitly mentioning you remember.
</memory>`;
  }

  private formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  // get memory stats for a user
  getStats(userId: number): { total: number; avgWeight: number } {
    this.ensureTable();
    const db = getDatabase();

    const row = db
      .query(
        `SELECT COUNT(*) as total, AVG(emotional_weight) as avg_weight 
         FROM memories WHERE user_id = ?`
      )
      .get(userId) as any;

    return {
      total: row?.total || 0,
      avgWeight: row?.avg_weight || 5,
    };
  }

  // clear all memories for a user
  clearUserMemories(userId: number): void {
    this.ensureTable();
    const db = getDatabase();
    db.run(`DELETE FROM memories WHERE user_id = ?`, [userId]);
    console.log(`[memory] cleared all memories for user ${userId}`);
  }

  // clear all memories
  clearAll(): void {
    this.ensureTable();
    const db = getDatabase();
    db.run(`DELETE FROM memories`);
    console.log("[memory] cleared all memories");
  }
}

export const memoryService = new MemoryService();
