// deep research tool - runs extended multi-query research sessions
// uses ddg lite search and web_fetch under the hood to gather, read, and synthesize information

import { z } from "zod";
import { OpenAI } from "openai";
import { executeTool } from "./registry.ts";
import { debug } from "../utils/debug.ts";
import { withRetry } from "../utils/retry.ts";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 30 * 1000,
});

// research config
const MAX_SEARCH_QUERIES = 25;
const MAX_PAGE_READS = 30;
const MAX_ITERATIONS = 80;
const TARGET_DURATION_MS = 150 * 1000; // ~2.5 minutes target
const MAX_DURATION_MS = 200 * 1000; // hard cap at ~3.3 minutes
const CONTENT_PER_PAGE = 6000;

// tracks a single piece of gathered information
interface ResearchFinding {
  query: string;
  url: string;
  title: string;
  content: string;
  relevance: number;
}

// tracks overall research state
interface ResearchState {
  topic: string;
  findings: ResearchFinding[];
  queriesUsed: string[];
  urlsVisited: Set<string>;
  urlsFailed: Set<string>;
  iteration: number;
  startTime: number;
  gaps: string[];
}

const DeepResearchSchema = z.object({
  topic: z
    .string()
    .describe(
      "the research topic or question to deeply investigate",
    ),
  focus: z
    .string()
    .optional()
    .describe(
      "optional focus area to narrow the research (e.g., 'recent developments', 'technical details', 'comparisons')",
    ),
});

// generate search queries based on the topic and what we've learned so far
async function generateSearchQueries(
  state: ResearchState,
  focus?: string,
): Promise<string[]> {
  const existingQueries = state.queriesUsed.join("\n- ");
  const findingSummary = state.findings
    .slice(-5)
    .map((f) => `[${f.title}]: ${f.content.slice(0, 150)}`)
    .join("\n");
  const gapsList = state.gaps.length > 0 ? state.gaps.join("\n- ") : "none identified yet";

  const prompt = `you are a research query generator. given a topic and previous research, generate 3-5 new search queries that would help fill knowledge gaps and explore different angles.

topic: ${state.topic}
${focus ? `focus area: ${focus}` : ""}

queries already used:
- ${existingQueries || "none yet"}

gaps identified:
- ${gapsList}

recent findings:
${findingSummary || "none yet"}

rules:
- generate diverse queries that cover different aspects
- avoid repeating queries already used
- include specific technical terms when relevant
- mix broad and narrow queries
- if gaps were identified, prioritize queries that address them

respond with a json array of query strings only, no explanation:
["query 1", "query 2", "query 3"]`;

  try {
    const response = await withRetry(
      () =>
        openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
          temperature: 0.7,
        }),
      { maxRetries: 10, baseDelayMs: 1000 },
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return [];

    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1]!.trim();

    const queries = JSON.parse(jsonStr) as string[];
    return queries.filter(
      (q) => typeof q === "string" && q.length > 2 && !state.queriesUsed.includes(q),
    );
  } catch (err) {
    debug(`[deep-research] query generation failed:`, err);
    return [];
  }
}

// assess relevance of a page's content to the research topic
async function assessRelevance(
  topic: string,
  content: string,
): Promise<{ relevance: number; keyPoints: string }> {
  const truncated = content.slice(0, 3000);

  try {
    const response = await withRetry(
      () =>
        openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            {
              role: "user",
              content: `rate the relevance of this content to the research topic and extract key points.

topic: ${topic}

content:
${truncated}

respond with json only:
{"relevance": 0.0-1.0, "key_points": "2-3 sentence summary of relevant information"}`,
            },
          ],
          max_tokens: 200,
          temperature: 0.2,
        }),
      { maxRetries: 10, baseDelayMs: 1000 },
    );

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return { relevance: 0.3, keyPoints: content.slice(0, 200) };

    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1]!.trim();

    const result = JSON.parse(jsonStr);
    return {
      relevance: Math.min(1, Math.max(0, result.relevance || 0.3)),
      keyPoints: result.key_points || content.slice(0, 200),
    };
  } catch {
    return { relevance: 0.3, keyPoints: content.slice(0, 200) };
  }
}

// identify gaps in the research so far
async function identifyGaps(state: ResearchState): Promise<string[]> {
  if (state.findings.length < 3) return [];

  const summaries = state.findings
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10)
    .map((f) => `- ${f.title}: ${f.content.slice(0, 100)}`)
    .join("\n");

  try {
    const response = await withRetry(
      () =>
        openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            {
              role: "user",
              content: `given this research topic and findings so far, identify 2-3 knowledge gaps that still need to be filled.

topic: ${state.topic}

findings:
${summaries}

respond with a json array of gap descriptions:
["gap 1", "gap 2"]`,
            },
          ],
          max_tokens: 200,
          temperature: 0.4,
        }),
      { maxRetries: 10, baseDelayMs: 1000 },
    );

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return [];

    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1]!.trim();

    return JSON.parse(jsonStr) as string[];
  } catch {
    return [];
  }
}

// run a single search query and extract results
async function executeSearch(
  query: string,
  userId: number,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const raw = await executeTool("web_search", JSON.stringify({ query }), userId);

  if (raw.startsWith("[Search failed") || raw.startsWith("[Error")) {
    debug(`[deep-research] search failed for "${query}": ${raw.slice(0, 100)}`);
    return [];
  }

  // parse the formatted search results
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = raw.split("\n\n- ").slice(0); // split on result boundaries

  // handle first block which starts with "Search results for..."
  const firstSplit = raw.indexOf("\n\n- ");
  const resultText = firstSplit > -1 ? raw.slice(firstSplit) : raw;
  const entries = resultText.split("\n- ").filter((b) => b.trim());

  for (const entry of entries) {
    const lines = entry.split("\n").map((l) => l.trim());
    const title = lines[0]?.replace(/^-\s*/, "") || "";
    let url = "";
    let snippet = "";

    for (const line of lines) {
      if (line.startsWith("URL: ")) url = line.slice(5);
      else if (line.startsWith("Source: ")) continue;
      else if (line.length > 10 && !line.startsWith("URL:") && line !== title) {
        snippet += (snippet ? " " : "") + line;
      }
    }

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

// fetch and extract content from a url
async function fetchPage(
  url: string,
  userId: number,
): Promise<string | null> {
  try {
    const result = await executeTool(
      "web_fetch",
      JSON.stringify({ url, maxChars: CONTENT_PER_PAGE }),
      userId,
    );

    if (result.startsWith("[Error") || result.startsWith("[Warning")) {
      return null;
    }

    return result;
  } catch {
    return null;
  }
}

// synthesize all findings into a final report
async function synthesizeReport(state: ResearchState): Promise<string> {
  // sort by relevance and take the best findings
  const topFindings = state.findings
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 20);

  if (topFindings.length === 0) {
    return `i searched extensively for "${state.topic}" but couldn't find substantial information. the search queries i tried were:\n${state.queriesUsed.map((q) => `- ${q}`).join("\n")}\n\ntry rephrasing or narrowing the topic.`;
  }

  const findingsText = topFindings
    .map(
      (f) =>
        `### ${f.title}\nurl: ${f.url}\n${f.content}`,
    )
    .join("\n\n---\n\n");

  const elapsed = Math.round((Date.now() - state.startTime) / 1000);

  try {
    const response = await withRetry(
      () =>
        openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            {
              role: "system",
              content: `you are a research synthesizer. combine the provided findings into a clear, well-structured research summary. use markdown formatting.

rules:
- write in lowercase, no punctuation in comments style
- organize information logically with headers
- include relevant urls as inline links using markdown [text](url) format
- highlight key takeaways and notable findings
- note any contradictions or areas where information is uncertain
- keep it comprehensive but readable
- do not use emojis`,
            },
            {
              role: "user",
              content: `synthesize these research findings on "${state.topic}" into a comprehensive summary.

${findingsText}

research stats: ${state.queriesUsed.length} queries, ${state.findings.length} sources found, ${state.urlsVisited.size} pages read, ${elapsed}s elapsed`,
            },
          ],
          max_tokens: 4000,
          temperature: 0.3,
        }),
      { maxRetries: 10, baseDelayMs: 1000 },
    );

    const report = response.choices[0]?.message?.content?.trim();
    if (!report) return buildFallbackReport(state, elapsed);

    return report;
  } catch (err) {
    debug(`[deep-research] synthesis failed:`, err);
    return buildFallbackReport(state, elapsed);
  }
}

// fallback if llm synthesis fails
function buildFallbackReport(state: ResearchState, elapsedSeconds: number): string {
  const topFindings = state.findings
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 15);

  let report = `## research results: ${state.topic}\n\n`;
  report += `*${state.queriesUsed.length} queries | ${state.findings.length} sources | ${elapsedSeconds}s*\n\n`;

  for (const finding of topFindings) {
    report += `### ${finding.title}\n`;
    report += `[source](${finding.url})\n\n`;
    report += `${finding.content}\n\n---\n\n`;
  }

  return report;
}

// checks if we should keep going or wrap up
function shouldContinue(state: ResearchState): boolean {
  const elapsed = Date.now() - state.startTime;

  // hard time limit
  if (elapsed >= MAX_DURATION_MS) {
    debug(`[deep-research] hit max duration (${Math.round(elapsed / 1000)}s)`);
    return false;
  }

  // iteration limit
  if (state.iteration >= MAX_ITERATIONS) {
    debug(`[deep-research] hit max iterations (${state.iteration})`);
    return false;
  }

  // query limit
  if (state.queriesUsed.length >= MAX_SEARCH_QUERIES) {
    debug(`[deep-research] hit max queries (${state.queriesUsed.length})`);
    return false;
  }

  // if we have enough high-quality findings and past minimum time, wrap up
  const highQuality = state.findings.filter((f) => f.relevance >= 0.6);
  if (highQuality.length >= 15 && elapsed >= TARGET_DURATION_MS) {
    debug(`[deep-research] sufficient findings (${highQuality.length} high quality)`);
    return false;
  }

  return true;
}

// main research loop
async function runDeepResearch(
  topic: string,
  userId: number,
  focus?: string,
): Promise<string> {
  const state: ResearchState = {
    topic,
    findings: [],
    queriesUsed: [],
    urlsVisited: new Set(),
    urlsFailed: new Set(),
    iteration: 0,
    startTime: Date.now(),
    gaps: [],
  };

  debug(`[deep-research] starting research on: ${topic}`);

  let searchesExecuted = 0;
  let pagesRead = 0;

  while (shouldContinue(state)) {
    state.iteration++;

    // generate new queries every batch
    const queries = await generateSearchQueries(state, focus);
    if (queries.length === 0 && state.queriesUsed.length > 0) {
      debug(`[deep-research] no new queries generated, wrapping up`);
      break;
    }

    // fall back to basic topic search if query gen fails on first try
    const searchBatch = queries.length > 0 ? queries : [topic];

    for (const query of searchBatch) {
      if (!shouldContinue(state)) break;
      if (searchesExecuted >= MAX_SEARCH_QUERIES) break;

      state.queriesUsed.push(query);
      searchesExecuted++;
      state.iteration++;

      debug(`[deep-research] searching: "${query}" (${searchesExecuted}/${MAX_SEARCH_QUERIES})`);

      const results = await executeSearch(query, userId);

      // read top results for this query
      for (const result of results.slice(0, 3)) {
        if (!shouldContinue(state)) break;
        if (pagesRead >= MAX_PAGE_READS) break;
        if (state.urlsVisited.has(result.url)) continue;
        if (state.urlsFailed.has(result.url)) continue;

        state.urlsVisited.add(result.url);
        state.iteration++;
        pagesRead++;

        debug(`[deep-research] reading: ${result.url}`);

        const content = await fetchPage(result.url, userId);
        if (!content) {
          state.urlsFailed.add(result.url);
          continue;
        }

        // assess how relevant this page is
        const { relevance, keyPoints } = await assessRelevance(topic, content);
        state.iteration++;

        if (relevance >= 0.3) {
          state.findings.push({
            query,
            url: result.url,
            title: result.title,
            content: keyPoints,
            relevance,
          });
          debug(
            `[deep-research] finding added (relevance: ${relevance.toFixed(2)}): ${result.title}`,
          );
        }
      }
    }

    // every few batches, identify gaps to guide the next round
    if (state.queriesUsed.length % 6 === 0 && state.findings.length >= 3) {
      const gaps = await identifyGaps(state);
      state.gaps = gaps;
      state.iteration++;
      debug(`[deep-research] gaps identified: ${gaps.join(", ")}`);
    }
  }

  const elapsed = Math.round((Date.now() - state.startTime) / 1000);
  debug(
    `[deep-research] research complete: ${state.findings.length} findings, ${searchesExecuted} searches, ${pagesRead} pages, ${elapsed}s`,
  );

  // synthesize final report
  return await synthesizeReport(state);
}

// tool exports
export const deepResearchTools = {
  deep_research: {
    description: `run an extended deep research session on a topic. this tool spends 2-3 minutes searching multiple queries, reading pages, and synthesizing a comprehensive summary with sources. use this when the user wants thorough research on a topic, asks you to "deep dive" or "research thoroughly", or when a topic needs multiple angles and sources to answer properly. do NOT use for simple lookups - use web_search instead.`,
    schema: DeepResearchSchema,
    handler: async (
      args: z.infer<typeof DeepResearchSchema>,
      userId: number,
    ) => {
      const topic = args.topic?.trim();
      if (!topic || topic.length < 3) {
        return "[Error] research topic is too short. provide a clear topic or question.";
      }

      try {
        return await runDeepResearch(topic, userId, args.focus);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debug(`[deep-research] fatal error: ${msg}`);
        return `[Error] deep research failed: ${msg}`;
      }
    },
  },
};
