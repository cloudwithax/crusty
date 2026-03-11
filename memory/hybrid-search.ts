// hybrid-search.ts
// combines bm25 (lexical) + vector (semantic) search
// gives balanced precision/recall for memory retrieval

import { getDatabase, isUsingPostgres } from "../data/db";
import { debug } from "../utils/debug";
import { generateEmbedding } from "./embeddings";
import { createHash } from "crypto";

// hybrid search config with sensible defaults
export interface HybridSearchConfig {
  vectorWeight: number; // 0-1, weight for semantic similarity
  textWeight: number; // 0-1, weight for bm25/keyword matching
  candidateMultiplier: number; // fetch this many times more candidates
  minScore: number; // minimum combined score threshold
}

const DEFAULT_CONFIG: HybridSearchConfig = {
  vectorWeight: 0.7,
  textWeight: 0.3,
  candidateMultiplier: 4,
  minScore: 0.1,
};

// get config from env or use defaults
export function getHybridConfig(): HybridSearchConfig {
  const vectorWeight = parseFloat(process.env.HYBRID_VECTOR_WEIGHT || "0.7");
  const textWeight = parseFloat(process.env.HYBRID_TEXT_WEIGHT || "0.3");

  // normalize weights to sum to 1
  const total = vectorWeight + textWeight;
  const normalizedVector = total > 0 ? vectorWeight / total : 0.7;
  const normalizedText = total > 0 ? textWeight / total : 0.3;

  return {
    vectorWeight: normalizedVector,
    textWeight: normalizedText,
    candidateMultiplier: parseInt(
      process.env.HYBRID_CANDIDATE_MULTIPLIER || "4",
      10,
    ),
    minScore: parseFloat(process.env.HYBRID_MIN_SCORE || "0.1"),
  };
}

// result from vector search
interface VectorCandidate {
  id: string;
  vectorScore: number;
}

// result from bm25/keyword search
interface TextCandidate {
  id: string;
  textScore: number;
}

// merged result
export interface HybridCandidate {
  id: string;
  vectorScore: number;
  textScore: number;
  combinedScore: number;
}

// convert bm25 rank to 0-1 score
// lower rank = better match, so we invert it
// formula: 1 / (1 + rank) gives nice 0-1 range
export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

// merge vector and text search results with weighted scoring
export function mergeHybridResults(
  vectorResults: VectorCandidate[],
  textResults: TextCandidate[],
  config: HybridSearchConfig = DEFAULT_CONFIG,
): HybridCandidate[] {
  const byId = new Map<
    string,
    { id: string; vectorScore: number; textScore: number }
  >();

  // add vector results
  for (const r of vectorResults) {
    byId.set(r.id, {
      id: r.id,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  // merge in text results
  for (const r of textResults) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
    } else {
      byId.set(r.id, {
        id: r.id,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  // calculate combined scores
  const merged = Array.from(byId.values()).map((entry) => {
    const combinedScore =
      config.vectorWeight * entry.vectorScore +
      config.textWeight * entry.textScore;
    return {
      ...entry,
      combinedScore,
    };
  });

  // sort by combined score descending
  return merged.sort((a, b) => b.combinedScore - a.combinedScore);
}

// chunking config for text segmentation
export interface ChunkConfig {
  targetTokens: number; // ~400 tokens per chunk
  overlapTokens: number; // ~80 tokens overlap
}

const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  targetTokens: 400,
  overlapTokens: 80,
};

// memory chunk with metadata
export interface MemoryChunk {
  id: string;
  memoryId: string;
  content: string;
  hash: string;
  startLine: number;
  endLine: number;
}

// chunk text with overlap for better context preservation
// uses sliding window approach with configurable overlap
export function chunkText(
  text: string,
  memoryId: string,
  config: ChunkConfig = DEFAULT_CHUNK_CONFIG,
): MemoryChunk[] {
  const lines = text.split("\n");

  // approximate: 4 chars = 1 token (reasonable for english)
  const maxChars = Math.max(32, config.targetTokens * 4);
  const overlapChars = Math.max(0, config.overlapTokens * 4);

  const chunks: MemoryChunk[] = [];
  let current: { line: string; lineNo: number }[] = [];
  let currentChars = 0;
  let chunkIndex = 0;

  const flushChunk = () => {
    if (current.length === 0) return;

    const content = current.map((e) => e.line).join("\n");
    const hash = createHash("sha256").update(content).digest("hex");

    chunks.push({
      id: `${memoryId}-${chunkIndex}`,
      memoryId,
      content,
      hash,
      startLine: current[0]?.lineNo ?? 0,
      endLine: current[current.length - 1]?.lineNo ?? 0,
    });

    chunkIndex++;

    // carry over overlap from end for context continuity
    if (overlapChars > 0 && current.length > 0) {
      let acc = 0;
      const kept: { line: string; lineNo: number }[] = [];
      for (let i = current.length - 1; i >= 0; i--) {
        const entry = current[i];
        if (!entry) continue;
        acc += entry.line.length + 1;
        kept.unshift(entry);
        if (acc >= overlapChars) break;
      }
      current = kept;
      currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
    } else {
      current = [];
      currentChars = 0;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineChars = line.length + 1; // +1 for newline

    // would exceed target? flush first
    if (currentChars + lineChars > maxChars && current.length > 0) {
      flushChunk();
    }

    current.push({ line, lineNo: i + 1 });
    currentChars += lineChars;
  }

  // flush remaining
  if (current.length > 0) {
    flushChunk();
  }

  return chunks;
}

// sqlite fts5 initialization status
let fts5Initialized = false;
let fts5Available = false;

// ensure fts5 table exists for full-text search
// fts5 is built into sqlite by default in most distributions
async function ensureFts5(): Promise<boolean> {
  if (fts5Initialized) return fts5Available;

  // fts5 only works with sqlite for now
  // postgres has tsquery which we could add later
  if (isUsingPostgres()) {
    fts5Initialized = true;
    fts5Available = false;
    debug("[hybrid] postgres mode - fts5 not applicable");
    return false;
  }

  const db = getDatabase();
  if (!db) {
    fts5Initialized = true;
    fts5Available = false;
    return false;
  }

  try {
    // create fts5 virtual table for memory chunks
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        content,
        chunk_id UNINDEXED,
        memory_id UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      )
    `);

    // create regular table to store chunks with their hashes
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding_cached INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);

    // create embedding cache table (hash -> embedding)
    // prevents re-embedding identical content
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        hash TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // index on memory_id for fast chunk lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_memory_id 
      ON memory_chunks(memory_id)
    `);

    // index on hash for cache lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_hash 
      ON memory_chunks(hash)
    `);

    fts5Available = true;
    debug("[hybrid] fts5 and chunk tables initialized");
  } catch (err) {
    debug("[hybrid] fts5 initialization failed:", err);
    fts5Available = false;
  }

  fts5Initialized = true;
  return fts5Available;
}

// store a chunk in the fts5 index
export async function indexChunk(chunk: MemoryChunk): Promise<boolean> {
  const available = await ensureFts5();
  if (!available) return false;

  const db = getDatabase();
  if (!db) return false;

  try {
    // check if chunk already exists by hash (deduplication)
    const existing = db
      .query<{ id: string }>(`SELECT id FROM memory_chunks WHERE hash = ?`)
      .get(chunk.hash);

    if (existing) {
      debug(`[hybrid] chunk already indexed: ${chunk.hash.substring(0, 8)}`);
      return true;
    }

    // insert into chunks table
    db.run(
      `INSERT INTO memory_chunks (id, memory_id, content, hash, start_line, end_line, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        chunk.id,
        chunk.memoryId,
        chunk.content,
        chunk.hash,
        chunk.startLine,
        chunk.endLine,
        Date.now(),
      ],
    );

    // insert into fts5 index
    db.run(
      `INSERT INTO memory_chunks_fts (content, chunk_id, memory_id, start_line, end_line)
       VALUES (?, ?, ?, ?, ?)`,
      [
        chunk.content,
        chunk.id,
        chunk.memoryId,
        chunk.startLine.toString(),
        chunk.endLine.toString(),
      ],
    );

    debug(`[hybrid] indexed chunk: ${chunk.id}`);
    return true;
  } catch (err) {
    debug("[hybrid] chunk indexing failed:", err);
    return false;
  }
}

// search using bm25 full-text search
export async function searchBm25(
  query: string,
  limit: number = 20,
): Promise<TextCandidate[]> {
  const available = await ensureFts5();
  if (!available) return [];

  const db = getDatabase();
  if (!db) return [];

  try {
    // fts5 match query with bm25 ranking
    const rows = db
      .query<{ chunk_id: string; rank: number }>(
        `SELECT chunk_id, bm25(memory_chunks_fts) as rank
         FROM memory_chunks_fts
         WHERE memory_chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit);

    return rows.map((row) => ({
      id: row.chunk_id,
      textScore: bm25RankToScore(-row.rank), // bm25 returns negative scores in fts5
    }));
  } catch (err) {
    debug("[hybrid] bm25 search failed:", err);
    return [];
  }
}

// get a chunk by id
export async function getChunkById(
  chunkId: string,
): Promise<MemoryChunk | null> {
  const available = await ensureFts5();
  if (!available) return null;

  const db = getDatabase();
  if (!db) return null;

  const row = db
    .query<{
      id: string;
      memory_id: string;
      content: string;
      hash: string;
      start_line: number;
      end_line: number;
    }>(`SELECT * FROM memory_chunks WHERE id = ?`)
    .get(chunkId);

  if (!row) return null;

  return {
    id: row.id,
    memoryId: row.memory_id,
    content: row.content,
    hash: row.hash,
    startLine: row.start_line,
    endLine: row.end_line,
  };
}

// check embedding cache for a content hash
export async function getCachedEmbedding(
  hash: string,
): Promise<number[] | null> {
  const available = await ensureFts5();
  if (!available) return null;

  const db = getDatabase();
  if (!db) return null;

  try {
    const row = db
      .query<{
        embedding: string;
      }>(`SELECT embedding FROM embedding_cache WHERE hash = ?`)
      .get(hash);

    if (row) {
      debug(`[hybrid] cache hit for hash: ${hash.substring(0, 8)}`);
      return JSON.parse(row.embedding);
    }
  } catch (err) {
    debug("[hybrid] cache lookup failed:", err);
  }

  return null;
}

// store embedding in cache
export async function cacheEmbedding(
  hash: string,
  embedding: number[],
  model: string,
): Promise<boolean> {
  const available = await ensureFts5();
  if (!available) return false;

  const db = getDatabase();
  if (!db) return false;

  try {
    db.run(
      `INSERT OR REPLACE INTO embedding_cache (hash, embedding, model, dimension, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [hash, JSON.stringify(embedding), model, embedding.length, Date.now()],
    );
    debug(`[hybrid] cached embedding for hash: ${hash.substring(0, 8)}`);
    return true;
  } catch (err) {
    debug("[hybrid] cache store failed:", err);
    return false;
  }
}

// generate embedding with cache-first strategy
export async function getOrCreateEmbedding(
  content: string,
  hash?: string,
): Promise<number[] | null> {
  const contentHash =
    hash || createHash("sha256").update(content).digest("hex");

  // try cache first
  const cached = await getCachedEmbedding(contentHash);
  if (cached) {
    return cached;
  }

  // generate new embedding
  const embedding = await generateEmbedding(content);
  if (!embedding) return null;

  // cache for future use
  const model =
    process.env.EMBEDDING_PROVIDER === "openai"
      ? process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small"
      : process.env.LOCAL_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";

  await cacheEmbedding(contentHash, embedding, model);

  return embedding;
}

// get cache stats
export async function getEmbeddingCacheStats(): Promise<{
  totalEntries: number;
  totalSize: number;
}> {
  const available = await ensureFts5();
  if (!available) return { totalEntries: 0, totalSize: 0 };

  const db = getDatabase();
  if (!db) return { totalEntries: 0, totalSize: 0 };

  try {
    const row = db
      .query<{
        count: number;
        size: number;
      }>(
        `SELECT COUNT(*) as count, SUM(LENGTH(embedding)) as size FROM embedding_cache`,
      )
      .get();

    return {
      totalEntries: row?.count || 0,
      totalSize: row?.size || 0,
    };
  } catch (err) {
    return { totalEntries: 0, totalSize: 0 };
  }
}

// clean old cache entries (older than 30 days)
export async function cleanEmbeddingCache(
  maxAgeDays: number = 30,
): Promise<number> {
  const available = await ensureFts5();
  if (!available) return 0;

  const db = getDatabase();
  if (!db) return 0;

  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    db.run(`DELETE FROM embedding_cache WHERE created_at < ?`, [cutoff]);

    // get count of remaining entries
    const row = db
      .query<{ count: number }>(`SELECT COUNT(*) as count FROM embedding_cache`)
      .get();

    debug(`[hybrid] cleaned cache, ${row?.count || 0} entries remaining`);
    return row?.count || 0;
  } catch (err) {
    debug("[hybrid] cache cleanup failed:", err);
    return 0;
  }
}
