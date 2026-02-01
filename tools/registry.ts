import type { z } from "zod";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { filesystemTools, cleanupFilesystem } from "./filesystem.ts";
import { bashTools, cleanupBash, DOCKER_ENV } from "./bash.ts";
import { browserTools, cleanupBrowser } from "./browser.ts";
import { skillTools } from "./skill.ts";
import { todoTools } from "./todo.ts";
import { reminderTools } from "./reminder.ts";
import { hookTools } from "./hooks.ts";

// minimal tool registry - nanocode style
// filesystem + browser + bash (in docker)

type ToolDefinition = {
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, userId: number) => Promise<string>;
};

const toolRegistry: Record<string, ToolDefinition> = {
  ...filesystemTools,
  ...browserTools,
  ...skillTools,
  ...todoTools,
  ...reminderTools,
  ...hookTools,
  ...(DOCKER_ENV ? bashTools : {}),
};

// convert zod schema to openai parameters
function zodToOpenAI(schema: z.ZodType): Record<string, unknown> {
  const shape = (schema as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) return { type: "object", properties: {} };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodType & { _def?: { typeName?: string; values?: string[] } };
    const description = zodType.description;
    const typeName = zodType._def?.typeName;

    if (typeName === "ZodEnum") {
      properties[key] = { type: "string", enum: zodType._def?.values, description };
    } else if (typeName === "ZodNumber") {
      properties[key] = { type: "number", description };
    } else if (typeName === "ZodBoolean") {
      properties[key] = { type: "boolean", description };
    } else if (typeName === "ZodArray") {
      properties[key] = { type: "array", description };
    } else if (typeName === "ZodObject") {
      properties[key] = { type: "object", description };
    } else {
      properties[key] = { type: "string", description };
    }

    if (typeName !== "ZodOptional") {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

export function generateOpenAITools(): ChatCompletionTool[] {
  return Object.entries(toolRegistry).map(([name, tool]) => ({
    type: "function" as const,
    function: {
      name,
      description: tool.description,
      parameters: zodToOpenAI(tool.schema),
    },
  }));
}

// sanitize and coerce argument values to fix common model quirks
// handles: type coercion, leading colons, malformed urls, escaped quotes, etc
function sanitizeArgs(args: Record<string, unknown>, toolName?: string): Record<string, unknown> {
  const result = { ...args };
  const keysToDelete: string[] = [];

  for (const key of Object.keys(result)) {
    const val = result[key];

    // null -> delete
    if (val === null) {
      keysToDelete.push(key);
      continue;
    }

    // string booleans -> actual booleans
    if (val === "true") {
      result[key] = true;
      continue;
    }
    if (val === "false") {
      result[key] = false;
      continue;
    }

    // only process strings from here
    if (typeof val !== "string") continue;

    // empty or whitespace-only strings -> delete (makes optional fields undefined)
    if (val.trim() === "") {
      keysToDelete.push(key);
      continue;
    }

    // special handling for bash_execute command field
    if (toolName === "bash_execute" && key === "command") {
      let cmd = val;
      // strip leading colons, slashes, and whitespace that models sometimes prepend
      // handles: ": cmd", ":cmd", "://cmd", "https://cmd", etc
      cmd = cmd.replace(/^(?:https?)?:?\/*\s*/, "");
      // unwrap a fully quoted command but do not strip legitimate closing quotes
      const trimmed = cmd.trim();
      if (trimmed.length >= 2) {
        const quote = trimmed[0];
        if ((quote === "\"" || quote === "'") && trimmed[trimmed.length - 1] === quote) {
          const inner = trimmed.slice(1, -1);
          if (!inner.includes(quote)) {
            cmd = inner;
          }
        }
      }
      result[key] = cmd;
      continue;
    }

    // special handling for timeout field - extract just the numeric part
    if (key === "timeout") {
      // handle malformed values like `:\"15000\",\"workdir\":...`
      const numMatch = val.match(/(\d+)/);
      if (numMatch) {
        result[key] = parseInt(numMatch[1]!, 10);
      } else {
        keysToDelete.push(key);
      }
      continue;
    }

    let cleaned = val;

    // remove leading colons and whitespace
    if (/^:\s*/.test(cleaned)) {
      cleaned = cleaned.replace(/^:\s*/, "");
    }

    // handle protocol-relative urls (//domain.com) by prepending https:
    if (/^\/\/[a-zA-Z0-9]/.test(cleaned)) {
      cleaned = `https:${cleaned}`;
    }

    // remove leading garbage before urls
    const urlPrefixMatch = cleaned.match(/^[^a-zA-Z]*(https?:\/\/)/i);
    if (urlPrefixMatch?.[1] && urlPrefixMatch[0] !== urlPrefixMatch[1]) {
      cleaned = cleaned.slice(urlPrefixMatch[0].length - urlPrefixMatch[1].length);
    }

    // remove wrapping quotes from urls
    if (/^["'].*["']$/.test(cleaned) && cleaned.includes("://")) {
      cleaned = cleaned.slice(1, -1);
    }

    // fix escaped quotes in urls
    if (cleaned.includes('\\"') && cleaned.includes("://")) {
      cleaned = cleaned.replace(/\\"/g, "");
    }

    // string numbers -> actual numbers
    if (/^\d+$/.test(cleaned)) {
      const num = parseInt(cleaned, 10);
      if (!isNaN(num)) {
        result[key] = num;
        continue;
      }
    }

    result[key] = cleaned;
  }

  for (const key of keysToDelete) {
    delete result[key];
  }

  return result;
}

// attempt to recover valid json from malformed tool arguments
// assistantText can be used to extract intent when args are completely garbage
function recoverMalformedArgs(toolName: string, brokenArgs: string, assistantText?: string): Record<string, unknown> {
  const directionMatch = brokenArgs.match(/"?direction"?\s*[:=]\s*"?(up|down)/i);
  // url extraction: handle quoted, unquoted, and protocol-relative urls
  const urlMatch = brokenArgs.match(/"?url"?\s*[:=]\s*"?((?:https?:)?\/\/[^"}\s]+|[^"}\s]+\.[a-z]{2,}[^"}\s]*)/i);
  const selectorMatch = brokenArgs.match(/"?selector"?\s*[:=]\s*"([^"]+)"/i);
  const textMatch = brokenArgs.match(/"?text"?\s*[:=]\s*"([^"]+)"/i);
  // query extraction: handle both quoted and unquoted values
  const queryMatch = brokenArgs.match(/"?query"?\s*[:=]\s*"?([^"{}]+?)(?:"|,|\s*}|$)/i);
  const pathMatch = brokenArgs.match(/"?path"?\s*[:=]\s*"([^"]+)"/i);
  const commandMatch = brokenArgs.match(/"?command"?\s*[:=]\s*"([^"]+)"/i);
  const contentMatch = brokenArgs.match(/"?content"?\s*[:=]\s*"([\s\S]*?)(?:"|$)/i);

  // try to parse the original args to preserve any valid fields
  let originalArgs: Record<string, unknown> = {};
  try {
    originalArgs = JSON.parse(brokenArgs) as Record<string, unknown>;
  } catch {
    // if completely unparseable, start with empty object
    originalArgs = {};
  }

  // browser tools
  if (toolName === "browser_scroll" && directionMatch) {
    return { ...originalArgs, direction: directionMatch[1]!.toLowerCase() };
  }
  if (toolName === "browser_navigate") {
    // try the url field match first
    if (urlMatch) {
      let url = urlMatch[1]!.trim();
      if (url.startsWith("//")) url = `https:${url}`;
      if (!url.startsWith("http") && url.includes(".")) url = `https://${url}`;
      return { ...originalArgs, url };
    }
    // fallback: find ANY url-like pattern in the args
    const anyUrl = brokenArgs.match(/((?:https?:)?\/\/[^\s"'<>]+|[a-z0-9][-a-z0-9]*\.[a-z]{2,}[^\s"'<>]*)/i);
    if (anyUrl) {
      let url = anyUrl[1]!.trim();
      if (url.startsWith("//")) url = `https:${url}`;
      if (!url.startsWith("http") && url.includes(".")) url = `https://${url}`;
      return { ...originalArgs, url };
    }
  }
  if (toolName === "browser_click" && selectorMatch) {
    return { ...originalArgs, selector: selectorMatch[1] };
  }
  if (toolName === "browser_type" && selectorMatch && textMatch) {
    return { ...originalArgs, selector: selectorMatch[1], text: textMatch[1] };
  }

  // web search - more flexible matching
  if (toolName === "web_search") {
    const query = queryMatch?.[1]?.trim();
    if (query && query.length >= 2) {
      return { ...originalArgs, query };
    }
    // fallback: if the whole arg looks like a search term (not json-like), use it
    const cleaned = brokenArgs.replace(/[{}":]/g, "").trim();
    if (cleaned.length >= 2 && !cleaned.includes("=")) {
      return { ...originalArgs, query: cleaned };
    }
  }

  // bash tools
  if (toolName === "bash_execute") {
    // try standard match first - if it's valid, use it
    if (commandMatch) {
      const cmd = commandMatch[1]!.replace(/^(?:https?)?:?\/*\s*/, "").trim();
      // only use if it looks like a real command (not just punctuation or garbage)
      if (cmd.length > 2 && /[a-zA-Z]/.test(cmd)) {
        return { ...originalArgs, command: cmd };
      }
      // commandMatch found garbage - remove it but continue to pattern/assistant recovery
      delete originalArgs.command;
    }

    // common shell command patterns - used for both args and assistant text recovery
    // patterns use [^\n"`,;:] to stop at common sentence/clause delimiters
    // curl/wget require a url-like argument (contains dot or protocol) to avoid matching "curl command"
    const cmdPatterns = [
      /\b(curl\s+(?:-[a-zA-Z]+\s+)*https?:\/\/[^\s"`,;:]+)/i,
      /\b(curl\s+(?:-[a-zA-Z]+\s+)*[^\s"`,;:]*\.[^\s"`,;:]+)/i,
      /\b(wget\s+(?:-[a-zA-Z]+\s+)*https?:\/\/[^\s"`,;:]+)/i,
      /\b(wget\s+(?:-[a-zA-Z]+\s+)*[^\s"`,;:]*\.[^\s"`,;:]+)/i,
      /\b(cat\s+[^\n"`,;:]+)/i,
      /\b(ls\s+[^\n"`,;:]*)/i,
      /\b(grep\s+(?:-[a-zA-Z]+\s+)*[^\n"`,;:]+)/i,
      /\b(find\s+[^\n"`,;:]+)/i,
      /\b(echo\s+[^\n"`,;]+)/i,
      /\b(cd\s+[^\n"`,;:]+)/i,
      /\b(mkdir\s+(?:-[a-zA-Z]+\s+)*[^\n"`,;:]+)/i,
      /\b(bun\s+[^\n"`,;:]+)/i,
      /\b(npm\s+[^\n"`,;:]+)/i,
      /\b(node\s+[^\n"`,;:]+)/i,
      /\b(python[3]?\s+[^\n"`,;:]+)/i,
      /\b(pip[3]?\s+[^\n"`,;:]+)/i,
      /\b(git\s+[^\n"`,;:]+)/i,
      /\b(docker\s+[^\n"`,;:]+)/i,
      /\b(rm\s+[^\n"`,;:]+)/i,
      /\b(cp\s+[^\n"`,;:]+)/i,
      /\b(mv\s+[^\n"`,;:]+)/i,
      /\b(chmod\s+[^\n"`,;:]+)/i,
      /\b(head\s+[^\n"`,;:]+)/i,
      /\b(tail\s+[^\n"`,;:]+)/i,
      /\b(wc\s+[^\n"`,;:]+)/i,
      /\b(sort\s+[^\n"`,;:]+)/i,
      /\b(uniq\s+[^\n"`,;:]+)/i,
      /\b(awk\s+[^\n"`,;:]+)/i,
      /\b(sed\s+[^\n"`,;:]+)/i,
      /\b(tar\s+[^\n"`,;:]+)/i,
      /\b(zip\s+[^\n"`,;:]+)/i,
      /\b(unzip\s+[^\n"`,;:]+)/i,
      /\b(whoami)\b/i,
      /\b(pwd)\b/i,
      /\b(date)\b/i,
      /\b(uname\s*[^\n"`,;:]*)/i,
      /\b(ps\s*[^\n"`,;:]*)/i,
      /\b(top)\b/i,
      /\b(df\s*[^\n"`,;:]*)/i,
      /\b(du\s+[^\n"`,;:]+)/i,
      /\b(free\s*[^\n"`,;:]*)/i,
      /\b(env)\b/i,
      /\b(export\s+[^\n"`,;:]+)/i,
      /\b(source\s+[^\n"`,;:]+)/i,
      /\b(bash\s+[^\n"`,;:]+)/i,
      /\b(sh\s+[^\n"`,;:]+)/i,
    ];

    // helper to clean up extracted command
    const cleanCommand = (raw: string): string => {
      return raw
        .replace(/\\"/g, '"')
        .replace(/[",}\s]+$/, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
    };

    // try to find command in broken args first
    for (const pattern of cmdPatterns) {
      const match = brokenArgs.match(pattern);
      if (match) {
        const cmd = cleanCommand(match[1]!);
        if (cmd.length > 2) return { ...originalArgs, command: cmd };
      }
    }

    // fallback: extract command intent from assistant text if provided
    // this handles cases where the model says what it wants to do but garbles the args
    if (assistantText) {
      for (const pattern of cmdPatterns) {
        const match = assistantText.match(pattern);
        if (match) {
          const cmd = cleanCommand(match[1]!);
          if (cmd.length > 2) return { ...originalArgs, command: cmd };
        }
      }

      // last resort: look for bare URLs in assistant text and construct a curl command
      // handles cases like "let me hit wttr.in" or "going to example.com"
      const urlPattern = /\b((?:https?:\/\/)?[a-z0-9][-a-z0-9]*(?:\.[a-z]{2,})+(?:\/[^\s"`,;:]*)?)\b/i;
      const urlMatch = assistantText.match(urlPattern);
      if (urlMatch) {
        let url = urlMatch[1]!;
        if (!url.startsWith("http")) url = `https://${url}`;
        return { ...originalArgs, command: `curl ${url}` };
      }
    }

    // no valid command found - preserve other valid args but let validation fail on missing command
    return originalArgs;
  }
  if ((toolName === "bash_read_file" || toolName === "read") && pathMatch) {
    return { ...originalArgs, path: pathMatch[1]!.replace(/^:\s*/, "") };
  }
  if ((toolName === "bash_write_file" || toolName === "write") && pathMatch) {
    return { ...originalArgs, path: pathMatch[1]!.replace(/^:\s*/, ""), content: contentMatch?.[1] ?? "" };
  }
  if (toolName === "bash_list_dir" && pathMatch) {
    return { ...originalArgs, path: pathMatch[1]!.replace(/^:\s*/, "") };
  }

  // filesystem tools
  if (toolName === "edit" && pathMatch) {
    const oldMatch = brokenArgs.match(/"?old"?\s*[:=]\s*"([\s\S]*?)(?:"|$)/i);
    const newMatch = brokenArgs.match(/"?new"?\s*[:=]\s*"([\s\S]*?)(?:"|$)/i);
    return { ...originalArgs, path: pathMatch[1], old: oldMatch?.[1] ?? "", new: newMatch?.[1] ?? "" };
  }
  if (toolName === "glob") {
    const patMatch = brokenArgs.match(/"?pat"?\s*[:=]\s*"([^"]+)"/i);
    if (patMatch) return { ...originalArgs, pat: patMatch[1] };
  }
  if (toolName === "grep") {
    const patMatch = brokenArgs.match(/"?pat"?\s*[:=]\s*"([^"]+)"/i);
    if (patMatch) return { ...originalArgs, pat: patMatch[1], path: pathMatch?.[1] };
  }

  // no recovery possible - preserve whatever we could parse
  return originalArgs;
}

// detect if parsed args look like garbage (model hallucination)
function isGarbageArgs(parsed: Record<string, unknown>, toolName: string): boolean {
  if (toolName === "bash_execute") {
    const cmd = parsed.command;
    // command should be a string with actual command characters
    if (typeof cmd !== "string") return true;
    const trimmed = cmd.trim();
    // garbage indicators: too short, only punctuation, or contains json-like fragments
    if (trimmed.length < 2) return true;
    if (!/[a-zA-Z]/.test(trimmed)) return true;
    if (/^[,.:;!?]+$/.test(trimmed)) return true;
  }
  return false;
}

export async function executeTool(name: string, args: string, userId: number = 0, assistantText?: string): Promise<string> {
  const tool = toolRegistry[name];
  if (!tool) {
    return `error: unknown tool "${name}". available: ${Object.keys(toolRegistry).join(", ")}`;
  }

  // try to parse json, recover if malformed
  let parsed: unknown;
  let needsRecovery = false;

  try {
    parsed = JSON.parse(args);
    // check if parsed successfully but values are garbage
    if (parsed && typeof parsed === "object") {
      needsRecovery = isGarbageArgs(parsed as Record<string, unknown>, name);
    }
  } catch {
    needsRecovery = true;
  }

  if (needsRecovery) {
    // attempt recovery from malformed/garbage args
    parsed = recoverMalformedArgs(name, args, assistantText);
  }

  // sanitize and coerce types before validation
  if (parsed && typeof parsed === "object") {
    parsed = sanitizeArgs(parsed as Record<string, unknown>, name);
  }

  // check if recovery still left us with invalid args for bash_execute
  if (name === "bash_execute" && parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    const cmd = typeof p.command === "string" ? p.command.trim() : "";
    if (!cmd || cmd.length < 2 || !/[a-zA-Z]/.test(cmd)) {
      return `error: could not parse a valid command. the "command" field must contain a shell command.

format: {"command": "<shell command>"}

received: ${args.slice(0, 150)}${args.length > 150 ? "..." : ""}`;
    }
  }

  try {
    const validated = tool.schema.parse(parsed);
    return await tool.handler(validated, userId);
  } catch (err) {
    // provide clearer errors for common tools
    const errMsg = err instanceof Error ? err.message : String(err);
    if (name === "bash_execute" && errMsg.includes("command")) {
      return `error: bash_execute requires a "command" field with a valid shell command.

format: {"command": "<shell command>"}

received: ${args.slice(0, 150)}${args.length > 150 ? "..." : ""}`;
    }
    return `error: ${errMsg}`;
  }
}

export function getAvailableTools(): string[] {
  return Object.keys(toolRegistry);
}

export async function cleanupTools(): Promise<void> {
  await cleanupFilesystem();
  await cleanupBrowser();
  await cleanupBash();
}

export type { ToolDefinition };
