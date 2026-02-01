import { z } from "zod";
import { memoryService } from "../memory/service.ts";
import { debug } from "../utils/debug.ts";

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
  const stats = await memoryService.getStats(userId);

  return `[Memory Stats]
- Total memories: ${stats.total}
- Average emotional weight: ${stats.avgWeight.toFixed(1)}/10`;
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

// export tool definitions
export const memoryTools = {
  save_memory: {
    description: `Save important information to long-term memory for future recall.

USE THIS WHEN:
- User shares personal facts, preferences, or important information
- You learn something that should be remembered across conversations
- A skill or task instructs you to remember something
- Information that would be useful to recall later

WHAT TO SAVE:
- User preferences (likes coffee, prefers dark mode, etc.)
- Personal facts (name, job, location, relationships)
- Project-specific context (tech stack, conventions, goals)
- Decisions made during conversations
- Important outcomes or learnings

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

Returns the total number of memories and average emotional weight.
Useful for understanding what has been remembered and its importance.`,
    schema: memoryStatsSchema,
    handler: handleMemoryStats,
  },
};
