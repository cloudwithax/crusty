// tool call parser
// handles parsing of tool calls from various llm response formats
// designed to work with actual model outputs, not against them

import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

// debug mode - set via environment variable
const DEBUG =
  process.env.DEBUG_TOOL_PARSER === "true" || process.env.DEBUG === "true";

// debug logger
function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[tool-parser]", ...args);
  }
}

// raw response logger - helps understand actual model behavior
export function logRawResponse(content: string, model: string): void {
  if (!DEBUG) return;

  const separator = "=".repeat(80);
  console.log("\n" + separator);
  console.log(`[TOOL-PARSER] RAW RESPONSE (model: ${model})`);
  console.log("-".repeat(80));
  console.log(content);
  console.log(separator + "\n");
}

// parsed result type
export interface ParsedToolCalls {
  toolCalls: ChatCompletionMessageToolCall[];
  textContent: string;
  format: string;
}

// format detection result
interface FormatDetection {
  format: string;
  pattern?: RegExp;
  confidence: number;
}

// helper to create a tool call object
function makeToolCall(
  name: string,
  args: unknown,
  id?: string,
  idx: number = 0,
): ChatCompletionMessageToolCall {
  return {
    id: id ?? `call_${Date.now()}${idx}`,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    },
  };
}

// helper to safely parse json
function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const trimmed = s.trim();
    const parsed = JSON.parse(trimmed);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// helper to strip markdown code fences
function stripCodeFences(s: string): string {
  return s
    .replace(/^```(?:json|python)?\s*/gm, "")
    .replace(/\s*```\s*$/gm, "")
    .trim();
}

// detect the response format
function detectFormat(content: string): FormatDetection | null {
  // ordered by specificity - check more unique patterns first
  // native openai tool_calls field is handled before this function is called

  // kimi k2 - uses specific tags with json content
  if (content.includes("<|tool_call_begin|>")) {
    return { format: "kimi-k2", confidence: 1.0 };
  }

  // deepseek v2/v3/r1 - uses fullwidth characters (｜ and ▁)
  if (/<[|｜]tool[_▁]calls[_▁]begin[|｜]>/u.test(content)) {
    return { format: "deepseek", confidence: 1.0 };
  }

  // mistral/mixtral - specific bracket marker
  if (content.includes("[TOOL_CALLS]")) {
    return { format: "mistral", confidence: 1.0 };
  }

  // phi-4 - specific open/close tags
  if (
    content.includes("<|tool_calls|>") &&
    content.includes("<|/tool_calls|>")
  ) {
    return { format: "phi-4", confidence: 1.0 };
  }

  // qwen2/2.5 and hermes - tool_call tags with closing tag
  // must check before granite-3 since both use <|tool_call|> but this is more specific
  if (
    content.includes("<|tool_call|>") &&
    /<\|tool_call\|>[\s\S]*?<\|\/tool_call\|>/.test(content)
  ) {
    return { format: "qwen-hermes", confidence: 1.0 };
  }

  // granite 3.x - single tool call tag (no closing tag)
  if (content.includes("<|tool_call|>")) {
    return { format: "granite-3", confidence: 0.9 };
  }

  // internlm2/2.5 - action tags with plugin marker
  if (content.includes("<|action_start|>") && content.includes("<|plugin|>")) {
    return { format: "internlm", confidence: 1.0 };
  }

  // functionary v3.1 - xml-style function tags
  if (/<function=([^>]+)>/.test(content)) {
    return { format: "functionary-v3", confidence: 1.0 };
  }

  // functionary v2 - specific from/recipient tags
  if (content.includes("<|from|>") && content.includes("<|recipient|>")) {
    return { format: "functionary-v2", confidence: 1.0 };
  }

  // glm-4 xml style - has both tool_call tags AND arg_key/arg_value markers
  if (content.includes("<|tool_call|>") && content.includes("<|arg_key|>")) {
    return { format: "glm-4-xml", confidence: 1.0 };
  }

  // qwen2/2.5 and hermes - tool_call tags with json content
  if (
    content.includes("<|tool_call|>") &&
    /<\|tool_call\|>[\s\S]*?<\/tool_call>/.test(content)
  ) {
    return { format: "qwen-hermes", confidence: 0.9 };
  }

  // cohere command-r - action code block with tool_name field
  if (/^Action:\s*```/m.test(content) && content.includes('"tool_name"')) {
    return { format: "cohere", confidence: 1.0 };
  }

  // glm-4/chatglm python style - python code block with tool_call function
  if (/```python[\s\S]*?tool_call\s*\(/.test(content)) {
    return { format: "glm-4-python", confidence: 1.0 };
  }

  // granite 20b - function_call tag with json
  if (content.includes("<function_call>") && !content.includes("<function=")) {
    return { format: "granite-20b", confidence: 0.9 };
  }

  // llama 3.1/3.2 pythonic - python_tag with function calls
  if (content.includes("<|python_tag|>")) {
    return { format: "llama-python", confidence: 0.9 };
  }

  return null;
}

// parse kimi k2 format
function parseKimiK2(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const raw = m[1]!.trim();
    const obj = tryParseJson(raw);
    if (!obj) continue;

    // kimi can have flat structure or nested under 'function'
    const fn = obj.function as Record<string, unknown> | undefined;
    const name = (fn?.name ?? obj.name) as string | undefined;
    const args = fn?.arguments ?? obj.arguments;

    if (name) {
      calls.push(makeToolCall(name, args, obj.id as string | undefined, idx++));
    }
  }

  if (calls.length === 0) return null;

  const textContent = content
    .replace(
      /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g,
      "",
    )
    .replace(/<\|[a-z_]+\|>/g, "")
    .replace(/^\s*\[[\s\S]*?'type'\s*:\s*'text'[\s\S]*?\]\s*/g, "")
    .trim();

  return { toolCalls: calls, textContent, format: "kimi-k2" };
}

// parse deepseek format
function parseDeepseek(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  // match both fullwidth (｜▁) and ascii variants (_|)
  const blockRe =
    /<[|｜]tool[_▁]call[_▁]begin[|｜]>([\s\S]*?)<[|｜]tool[_▁]call[_▁]end[|｜]>/gu;
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
    const name = (nlIdx === -1 ? afterSep : afterSep.slice(0, nlIdx)).trim();
    const argsRaw = nlIdx === -1 ? "{}" : afterSep.slice(nlIdx);
    const args = tryParseJson(stripCodeFences(argsRaw)) ?? {};

    if (name) {
      calls.push(makeToolCall(name, args, undefined, idx++));
    }
  }

  if (calls.length === 0) return null;

  const textContent = content
    .replace(
      /<[|｜]tool[_▁]calls[_▁]begin[|｜]>[\s\S]*?<[|｜]tool[_▁]calls[_▁]end[|｜]>/gu,
      "",
    )
    .trim();

  return { toolCalls: calls, textContent, format: "deepseek" };
}

// parse mistral format
function parseMistral(content: string): ParsedToolCalls | null {
  const cut = content.indexOf("[TOOL_CALLS]");
  if (cut === -1) return null;

  const after = content.slice(cut + "[TOOL_CALLS]".length).trim();
  const arrMatch = after.match(/^\s*(\[[\s\S]*?\])\s*/);
  if (!arrMatch) return null;

  try {
    const arr = JSON.parse(arrMatch[1]!) as Array<Record<string, unknown>>;
    const calls: ChatCompletionMessageToolCall[] = [];

    arr.forEach((item, i) => {
      const name = item.name as string;
      if (name) {
        calls.push(
          makeToolCall(name, item.arguments, item.id as string | undefined, i),
        );
      }
    });

    if (calls.length === 0) return null;

    return {
      toolCalls: calls,
      textContent: content.slice(0, cut).trim(),
      format: "mistral",
    };
  } catch {
    return null;
  }
}

// parse phi-4 format
function parsePhi4(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /<\|tool_calls\|>([\s\S]*?)<\|\/tool_calls\|>/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const raw = m[1]!.trim();
    try {
      const parsed = JSON.parse(raw);
      const items: Array<Record<string, unknown>> = Array.isArray(parsed)
        ? parsed
        : [parsed];

      for (const item of items) {
        const name = item.name as string;
        if (name) {
          calls.push(
            makeToolCall(
              name,
              item.arguments,
              item.id as string | undefined,
              idx++,
            ),
          );
        }
      }
    } catch {
      // skip malformed json
    }
  }

  if (calls.length === 0) return null;

  const textContent = content
    .replace(/<\|tool_calls\|>[\s\S]*?<\|\/tool_calls\|>/g, "")
    .trim();
  return { toolCalls: calls, textContent, format: "phi-4" };
}

// parse granite 3.x format
function parseGranite3(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /<\|tool_call\|>([\s\S]*?)(?=<\|tool_call\|>|<\||$)/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const raw = m[1]!.trim();
    const obj = tryParseJson(raw);
    if (!obj) continue;

    // granite can have nested structure: {"tool": {"name": ..., "arguments": ...}}
    const inner = (
      obj.tool && typeof obj.tool === "object" ? obj.tool : obj
    ) as Record<string, unknown>;
    const name = inner.name as string;

    if (name) {
      calls.push(makeToolCall(name, inner.arguments, undefined, idx++));
    }
  }

  if (calls.length === 0) return null;

  const textContent = content
    .replace(/<\|tool_call\|>[\s\S]*?(?=<\|tool_call\|>|<\||$)/g, "")
    .trim();
  return { toolCalls: calls, textContent, format: "granite-3" };
}

// parse internlm format
function parseInternlm(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /<\|action_start\|><\|plugin\|>\s*([\s\S]*?)<\|action_end\|>/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const raw = m[1]!.trim();
    const obj = tryParseJson(raw);
    if (!obj) continue;

    const name = obj.name as string;
    // internlm uses "parameters" instead of "arguments"
    const args = obj.parameters ?? obj.arguments;

    if (name) {
      calls.push(makeToolCall(name, args, undefined, idx++));
    }
  }

  if (calls.length === 0) return null;

  const textContent = content
    .replace(/<\|action_start\|>[\s\S]*?<\|action_end\|>/g, "")
    .trim();
  return { toolCalls: calls, textContent, format: "internlm" };
}

// parse functionary v3 format
function parseFunctionaryV3(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const name = m[1]!.trim();
    const raw = m[2]!.trim();
    const args = tryParseJson(raw) ?? raw;

    if (name) {
      calls.push(makeToolCall(name, args, undefined, idx++));
    }
  }

  if (calls.length === 0) return null;

  const textContent = content
    .replace(/<function=[^>]+>[\s\S]*?<\/function>/g, "")
    .trim();
  return { toolCalls: calls, textContent, format: "functionary-v3" };
}

// parse functionary v2 format
function parseFunctionaryV2(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  // newline after recipient name is optional - some models include it, some don't
  const re =
    /<\|recipient\|>([^\n<]+)(?:\n|\s*)<\|content\|>([\s\S]*?)(?=<\|from\|>|$)/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const name = m[1]!.trim();
    // "all" means final text response, skip it
    if (name === "all") continue;

    const raw = m[2]!.trim();
    const args = tryParseJson(raw) ?? raw;

    if (name) {
      calls.push(makeToolCall(name, args, undefined, idx++));
    }
  }

  // return empty result instead of null when all tool calls were filtered
  // this distinguishes "recognized format but no valid calls" from "unknown format"
  if (calls.length === 0) {
    const textContent = content.slice(0, content.indexOf("<|from|>")).trim();
    return { toolCalls: [], textContent, format: "functionary-v2" };
  }

  const textContent = content.slice(0, content.indexOf("<|from|>")).trim();
  return { toolCalls: calls, textContent, format: "functionary-v2" };
}

// parse glm-4 xml format
function parseGlm4Xml(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /<\|tool_call\|>([\s\S]*?)<\/tool_call>/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const block = m[1]!;
    const nameMatch = block.match(/^([^\n<]+)/);
    if (!nameMatch) continue;

    const name = nameMatch[1]!.trim();
    const args: Record<string, string> = {};
    const pairRe =
      /<\|arg_key\|>([\s\S]*?)<\/arg_key>\s*<\|arg_value\|>([\s\S]*?)<\/arg_value>/g;
    let pair: RegExpExecArray | null;

    while ((pair = pairRe.exec(block)) !== null) {
      args[pair[1]!.trim()] = pair[2]!.trim();
    }

    calls.push(makeToolCall(name, args, undefined, idx++));
  }

  if (calls.length === 0) return null;

  const textContent = content
    .replace(/<\|tool_call\|>[\s\S]*?<\/tool_call>/g, "")
    .trim();
  return { toolCalls: calls, textContent, format: "glm-4-xml" };
}

// parse qwen/hermes format
function parseQwenHermes(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /<\|tool_call\|>\s*([\s\S]*?)\s*<\|\/tool_call\|>/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const raw = m[1]!.trim();
    const obj = tryParseJson(raw);
    if (!obj) continue;

    const name = obj.name as string;
    if (name)
      calls.push(
        makeToolCall(name, obj.arguments, obj.id as string | undefined, idx++),
      );
  }

  if (calls.length === 0) return null;

  const textContent = content
    .replace(/<\|tool_call\|>[\s\S]*?<\|\/tool_call\|>/g, "")
    .trim();
  return { toolCalls: calls, textContent, format: "qwen-hermes" };
}

// parse cohere command-r format
function parseCohere(content: string): ParsedToolCalls | null {
  const blockMatch = content.match(/^Action:\s*```(?:json)?\s*([\s\S]*?)```/m);
  if (!blockMatch) return null;

  try {
    const arr = JSON.parse(blockMatch[1]!.trim());
    const items: Array<Record<string, unknown>> = Array.isArray(arr)
      ? arr
      : [arr];
    const calls: ChatCompletionMessageToolCall[] = [];

    items.forEach((item, i) => {
      const name = item.tool_name as string;
      // cohere uses "parameters" instead of "arguments"
      // "directly_answer" means no tool call needed
      if (name && name !== "directly_answer") {
        calls.push(makeToolCall(name, item.parameters, undefined, i));
      }
    });

    // return empty result instead of null when all tool calls were filtered
    if (calls.length === 0) {
      const textContent = content.replace(blockMatch[0], "").trim();
      return { toolCalls: [], textContent, format: "cohere" };
    }

    const textContent = content.replace(blockMatch[0], "").trim();
    return { toolCalls: calls, textContent, format: "cohere" };
  } catch {
    return null;
  }
}

// parse glm-4 python style
function parseGlm4Python(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /```python\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const block = m[1]!;
    if (!block.includes("tool_call(")) continue;

    const nameMatch = block.match(/name\s*=\s*["']([^"']+)["']/);
    if (!nameMatch) continue;

    const name = nameMatch[1]!;
    const argsMatch = block.match(/arguments\s*=\s*(\{[\s\S]*?\})\s*\)/);

    let args: unknown = {};
    if (argsMatch) {
      // convert python literals to json
      const jsonStr = argsMatch[1]!
        .replace(/'/g, '"')
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false")
        .replace(/\bNone\b/g, "null");
      args = tryParseJson(jsonStr) ?? jsonStr;
    }

    calls.push(makeToolCall(name, args, undefined, idx++));
  }

  if (calls.length === 0) return null;

  const textContent = content.replace(/```python[\s\S]*?```/g, "").trim();
  return { toolCalls: calls, textContent, format: "glm-4-python" };
}

// parse granite 20b format
function parseGranite20b(content: string): ParsedToolCalls | null {
  const calls: ChatCompletionMessageToolCall[] = [];
  const re = /<function_call>\s*([\s\S]*?)(?=<function_call>|$)/g;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = re.exec(content)) !== null) {
    const raw = m[1]!.trim();
    const obj = tryParseJson(raw);
    if (!obj) continue;

    const name = obj.name as string;
    if (name) {
      calls.push(makeToolCall(name, obj.arguments, undefined, idx++));
    }
  }

  if (calls.length === 0) return null;

  const textContent = content.replace(/<function_call>[\s\S]*/g, "").trim();
  return { toolCalls: calls, textContent, format: "granite-20b" };
}

// parse llama pythonic format
function parseLlamaPythonic(content: string): ParsedToolCalls | null {
  const tagIdx = content.indexOf("<|python_tag|>");
  if (tagIdx === -1) return null;

  const after = content
    .slice(tagIdx + "<|python_tag|>".length)
    .replace(/<\|eom_id\|>[\s\S]*$/, "")
    .trim();

  const calls: ChatCompletionMessageToolCall[] = [];
  // unwrap optional [...] list wrapper
  const inner = after.match(/^\[([\s\S]+)\]$/) ? after.slice(1, -1) : after;
  // split on top-level commas before func(
  const targets = inner.split(/,\s*(?=[a-zA-Z_]\w*\s*\()/);

  targets.forEach((target, i) => {
    const fnMatch = target.trim().match(/^([a-zA-Z_][\w.]*)\s*\(([\s\S]*)\)$/);
    if (!fnMatch) return;

    const name = fnMatch[1]!.replace(/\.call$/, "");
    const args: Record<string, string | number> = {};
    const kvRe = /([a-zA-Z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\d.]+))/g;
    let kv: RegExpExecArray | null;

    while ((kv = kvRe.exec(fnMatch[2]!)) !== null) {
      args[kv[1]!] =
        kv[4] !== undefined ? Number(kv[4]) : (kv[2] ?? kv[3] ?? "");
    }

    calls.push(makeToolCall(name, args, undefined, i));
  });

  if (calls.length === 0) return null;

  const textContent = content.slice(0, tagIdx).trim();
  return { toolCalls: calls, textContent, format: "llama-python" };
}

// main parser - entry point
export function parseToolCalls(
  content: string,
  model?: string,
): ParsedToolCalls | null {
  // log raw response for debugging
  if (DEBUG && model) {
    logRawResponse(content, model);
  }

  // detect format
  const detection = detectFormat(content);
  if (!detection) {
    debug("no tool call format detected");
    return null;
  }

  debug(
    `detected format: ${detection.format} (confidence: ${detection.confidence})`,
  );

  // parse based on detected format
  let result: ParsedToolCalls | null = null;

  switch (detection.format) {
    case "kimi-k2":
      result = parseKimiK2(content);
      break;
    case "deepseek":
      result = parseDeepseek(content);
      break;
    case "mistral":
      result = parseMistral(content);
      break;
    case "phi-4":
      result = parsePhi4(content);
      break;
    case "granite-3":
      result = parseGranite3(content);
      break;
    case "internlm":
      result = parseInternlm(content);
      break;
    case "functionary-v3":
      result = parseFunctionaryV3(content);
      break;
    case "functionary-v2":
      result = parseFunctionaryV2(content);
      break;
    case "glm-4-xml":
      result = parseGlm4Xml(content);
      break;
    case "qwen-hermes":
      result = parseQwenHermes(content);
      break;
    case "cohere":
      result = parseCohere(content);
      break;
    case "glm-4-python":
      result = parseGlm4Python(content);
      break;
    case "granite-20b":
      result = parseGranite20b(content);
      break;
    case "llama-python":
      result = parseLlamaPythonic(content);
      break;
  }

  if (result) {
    debug(`parsed ${result.toolCalls.length} tool call(s)`);
    for (const tc of result.toolCalls) {
      if (tc.type === "function") {
        debug(
          `  - ${tc.function.name}: ${tc.function.arguments.slice(0, 100)}...`,
        );
      }
    }
  }

  return result;
}
