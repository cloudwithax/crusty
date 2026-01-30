import { OpenAI } from "openai";
import { getDatabase, getAsyncDatabase } from "../data/db.ts";
import { debug } from "../utils/debug.ts";

// environment configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const LOOKBACK_DAYS = 7;

// valid tags for self-review entries
type ReviewTag = "confidence" | "uncertainty" | "speed" | "depth";

// parsed entry from self-review
interface ReviewEntry {
  id: number;
  date: string;
  tag: ReviewTag;
  miss: string;
  fix: string;
}

// watchlist entry with recency weight
interface WatchlistEntry extends ReviewEntry {
  weight: number;
}

// module state
let watchlist: WatchlistEntry[] = [];
let isInitialized = false;

// openai client for self-check introspection
let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY required for self-review");
    }
    openai = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: OPENAI_BASE_URL,
      timeout: 15 * 1000,
    });
  }
  return openai;
}

// calculate recency weight (1.0 for today, decaying over time)
function calculateWeight(dateStr: string): number {
  const entryDate = new Date(dateStr);
  const now = new Date();
  const daysDiff = Math.floor((now.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));

  if (daysDiff < 0 || daysDiff > LOOKBACK_DAYS) {
    return 0;
  }

  return 1 - daysDiff / LOOKBACK_DAYS;
}

// load entries from database and build watchlist
async function loadEntriesFromDb(): Promise<ReviewEntry[]> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - LOOKBACK_DAYS);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    const rows = await asyncDb.all<{ id: number; date: string; tag: string; miss: string; fix: string }>(
      "SELECT id, date, tag, miss, fix FROM self_review WHERE date >= $1 ORDER BY date DESC",
      cutoffStr!
    );

    return rows.map((row) => ({
      id: row.id,
      date: row.date,
      tag: row.tag as ReviewTag,
      miss: row.miss,
      fix: row.fix,
    }));
  }

  const db = getDatabase();
  const rows = db
    .query<{ id: number; date: string; tag: string; miss: string; fix: string }>(
      "SELECT id, date, tag, miss, fix FROM self_review WHERE date >= ? ORDER BY date DESC"
    )
    .all(cutoffStr!);

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    tag: row.tag as ReviewTag,
    miss: row.miss,
    fix: row.fix,
  }));
}

// build watchlist from entries
function buildWatchlist(entries: ReviewEntry[]): WatchlistEntry[] {
  return entries
    .map((entry) => ({
      ...entry,
      weight: calculateWeight(entry.date),
    }))
    .filter((e) => e.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

// initialize self-review system
export async function initSelfReview(): Promise<void> {
  if (isInitialized) {
    return;
  }

  debug("[self-review] initializing...");

  try {
    const entries = await loadEntriesFromDb();
    watchlist = buildWatchlist(entries);
    debug(`[self-review] loaded ${watchlist.length} entries from last ${LOOKBACK_DAYS} days`);

    if (watchlist.length > 0) {
      debug("[self-review] top patterns to watch:");
      for (const entry of watchlist.slice(0, 3)) {
        debug(`  - [${entry.tag}] ${entry.miss.substring(0, 50)}...`);
      }
    }
  } catch (error) {
    console.error("[self-review] failed to load entries:", error);
    watchlist = [];
  }

  isInitialized = true;
}

// get the current watchlist
export function getWatchlist(): WatchlistEntry[] {
  return watchlist;
}

// check if a task context overlaps with any MISS patterns
export async function checkForOverlaps(taskContext: string): Promise<WatchlistEntry[]> {
  if (!isInitialized || watchlist.length === 0) {
    return [];
  }

  const contextLower = taskContext.toLowerCase();
  const matches: WatchlistEntry[] = [];

  for (const entry of watchlist) {
    const missLower = entry.miss.toLowerCase();

    const missWords = missLower.split(/\s+/).filter((w) => w.length > 3);
    const contextWords = contextLower.split(/\s+/).filter((w) => w.length > 3);

    const overlap = missWords.some((word) => contextWords.includes(word));
    const tagOverlap = contextLower.includes(entry.tag);

    if (overlap || tagOverlap) {
      matches.push(entry);
    }
  }

  return matches.sort((a, b) => b.weight - a.weight);
}

// generate counter-check prompt for overlapping patterns
export function generateCounterCheckPrompt(matches: WatchlistEntry[]): string {
  if (matches.length === 0) {
    return "";
  }

  const patterns = matches
    .slice(0, 3)
    .map((m) => `- [${m.tag}] MISS: ${m.miss} → FIX: ${m.fix}`)
    .join("\n");

  return `[SELF-REVIEW COUNTER-CHECK]
before responding, pause and consider these recent failure patterns:

${patterns}

explicitly consider the opposite of your first instinct. if any of these patterns apply to the current task, adjust accordingly.`;
}

// append a new entry to the database
export async function logReviewEntry(tag: ReviewTag, miss: string, fix: string): Promise<void> {
  const date = new Date().toISOString().split("T")[0];

  try {
    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      await asyncDb.run("INSERT INTO self_review (date, tag, miss, fix) VALUES ($1, $2, $3, $4)", [
        date!,
        tag,
        miss,
        fix,
      ]);
    } else {
      const db = getDatabase();
      db.run("INSERT INTO self_review (date, tag, miss, fix) VALUES (?, ?, ?, ?)", [date!, tag, miss, fix]);
    }

    debug(`[self-review] logged entry: [${tag}] ${miss.substring(0, 40)}...`);

    // refresh watchlist
    const entries = await loadEntriesFromDb();
    watchlist = buildWatchlist(entries);
  } catch (error) {
    console.error("[self-review] failed to log entry:", error);
  }
}

// run the self-check introspection using the model
export async function runSelfCheck(recentContext: string): Promise<{
  detected: boolean;
  tag?: ReviewTag;
  miss?: string;
  fix?: string;
}> {
  const client = getOpenAI();

  const systemPrompt = `you are an introspection module that analyzes recent behavior for failure patterns.

given the recent context below, answer these three questions:
1. what sounded right but went nowhere?
2. where was there a default to consensus instead of actual thinking?
3. what assumption was not pressure tested?

if you detect a pattern worth logging, respond with:
DETECTED: yes
TAG: [confidence|uncertainty|speed|depth]
MISS: [brief description of what went wrong]
FIX: [concrete adjustment for next time]

if no pattern detected, respond with:
DETECTED: no

be specific and actionable. dont log trivial issues.`;

  try {
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `recent context:\n\n${recentContext}` },
      ],
      temperature: 0.4,
    });

    const output = response.choices[0]?.message?.content?.trim() || "";

    if (output.toLowerCase().includes("detected: no")) {
      return { detected: false };
    }

    const tagMatch = output.match(/TAG:\s*(confidence|uncertainty|speed|depth)/i);
    const missMatch = output.match(/MISS:\s*(.+?)(?:\n|$)/i);
    const fixMatch = output.match(/FIX:\s*(.+?)(?:\n|$)/i);

    if (tagMatch && missMatch) {
      return {
        detected: true,
        tag: tagMatch[1]!.toLowerCase() as ReviewTag,
        miss: missMatch[1]!.trim(),
        fix: fixMatch?.[1]?.trim() || "review and adjust approach",
      };
    }

    return { detected: false };
  } catch (error) {
    console.error("[self-review] self-check failed:", error);
    return { detected: false };
  }
}

// full self-review cycle
export async function selfReviewCycle(recentContext: string): Promise<void> {
  debug("[self-review] running self-check cycle...");

  const result = await runSelfCheck(recentContext);

  if (result.detected && result.tag && result.miss && result.fix) {
    await logReviewEntry(result.tag, result.miss, result.fix);
    debug(`[self-review] pattern detected and logged: [${result.tag}]`);
  } else {
    debug("[self-review] no patterns detected this cycle");
  }
}

// cleanup function
export function cleanupSelfReview(): void {
  watchlist = [];
  isInitialized = false;
  debug("[self-review] cleaned up");
}
