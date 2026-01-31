// cli tool for context management
// view stats, backfill embeddings, clear conversations

import { getDatabase, getAsyncDatabase, isUsingPostgres } from "../data/db";
import { conversationStore } from "../core/conversation-store";
import { backfillEmbeddings, getEmbeddingStats, isEmbeddingsAvailable, getEmbeddingProviderInfo, resetOpenAIFallback } from "../memory/embeddings";
import {
  MAX_CONTEXT_TOKENS,
  RESERVED_COMPLETION_TOKENS,
  MAX_TURNS,
  SUMMARIZE_TRIGGER_TOKENS,
  estimateTotalTokens,
} from "../core/context-config";

interface ConversationRow {
  user_id: number;
  messages_json: string | object;
  summary: string | null;
  updated_at: number;
}

// list all stored conversations
async function listConversations(): Promise<void> {
  console.log("stored conversations:\n");

  const asyncDb = getAsyncDatabase();
  let rows: ConversationRow[];

  if (asyncDb) {
    rows = await asyncDb.all<ConversationRow>(
      `SELECT user_id, messages_json, summary, updated_at FROM conversations ORDER BY updated_at DESC`
    );
  } else {
    const db = getDatabase();
    rows = db.query<ConversationRow>(
      `SELECT user_id, messages_json, summary, updated_at FROM conversations ORDER BY updated_at DESC`
    ).all() as ConversationRow[];
  }

  if (rows.length === 0) {
    console.log("  no conversations stored");
    return;
  }

  for (const row of rows) {
    const messages = typeof row.messages_json === "string"
      ? JSON.parse(row.messages_json)
      : row.messages_json;

    const messageCount = Array.isArray(messages) ? messages.length : 0;
    const tokens = Array.isArray(messages) ? estimateTotalTokens(messages) : 0;
    const updatedAt = new Date(row.updated_at).toLocaleString();

    console.log(`  user ${row.user_id}:`);
    console.log(`    messages: ${messageCount}`);
    console.log(`    estimated tokens: ${tokens}`);
    console.log(`    has summary: ${row.summary ? "yes" : "no"}`);
    console.log(`    last updated: ${updatedAt}`);
    console.log();
  }
}

// show context configuration
function showConfig(): void {
  console.log("context configuration:\n");
  console.log(`  MAX_CONTEXT_TOKENS: ${MAX_CONTEXT_TOKENS}`);
  console.log(`  RESERVED_COMPLETION_TOKENS: ${RESERVED_COMPLETION_TOKENS}`);
  console.log(`  MAX_TURNS: ${MAX_TURNS}`);
  console.log(`  SUMMARIZE_TRIGGER_TOKENS: ${SUMMARIZE_TRIGGER_TOKENS}`);
  console.log(`  database: ${isUsingPostgres() ? "postgres" : "sqlite"}`);
}

// show embedding stats
async function showEmbeddingStats(userId?: number): Promise<void> {
  const providerInfo = getEmbeddingProviderInfo();
  const available = await isEmbeddingsAvailable();
  
  console.log("embedding stats:\n");
  console.log(`  provider: ${providerInfo.provider}`);
  console.log(`  model: ${providerInfo.model}`);
  console.log(`  dimension: ${providerInfo.dimension}`);
  console.log(`  storage dimension: ${providerInfo.storageDimension}`);
  console.log(`  fallback active: ${providerInfo.fallbackActive ? "yes (openai failed)" : "no"}`);
  console.log(`  pgvector available: ${available ? "yes" : "no"}`);

  if (!available && providerInfo.provider !== "none") {
    console.log("  (requires postgres with pgvector extension)");
  }

  if (available && userId !== undefined) {
    const stats = await getEmbeddingStats(userId);
    console.log(`\n  user ${userId}:`);
    console.log(`    total memories: ${stats.total}`);
    console.log(`    with embeddings: ${stats.withEmbedding}`);
    console.log(`    coverage: ${(stats.coverage * 100).toFixed(1)}%`);
  }
}

// backfill embeddings for memories
async function runBackfill(userId?: number): Promise<void> {
  const available = await isEmbeddingsAvailable();
  if (!available) {
    console.log("embeddings not available (requires postgres with pgvector)");
    return;
  }

  console.log("backfilling embeddings...\n");

  let total = 0;
  let batch = 0;

  // process in batches
  while (true) {
    const count = await backfillEmbeddings(userId, 50);
    if (count === 0) break;
    total += count;
    batch++;
    console.log(`  batch ${batch}: ${count} embeddings created`);
  }

  console.log(`\n  total: ${total} embeddings created`);
}

// clear conversation for a user
async function clearConversation(userId: number): Promise<void> {
  await conversationStore().clear(userId);
  console.log(`cleared conversation for user ${userId}`);
}

// main cli entry
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "list":
      await listConversations();
      break;

    case "config":
      showConfig();
      break;

    case "embeddings":
      const embUserId = args[1] ? parseInt(args[1], 10) : undefined;
      await showEmbeddingStats(embUserId);
      break;

    case "backfill":
      const backfillUserId = args[1] ? parseInt(args[1], 10) : undefined;
      await runBackfill(backfillUserId);
      break;

    case "clear":
      const clearUserId = args[1] ? parseInt(args[1], 10) : undefined;
      if (clearUserId === undefined) {
        console.log("usage: context clear <user_id>");
        process.exit(1);
      }
      await clearConversation(clearUserId);
      break;

    case "reset-fallback":
      resetOpenAIFallback();
      console.log("openai embedding fallback state reset");
      break;

    default:
      console.log("context management cli\n");
      console.log("commands:");
      console.log("  list              - list all stored conversations");
      console.log("  config            - show context configuration");
      console.log("  embeddings [uid]  - show embedding stats");
      console.log("  backfill [uid]    - backfill embeddings for memories");
      console.log("  clear <uid>       - clear conversation for user");
      console.log("  reset-fallback    - reset openai fallback to retry api");
  }
}

main().catch(console.error);
