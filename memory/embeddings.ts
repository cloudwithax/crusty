// embedding-based memory search
// supports multiple providers: openai, local (transformers.js), or none

import { OpenAI } from "openai";
import { getAsyncDatabase, isUsingPostgres } from "../data/db";
import { debug } from "../utils/debug";

// embedding provider: openai, local, or none
// local uses transformers.js with all-MiniLM-L6-v2 (384 dimensions, runs on cpu)
type EmbeddingProvider = "openai" | "local" | "none";
const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER || "openai") as EmbeddingProvider;

// track if openai embeddings have failed so we can fallback to local
let openaiEmbeddingsFailed = false;
let openaiFailureCount = 0;
const OPENAI_FAILURE_THRESHOLD = 3; // fallback after this many consecutive failures

// reset openai fallback state (call this to retry openai after it recovers)
export function resetOpenAIFallback(): void {
  openaiEmbeddingsFailed = false;
  openaiFailureCount = 0;
  debug("[embeddings] openai fallback state reset");
}

// openai config
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_EMBEDDING_DIMENSION = parseInt(process.env.OPENAI_EMBEDDING_DIMENSION || "1536", 10);

// local model config
const LOCAL_EMBEDDING_MODEL = process.env.LOCAL_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const LOCAL_EMBEDDING_DIMENSION = parseInt(process.env.LOCAL_EMBEDDING_DIMENSION || "384", 10);

// get the dimension for current provider
// when using openai with fallback, we use local dimension since thats the fallback
function getEmbeddingDimension(): number {
  if (EMBEDDING_PROVIDER === "local") return LOCAL_EMBEDDING_DIMENSION;
  // for openai provider, we use local dimension because we might fall back
  // this ensures consistent vector sizes in the database
  // trade-off: openai embeddings get truncated but search still works
  return LOCAL_EMBEDDING_DIMENSION;
}

// normalize embedding to target dimension
// pads with zeros or truncates as needed
function normalizeEmbeddingDimension(embedding: number[], targetDim: number): number[] {
  if (embedding.length === targetDim) return embedding;
  
  if (embedding.length > targetDim) {
    // truncate (loses some precision but maintains comparability)
    return embedding.slice(0, targetDim);
  }
  
  // pad with zeros (shouldn't happen in practice)
  const padded = [...embedding];
  while (padded.length < targetDim) {
    padded.push(0);
  }
  return padded;
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 30 * 1000,
});

// local embedding pipeline (lazy loaded)
let localPipeline: any = null;
let localPipelineLoading: Promise<any> | null = null;

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
      localPipeline = await pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL, {
        dtype: "fp32", // use fp32 for cpu compatibility
      });
      
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

// check if pgvector extension is available and initialize
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
    // try to create pgvector extension
    await asyncDb.run(`CREATE EXTENSION IF NOT EXISTS vector`);

    // add embedding column if it doesnt exist
    await asyncDb.run(`
      ALTER TABLE memories 
      ADD COLUMN IF NOT EXISTS embedding vector(${dimension})
    `);

    // create index for fast similarity search
    // using ivfflat for approximate nearest neighbor (good balance of speed/accuracy)
    // lists = 100 is reasonable for small-medium datasets
    try {
      await asyncDb.run(`
        CREATE INDEX IF NOT EXISTS idx_memories_embedding 
        ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
      `);
    } catch (indexErr) {
      // ivfflat needs enough rows to work, fall back to exact search for now
      debug("[embeddings] ivfflat index creation deferred (need more rows)");
    }

    pgvectorAvailable = true;
    debug(`[embeddings] pgvector initialized (provider: ${EMBEDDING_PROVIDER}, dim: ${dimension})`);
  } catch (err) {
    debug("[embeddings] pgvector not available:", err);
    pgvectorAvailable = false;
  }

  pgvectorInitialized = true;
  return pgvectorAvailable;
}

// generate embedding using openai api
async function generateOpenAIEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await openai.embeddings.create({
      model: OPENAI_EMBEDDING_MODEL,
      input: text.substring(0, 8000),
    });

    // reset failure count on success
    openaiFailureCount = 0;
    openaiEmbeddingsFailed = false;

    return response.data[0]?.embedding || null;
  } catch (err) {
    openaiFailureCount++;
    
    if (openaiFailureCount >= OPENAI_FAILURE_THRESHOLD && !openaiEmbeddingsFailed) {
      openaiEmbeddingsFailed = true;
      debug(`[embeddings] openai embeddings failed ${openaiFailureCount} times, falling back to local`);
    } else {
      debug("[embeddings] openai embedding failed:", err);
    }
    
    return null;
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

// generate embedding for text (dispatches to appropriate provider)
// falls back to local if openai fails repeatedly
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (EMBEDDING_PROVIDER === "none") {
    return null;
  }
  
  if (EMBEDDING_PROVIDER === "local") {
    return generateLocalEmbedding(text);
  }
  
  // openai provider with automatic fallback to local
  if (openaiEmbeddingsFailed) {
    // already failed too many times, go straight to local
    return generateLocalEmbedding(text);
  }
  
  const result = await generateOpenAIEmbedding(text);
  
  if (result) {
    return result;
  }
  
  // openai failed, try local as fallback
  debug("[embeddings] trying local fallback");
  return generateLocalEmbedding(text);
}

// generate embedding and normalize to storage dimension
export async function generateNormalizedEmbedding(text: string): Promise<number[] | null> {
  const embedding = await generateEmbedding(text);
  if (!embedding) return null;
  
  const targetDim = getEmbeddingDimension();
  return normalizeEmbeddingDimension(embedding, targetDim);
}

// format embedding array for postgres vector type
function formatEmbedding(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// store memory with embedding
export async function storeMemoryWithEmbedding(
  memoryId: string,
  content: string
): Promise<boolean> {
  const available = await ensurePgvector();
  if (!available) return false;

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) return false;

  const embedding = await generateNormalizedEmbedding(content);
  if (!embedding) return false;

  try {
    await asyncDb.run(
      `UPDATE memories SET embedding = $1::vector WHERE id = $2`,
      [formatEmbedding(embedding), memoryId]
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
  limit: number = 5
): Promise<EmbeddingSearchResult[]> {
  const available = await ensurePgvector();
  if (!available) return [];

  const asyncDb = getAsyncDatabase();
  if (!asyncDb) return [];

  const queryEmbedding = await generateNormalizedEmbedding(queryText);
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
      limit
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
  batchSize: number = 50
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
    ...params
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

// get current embedding provider info
export function getEmbeddingProviderInfo(): {
  provider: EmbeddingProvider;
  model: string;
  dimension: number;
  fallbackActive: boolean;
  storageDimension: number;
} {
  const storageDim = getEmbeddingDimension();
  
  if (EMBEDDING_PROVIDER === "local") {
    return {
      provider: "local",
      model: LOCAL_EMBEDDING_MODEL,
      dimension: LOCAL_EMBEDDING_DIMENSION,
      fallbackActive: false,
      storageDimension: storageDim,
    };
  }
  
  if (EMBEDDING_PROVIDER === "openai") {
    return {
      provider: "openai",
      model: openaiEmbeddingsFailed ? LOCAL_EMBEDDING_MODEL : OPENAI_EMBEDDING_MODEL,
      dimension: openaiEmbeddingsFailed ? LOCAL_EMBEDDING_DIMENSION : OPENAI_EMBEDDING_DIMENSION,
      fallbackActive: openaiEmbeddingsFailed,
      storageDimension: storageDim,
    };
  }
  
  return {
    provider: "none",
    model: "none",
    dimension: 0,
    fallbackActive: false,
    storageDimension: 0,
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
    userId
  );

  const total = row?.total || 0;
  const withEmbedding = row?.with_embedding || 0;

  return {
    total,
    withEmbedding,
    coverage: total > 0 ? withEmbedding / total : 0,
  };
}
