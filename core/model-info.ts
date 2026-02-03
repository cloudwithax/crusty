// model info fetcher
// queries openrouter's free api to get context lengths for models

import { debug } from "../utils/debug";

interface OpenRouterModel {
  id: string;
  context_length: number;
  name: string;
  architecture?: {
    tokenizer?: string;
  };
}

interface ModelInfo {
  contextLength: number;
  name: string;
  fetchedAt: number;
}

// cache model info in memory with 24h ttl
const modelCache = new Map<string, ModelInfo>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// known model aliases (openai model names -> openrouter ids)
const MODEL_ALIASES: Record<string, string> = {
  "gpt-4o": "openai/gpt-4o",
  "gpt-4o-mini": "openai/gpt-4o-mini",
  "gpt-4-turbo": "openai/gpt-4-turbo",
  "gpt-4": "openai/gpt-4",
  "gpt-3.5-turbo": "openai/gpt-3.5-turbo",
  "claude-3-opus-20240229": "anthropic/claude-3-opus",
  "claude-3-sonnet-20240229": "anthropic/claude-3-sonnet",
  "claude-3-haiku-20240307": "anthropic/claude-3-haiku",
  "claude-3-5-sonnet-20241022": "anthropic/claude-3.5-sonnet",
};

// fallback context lengths for common models/patterns if api is unavailable
const FALLBACK_CONTEXT: Record<string, number> = {
  // openai
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4": 8192,
  "gpt-3.5-turbo": 16385,
  // anthropic
  "claude-3-opus": 200000,
  "claude-3-sonnet": 200000,
  "claude-3-haiku": 200000,
  "claude-3.5-sonnet": 200000,
  "claude-3-5-sonnet": 200000,
  // meta llama
  "llama-3.1-405b": 131072,
  "llama-3.1-70b": 131072,
  "llama-3.1-8b": 131072,
  "llama-3-70b": 8192,
  "llama-3-8b": 8192,
  "llama-2-70b": 4096,
  "llama-2-13b": 4096,
  "llama-2-7b": 4096,
  // mistral
  "mistral-large": 128000,
  "mistral-medium": 32768,
  "mistral-small": 32768,
  "mistral-nemo": 131072,
  "mistral-7b": 32768,
  "mixtral-8x7b": 32768,
  "mixtral-8x22b": 65536,
  // qwen
  "qwen-2.5-72b": 131072,
  "qwen-2.5-32b": 131072,
  "qwen-2-72b": 131072,
  "qwen2": 32768,
  // deepseek
  "deepseek-v3": 65536,
  "deepseek-r1": 65536,
  "deepseek-coder": 65536,
  // google
  "gemini-pro": 1000000,
  "gemini-1.5-pro": 1000000,
  "gemini-1.5-flash": 1000000,
  // cohere
  "command-r": 128000,
  "command-r-plus": 128000,
};

let allModels: OpenRouterModel[] | null = null;
let modelsFetchedAt = 0;

async function fetchAllModels(): Promise<OpenRouterModel[]> {
  // use cached list if fresh
  if (allModels && Date.now() - modelsFetchedAt < CACHE_TTL_MS) {
    return allModels;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "User-Agent": "crusty-bot/1.0" },
    });

    if (!response.ok) {
      throw new Error(`openrouter api returned ${response.status}`);
    }

    const data = (await response.json()) as { data: OpenRouterModel[] };
    allModels = data.data || [];
    modelsFetchedAt = Date.now();
    debug(`[model-info] fetched ${allModels.length} models from openrouter`);
    return allModels;
  } catch (err) {
    debug(`[model-info] failed to fetch models:`, err);
    return allModels || [];
  }
}

// normalize model id for comparison
// strips common suffixes, provider prefixes, and lowercases
function normalizeForComparison(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/^(openai|anthropic|meta-llama|mistralai|google|cohere|deepseek|qwen)\//, "")
    .replace(/[-_:]/g, "-")
    .replace(/-+(instruct|chat|base|fp16|fp8|awq|gptq|gguf|q[0-9]+|[0-9]+k)$/g, "")
    .replace(/-+v?[0-9]+(\.[0-9]+)*$/, "") // strip version suffixes like -v0.1, -20240229
    .replace(/--+/g, "-")
    .trim();
}

// extract key identifiers from model name for matching
function extractModelTokens(modelId: string): string[] {
  const normalized = normalizeForComparison(modelId);
  
  // extract meaningful tokens
  const tokens: string[] = [];
  
  // model family
  const families = ["gpt", "claude", "llama", "mistral", "mixtral", "qwen", "gemini", "deepseek", "command"];
  for (const family of families) {
    if (normalized.includes(family)) {
      tokens.push(family);
      break;
    }
  }
  
  // version/size patterns
  const versionMatch = normalized.match(/[0-9]+\.?[0-9]*[b]?/g);
  if (versionMatch) {
    tokens.push(...versionMatch);
  }
  
  // special variants
  const variants = ["mini", "small", "medium", "large", "turbo", "pro", "opus", "sonnet", "haiku", "nemo", "coder"];
  for (const variant of variants) {
    if (normalized.includes(variant)) {
      tokens.push(variant);
    }
  }
  
  return tokens;
}

// calculate similarity score between two model ids
function modelSimilarity(a: string, b: string): number {
  const tokensA = extractModelTokens(a);
  const tokensB = extractModelTokens(b);
  
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  
  let matches = 0;
  for (const token of tokensA) {
    if (tokensB.includes(token)) {
      matches++;
    }
  }
  
  // normalize by average length
  const avgLen = (tokensA.length + tokensB.length) / 2;
  return matches / avgLen;
}

function normalizeModelId(modelId: string): string {
  // check aliases first
  if (MODEL_ALIASES[modelId]) {
    return MODEL_ALIASES[modelId];
  }

  // if already has a provider prefix, use as-is
  if (modelId.includes("/")) {
    return modelId;
  }

  // try adding openai prefix
  return `openai/${modelId}`;
}

export async function getModelContextLength(modelId: string): Promise<number> {
  // check memory cache first
  const cached = modelCache.get(modelId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.contextLength;
  }

  const models = await fetchAllModels();
  const normalizedId = normalizeModelId(modelId);
  const normalizedForMatch = normalizeForComparison(modelId);

  // 1. exact match
  let match = models.find((m) => m.id === normalizedId);

  // 2. exact match on normalized form
  if (!match) {
    match = models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
  }

  // 3. partial match (e.g., "gpt-4o" matches "openai/gpt-4o")
  if (!match) {
    match = models.find(
      (m) => m.id.endsWith(`/${modelId}`) || m.id.toLowerCase().includes(modelId.toLowerCase())
    );
  }

  // 4. normalized comparison match
  if (!match) {
    match = models.find((m) => normalizeForComparison(m.id) === normalizedForMatch);
  }

  // 5. fuzzy match - find best similarity score
  if (!match && models.length > 0) {
    let bestScore = 0;
    let bestMatch: OpenRouterModel | null = null;

    for (const m of models) {
      const score = modelSimilarity(modelId, m.id);
      if (score > bestScore && score >= 0.6) {
        bestScore = score;
        bestMatch = m;
      }
    }

    if (bestMatch) {
      match = bestMatch;
      debug(`[model-info] fuzzy matched ${modelId} -> ${match.id} (score: ${bestScore.toFixed(2)})`);
    }
  }

  if (match) {
    const info: ModelInfo = {
      contextLength: match.context_length,
      name: match.name,
      fetchedAt: Date.now(),
    };
    modelCache.set(modelId, info);
    debug(`[model-info] ${modelId} context: ${match.context_length}`);
    return match.context_length;
  }

  // fallback to hardcoded values with fuzzy matching
  const fallback = findFallbackContext(modelId);
  if (fallback) {
    debug(`[model-info] using fallback for ${modelId}: ${fallback}`);
    return fallback;
  }

  // default conservative value
  debug(`[model-info] no info for ${modelId}, defaulting to 128000`);
  return 128000;
}

// find fallback context with fuzzy matching on known models
function findFallbackContext(modelId: string): number | null {
  const normalized = normalizeForComparison(modelId);

  // exact match first
  if (FALLBACK_CONTEXT[modelId]) {
    return FALLBACK_CONTEXT[modelId];
  }

  // check if normalized form matches any key
  for (const [key, value] of Object.entries(FALLBACK_CONTEXT)) {
    if (normalizeForComparison(key) === normalized) {
      return value;
    }
  }

  // check if any key is contained in the model id
  for (const [key, value] of Object.entries(FALLBACK_CONTEXT)) {
    if (normalized.includes(normalizeForComparison(key))) {
      return value;
    }
  }

  // fuzzy match on fallback keys
  let bestScore = 0;
  let bestValue: number | null = null;

  for (const [key, value] of Object.entries(FALLBACK_CONTEXT)) {
    const score = modelSimilarity(modelId, key);
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestValue = value;
    }
  }

  return bestValue;
}

// get context length synchronously from cache, or return fallback
export function getModelContextLengthSync(modelId: string): number {
  const cached = modelCache.get(modelId);
  if (cached) {
    return cached.contextLength;
  }

  return findFallbackContext(modelId) || 128000;
}

// prefetch model info at startup
export async function prefetchModelInfo(modelId: string): Promise<void> {
  await getModelContextLength(modelId);
}
