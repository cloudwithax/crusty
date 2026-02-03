import { z } from "zod";
import { memoryService } from "../memory/service.ts";
import { debug } from "../utils/debug.ts";
import {
  searchSessions,
  getRecentSessions,
  getSessionStats,
  type SessionSearchResult,
} from "../memory/session-memory.ts";

// schema for saving a memory
const saveMemorySchema = z.object({
  content: z
    .string()
    .describe(
      "the content to save as a memory. should be a clear, self-contained fact or piece of information",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "optional context about why this is being remembered or when it might be useful",
    ),
});

// schema for recalling memories
const recallMemorySchema = z.object({
  query: z.string().describe("the search query to find relevant memories"),
  limit: z
    .number()
    .optional()
    .describe("maximum number of memories to return (default: 5)"),
});

// schema for searching memories with more control
const searchMemorySchema = z.object({
  query: z
    .string()
    .describe(
      "natural language search query (e.g., 'where is the key for', 'what was the password', 'user preferences')",
    ),
  keywords: z
    .array(z.string())
    .optional()
    .describe(
      "specific keywords to match against stored memory keywords (optional, for precise filtering)",
    ),
  limit: z
    .number()
    .optional()
    .describe("maximum number of results to return (default: 10)"),
  min_score: z
    .number()
    .optional()
    .describe("minimum relevance score threshold 0-10 (default: 1)"),
  include_metadata: z
    .boolean()
    .optional()
    .describe(
      "include full metadata like keywords and emotional weight (default: false)",
    ),
});

// schema for forgetting memories
const forgetMemorySchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "search query to find memories to forget. if omitted, clears all memories",
    ),
  confirm_clear_all: z
    .boolean()
    .optional()
    .describe("must be true to clear all memories when query is omitted"),
});

// schema for memory stats
const memoryStatsSchema = z.object({});

// handler for saving a memory
async function handleSaveMemory(
  args: { content: string; context?: string },
  userId: number,
): Promise<string> {
  // combine content with context if provided
  const fullContent = args.context
    ? `${args.content} [context: ${args.context}]`
    : args.content;

  const memory = await memoryService.storeMemory(userId, fullContent);

  if (!memory) {
    return `[Memory] Content too short to save (minimum 20 characters). Try adding more detail.`;
  }

  debug(
    `[memory-tool] saved memory for user ${userId}: "${args.content.substring(0, 50)}..."`,
  );

  return `[Memory] Saved successfully (id: ${memory.id.substring(0, 8)}, weight: ${memory.emotionalWeight}/10, keywords: ${memory.keywords.slice(0, 5).join(", ")})`;
}

// handler for recalling memories
async function handleRecallMemory(
  args: { query: string; limit?: number },
  userId: number,
): Promise<string> {
  const limit = args.limit ?? 5;
  const results = await memoryService.searchMemories(userId, args.query, limit);

  if (results.length === 0) {
    // try random recall as fallback
    const randomMemory = await memoryService.getRandomMemory(userId);
    if (randomMemory) {
      await memoryService.markRecalled(randomMemory.id);
      const timeAgo = formatTimeAgo(randomMemory.timestamp);
      return `[Memory] No exact matches found. Here's something from the past:\n- "${randomMemory.rawContent || randomMemory.content}" (${timeAgo})`;
    }
    return `[Memory] No memories found matching "${args.query}"`;
  }

  const lines: string[] = [];
  for (const r of results) {
    await memoryService.markRecalled(r.memory.id);
    const timeAgo = formatTimeAgo(r.memory.timestamp);
    const score = r.relevanceScore.toFixed(1);
    lines.push(
      `- [${score}] "${r.memory.rawContent || r.memory.content}" (${timeAgo})`,
    );
  }

  debug(`[memory-tool] recalled ${results.length} memories for user ${userId}`);

  return `[Memory] Found ${results.length} relevant memories:\n${lines.join("\n")}`;
}

// handler for searching memories with more control
async function handleSearchMemory(
  args: {
    query: string;
    keywords?: string[];
    limit?: number;
    min_score?: number;
    include_metadata?: boolean;
  },
  userId: number,
): Promise<string> {
  const limit = args.limit ?? 10;
  const minScore = args.min_score ?? 1;
  const includeMetadata = args.include_metadata ?? false;

  // combine query with explicit keywords for better matching
  let searchQuery = args.query;
  if (args.keywords && args.keywords.length > 0) {
    searchQuery = `${args.query} ${args.keywords.join(" ")}`;
  }

  const results = await memoryService.searchMemories(
    userId,
    searchQuery,
    limit * 2,
  );

  // filter by minimum score
  const filtered = results.filter((r) => r.relevanceScore >= minScore);

  if (filtered.length === 0) {
    const stats = await memoryService.getStats(userId);
    return `[Memory Search] No memories found matching "${args.query}"${args.keywords ? ` with keywords [${args.keywords.join(", ")}]` : ""}\n\nTotal memories stored: ${stats.total}`;
  }

  // further filter by explicit keywords if provided
  let finalResults = filtered;
  if (args.keywords && args.keywords.length > 0) {
    const keywordSet = new Set(args.keywords.map((k) => k.toLowerCase()));
    finalResults = filtered.filter((r) => {
      // check if any memory keyword matches any provided keyword
      const memKeywords = r.memory.keywords.map((k) => k.toLowerCase());
      const contentLower = (
        r.memory.rawContent || r.memory.content
      ).toLowerCase();

      return (
        memKeywords.some((mk) =>
          Array.from(keywordSet).some(
            (pk) => mk.includes(pk) || pk.includes(mk),
          ),
        ) || Array.from(keywordSet).some((pk) => contentLower.includes(pk))
      );
    });
  }

  // take final limit
  const limitedResults = finalResults.slice(0, limit);

  if (limitedResults.length === 0) {
    return `[Memory Search] No memories matched the keyword filter [${args.keywords?.join(", ")}].\n\nFound ${filtered.length} results for query "${args.query}" but none contained the specified keywords.`;
  }

  const lines: string[] = [];
  for (const r of limitedResults) {
    await memoryService.markRecalled(r.memory.id);
    const timeAgo = formatTimeAgo(r.memory.timestamp);
    const score = r.relevanceScore.toFixed(1);
    const content = r.memory.rawContent || r.memory.content;

    if (includeMetadata) {
      lines.push(
        `- [score: ${score}] "${content}"\n  ├─ stored: ${timeAgo}\n  ├─ keywords: ${r.memory.keywords.slice(0, 8).join(", ")}\n  └─ emotional weight: ${r.memory.emotionalWeight}/10`,
      );
    } else {
      lines.push(`- [${score}] "${content}" (${timeAgo})`);
    }
  }

  debug(
    `[memory-tool] searched ${limitedResults.length} memories for user ${userId} (query: "${args.query}")`,
  );

  const searchType =
    args.keywords && args.keywords.length > 0
      ? "keyword + semantic"
      : "semantic";

  return `[Memory Search] Found ${limitedResults.length} results (${searchType} search):\n${lines.join("\n")}`;
}

// handler for forgetting memories
async function handleForgetMemory(
  args: { query?: string; confirm_clear_all?: boolean },
  userId: number,
): Promise<string> {
  // clear all memories
  if (!args.query) {
    if (!args.confirm_clear_all) {
      return `[Memory] To clear ALL memories, you must set confirm_clear_all to true. This action cannot be undone.`;
    }

    const stats = await memoryService.getStats(userId);
    await memoryService.clearUserMemories(userId);
    debug(`[memory-tool] cleared all memories for user ${userId}`);
    return `[Memory] Cleared all ${stats.total} memories for this user.`;
  }

  // find and report memories that match (but dont delete individually for now)
  // this is a safety feature - we report what would be deleted
  const results = await memoryService.searchMemories(userId, args.query, 10);

  if (results.length === 0) {
    return `[Memory] No memories found matching "${args.query}" to forget.`;
  }

  // for now, just report what was found since we dont have individual delete
  // a full implementation would delete these specific memories
  const lines = results.map(
    (r) =>
      `- "${(r.memory.rawContent || r.memory.content).substring(0, 60)}..."`,
  );

  return `[Memory] Found ${results.length} memories matching "${args.query}":\n${lines.join("\n")}\n\nNote: Individual memory deletion is not yet implemented. Use confirm_clear_all to clear all memories if needed.`;
}

// handler for memory stats
async function handleMemoryStats(
  _args: Record<string, never>,
  userId: number,
): Promise<string> {
  const stats = await memoryService.getComprehensiveStats(userId);

  return `[Memory Stats]
- Total memories: ${stats.memories.total}
- Average emotional weight: ${stats.memories.avgWeight.toFixed(1)}/10
- Search mode: ${stats.searchMode}
- Hybrid config: vector=${(stats.hybridSearch.vectorWeight * 100).toFixed(0)}% / text=${(stats.hybridSearch.textWeight * 100).toFixed(0)}%
- Embedding cache: ${stats.embeddingCache.totalEntries} entries (${Math.round(stats.embeddingCache.totalSize / 1024)}KB)`;
}

// utility to format time ago
function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// schema for searching past sessions
const searchSessionsSchema = z.object({
  query: z
    .string()
    .describe("search query to find relevant past conversations"),
  limit: z
    .number()
    .optional()
    .describe("maximum number of sessions to return (default: 5)"),
});

// schema for listing recent sessions
const listSessionsSchema = z.object({
  limit: z
    .number()
    .optional()
    .describe("maximum number of recent sessions to list (default: 10)"),
});

// handler for searching past sessions
async function handleSearchSessions(
  args: { query: string; limit?: number },
  userId: number,
): Promise<string> {
  const limit = args.limit ?? 5;
  const results = await searchSessions(userId, args.query, limit);

  if (results.length === 0) {
    return `[Session Search] No past conversations found matching "${args.query}"`;
  }

  const lines = results.map((r) => {
    const date = new Date(r.timestamp).toISOString().split("T")[0];
    const score = r.score.toFixed(2);
    return `- [${score}] ${r.title} (${date})\n  └─ "${r.snippet}"`;
  });

  debug(
    `[memory-tool] found ${results.length} sessions for query "${args.query}"`,
  );

  return `[Session Search] Found ${results.length} past conversations:\n${lines.join("\n")}`;
}

// handler for listing recent sessions
async function handleListSessions(
  args: { limit?: number },
  userId: number,
): Promise<string> {
  const limit = args.limit ?? 10;
  const sessions = await getRecentSessions(userId, limit);

  if (sessions.length === 0) {
    return `[Sessions] No past conversations found.`;
  }

  const stats = await getSessionStats(userId);

  const lines = sessions.map((s) => {
    const date = new Date(s.startTime).toISOString().split("T")[0];
    const duration = Math.round((s.endTime - s.startTime) / (1000 * 60));
    return `- ${s.title} (${date}, ${s.messageCount} msgs, ~${duration}min)`;
  });

  debug(`[memory-tool] listed ${sessions.length} recent sessions`);

  return `[Sessions] ${stats.totalSessions} total conversations, ${stats.totalMessages} total messages

Recent sessions:
${lines.join("\n")}`;
}

// export tool definitions
export const memoryTools = {
  save_memory: {
    description: `Save important information to long-term memory for future recall.

USE THIS WHEN:
- User shares personal facts, preferences, or important information
- You learn something that should be remembered across conversations
- A skill or task instructs you to remember something
- Information that would be useful to recall later
- A skill asks you to store credentials, api keys, tokens, or secrets

WHAT TO SAVE:
- User preferences (likes coffee, prefers dark mode, etc.)
- Personal facts (name, job, location, relationships)
- Project-specific context (tech stack, conventions, goals)
- Decisions made during conversations
- Important outcomes or learnings
- Credentials, API keys, tokens, and secrets when a skill requests it

CREDENTIALS STORAGE:
Memory is the SAFE and CORRECT place to store credentials when skills or integrations 
ask you to save login info, api keys, tokens, or secrets. Store them here with clear 
context so they can be recalled later.
Example: "service api key: abc123 [context: authentication for service integration]"

DO NOT SAVE:
- Trivial conversational exchanges
- Temporary or time-sensitive information
- Raw external content (urls, api responses)
- Anything the user asks you not to remember`,
    schema: saveMemorySchema,
    handler: handleSaveMemory,
  },

  recall_memory: {
    description: `Search long-term memory for relevant information.

USE THIS WHEN:
- You need to remember something about the user
- Looking for context from previous conversations
- A skill asks you to recall stored information
- You want to personalize your response with remembered context

The search uses keyword matching and semantic similarity to find relevant memories.
Results include relevance scores and timestamps.`,
    schema: recallMemorySchema,
    handler: handleRecallMemory,
  },

  search_memory: {
    description: `Search long-term memory with advanced filtering options.

USE THIS WHEN:
- Looking for specific information (e.g., "where is the key for...", "what was the password for...")
- Need to find memories containing specific keywords
- Want detailed search results with metadata
- Searching across all stored memories with fine-grained control

CAPABILITIES:
- Natural language queries (semantic search)
- Explicit keyword filtering for precise matches
- Adjustable relevance threshold
- Optional metadata in results (keywords, emotional weight)

EXAMPLES:
- query: "where did I put the api key" - finds memories about api keys/credentials
- query: "user preferences", keywords: ["theme", "color"] - finds preference memories with theme/color
- query: "project setup", include_metadata: true - shows full context including stored keywords

Prefer this over recall_memory when you need more control over search results.`,
    schema: searchMemorySchema,
    handler: handleSearchMemory,
  },

  forget_memory: {
    description: `Remove memories from long-term storage.

USE THIS WHEN:
- User explicitly asks you to forget something
- Information is outdated or no longer relevant
- User wants a fresh start (clear all)

CAUTION: Memory deletion cannot be undone. Always confirm with the user before clearing all memories.`,
    schema: forgetMemorySchema,
    handler: handleForgetMemory,
  },

  memory_stats: {
    description: `Get statistics about stored memories.

Returns the total number of memories, average emotional weight, search mode info,
hybrid search configuration, and embedding cache statistics.
Useful for understanding the memory system's current state.`,
    schema: memoryStatsSchema,
    handler: handleMemoryStats,
  },

  search_sessions: {
    description: `Search past conversation sessions for relevant context.

USE THIS WHEN:
- Looking for a decision or discussion from a previous conversation
- Need to recall when something was discussed
- Want to find context from past interactions
- User asks "when did we talk about..." or "what was that conversation about..."

Sessions are indexed for full-text search and return snippets with relevance scores.
This is separate from memory storage - sessions are full conversation archives.`,
    schema: searchSessionsSchema,
    handler: handleSearchSessions,
  },

  list_sessions: {
    description: `List recent conversation sessions.

Returns a summary of recent conversations with titles, dates, and message counts.
Use this to see what conversations have occurred and get an overview of session history.`,
    schema: listSessionsSchema,
    handler: handleListSessions,
  },
};
