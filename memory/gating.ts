// memory/gating.ts
// selective memory storage - only durable facts, not noise

import { debug } from "../utils/debug.ts";

export interface MemoryCandidate {
  content: string;
  role: "user" | "assistant";
  hasToolContext?: boolean;
}

export interface GatingResult {
  shouldStore: boolean;
  reason: string;
  cleanedContent?: string;
  category?: MemoryCategory;
}

export type MemoryCategory =
  | "preference" // user likes/dislikes
  | "fact" // personal facts (name, location, job)
  | "project" // ongoing work or goals
  | "instruction" // explicit "remember this" requests
  | "decision" // choices made
  | "none"; // should not be stored

// patterns that indicate durable information
const DURABLE_PATTERNS = [
  // explicit memory requests
  /\b(remember|don't forget|keep in mind|note that|fyi)\b/i,

  // preferences
  /\b(i (always|never|prefer|like|love|hate|dislike)|my favorite|i tend to)\b/i,

  // personal facts
  /\b(my name is|i('m| am) (a|an)|i work (at|as|for)|i live in|i'm from)\b/i,

  // ongoing projects
  /\b(i('m| am) (working on|building|creating|developing)|my project|the project)\b/i,

  // decisions and commitments
  /\b(i('ve| have) decided|let's go with|we('ll| will) use|the plan is)\b/i,

  // important context
  /\b(always|never) (use|do|call|include)\b/i,
];

// patterns that indicate transient content - should NOT be stored
const TRANSIENT_PATTERNS = [
  // questions that don't contain facts
  /^(what|where|when|who|why|how|can you|could you|would you|should i)\b/i,

  // acknowledgments
  /^(ok|okay|thanks|thank you|got it|sure|cool|nice|great|perfect|awesome)\b/i,

  // greetings
  /^(hi|hello|hey|good morning|good evening|bye|goodbye)\b/i,

  // single-use requests
  /^(show me|tell me|list|find|search|look up|check)\b/i,

  // tool-related queries
  /^(open|browse|navigate|run|execute|read file)\b/i,
];

// words that boost importance
const IMPORTANCE_BOOSTERS = [
  "always",
  "never",
  "important",
  "critical",
  "must",
  "essential",
  "remember",
  "don't forget",
  "make sure",
  "key",
  "priority",
];

// classify content category
function classifyCategory(content: string): MemoryCategory {
  if (/\b(remember|don't forget|keep in mind)\b/i.test(content)) {
    return "instruction";
  }

  if (
    /\b(prefer|like|love|hate|dislike|favorite|always|never)\b/i.test(content)
  ) {
    return "preference";
  }

  if (/\b(my name|i('m| am) (a|an)|i work|i live|i'm from)\b/i.test(content)) {
    return "fact";
  }

  if (/\b(working on|building|project|developing|goal)\b/i.test(content)) {
    return "project";
  }

  if (/\b(decided|go with|we'll use|the plan)\b/i.test(content)) {
    return "decision";
  }

  return "none";
}

// calculate importance score (0-10)
function calculateImportance(content: string): number {
  let score = 5;
  const lower = content.toLowerCase();

  // boost for importance words
  for (const word of IMPORTANCE_BOOSTERS) {
    if (lower.includes(word)) {
      score += 1;
    }
  }

  // boost for durable patterns
  for (const pattern of DURABLE_PATTERNS) {
    if (pattern.test(content)) {
      score += 1;
    }
  }

  // penalty for short content
  if (content.length < 30) {
    score -= 2;
  }

  // penalty for being mostly a question
  if (content.split("?").length > 2) {
    score -= 1;
  }

  return Math.max(1, Math.min(10, score));
}

// clean content for storage - remove noise, extract key info
function cleanForStorage(content: string): string {
  let cleaned = content;

  // remove filler phrases
  cleaned = cleaned.replace(/^(so,?|well,?|um,?|uh,?|like,?)\s*/gi, "");
  cleaned = cleaned.replace(
    /,?\s*(you know|i mean|basically|actually)\s*,?/gi,
    " "
  );

  // normalize whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // truncate if too long (preserve meaning)
  if (cleaned.length > 400) {
    // try to find a good break point
    const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
    let result = "";
    for (const sentence of sentences) {
      if (result.length + sentence.length > 400) break;
      result += sentence;
    }
    cleaned = result.trim() || cleaned.slice(0, 400);
  }

  return cleaned;
}

// main gating function - decide if content should be stored
export function shouldStoreMemory(candidate: MemoryCandidate): GatingResult {
  const { content, role, hasToolContext } = candidate;

  // skip very short content
  if (content.length < 15) {
    return { shouldStore: false, reason: "too short" };
  }

  // skip if mostly punctuation or special chars
  const alphaRatio =
    (content.match(/[a-zA-Z]/g)?.length || 0) / content.length;
  if (alphaRatio < 0.5) {
    return { shouldStore: false, reason: "low alpha ratio" };
  }

  // check for explicit transient patterns
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(content)) {
      // but allow if it also has durable patterns
      const hasDurable = DURABLE_PATTERNS.some((p) => p.test(content));
      if (!hasDurable) {
        return { shouldStore: false, reason: "transient pattern" };
      }
    }
  }

  // classify and check importance
  const category = classifyCategory(content);
  const importance = calculateImportance(content);

  // require higher importance for assistant messages (avoid storing AI responses as memories)
  const threshold = role === "assistant" ? 7 : 5;

  if (category === "none" && importance < threshold) {
    return { shouldStore: false, reason: `low importance (${importance})` };
  }

  // tool context without explicit facts usually shouldn't be stored
  if (hasToolContext && category === "none") {
    return { shouldStore: false, reason: "tool context without facts" };
  }

  // passed all checks - store it
  const cleanedContent = cleanForStorage(content);

  debug(`[memory-gate] storing: category=${category}, importance=${importance}`);

  return {
    shouldStore: true,
    reason: `category=${category}, importance=${importance}`,
    cleanedContent,
    category,
  };
}

// check if random recall should be suppressed for this context
export function shouldSuppressRandomRecall(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();

  // suppress for technical/coding contexts
  const technicalPatterns = [
    /\b(code|function|class|method|api|debug|error|bug|fix|implement)\b/i,
    /\b(file|directory|path|config|setting|variable)\b/i,
    /\b(run|execute|test|build|deploy|compile)\b/i,
    /\b(json|xml|html|css|javascript|typescript|python)\b/i,
  ];

  for (const pattern of technicalPatterns) {
    if (pattern.test(lower)) {
      return true;
    }
  }

  // suppress for explicit task requests
  if (/^(do|make|create|edit|delete|find|search|show)\b/i.test(lower)) {
    return true;
  }

  return false;
}
