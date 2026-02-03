// learning machine tools - save and search discovered patterns
// provides the agent with tools to build its own knowledge base

import { z } from "zod";
import {
  learningsService,
  type LearningCategory,
} from "../memory/learnings.ts";
import { debug } from "../utils/debug.ts";

// schema for saving a learning
const saveLearningSchema = z.object({
  title: z
    .string()
    .describe(
      "short title describing the learning (e.g., 'browser navigation requires full url', 'user prefers concise responses')",
    ),
  learning: z
    .string()
    .describe(
      "detailed description of what was learned and how to apply it in the future",
    ),
  category: z
    .enum([
      "error_pattern",
      "gotcha",
      "fix",
      "preference",
      "workflow",
      "context",
    ])
    .describe(
      "category: error_pattern (tool/api failures), gotcha (non-obvious quirks), fix (solutions), preference (user corrections), workflow (successful patterns), context (domain knowledge)",
    ),
  tool_name: z
    .string()
    .optional()
    .describe("name of the tool this learning relates to, if applicable"),
});

// schema for searching learnings
const searchLearningsSchema = z.object({
  query: z
    .string()
    .describe(
      "search query to find relevant learnings (e.g., 'browser errors', 'file permissions', 'user preferences')",
    ),
  category: z
    .enum([
      "error_pattern",
      "gotcha",
      "fix",
      "preference",
      "workflow",
      "context",
    ])
    .optional()
    .describe("filter by category"),
  limit: z
    .number()
    .optional()
    .describe("maximum number of results (default: 5)"),
});

// schema for marking a learning as applied
const applyLearningSchema = z.object({
  learning_id: z
    .string()
    .describe("id of the learning that was successfully applied"),
});

// schema for getting learning stats
const learningStatsSchema = z.object({});

// handler for saving a learning
async function handleSaveLearning(
  args: {
    title: string;
    learning: string;
    category: LearningCategory;
    tool_name?: string;
  },
  userId: number,
): Promise<string> {
  const learning = await learningsService.storeLearning(
    userId,
    args.title,
    args.learning,
    args.category,
    { toolName: args.tool_name },
  );

  if (!learning) {
    return `[Learning] Could not save - content too short or duplicate detected.`;
  }

  debug(`[learning-tool] saved: "${args.title}" (${args.category})`);

  return `[Learning] Saved: "${args.title}" (id: ${learning.id.substring(0, 8)}, confidence: ${(learning.confidence * 100).toFixed(0)}%)

This learning will be recalled in future similar situations to help avoid repeating mistakes and apply proven solutions.`;
}

// handler for searching learnings
async function handleSearchLearnings(
  args: {
    query: string;
    category?: LearningCategory;
    limit?: number;
  },
  userId: number,
): Promise<string> {
  const limit = args.limit ?? 5;
  const results = await learningsService.searchLearnings(
    userId,
    args.query,
    limit,
    args.category,
  );

  if (results.length === 0) {
    // return top learnings as fallback context
    const topLearnings = await learningsService.getTopLearnings(userId, 3);
    if (topLearnings.length > 0) {
      const lines = topLearnings.map(
        (l) =>
          `- [${l.category}] ${l.title}: ${l.content.substring(0, 100)}...`,
      );
      return `[Learning] No exact matches for "${args.query}". Here are some top learnings:\n${lines.join("\n")}`;
    }
    return `[Learning] No learnings found. Use save_learning to build your knowledge base as you discover patterns.`;
  }

  const lines: string[] = [];
  for (const r of results) {
    const confidence = (r.learning.confidence * 100).toFixed(0);
    const applied =
      r.learning.applicationCount > 0
        ? ` (applied ${r.learning.applicationCount}x)`
        : "";
    lines.push(
      `- [${r.learning.category}] **${r.learning.title}**: ${r.learning.content}${applied} (${confidence}% confidence, id: ${r.learning.id.substring(0, 8)})`,
    );
  }

  debug(
    `[learning-tool] searched "${args.query}" -> ${results.length} results`,
  );

  return `[Learning] Found ${results.length} relevant learnings:\n\n${lines.join("\n\n")}

Use apply_learning with the id when you successfully use one of these learnings to increase its confidence.`;
}

// handler for marking a learning as applied
async function handleApplyLearning(
  args: { learning_id: string },
  userId: number,
): Promise<string> {
  // find the learning first (could be short id)
  const learning = await learningsService.getLearningById(args.learning_id);

  if (!learning) {
    // try to find by partial id
    const topLearnings = await learningsService.getTopLearnings(userId, 100);
    const match = topLearnings.find((l) => l.id.startsWith(args.learning_id));

    if (match) {
      await learningsService.markApplied(match.id);
      return `[Learning] Marked "${match.title}" as applied. Confidence increased.`;
    }

    return `[Learning] Could not find learning with id starting with "${args.learning_id}".`;
  }

  await learningsService.markApplied(learning.id);

  debug(`[learning-tool] applied: ${args.learning_id}`);

  return `[Learning] Marked "${learning.title}" as successfully applied. Confidence increased to ${((learning.confidence + 0.1) * 100).toFixed(0)}%.`;
}

// handler for learning stats
async function handleLearningStats(
  _args: Record<string, never>,
  userId: number,
): Promise<string> {
  const stats = await learningsService.getStats(userId);

  const categoryLines = Object.entries(stats.byCategory)
    .filter(([_, count]) => count > 0)
    .map(([cat, count]) => `  - ${cat}: ${count}`)
    .join("\n");

  return `[Learning] Knowledge Base Stats:
- Total learnings: ${stats.total}
- Average confidence: ${(stats.avgConfidence * 100).toFixed(0)}%
- Total applications: ${stats.totalApplications}
- By category:
${categoryLines || "  (no learnings yet)"}

Use save_learning to grow your knowledge base, and search_learnings before tasks to avoid repeating mistakes.`;
}

// format learnings for context injection
export function formatLearningsForContext(
  learnings: { learning: any; relevanceScore: number }[],
): string {
  if (learnings.length === 0) return "";

  const lines = learnings.map((r) => {
    const l = r.learning;
    return `[${l.category}] ${l.title}: ${l.content}`;
  });

  return `## Relevant Learnings

The following patterns and fixes have been discovered from previous interactions. Apply them when relevant:

${lines.join("\n\n")}`;
}

// helper to auto-capture tool failure as learning
export async function captureToolFailure(
  userId: number,
  toolName: string,
  errorMessage: string,
  context?: string,
): Promise<void> {
  // extract meaningful error info
  const shortError = errorMessage.substring(0, 200);

  // classify error type
  let errorType = "unknown";
  if (errorMessage.includes("timeout")) errorType = "timeout";
  else if (errorMessage.includes("permission")) errorType = "permission";
  else if (errorMessage.includes("not found") || errorMessage.includes("404"))
    errorType = "not_found";
  else if (
    errorMessage.includes("invalid") ||
    errorMessage.includes("malformed")
  )
    errorType = "validation";
  else if (errorMessage.includes("rate") || errorMessage.includes("limit"))
    errorType = "rate_limit";

  const title = `${toolName} ${errorType} error`;
  const content = context
    ? `Error: ${shortError}. Context: ${context}`
    : `Error: ${shortError}`;

  await learningsService.storeLearning(
    userId,
    title,
    content,
    "error_pattern",
    { toolName, errorType, confidence: 0.3 },
  );

  debug(`[learning-tool] auto-captured failure: ${toolName} -> ${errorType}`);
}

// export tool definitions
export const learningTools = {
  save_learning: {
    description:
      "save a discovered pattern, gotcha, or fix to your knowledge base. use this when you learn something that could help in future similar situations - tool errors, user preferences, successful approaches, or domain-specific knowledge.",
    schema: saveLearningSchema,
    handler: handleSaveLearning,
  },
  search_learnings: {
    description:
      "search your knowledge base for relevant learnings before starting a task. this helps avoid repeating mistakes and apply proven solutions.",
    schema: searchLearningsSchema,
    handler: handleSearchLearnings,
  },
  apply_learning: {
    description:
      "mark a learning as successfully applied, increasing its confidence score. use the learning id (or partial id) returned from search_learnings.",
    schema: applyLearningSchema,
    handler: handleApplyLearning,
  },
  learning_stats: {
    description:
      "get statistics about your knowledge base - total learnings, confidence levels, and category breakdown.",
    schema: learningStatsSchema,
    handler: handleLearningStats,
  },
};
