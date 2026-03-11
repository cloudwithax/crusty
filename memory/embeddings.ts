// embedding-based memory search
// uses local transformers.js model by default (all-MiniLM-L6-v2, 384 dims, runs on cpu)
// openai embeddings fallback available via native fetch if EMBEDDING_PROVIDER=openai
// works with both memories and learnings tables

import {
  getDatabase,
  getAsyncDatabase,
  isUsingPostgres,
  tryLoadSqliteExtension,
} from "../data/db";
import { debug } from "../utils/debug";

// embedding provider: local, openai, or none
type EmbeddingProvider = "local" | "openai" | "none";
const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER ||
  "local") as EmbeddingProvider;

// local model config
const LOCAL_EMBEDDING_MODEL =
  process.env.LOCAL_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const LOCAL_EMBEDDING_DIMENSION = parseInt(
  process.env.LOCAL_EMBEDDING_DIMENSION || "384",
  10,
);

// openai config (only used if EMBEDDING_PROVIDER=openai)
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_EMBEDDING_DIMENSION = parseInt(
  process.env.OPENAI_EMBEDDING_DIMENSION || "1536",
  10,
);

// get the dimension for current provider
function getEmbeddingDimension(): number {
  if (EMBEDDING_PROVIDER === "none") return 0;
  if (EMBEDDING_PROVIDER === "openai") return OPENAI_EMBEDDING_DIMENSION;
  return LOCAL_EMBEDDING_DIMENSION;
}

// local embedding pipeline (lazy loaded)
let localPipeline: any = null;
let localPipelineLoading: Promise<any> | null = null;

// preload the embedding model at startup for faster first inference
export async function preloadEmbeddingModel(): Promise<boolean> {
  if (EMBEDDING_PROVIDER === "none") {
    debug("[embeddings] provider is none, skipping preload");
    return false;
  }

  // openai provider calls an api on demand - no local model to warm up
  if (EMBEDDING_PROVIDER === "openai") {
    debug("[embeddings] openai provider - no local model to preload");
    return true;
  }

  // no point warming the model if there is no vector backend to write into
  const pgAvail = await ensurePgvector();
  const sqliteAvail = !pgAvail && (await ensureSqliteVec());
  if (!pgAvail && !sqliteAvail) {
    debug("[embeddings] no vector backend available, skipping model preload");
    return false;
  }

  const pipe = await getLocalPipeline();
  return pipe !== null;
}

async function getLocalPipeline(): Promise<any> {
  if (localPipeline) return localPipeline;

  if (localPipelineLoading) {
    return localPipelineLoading;
  }

  localPipelineLoading = (async () => {
    try {
      debug(`[embeddings] loading local model: ${LOCAL_EMBEDDING_MODEL}`);
      const { pipeline } = await import("@huggingface/transformers");

      // feature-extraction pipeline for embeddings
      localPipeline = await pipeline(
        "feature-extraction",
        LOCAL_EMBEDDING_MODEL,
        {
          dtype: "fp32", // use fp32 for cpu compatibility
        },
      );

      debug(`[embeddings] local model loaded`);
      return localPipeline;
    } catch (err) {
      debug(`[embeddings] failed to load local model:`, err);
      localPipelineLoading = null;
      return null;
    }
  })();

  return localPipelineLoading;
}

let pgvectorInitialized = false;
let pgvectorAvailable = false;

// sqlite-vec state (for sqlite mode)
let sqliteVecInitialized = false;
let sqliteVecAvailable = false;

// check if pgvector extension is available and initialize both memories and learnings tables
async function ensurePgvector(): Promise<boolean> {
  if (pgvectorInitialized) return pgvectorAvailable;

  if (EMBEDDING_PROVIDER === "none") {
    pgvectorInitialized = true;
    pgvectorAvailable = false;
    debug("[embeddings] disabled via EMBEDDING_PROVIDER=none");
    return false;
  }

  if (!isUsingPostgres()) {
    pgvectorInitialized = true;
    pgvectorAvailable = false;
    debug("[embeddings] sqlite mode - using keyword fallback");
    return false;
  }

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) {
    pgvectorInitialized = true;
    pgvectorAvailable = false;
    return false;
  }

  const dimension = getEmbeddingDimension();

  try {
    // suppress postgres NOTICE messages for "already exists, skipping"
    await asyncDb.run(`SET client_min_messages TO WARNING`);

    // try to create pgvector extension
    await asyncDb.run(`CREATE EXTENSION IF NOT EXISTS vector`);

    // add embedding column to memories table if it doesnt exist
    await asyncDb.run(`
      ALTER TABLE memories 
      ADD COLUMN IF NOT EXISTS embedding vector(${dimension})
    `);

    // add embedding column to learnings table if it doesnt exist
    await asyncDb.run(`
      ALTER TABLE learnings 
      ADD COLUMN IF NOT EXISTS embedding vector(${dimension})
    `);

    // create index for fast similarity search on memories
    // using ivfflat for approximate nearest neighbor (good balance of speed/accuracy)
    // lists = 100 is reasonable for small-medium datasets
    try {
      await asyncDb.run(`
        CREATE INDEX IF NOT EXISTS idx_memories_embedding 
        ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
      `);
    } catch (indexErr) {
      // ivfflat needs enough rows to work, fall back to exact search for now
      debug(
        "[embeddings] memories ivfflat index creation deferred (need more rows)",
      );
    }

    // create index for learnings table
    try {
      await asyncDb.run(`
        CREATE INDEX IF NOT EXISTS idx_learnings_embedding 
        ON learnings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
      `);
    } catch (indexErr) {
      debug(
        "[embeddings] learnings ivfflat index creation deferred (need more rows)",
      );
    }

    // restore default message level
    await asyncDb.run(`SET client_min_messages TO NOTICE`);

    pgvectorAvailable = true;
    debug(
      `[embeddings] pgvector initialized (provider: ${EMBEDDING_PROVIDER}, dim: ${dimension})`,
    );
  } catch (err) {
    debug("[embeddings] pgvector not available:", err);
    pgvectorAvailable = false;
  }

  pgvectorInitialized = true;
  return pgvectorAvailable;
}

// initialize sqlite-vec extension and create vec0 virtual tables
async function ensureSqliteVec(): Promise<boolean> {
  if (sqliteVecInitialized) return sqliteVecAvailable;

  if (EMBEDDING_PROVIDER === "none" || isUsingPostgres()) {
    sqliteVecInitialized = true;
    return false;
  }

  const dim = getEmbeddingDimension();

  try {
    const { load } = await import("sqlite-vec");
    const loaded = tryLoadSqliteExtension(load);
    if (!loaded) {
      debug("[embeddings] sqlite-vec extension failed to load");
      sqliteVecInitialized = true;
      return false;
    }

    const db = getDatabase();
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[${dim}])`,
    );
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_learnings USING vec0(learning_id TEXT PRIMARY KEY, embedding FLOAT[${dim}])`,
    );

    sqliteVecAvailable = true;
    debug(`[embeddings] sqlite-vec initialized (dim: ${dim})`);
  } catch (err) {
    debug("[embeddings] sqlite-vec not available:", err);
    sqliteVecAvailable = false;
  }

  sqliteVecInitialized = true;
  return sqliteVecAvailable;
}

// sqlite-vec: store a memory embedding into the vec0 virtual table
async function storeSqliteVecMemory(
  memoryId: string,
  embedding: number[],
): Promise<boolean> {
  const db = getDatabase();
  try {
    const embJson = JSON.stringify(embedding);
    db.run("DELETE FROM vec_memories WHERE memory_id = ?", [memoryId]);
    db.run("INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)", [
      memoryId,
      embJson,
    ]);
    debug(`[embeddings] sqlite-vec stored memory ${memoryId}`);
    return true;
  } catch (err) {
    debug("[embeddings] sqlite-vec memory store failed:", err);
    return false;
  }
}

// sqlite-vec: knn search over memories, filtered to userId
async function searchSqliteVecMemories(
  userId: number,
  queryEmbedding: number[],
  limit: number,
): Promise<EmbeddingSearchResult[]> {
  const db = getDatabase();
  try {
    const embJson = JSON.stringify(queryEmbedding);
    const vecRows = db
      .query<{ memory_id: string; distance: number }>(
        // k is inlined as a literal - vec0 needs it at plan time
        `SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ${limit * 4} ORDER BY distance`,
      )
      .all(embJson);

    if (vecRows.length === 0) return [];

    const placeholders = vecRows.map(() => "?").join(",");
    const memRows = db
      .query<{
        id: string;
        user_id: number;
        content: string;
        raw_content: string | null;
        timestamp: number;
        recall_count: number;
      }>(
        `SELECT id, user_id, content, raw_content, timestamp, recall_count
         FROM memories WHERE id IN (${placeholders}) AND user_id = ?`,
      )
      .all(...vecRows.map((r) => r.memory_id), userId);

    const distMap = new Map(vecRows.map((r) => [r.memory_id, r.distance]));

    return memRows
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        content: row.content,
        rawContent: row.raw_content || undefined,
        // embeddings are l2-normalized so cosine sim ≈ 1 - (l2_dist / 2)
        similarity: Math.max(0, 1 - (distMap.get(row.id) ?? 2) * 0.5),
        timestamp: row.timestamp,
        recallCount: row.recall_count,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  } catch (err) {
    debug("[embeddings] sqlite-vec memory search failed:", err);
    return [];
  }
}

// sqlite-vec: store a learning embedding into the vec0 virtual table
async function storeSqliteVecLearning(
  learningId: string,
  embedding: number[],
): Promise<boolean> {
  const db = getDatabase();
  try {
    const embJson = JSON.stringify(embedding);
    db.run("DELETE FROM vec_learnings WHERE learning_id = ?", [learningId]);
    db.run("INSERT INTO vec_learnings(learning_id, embedding) VALUES (?, ?)", [
      learningId,
      embJson,
    ]);
    debug(
      `[embeddings] sqlite-vec stored learning ${learningId.substring(0, 8)}`,
    );
    return true;
  } catch (err) {
    debug("[embeddings] sqlite-vec learning store failed:", err);
    return false;
  }
}

// sqlite-vec: knn search over learnings, filtered to userId and optional category
async function searchSqliteVecLearnings(
  userId: number,
  queryEmbedding: number[],
  limit: number,
  category?: string,
): Promise<LearningEmbeddingSearchResult[]> {
  const db = getDatabase();
  try {
    const embJson = JSON.stringify(queryEmbedding);
    // fetch extra candidates to allow post-filter by category
    const vecRows = db
      .query<{
        learning_id: string;
        distance: number;
      }>(
        `SELECT learning_id, distance FROM vec_learnings WHERE embedding MATCH ? AND k = ${limit * 4} ORDER BY distance`,
      )
      .all(embJson);

    if (vecRows.length === 0) return [];

    const placeholders = vecRows.map(() => "?").join(",");
    const categoryFilter = category ? " AND category = ?" : "";
    const queryArgs: unknown[] = [
      ...vecRows.map((r) => r.learning_id),
      userId,
      ...(category ? [category] : []),
    ];

    const rows = db
      .query<{
        id: string;
        user_id: number;
        title: string;
        content: string;
        category: string;
        tool_name: string | null;
        confidence: number;
        application_count: number;
        timestamp: number;
      }>(
        `SELECT id, user_id, title, content, category, tool_name, confidence, application_count, timestamp
         FROM learnings WHERE id IN (${placeholders}) AND user_id = ?${categoryFilter}`,
      )
      .all(...queryArgs);

    const distMap = new Map(vecRows.map((r) => [r.learning_id, r.distance]));

    return rows
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        title: row.title,
        content: row.content,
        category: row.category,
        toolName: row.tool_name || undefined,
        similarity: Math.max(0, 1 - (distMap.get(row.id) ?? 2) * 0.5),
        confidence: row.confidence,
        applicationCount: row.application_count,
        timestamp: row.timestamp,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  } catch (err) {
    debug("[embeddings] sqlite-vec learning search failed:", err);
    return [];
  }
}

// generate embedding using local transformers.js model
async function generateLocalEmbedding(text: string): Promise<number[] | null> {
  try {
    const pipe = await getLocalPipeline();
    if (!pipe) return null;

    // truncate text for local model (smaller context window)
    const truncated = text.substring(0, 512);

    // run inference
    const output = await pipe(truncated, { pooling: "mean", normalize: true });

    // extract embedding from tensor
    const embedding = Array.from(output.data as Float32Array);
    return embedding;
  } catch (err) {
    debug("[embeddings] local embedding failed:", err);
    return null;
  }
}

// generate embedding using openai embeddings api via native fetch
async function generateOpenAIEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    debug("[embeddings] OPENAI_API_KEY not set");
    return null;
  }

  const baseUrl = (
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const truncated = text.substring(0, 8192);

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_EMBEDDING_MODEL,
        input: truncated,
        dimensions: OPENAI_EMBEDDING_DIMENSION,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      debug(`[embeddings] openai embeddings api returned ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      data?: { embedding: number[] }[];
    };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) {
      debug("[embeddings] openai returned no embedding");
      return null;
    }

    return embedding;
  } catch (err) {
    debug("[embeddings] openai embedding failed:", err);
    return null;
  }
}

// generate embedding for text using configured provider
export async function generateEmbedding(
  text: string,
): Promise<number[] | null> {
  if (EMBEDDING_PROVIDER === "none") {
    return null;
  }

  if (EMBEDDING_PROVIDER === "openai") {
    return generateOpenAIEmbedding(text);
  }

  return generateLocalEmbedding(text);
}

// format embedding array for postgres vector type
function formatEmbedding(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// store memory with embedding
export async function storeMemoryWithEmbedding(
  memoryId: string,
  content: string,
): Promise<boolean> {
  const pgAvail = await ensurePgvector();

  if (pgAvail) {
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return false;
    const embedding = await generateEmbedding(content);
    if (!embedding) return false;
    try {
      await asyncDb.run(
        `UPDATE memories SET embedding = $1::vector WHERE id = $2`,
        [formatEmbedding(embedding), memoryId],
      );
      debug(`[embeddings] stored embedding for memory ${memoryId}`);
      return true;
    } catch (err) {
      debug("[embeddings] failed to store embedding:", err);
      return false;
    }
  }

  const sqliteAvail = await ensureSqliteVec();
  if (!sqliteAvail) return false;

  const embedding = await generateEmbedding(content);
  if (!embedding) return false;
  return storeSqliteVecMemory(memoryId, embedding);
}

export interface EmbeddingSearchResult {
  id: string;
  userId: number;
  content: string;
  rawContent?: string;
  similarity: number;
  timestamp: number;
  recallCount: number;
}

// search memories by embedding similarity
export async function searchByEmbedding(
  userId: number,
  queryText: string,
  limit: number = 5,
): Promise<EmbeddingSearchResult[]> {
  const queryEmbedding = await generateEmbedding(queryText);
  if (!queryEmbedding) return [];

  const pgAvail = await ensurePgvector();
  if (pgAvail) {
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return [];
    try {
      const rows = await asyncDb.all<{
        id: string;
        user_id: number;
        content: string;
        raw_content: string | null;
        similarity: number;
        timestamp: number;
        recall_count: number;
      }>(
        `SELECT 
          id, user_id, content, raw_content, timestamp, recall_count,
          1 - (embedding <=> $1::vector) as similarity
        FROM memories
        WHERE user_id = $2 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
        formatEmbedding(queryEmbedding),
        userId,
        limit,
      );
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        content: row.content,
        rawContent: row.raw_content || undefined,
        similarity: row.similarity,
        timestamp: row.timestamp,
        recallCount: row.recall_count,
      }));
    } catch (err) {
      debug("[embeddings] search failed:", err);
      return [];
    }
  }

  const sqliteAvail = await ensureSqliteVec();
  if (!sqliteAvail) return [];
  return searchSqliteVecMemories(userId, queryEmbedding, limit);
}

// backfill embeddings for existing memories without them
export async function backfillEmbeddings(
  userId?: number,
  batchSize: number = 50,
): Promise<number> {
  const available = await ensurePgvector();
  if (!available) return 0;

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) return 0;

  const whereClause = userId !== undefined ? `user_id = $1 AND` : "";
  const params = userId !== undefined ? [userId, batchSize] : [batchSize];

  const rows = await asyncDb.all<{ id: string; content: string }>(
    `SELECT id, content FROM memories 
     WHERE ${whereClause} embedding IS NULL 
     LIMIT ${userId !== undefined ? "$2" : "$1"}`,
    ...params,
  );

  let count = 0;
  for (const row of rows) {
    const success = await storeMemoryWithEmbedding(row.id, row.content);
    if (success) count++;
  }

  debug(`[embeddings] backfilled ${count}/${rows.length} memories`);
  return count;
}

// check if embeddings are available (pgvector or sqlite-vec)
export async function isEmbeddingsAvailable(): Promise<boolean> {
  const pgAvail = await ensurePgvector();
  if (pgAvail) return true;
  return ensureSqliteVec();
}

// learning embedding types
export interface LearningEmbeddingSearchResult {
  id: string;
  userId: number;
  title: string;
  content: string;
  category: string;
  toolName?: string;
  similarity: number;
  confidence: number;
  applicationCount: number;
  timestamp: number;
}

// store learning with embedding
export async function storeLearningWithEmbedding(
  learningId: string,
  content: string,
): Promise<boolean> {
  const pgAvail = await ensurePgvector();

  if (pgAvail) {
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return false;
    const embedding = await generateEmbedding(content);
    if (!embedding) return false;
    try {
      await asyncDb.run(
        `UPDATE learnings SET embedding = $1::vector WHERE id = $2`,
        [formatEmbedding(embedding), learningId],
      );
      debug(
        `[embeddings] stored embedding for learning ${learningId.substring(0, 8)}`,
      );
      return true;
    } catch (err) {
      debug("[embeddings] failed to store learning embedding:", err);
      return false;
    }
  }

  const sqliteAvail = await ensureSqliteVec();
  if (!sqliteAvail) return false;

  const embedding = await generateEmbedding(content);
  if (!embedding) return false;
  return storeSqliteVecLearning(learningId, embedding);
}

// search learnings by embedding similarity
export async function searchLearningsByEmbedding(
  userId: number,
  queryText: string,
  limit: number = 5,
  category?: string,
): Promise<LearningEmbeddingSearchResult[]> {
  const queryEmbedding = await generateEmbedding(queryText);
  if (!queryEmbedding) return [];

  const pgAvail = await ensurePgvector();
  if (pgAvail) {
    const asyncDb = getAsyncDatabase();
    if (!asyncDb) return [];
    try {
      const categoryFilter = category ? ` AND category = $4` : "";
      const params = category
        ? [formatEmbedding(queryEmbedding), userId, limit, category]
        : [formatEmbedding(queryEmbedding), userId, limit];

      const rows = await asyncDb.all<{
        id: string;
        user_id: number;
        title: string;
        content: string;
        category: string;
        tool_name: string | null;
        similarity: number;
        confidence: number;
        application_count: number;
        timestamp: number;
      }>(
        `SELECT 
          id, user_id, title, content, category, tool_name, confidence, application_count, timestamp,
          1 - (embedding <=> $1::vector) as similarity
        FROM learnings
        WHERE user_id = $2 AND embedding IS NOT NULL${categoryFilter}
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
        ...params,
      );

      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        title: row.title,
        content: row.content,
        category: row.category,
        toolName: row.tool_name || undefined,
        similarity: row.similarity,
        confidence: row.confidence,
        applicationCount: row.application_count,
        timestamp: row.timestamp,
      }));
    } catch (err) {
      debug("[embeddings] learning search failed:", err);
      return [];
    }
  }

  const sqliteAvail = await ensureSqliteVec();
  if (!sqliteAvail) return [];
  return searchSqliteVecLearnings(userId, queryEmbedding, limit, category);
}

// backfill embeddings for existing learnings without them
export async function backfillLearningEmbeddings(
  userId?: number,
  batchSize: number = 50,
): Promise<number> {
  const available = await ensurePgvector();
  if (!available) return 0;

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) return 0;

  const whereClause = userId !== undefined ? `user_id = $1 AND` : "";
  const params = userId !== undefined ? [userId, batchSize] : [batchSize];

  const rows = await asyncDb.all<{
    id: string;
    title: string;
    content: string;
  }>(
    `SELECT id, title, content FROM learnings 
     WHERE ${whereClause} embedding IS NULL 
     LIMIT ${userId !== undefined ? "$2" : "$1"}`,
    ...params,
  );

  let count = 0;
  for (const row of rows) {
    // combine title and content for better semantic representation
    const success = await storeLearningWithEmbedding(
      row.id,
      `${row.title}\n${row.content}`,
    );
    if (success) count++;
  }

  debug(`[embeddings] backfilled ${count}/${rows.length} learnings`);
  return count;
}

// get embedding stats for learnings
export async function getLearningEmbeddingStats(userId: number): Promise<{
  total: number;
  withEmbedding: number;
  coverage: number;
}> {
  const available = await ensurePgvector();
  if (!available) {
    return { total: 0, withEmbedding: 0, coverage: 0 };
  }

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) {
    return { total: 0, withEmbedding: 0, coverage: 0 };
  }

  const row = await asyncDb.get<{ total: number; with_embedding: number }>(
    `SELECT 
      COUNT(*) as total,
      COUNT(embedding) as with_embedding
    FROM learnings WHERE user_id = $1`,
    userId,
  );

  const total = row?.total || 0;
  const withEmbedding = row?.with_embedding || 0;

  return {
    total,
    withEmbedding,
    coverage: total > 0 ? withEmbedding / total : 0,
  };
}

// get current embedding provider info
export function getEmbeddingProviderInfo(): {
  provider: EmbeddingProvider;
  model: string;
  dimension: number;
} {
  if (EMBEDDING_PROVIDER === "local") {
    return {
      provider: "local",
      model: LOCAL_EMBEDDING_MODEL,
      dimension: LOCAL_EMBEDDING_DIMENSION,
    };
  }

  if (EMBEDDING_PROVIDER === "openai") {
    return {
      provider: "openai",
      model: OPENAI_EMBEDDING_MODEL,
      dimension: OPENAI_EMBEDDING_DIMENSION,
    };
  }

  return {
    provider: "none",
    model: "none",
    dimension: 0,
  };
}

// get embedding stats
export async function getEmbeddingStats(userId: number): Promise<{
  total: number;
  withEmbedding: number;
  coverage: number;
}> {
  const available = await ensurePgvector();
  if (!available) {
    return { total: 0, withEmbedding: 0, coverage: 0 };
  }

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) {
    return { total: 0, withEmbedding: 0, coverage: 0 };
  }

  const row = await asyncDb.get<{ total: number; with_embedding: number }>(
    `SELECT 
      COUNT(*) as total,
      COUNT(embedding) as with_embedding
    FROM memories WHERE user_id = $1`,
    userId,
  );

  const total = row?.total || 0;
  const withEmbedding = row?.with_embedding || 0;

  return {
    total,
    withEmbedding,
    coverage: total > 0 ? withEmbedding / total : 0,
  };
}
