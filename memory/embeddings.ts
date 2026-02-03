// embedding-based memory search
// supports local transformers.js model (default) and openai embeddings
// works with both memories and learnings tables

import { getAsyncDatabase, isUsingPostgres } from "../data/db";
import { debug } from "../utils/debug";
import { OpenAI } from "openai";

// embedding provider: local, openai, or none
// local uses transformers.js with all-MiniLM-L6-v2 (384 dimensions, runs on cpu)
// openai uses text-embedding-3-small (1536 dimensions)
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

// openai config
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_EMBEDDING_DIMENSION = parseInt(
  process.env.OPENAI_EMBEDDING_DIMENSION || "1536",
  10,
);

// lazy-loaded openai client
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (!OPENAI_API_KEY) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: OPENAI_BASE_URL,
      timeout: 30 * 1000,
    });
  }
  return openaiClient;
}

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

// generate embedding using openai api
async function generateOpenAIEmbedding(text: string): Promise<number[] | null> {
  try {
    const client = getOpenAIClient();
    if (!client) {
      debug("[embeddings] openai client not available");
      return null;
    }

    // truncate for api limits
    const truncated = text.substring(0, 8192);

    const response = await client.embeddings.create({
      model: OPENAI_EMBEDDING_MODEL,
      input: truncated,
      dimensions: OPENAI_EMBEDDING_DIMENSION,
    });

    const embedding = response.data[0]?.embedding;
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
  const available = await ensurePgvector();
  if (!available) return false;

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

export interface EmbeddingSearchResult {
  id: string;
  userId: number;
  content: string;
  rawContent?: string;
  similarity: number;
  timestamp: number;
  emotionalWeight: number;
  recallCount: number;
}

// search memories by embedding similarity
export async function searchByEmbedding(
  userId: number,
  queryText: string,
  limit: number = 5,
): Promise<EmbeddingSearchResult[]> {
  const available = await ensurePgvector();
  if (!available) return [];

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) return [];

  const queryEmbedding = await generateEmbedding(queryText);
  if (!queryEmbedding) return [];

  try {
    // cosine similarity search
    // 1 - (a <=> b) gives similarity (1 = identical, 0 = orthogonal)
    const rows = await asyncDb.all<{
      id: string;
      user_id: number;
      content: string;
      raw_content: string | null;
      similarity: number;
      timestamp: number;
      emotional_weight: number;
      recall_count: number;
    }>(
      `SELECT 
        id, user_id, content, raw_content, timestamp, emotional_weight, recall_count,
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
      emotionalWeight: row.emotional_weight,
      recallCount: row.recall_count,
    }));
  } catch (err) {
    debug("[embeddings] search failed:", err);
    return [];
  }
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

// check if embeddings are available
export async function isEmbeddingsAvailable(): Promise<boolean> {
  return ensurePgvector();
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
  const available = await ensurePgvector();
  if (!available) return false;

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

// search learnings by embedding similarity
export async function searchLearningsByEmbedding(
  userId: number,
  queryText: string,
  limit: number = 5,
  category?: string,
): Promise<LearningEmbeddingSearchResult[]> {
  const available = await ensurePgvector();
  if (!available) return [];

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) return [];

  const queryEmbedding = await generateEmbedding(queryText);
  if (!queryEmbedding) return [];

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
