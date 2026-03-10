import { OpenAI } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  getOpenAITools,
  getAvailableTools,
  executeTool,
  cleanupTools,
} from "../tools/registry.ts";
import { getCurrentModel, setCurrentModel } from "./model-state.ts";
import { loadBootstrapSystem } from "./bootstrap.ts";
import { addRecentContext } from "../scheduler/context-buffer.ts";
import { memoryService } from "../memory/service.ts";
import { debug } from "../utils/debug.ts";
import {
  stripReasoningTags,
  stripProviderArtifacts,
} from "../utils/reasoning.ts";
import { ContextManager } from "./context-manager";
import { conversationStore } from "./conversation-store";
import { withRetry, isRetryableError } from "../utils/retry.ts";
import { compressToolOutput } from "../utils/compress.ts";
import {
  shouldStoreMemory,
  shouldSuppressRandomRecall,
} from "../memory/gating.ts";
import { createPlan, classifyIntent, type TaskPlan } from "./planner.ts";
import { skillRegistry } from "./skills.ts";
import { learningsService } from "../memory/learnings.ts";
import {
  formatLearningsForContext,
  captureToolFailure,
} from "../tools/learnings.ts";
import {
  shouldTriggerFlush,
  markFlushPerformed,
  getMemoryFlushConfig,
  archiveConversation,
  isFlushResponse,
} from "../memory/memory-flush.ts";
import {
  recordTokenUsage,
  clearTokenUsage,
  getLastTokenUsage,
  getSmartTokenCount,
} from "./context-config";

// environment configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const SUMMARIZE_MODEL =
  process.env.SUMMARIZE_MODEL || process.env.OPENAI_MODEL || "gpt-4o";

// re-export model accessors so callers (telegram/bot.ts) don't need to know about model-state
export { getCurrentModel, setCurrentModel } from "./model-state.ts";

const INFERENCE_RPM_LIMIT = parseInt(
  process.env.INFERENCE_RPM_LIMIT || "40",
  10,
);

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 60 * 100000, // increase timeout for long-running requests
});

export function getOpenAIClient(): OpenAI {
  return openai;
}

// simple rate limiter with iterative wait loop (avoids stack growth)
class RateLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    let attempts = 0;
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter(
        (ts) => now - ts < this.windowMs,
      );

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      attempts++;
      const oldestTimestamp = this.timestamps[0]!;
      const baseWait = this.windowMs - (now - oldestTimestamp) + 10;
      // add exponential backoff/jitter based on attempts to prevent thundering herd
      const backoff = Math.min(100 * Math.pow(2, attempts - 1), 5000);
      const jitter = Math.random() * backoff;
      const waitTime = baseWait + jitter;

      debug(`[rate limit] waiting ${Math.round(waitTime)}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }
}

const rateLimiter = new RateLimiter(INFERENCE_RPM_LIMIT);

// build system prompt from bootstrap
async function getSystemPrompt(): Promise<string> {
  const now = new Date();
  const timeString = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const coreInstructions = `Current time: ${timeString}\nWorking directory: ${process.cwd()}`;
  const { prompt } = await loadBootstrapSystem(coreInstructions);
  return prompt;
}

// strip emojis from responses
function stripEmojis(text: string): string {
  return text
    .replace(
      /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]/gu,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

// combined cleanup for model responses
function cleanModelResponse(text: string): string {
  return stripEmojis(stripReasoningTags(stripProviderArtifacts(text)));
}

// ─── Universal provider tool-call text format parser ──────────────────────
//
// Several models (or local inference stacks) embed tool calls as plain text
// using model-specific special tokens rather than the OpenAI tool_calls field.
// This function detects and translates those formats into standard
// ChatCompletionMessageToolCall objects so the agent can execute them.
//
// Supported formats:
//   kimi-k2          <|tool_call_begin|>JSON<|tool_call_end|>
//   deepseek v2/v3   <｜tool▁calls▁begin｜>...<｜tool▁sep｜>name\njson...<｜tool▁calls▁end｜>
//   mistral/mixtral  [TOOL_CALLS] [{name, arguments, id}]
//   qwen2 / hermes   <tool_call>{"name","arguments"}</tool_call>
//   phi-4            <|tool_calls|>[{name, arguments}]<|/tool_calls|>
//   granite-3.x      <|tool_call|>{name, arguments}
//   internlm2        <|action_start|><|plugin|>{name, parameters}<|action_end|>
//   functionary-v3   <function=name>{arguments}</function>
//   functionary-v2   <|from|>assistant\n<|recipient|>name\n<|content|>{args}
//   glm-4.7          <tool_call>name\n<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
//   glm-4            ```python\ntool_call(name="...", arguments={...})\n```
//   command-r        Action: ```json [{tool_name, parameters}]```
//   granite-20b      <function_call> {name, arguments}
//   llama-3.1        <|python_tag|>func(arg=val)<|eom_id|>
// ──────────────────────────────────────────────────────────────────────────

interface ProviderParseResult {
  toolCalls: ChatCompletionMessageToolCall[];
  textContent: string;
}

function _argsStr(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

function _makeTC(
  name: string,
  args: unknown,
  id?: string,
  idx = 0,
): ChatCompletionMessageToolCall {
  return {
    id: id ?? `tc_${Date.now()}_${idx}`,
    type: "function",
    function: { name, arguments: _argsStr(args) },
  };
}

function _tryObj(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s.trim());
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function _stripFences(s: string): string {
  return s
    .replace(/^```(?:json|python)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

function parseProviderToolCalls(content: string): ProviderParseResult | null {
  // ── 1. Kimi K2 ───────────────────────────────────────────────────────────
  // <|tool_calls_section_begin|><|tool_call_begin|>JSON<|tool_call_end|><|tool_calls_section_end|>
  // JSON: {id?, type, function:{name,arguments}} OR flat {id?, name, arguments}
  if (content.includes("<|tool_call_begin|>")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const obj = _tryObj(m[1]!.trim());
      if (!obj) continue;
      const fn = obj.function as Record<string, unknown> | undefined;
      const name = (fn?.name ?? obj.name) as string | undefined;
      const args = fn?.arguments ?? obj.arguments;
      if (name)
        calls.push(_makeTC(name, args, obj.id as string | undefined, idx++));
    }
    if (!calls.length) return null;
    const textContent = content
      .replace(
        /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g,
        "",
      )
      .replace(/<\|[a-z_]+\|>/g, "")
      .replace(/^\s*\[[\s\S]*?'type'\s*:\s*'text'[\s\S]*?\]\s*/g, "")
      .trim();
    return { toolCalls: calls, textContent };
  }

  // ── 2. DeepSeek V2/V3/R1 ─────────────────────────────────────────────────
  // Uses fullwidth vertical bars ｜ (U+FF5C) and block underscore ▁ (U+2581).
  // Inference engines sometimes normalize these to ASCII | and _.
  // <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>name\n```json\n{}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>
  {
    const CALLS_BEGIN = /<[|｜]tool[_▁]calls[_▁]begin[|｜]>/;
    if (CALLS_BEGIN.test(content)) {
      const calls: ChatCompletionMessageToolCall[] = [];
      const blockRe =
        /<[|｜]tool[_▁]call[_▁]begin[|｜]>([\s\S]*?)<[|｜]tool[_▁]call[_▁]end[|｜]>/g;
      let m: RegExpExecArray | null;
      let idx = 0;
      while ((m = blockRe.exec(content)) !== null) {
        const block = m[1]!;
        const sepMatch = block.match(/<[|｜]tool[_▁]sep[|｜]>/);
        if (!sepMatch) continue;
        const afterSep = block.slice(
          block.search(/<[|｜]tool[_▁]sep[|｜]>/) + sepMatch[0].length,
        );
        const nlIdx = afterSep.search(/[\n`]/);
        const name = (
          nlIdx === -1 ? afterSep : afterSep.slice(0, nlIdx)
        ).trim();
        const argsRaw = nlIdx === -1 ? "{}" : afterSep.slice(nlIdx);
        const obj = _tryObj(_stripFences(argsRaw));
        if (name) calls.push(_makeTC(name, obj ?? {}, undefined, idx++));
      }
      if (!calls.length) return null;
      const textContent = content
        .replace(
          /<[|｜]tool[_▁]calls[_▁]begin[|｜]>[\s\S]*?<[|｜]tool[_▁]calls[_▁]end[|｜]>/g,
          "",
        )
        .trim();
      return { toolCalls: calls, textContent };
    }
  }

  // ── 3. Mistral / Mixtral ─────────────────────────────────────────────────
  // [TOOL_CALLS] [{"name":"...","arguments":{...},"id":"XXXXXXXXX"}]
  // id is exactly 9 alphanumeric chars per the official template
  if (content.includes("[TOOL_CALLS]")) {
    const cut = content.indexOf("[TOOL_CALLS]");
    const after = content.slice(cut + "[TOOL_CALLS]".length).trim();
    const arrMatch = after.match(/^(\[[\s\S]*?\])/);
    if (arrMatch) {
      try {
        const arr = JSON.parse(arrMatch[1]!) as Array<Record<string, unknown>>;
        const calls = arr
          .map((item, i) => {
            const name = item.name as string;
            return name
              ? _makeTC(name, item.arguments, item.id as string | undefined, i)
              : null;
          })
          .filter((c): c is ChatCompletionMessageToolCall => c !== null);
        if (calls.length) {
          return {
            toolCalls: calls,
            textContent: content.slice(0, cut).trim(),
          };
        }
      } catch {
        /* fall through */
      }
    }
  }

  // ── 4. Phi-4 ─────────────────────────────────────────────────────────────
  // <|tool_calls|>[{"name":"...","arguments":{...}}]<|/tool_calls|>
  if (content.includes("<|tool_calls|>")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /<\|tool_calls\|>([\s\S]*?)<\|\/tool_calls\|>/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      try {
        const arr = JSON.parse(m[1]!.trim());
        const items: Array<Record<string, unknown>> = Array.isArray(arr)
          ? arr
          : [arr];
        for (const item of items) {
          const name = item.name as string;
          if (name) calls.push(_makeTC(name, item.arguments, undefined, idx++));
        }
      } catch {
        /* skip malformed */
      }
    }
    if (!calls.length) return null;
    const textContent = content
      .replace(/<\|tool_calls\|>[\s\S]*?<\|\/tool_calls\|>/g, "")
      .trim();
    return { toolCalls: calls, textContent };
  }

  // ── 5. Granite 3.x ───────────────────────────────────────────────────────
  // <|tool_call|>{"name":"...","arguments":{...}}  (no trailing delimiter; ends at next token or EOF)
  // Some template versions wrap in {"tool": {"name": ..., "arguments": ...}}
  if (content.includes("<|tool_call|>")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /<\|tool_call\|>([\s\S]*?)(?=<\||$)/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const obj = _tryObj(m[1]!.trim());
      if (!obj) continue;
      const inner = (
        obj.tool && typeof obj.tool === "object" ? obj.tool : obj
      ) as Record<string, unknown>;
      const name = inner.name as string;
      if (name) calls.push(_makeTC(name, inner.arguments, undefined, idx++));
    }
    if (!calls.length) return null;
    const textContent = content
      .replace(/<\|tool_call\|>[\s\S]*?(?=<\||$)/g, "")
      .trim();
    return { toolCalls: calls, textContent };
  }

  // ── 6. InternLM2 / InternLM2.5 ──────────────────────────────────────────
  // <|action_start|><|plugin|>\n{"name":"...","parameters":{...}}\n<|action_end|>
  // Uses "parameters" instead of "arguments"
  if (content.includes("<|action_start|>")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /<\|action_start\|><\|plugin\|>\s*([\s\S]*?)<\|action_end\|>/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const obj = _tryObj(m[1]!.trim());
      const name = obj?.name as string;
      if (name)
        calls.push(
          _makeTC(name, obj?.parameters ?? obj?.arguments, undefined, idx++),
        );
    }
    if (!calls.length) return null;
    const textContent = content
      .replace(/<\|action_start\|>[\s\S]*?<\|action_end\|>/g, "")
      .trim();
    return { toolCalls: calls, textContent };
  }

  // ── 7. Functionary v3.1 ──────────────────────────────────────────────────
  // <function=name>{...}</function>
  // Function name is in the tag; body is the args object directly
  if (content.includes("<function=")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const name = m[1]!.trim();
      const obj = _tryObj(m[2]!.trim());
      if (name)
        calls.push(_makeTC(name, obj ?? m[2]!.trim(), undefined, idx++));
    }
    if (!calls.length) return null;
    const textContent = content
      .replace(/<function=[^>]+>[\s\S]*?<\/function>/g, "")
      .trim();
    return { toolCalls: calls, textContent };
  }

  // ── 8. Functionary v2 ────────────────────────────────────────────────────
  // <|from|>assistant\n<|recipient|>func_name\n<|content|>{args}\n<|from|>...
  // "all" as recipient means final text response; skip it
  if (content.includes("<|from|>") && content.includes("<|recipient|>")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re =
      /<\|recipient\|>([^\n<]+)\n<\|content\|>([\s\S]*?)(?=<\|from\|>|$)/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const name = m[1]!.trim();
      if (name === "all") continue;
      const obj = _tryObj(m[2]!.trim());
      if (name)
        calls.push(_makeTC(name, obj ?? m[2]!.trim(), undefined, idx++));
    }
    if (!calls.length) return null;
    const textContent = content.slice(0, content.indexOf("<|from|>")).trim();
    return { toolCalls: calls, textContent };
  }

  // ── 9. GLM-4.7 XML key-value format ──────────────────────────────────────
  // <tool_call>func_name\n<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>
  // Checked before Qwen/Hermes since both use <tool_call>; the presence of <arg_key> distinguishes it
  if (content.includes("<tool_call>") && content.includes("<arg_key>")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const block = m[1]!;
      const name = block.match(/^([^\n<]+)/)?.[1]?.trim();
      if (!name) continue;
      const args: Record<string, string> = {};
      const pairRe =
        /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
      let pair: RegExpExecArray | null;
      while ((pair = pairRe.exec(block)) !== null) {
        args[pair[1]!.trim()] = pair[2]!.trim();
      }
      calls.push(_makeTC(name, args, undefined, idx++));
    }
    if (!calls.length) return null;
    const textContent = content
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .trim();
    return { toolCalls: calls, textContent };
  }

  // ── 10. Qwen2/2.5 and NousHermes (identical format) ──────────────────────
  // <tool_call>{"name":"...","arguments":{...}}</tool_call>
  // Also used by vLLM's hermes parser for both model families
  if (content.includes("<tool_call>")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const obj = _tryObj(m[1]!);
      const name = obj?.name as string;
      if (name) calls.push(_makeTC(name, obj?.arguments, undefined, idx++));
    }
    if (!calls.length) return null;
    const textContent = content
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .trim();
    return { toolCalls: calls, textContent };
  }

  // ── 11. Cohere Command-R / Command-R+ ────────────────────────────────────
  // Action: ```json\n[{"tool_name":"...","parameters":{...}}]\n```
  // Uses "tool_name" and "parameters" instead of "name" and "arguments"
  // "directly_answer" is a pseudo-tool signaling no external call needed
  if (/^Action:\s*```/m.test(content) && content.includes('"tool_name"')) {
    const blockMatch = content.match(
      /^Action:\s*```(?:json)?\s*([\s\S]*?)```/m,
    );
    if (blockMatch) {
      try {
        const arr = JSON.parse(blockMatch[1]!.trim());
        const items: Array<Record<string, unknown>> = Array.isArray(arr)
          ? arr
          : [arr];
        const calls = items
          .map((item, i) => {
            const name = item.tool_name as string;
            return name && name !== "directly_answer"
              ? _makeTC(name, item.parameters, undefined, i)
              : null;
          })
          .filter((c): c is ChatCompletionMessageToolCall => c !== null);
        if (calls.length) {
          const textContent = content.replace(blockMatch[0], "").trim();
          return { toolCalls: calls, textContent };
        }
      } catch {
        /* fall through */
      }
    }
  }

  // ── 12. GLM-4 / ChatGLM Python-style ──────────────────────────────────────
  // ```python\ntool_call(name="...", arguments={...})\n```
  // Python dict literals need True/False/None → true/false/null conversion
  if (/```python[\s\S]*?tool_call\s*\(/.test(content)) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /```python\s*([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const block = m[1]!;
      if (!block.includes("tool_call(")) continue;
      const name = block.match(/name\s*=\s*["']([^"']+)["']/)?.[1];
      if (!name) continue;
      const argsMatch = block.match(/arguments\s*=\s*(\{[\s\S]*?\})\s*\)/);
      let args: unknown = {};
      if (argsMatch) {
        const jsonStr = argsMatch[1]!
          .replace(/'/g, '"')
          .replace(/\bTrue\b/g, "true")
          .replace(/\bFalse\b/g, "false")
          .replace(/\bNone\b/g, "null");
        args = _tryObj(jsonStr) ?? jsonStr;
      }
      calls.push(_makeTC(name, args, undefined, idx++));
    }
    if (!calls.length) return null;
    const textContent = content.replace(/```python[\s\S]*?```/g, "").trim();
    return { toolCalls: calls, textContent };
  }

  // ── 13. Granite 20B ──────────────────────────────────────────────────────
  // <function_call> {"name":"...","arguments":{...}}
  if (content.includes("<function_call>")) {
    const calls: ChatCompletionMessageToolCall[] = [];
    const re = /<function_call>\s*([\s\S]*?)(?=<function_call>|$)/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      const obj = _tryObj(m[1]!.trim());
      const name = obj?.name as string;
      if (name) calls.push(_makeTC(name, obj?.arguments, undefined, idx++));
    }
    if (!calls.length) return null;
    const textContent = content.replace(/<function_call>[\s\S]*/g, "").trim();
    return { toolCalls: calls, textContent };
  }

  // ── 14. Llama 3.1 / 3.2 pythonic ─────────────────────────────────────────
  // Built-in tools: <|python_tag|>brave_search.call(query="...") <|eom_id|>
  // Custom list:    <|python_tag|>[get_weather(location="Paris")] <|eom_id|>
  // Only handles simple key="value" / key=number kwargs; complex args are skipped
  if (content.includes("<|python_tag|>")) {
    const tagIdx = content.indexOf("<|python_tag|>");
    const after = content
      .slice(tagIdx + "<|python_tag|>".length)
      .replace(/<\|eom_id\|>[\s\S]*$/, "")
      .trim();
    const calls: ChatCompletionMessageToolCall[] = [];
    // unwrap optional [...] list wrapper, then split on top-level commas before func(
    const inner = after.match(/^\[([\s\S]+)\]$/) ? after.slice(1, -1) : after;
    const targets = inner.split(/,\s*(?=[a-zA-Z_]\w*\s*\()/);
    for (let i = 0; i < targets.length; i++) {
      const fnMatch = targets[i]!.trim().match(
        /^([a-zA-Z_][\w.]*)\s*\(([\s\S]*)\)$/,
      );
      if (!fnMatch) continue;
      const name = fnMatch[1]!.replace(/\.call$/, "");
      const args: Record<string, string | number> = {};
      const kvRe = /([a-zA-Z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\d.]+))/g;
      let kv: RegExpExecArray | null;
      while ((kv = kvRe.exec(fnMatch[2]!)) !== null) {
        args[kv[1]!] =
          kv[4] !== undefined ? Number(kv[4]) : (kv[2] ?? kv[3] ?? "");
      }
      calls.push(_makeTC(name, args, undefined, i));
    }
    if (!calls.length) return null;
    const textContent = content.slice(0, tagIdx).trim();
    return { toolCalls: calls, textContent };
  }

  return null;
}

// step tracking for dynamic status updates
interface AgentStep {
  tool: string;
  summary: string;
  timestamp: number;
}

class StepTracker {
  private steps: AgentStep[] = [];

  addStep(tool: string, args: string, result: string): void {
    const summary = this.summarizeStep(tool, args, result);
    this.steps.push({ tool, summary, timestamp: Date.now() });
  }

  private summarizeStep(tool: string, args: string, result: string): string {
    // extract key info from tool execution for human-readable summary
    try {
      const parsed = JSON.parse(args);

      switch (tool) {
        case "browser_navigate":
        case "browser_go_to_url":
          return `visited ${parsed.url || "a webpage"}`;
        case "browser_snapshot":
          return `scanned page structure`;
        case "browser_act":
          return `${parsed.action || "interacted with"} element [${parsed.ref || "?"}]`;
        case "browser_tabs":
          return `${parsed.action || "managed"} browser tabs`;
        case "browser_wait":
          return `waited for ${parsed.condition || "page"} to be ready`;
        case "browser_search":
        case "web_search":
          return `searched for "${parsed.query || "something"}"`;
        case "web_fetch":
          return `fetched ${parsed.url || "a page"}`;
        case "read_file":
          return `read ${this.extractFilename(parsed.path || parsed.file_path || "")}`;
        case "write_file":
        case "create_file":
          return `wrote to ${this.extractFilename(parsed.path || parsed.file_path || "")}`;
        case "bash":
        case "execute_command":
          return `ran command: ${(parsed.command || "").slice(0, 50)}`;
        case "search_files":
        case "grep":
          return `searched files for "${parsed.pattern || parsed.query || ""}"`;
        case "list_directory":
        case "list_dir":
          return `listed ${this.extractFilename(parsed.path || "") || "directory"}`;
        case "save_memory":
          return `saved a memory`;
        case "recall_memory":
        case "search_memory":
          return `searched memories`;
        case "save_learning":
          return `recorded a learning`;
        case "search_learnings":
          return `checked past learnings`;
        case "deep_research":
          return `running deep research on "${parsed.topic || "a topic"}"`;
        default:
          return `used ${tool.replace(/_/g, " ")}`;
      }
    } catch {
      return `used ${tool.replace(/_/g, " ")}`;
    }
  }

  private extractFilename(path: string): string {
    if (!path) return "";
    const parts = path.split(/[\/\\]/);
    return parts[parts.length - 1] || path;
  }

  generateStatus(): string {
    if (this.steps.length === 0) {
      return "thinking...";
    }

    // get recent steps (last 10 seconds worth, or last 5 steps max)
    const tenSecondsAgo = Date.now() - 10000;
    const recentSteps = this.steps
      .filter((s) => s.timestamp > tenSecondsAgo)
      .slice(-5);

    if (recentSteps.length === 0) {
      // no recent activity, summarize last step
      const lastStep = this.steps[this.steps.length - 1];
      return lastStep ? `last action: ${lastStep.summary}` : "working on it...";
    }

    if (recentSteps.length === 1) {
      return recentSteps[0]!.summary;
    }

    // combine recent steps into a summary
    const uniqueActions = [...new Set(recentSteps.map((s) => s.summary))];
    if (uniqueActions.length === 1) {
      return uniqueActions[0]!;
    }

    // group by type and summarize
    if (uniqueActions.length <= 3) {
      return uniqueActions.join(", then ");
    }

    return `${uniqueActions.slice(0, 2).join(", ")} and ${uniqueActions.length - 2} more steps`;
  }

  getStepCount(): number {
    return this.steps.length;
  }

  clear(): void {
    this.steps = [];
  }
}

const MAX_TOOL_ITERATIONS = 50;
const ITERATION_WARNING_THRESHOLD = 40; // warn when this many iterations used
const ITERATION_EXTENSION_AMOUNT = 25; // how many extra iterations to grant
const MAX_EXTENSIONS = 3; // max times agent can extend
const MAX_REPEAT_ASSISTANT_MESSAGES = 2;
const MAX_REPEAT_TOOL_SIGNATURES = 2;

// scary system message to inject when nearing iteration limit
const ITERATION_WARNING_MESSAGE = `
=======================================================================
                    CRITICAL: ITERATION LIMIT WARNING
=======================================================================

YOU ARE RUNNING OUT OF TOOL ITERATIONS.

Iterations used: {{USED}} / {{MAX}}
Remaining: {{REMAINING}}

IF YOU NEED MORE TIME TO COMPLETE THIS TASK, YOU MUST CALL THE
"request_more_iterations" TOOL IMMEDIATELY.

IF YOU DO NOT CALL THIS TOOL AND RUN OUT OF ITERATIONS:
- Your work will be TERMINATED
- The user will receive an INCOMPLETE response
- Any progress will be LOST

ONLY request more iterations if you genuinely need them to complete
the task. Do not request them just to be safe.

=======================================================================
`;

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const sorted: Record<string, unknown> = {};

    for (const [key, val] of entries) {
      sorted[key] = sortObjectKeys(val);
    }

    return sorted;
  }

  return value;
}

function normalizeToolArgs(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(sortObjectKeys(parsed));
  } catch {
    return trimmed;
  }
}

function buildToolSignature(
  toolCalls: ChatCompletionMessageToolCall[],
): string {
  return toolCalls
    .map((toolCall) => {
      if (toolCall.type === "function" && "function" in toolCall) {
        const name = toolCall.function?.name ?? "unknown";
        const args = toolCall.function?.arguments ?? "";
        return `${name}:${normalizeToolArgs(args)}`;
      }

      if (toolCall.type === "custom" && "custom" in toolCall) {
        const name = toolCall.custom?.name ?? "custom";
        const input = toolCall.custom?.input ?? "";
        return `${name}:${normalizeToolArgs(input)}`;
      }

      return "unknown:";
    })
    .join("|");
}

export interface AgentCallbacks {
  onPlanReady?: (intent: string) => Promise<void>;
  onTyping?: () => Promise<void>;
  abortSignal?: AbortSignal;
}

// error thrown when agent loop is interrupted by a new user message
export class AgentInterruptedError extends Error {
  constructor() {
    super("agent interrupted by user");
    this.name = "AgentInterruptedError";
  }
}

export class Agent {
  private _messages: ChatCompletionMessageParam[];
  private userId: number;
  private initialized: boolean = false;
  private contextManager: ContextManager;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  get messages(): ChatCompletionMessageParam[] {
    return this._messages;
  }

  constructor(userId: number = 0) {
    this.userId = userId;
    this._messages = [];
    this.contextManager = new ContextManager();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const systemPrompt = await getSystemPrompt();
    const stored = await conversationStore().load(this.userId);

    if (stored && stored.messages.length > 0) {
      debug(`[agent] restored ${stored.messages.length} messages`);
      const firstIsSystem = stored.messages[0]?.role === "system";
      this._messages = firstIsSystem
        ? [
            { role: "system", content: systemPrompt },
            ...stored.messages.slice(1),
          ]
        : [{ role: "system", content: systemPrompt }, ...stored.messages];

      if (stored.summary) {
        this.contextManager = new ContextManager(stored.summary);
      }
    } else {
      this._messages = [{ role: "system", content: systemPrompt }];
    }

    this.initialized = true;
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      this.saveConversation().catch((err) =>
        debug(`[agent] save failed:`, err),
      );
    }, 1000);
  }

  async saveConversation(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    await conversationStore().save(
      this.userId,
      this._messages,
      this.contextManager.summary,
    );
  }

  // enhanced agentic loop with planning, retry, and compression
  async chat(
    userMessage: string,
    callbacks?: AgentCallbacks,
    replyContext?: string,
  ): Promise<string> {
    await this.initialize();

    // helper to check if we should abort
    const checkAbort = () => {
      if (callbacks?.abortSignal?.aborted) {
        debug(`[agent] interrupted by user`);
        throw new AgentInterruptedError();
      }
    };

    // pre-compaction memory flush
    // triggered when approaching context limit to preserve important information
    const flushConfig = getMemoryFlushConfig();
    if (
      flushConfig.enabled &&
      shouldTriggerFlush(this.userId, this._messages, flushConfig)
    ) {
      debug(`[agent] triggering pre-compaction memory flush`);

      // archive the current conversation before compaction
      await archiveConversation(this.userId, this._messages);
      markFlushPerformed(this.userId);
    }

    // context management
    const { summarized, messagesToDrop } =
      await this.contextManager.maybeSummarize(this._messages);
    if (summarized && messagesToDrop > 0) {
      this._messages = this.contextManager.pruneMessages(
        this._messages,
        messagesToDrop,
      );
      debug(`[agent] context pruned`);
    }

    // selective memory integration with gating
    const suppressRandomRecall = shouldSuppressRandomRecall(userMessage);
    let memoryContext = "";
    if (!suppressRandomRecall) {
      memoryContext = await memoryService.buildMemoryContext(
        this.userId,
        userMessage,
      );
    }

    // learning machine: retrieve relevant learnings for context
    let learningContext = "";
    const relevantLearnings = await learningsService.searchLearnings(
      this.userId,
      userMessage,
      3,
    );
    if (relevantLearnings.length > 0) {
      learningContext = formatLearningsForContext(relevantLearnings);
      debug(
        `[agent] injected ${relevantLearnings.length} learnings into context`,
      );
    }

    // gated memory storage - only store durable facts
    const gatingResult = shouldStoreMemory({
      content: userMessage,
      role: "user",
      hasToolContext: false,
    });
    if (gatingResult.shouldStore) {
      await memoryService.storeMemory(
        this.userId,
        gatingResult.cleanedContent || userMessage,
      );
    }

    // build the user message with optional reply context
    let messageContent = userMessage;
    if (replyContext) {
      messageContent = `[replying to your previous message: "${replyContext}"]\n\n${userMessage}`;
      debug(`[agent] reply context attached`);
    }

    this._messages.push({ role: "user", content: messageContent });
    this.scheduleSave();

    // optional planning for complex tasks
    const intent = classifyIntent(userMessage);
    let taskPlan: TaskPlan | null = null;

    if (intent === "task" || intent === "command") {
      // build recent context for planning
      const recentContext = this._messages
        .slice(-6)
        .filter((m) => m.role !== "system")
        .map((m) => `${m.role}: ${String(m.content).slice(0, 200)}`)
        .join("\n");

      taskPlan = await createPlan(
        userMessage,
        recentContext,
        getAvailableTools(),
      );

      // if planner says clarification needed, ask before proceeding
      if (taskPlan?.needs_clarification && taskPlan.clarifying_question) {
        this._messages.push({
          role: "assistant",
          content: taskPlan.clarifying_question,
        });
        this.scheduleSave();
        return taskPlan.clarifying_question;
      }
    }

    // auto-inject coding agent skill when planner detects a coding project
    if (taskPlan?.work_mode === "coding_project") {
      const codingSkill = await skillRegistry.loadSkillContent("coding-agent");
      if (codingSkill) {
        this._messages.push({
          role: "system",
          content: codingSkill,
        });
        debug(`[agent] coding agent skill auto-injected`);
      }
    }

    const tools = getOpenAITools();
    let lastTextResponse = "";
    let toolIterationCount = 0;
    let lastAssistantText = "";
    let repeatAssistantCount = 0;
    let lastToolSignature = "";
    let repeatToolCount = 0;
    let loopGuardMessage: string | null = null;
    const toolResults: string[] = []; // track for verification
    let hadToolError = false;
    let actionNudgeSent = false; // ensure we only nudge once per conversation turn
    const stepTracker = new StepTracker();

    // iteration extension tracking
    let currentMaxIterations = MAX_TOOL_ITERATIONS;
    let extensionCount = 0;
    let warningInjected = false;

    // send plan intent once if planner produced one
    if (callbacks?.onPlanReady && taskPlan?.intent) {
      await callbacks.onPlanReady(taskPlan.intent);
    }

    // agentic loop: keep calling api until no more tool calls
    while (true) {
      // check for interrupt at start of each iteration
      checkAbort();

      if (callbacks?.onTyping) await callbacks.onTyping();

      // build messages with context window management
      // combine memory and learning contexts
      const combinedContext =
        [memoryContext, learningContext].filter(Boolean).join("\n\n") ||
        undefined;
      const messagesForModel = this.contextManager.buildMessagesForModel(
        this._messages,
        combinedContext,
      );

      await rateLimiter.acquire();

      // validate and fix messages before sending to api
      const validMessages = messagesForModel
        .map((msg) => {
          // fix assistant messages with missing content
          if (msg.role === "assistant") {
            const hasToolCalls =
              (msg as any).tool_calls && (msg as any).tool_calls.length > 0;
            const hasContent =
              msg.content &&
              (typeof msg.content === "string" ? msg.content.trim() : true);

            // assistant must have content or tool_calls
            if (!hasContent && !hasToolCalls) {
              return null; // drop invalid message
            }

            // if has tool_calls but no content, set empty string
            if (hasToolCalls && !msg.content) {
              return { ...msg, content: "" };
            }
          }

          // ensure tool messages have content
          if (msg.role === "tool" && msg.content === undefined) {
            return null;
          }

          return msg;
        })
        .filter((msg): msg is ChatCompletionMessageParam => msg !== null);

      if (validMessages.length === 0) {
        debug("[api] no valid messages to send");
        break;
      }

      let response;
      try {
        // api call with automatic retry for transient errors
        response = await withRetry(
          () =>
            openai.chat.completions.create({
              model: getCurrentModel(),
              messages: validMessages,
              tools: tools.length > 0 ? tools : undefined,
              tool_choice: tools.length > 0 ? "auto" : undefined,
            }),
          { maxRetries: 10, baseDelayMs: 1000, maxDelayMs: 60000 },
        );
      } catch (apiError) {
        // extract detailed error info from openai sdk
        let errorDetails = "unknown error";
        if (apiError instanceof Error) {
          errorDetails = apiError.message;

          // openai sdk errors have additional properties
          const anyError = apiError as any;
          if (anyError.status) {
            errorDetails = `${anyError.status} status code`;
          }
          if (anyError.error) {
            // detailed error from api response body
            const errorBody =
              typeof anyError.error === "string"
                ? anyError.error
                : JSON.stringify(anyError.error);
            errorDetails += ` - ${errorBody}`;
          }
        }

        debug(`[api error after 10 retries: ${errorDetails}]`);
        return (
          lastTextResponse ||
          "the inference endpoint is not responding after multiple retries. this could be a provider outage or network issue - give it a few minutes and try again."
        );
      }

      // check for interrupt after api call completes
      checkAbort();

      // capture actual token usage from api response
      if (response.usage) {
        recordTokenUsage(this.userId, response.usage, validMessages.length);
      }

      const choice = response.choices[0];
      if (!choice) {
        debug("[no choice in response]");
        break;
      }

      const message = choice.message;
      let content = message.content || "";
      let toolCalls = message.tool_calls || [];

      // some providers embed tool calls as plain text rather than the structured
      // tool_calls field — detect and translate into standard format
      if (toolCalls.length === 0) {
        const parsed = parseProviderToolCalls(content);
        if (parsed && parsed.toolCalls.length > 0) {
          toolCalls = parsed.toolCalls;
          content = parsed.textContent;
          debug(
            `[tool-parser] parsed ${toolCalls.length} text-embedded tool call(s)`,
          );
        }
      }

      // collect text response - only update if cleaned result is non-empty
      // models that respond with only reasoning tags (e.g. <think>...</think>) will
      // produce an empty string after stripping, so we avoid overwriting a valid
      // previous response with nothing
      if (content.trim()) {
        const cleaned = cleanModelResponse(content);
        if (cleaned) {
          lastTextResponse = cleaned;
        }
        debug(`[text]: ${(cleaned || lastTextResponse).slice(0, 100)}...`);
      }

      // add assistant message to history (strip reasoning tags to reduce context bloat)
      const cleanedContent = stripReasoningTags(content);
      this._messages.push({
        role: "assistant",
        content: cleanedContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      // no tools = done, but nudge the model once if it talked instead of acting on a task
      if (toolCalls.length === 0) {
        const isTask = taskPlan !== null;
        const nothingDoneYet = toolResults.length === 0;
        if (isTask && nothingDoneYet && !actionNudgeSent) {
          actionNudgeSent = true;
          this._messages.push({
            role: "user",
            content:
              "stop planning in text. start executing right now using your tools. do not explain what you're going to do - just do it.",
          });
          debug(
            "[agent] model returned text-only on first task turn - nudging to use tools",
          );
          continue;
        }
        break;
      }

      toolIterationCount += 1;

      const normalizedContent = cleanModelResponse(content).toLowerCase();
      if (normalizedContent) {
        if (normalizedContent === lastAssistantText) {
          repeatAssistantCount += 1;
        } else {
          lastAssistantText = normalizedContent;
          repeatAssistantCount = 0;
        }
      }

      const toolSignature = buildToolSignature(toolCalls);
      if (toolSignature) {
        if (toolSignature === lastToolSignature) {
          repeatToolCount += 1;
        } else {
          lastToolSignature = toolSignature;
          repeatToolCount = 0;
        }
      }

      // check if agent requested more iterations
      const extensionRequest = toolCalls.find(
        (tc) =>
          tc.type === "function" &&
          tc.function?.name === "request_more_iterations",
      );

      if (extensionRequest) {
        if (extensionCount < MAX_EXTENSIONS) {
          extensionCount += 1;
          currentMaxIterations += ITERATION_EXTENSION_AMOUNT;
          warningInjected = false; // reset warning flag for next threshold
          debug(
            `[agent] iteration extension granted (${extensionCount}/${MAX_EXTENSIONS}), new max: ${currentMaxIterations}`,
          );

          // respond to the tool call
          this._messages.push({
            role: "tool",
            content: `granted ${ITERATION_EXTENSION_AMOUNT} additional iterations. new limit: ${currentMaxIterations}. extensions remaining: ${MAX_EXTENSIONS - extensionCount}`,
            tool_call_id: extensionRequest.id,
          });

          // skip this tool call in the execution loop below
        } else {
          debug(`[agent] iteration extension denied - max extensions reached`);
          this._messages.push({
            role: "tool",
            content: `denied. you have already used all ${MAX_EXTENSIONS} extensions. wrap up your work now.`,
            tool_call_id: extensionRequest.id,
          });
        }
      }

      // inject warning when approaching limit (only once per threshold)
      const iterationsRemaining = currentMaxIterations - toolIterationCount;
      const shouldWarn =
        !warningInjected &&
        toolIterationCount >= ITERATION_WARNING_THRESHOLD &&
        iterationsRemaining <= 10;

      if (shouldWarn) {
        warningInjected = true;
        const warningContent = ITERATION_WARNING_MESSAGE.replace(
          "{{USED}}",
          String(toolIterationCount),
        )
          .replace("{{MAX}}", String(currentMaxIterations))
          .replace("{{REMAINING}}", String(iterationsRemaining));

        this._messages.push({
          role: "system",
          content: warningContent,
        });
        debug(
          `[agent] iteration warning injected at ${toolIterationCount}/${currentMaxIterations}`,
        );
      }

      let loopReason: string | null = null;
      if (toolIterationCount > currentMaxIterations) {
        loopReason = "too many tool iterations";
      } else if (repeatAssistantCount >= MAX_REPEAT_ASSISTANT_MESSAGES) {
        loopReason = "repeating assistant response";
      } else if (repeatToolCount >= MAX_REPEAT_TOOL_SIGNATURES) {
        loopReason = "repeating tool calls";
      }

      if (loopReason) {
        loopGuardMessage =
          "i got stuck in a tool loop and stopped to avoid repeating myself. please try again.";
        lastTextResponse = loopGuardMessage;
        debug(`[tool loop guard] ${loopReason}`);

        for (const toolCall of toolCalls) {
          this._messages.push({
            role: "tool",
            content: `error: tool call stopped to avoid loop (${loopReason})`,
            tool_call_id: toolCall.id,
          });
        }

        break;
      }

      // execute tools and collect results
      for (const toolCall of toolCalls) {
        // skip iteration extension tool - already handled above
        if (
          toolCall.type === "function" &&
          toolCall.function?.name === "request_more_iterations"
        ) {
          continue;
        }

        // check for interrupt before each tool execution
        checkAbort();

        if (callbacks?.onTyping) await callbacks.onTyping();

        // handle both standard function type and custom/alternative formats
        let name: string;
        let args: string;

        if (toolCall.type === "function" && toolCall.function) {
          name = toolCall.function.name;
          args = toolCall.function.arguments ?? "";
        } else {
          // fallback for non-standard tool call formats (some providers use different structures)
          const anyCall = toolCall as unknown as Record<string, unknown>;
          const fn = anyCall.function as
            | { name?: string; arguments?: string }
            | undefined;
          const custom = anyCall.custom as
            | { name?: string; input?: string }
            | undefined;

          name = fn?.name ?? custom?.name ?? String(anyCall.name ?? "unknown");
          args =
            fn?.arguments ??
            custom?.input ??
            String(anyCall.arguments ?? anyCall.input ?? "{}");
        }

        debug(`[tool: ${name}]`);
        debug(`[args raw]: ${args.slice(0, 500)}`);

        let result: string;
        try {
          result = await executeTool(name, args, this.userId, content);
          debug(`[result]: ${result.slice(0, 200)}...`);

          // track step for status summarization
          stepTracker.addStep(name, args, result);
        } catch (error) {
          // capture tool failure for learning machine
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result = `[Error] ${errorMessage}`;
          debug(`[tool error]: ${errorMessage}`);
          hadToolError = true;

          // track failed step too
          stepTracker.addStep(name, args, result);

          // auto-capture the failure (fire and forget)
          captureToolFailure(
            this.userId,
            name,
            errorMessage,
            args.slice(0, 200),
          ).catch(() => {});
        }

        // track results for potential verification
        toolResults.push(result.slice(0, 500));

        // flag any error result so we can nudge the ai to self-correct after the loop
        if (result.startsWith("error:") || result.startsWith("[Error]")) {
          hadToolError = true;
        }

        // compress large tool outputs before storing in context
        const compressedResult = compressToolOutput(result, name);
        this._messages.push({
          role: "tool",
          content: compressedResult,
          tool_call_id: toolCall.id,
        });
      }

      // immediately surface errors back to the ai so it fixes them in the next turn
      if (hadToolError) {
        hadToolError = false;
        this._messages.push({
          role: "user",
          content:
            "one or more tool calls returned errors. review each error message above, fix your arguments, and retry the failed calls now.",
        });
        debug("[agent] tool error detected - injecting fix prompt");
      }
    }

    if (loopGuardMessage) {
      this._messages.push({ role: "assistant", content: loopGuardMessage });
    }

    // log plan outcome for future reference
    if (taskPlan) {
      debug(
        `[planner] completed: ${taskPlan.intent} (${toolResults.length} tool results)`,
      );
    }

    // log for self-review
    addRecentContext(`user: ${userMessage}\n\nassistant: ${lastTextResponse}`);
    this.scheduleSave();

    return (
      lastTextResponse || "i couldn't complete that request. please try again."
    );
  }

  getMemory(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  getContextStats(): {
    messageCount: number;
    estimatedTokens: number;
    hasSummary: boolean;
    summaryLength: number;
    actualUsage: import("./context-config").TokenUsage | null;
    smartTokenCount: {
      tokens: number;
      source: "actual" | "actual+delta" | "tiktoken";
    };
  } {
    const base = this.contextManager.getStats(this._messages);
    return {
      ...base,
      actualUsage: getLastTokenUsage(this.userId),
      smartTokenCount: getSmartTokenCount(this.userId, this._messages),
    };
  }

  clearMemory(): void {
    const systemMessage = this._messages[0];
    this._messages = systemMessage ? [systemMessage] : [];
    this.contextManager = new ContextManager();
    clearTokenUsage(this.userId);
  }

  async clearMemoryAndPersist(): Promise<void> {
    this.clearMemory();
    await conversationStore().clear(this.userId);
  }

  async cleanup(): Promise<void> {
    await this.saveConversation();
    await cleanupTools();
  }
}
