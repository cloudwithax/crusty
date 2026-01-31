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

    // empty strings -> delete (makes optional fields undefined)
    if (val === "") {
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
function recoverMalformedArgs(toolName: string, brokenArgs: string): string {
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

  // browser tools
  if (toolName === "browser_scroll" && directionMatch) {
    return JSON.stringify({ direction: directionMatch[1]!.toLowerCase() });
  }
  if (toolName === "browser_navigate" && urlMatch) {
    let url = urlMatch[1]!.trim();
    // fix protocol-relative urls
    if (url.startsWith("//")) url = `https:${url}`;
    // add protocol if missing but looks like a url
    if (!url.startsWith("http") && url.includes(".")) url = `https://${url}`;
    return JSON.stringify({ url });
  }
  if (toolName === "browser_click" && selectorMatch) {
    return JSON.stringify({ selector: selectorMatch[1] });
  }
  if (toolName === "browser_type" && selectorMatch && textMatch) {
    return JSON.stringify({ selector: selectorMatch[1], text: textMatch[1] });
  }

  // web search - more flexible matching
  if (toolName === "web_search") {
    const query = queryMatch?.[1]?.trim();
    if (query && query.length >= 2) {
      return JSON.stringify({ query });
    }
    // fallback: if the whole arg looks like a search term (not json-like), use it
    const cleaned = brokenArgs.replace(/[{}":]/g, "").trim();
    if (cleaned.length >= 2 && !cleaned.includes("=")) {
      return JSON.stringify({ query: cleaned });
    }
  }

  // bash tools
  if (toolName === "bash_execute" && commandMatch) {
    const cmd = commandMatch[1]!.replace(/^(?:https?)?:?\/*\s*/, "");
    if (cmd && cmd.length > 2) return JSON.stringify({ command: cmd });
  }
  if ((toolName === "bash_read_file" || toolName === "read") && pathMatch) {
    return JSON.stringify({ path: pathMatch[1]!.replace(/^:\s*/, "") });
  }
  if ((toolName === "bash_write_file" || toolName === "write") && pathMatch) {
    return JSON.stringify({ path: pathMatch[1]!.replace(/^:\s*/, ""), content: contentMatch?.[1] ?? "" });
  }
  if (toolName === "bash_list_dir" && pathMatch) {
    return JSON.stringify({ path: pathMatch[1]!.replace(/^:\s*/, "") });
  }

  // filesystem tools
  if (toolName === "edit" && pathMatch) {
    const oldMatch = brokenArgs.match(/"?old"?\s*[:=]\s*"([\s\S]*?)(?:"|$)/i);
    const newMatch = brokenArgs.match(/"?new"?\s*[:=]\s*"([\s\S]*?)(?:"|$)/i);
    return JSON.stringify({ path: pathMatch[1], old: oldMatch?.[1] ?? "", new: newMatch?.[1] ?? "" });
  }
  if (toolName === "glob") {
    const patMatch = brokenArgs.match(/"?pat"?\s*[:=]\s*"([^"]+)"/i);
    if (patMatch) return JSON.stringify({ pat: patMatch[1] });
  }
  if (toolName === "grep") {
    const patMatch = brokenArgs.match(/"?pat"?\s*[:=]\s*"([^"]+)"/i);
    if (patMatch) return JSON.stringify({ pat: patMatch[1], path: pathMatch?.[1] });
  }

  return "{}";
}

export async function executeTool(name: string, args: string, userId: number = 0): Promise<string> {
  const tool = toolRegistry[name];
  if (!tool) {
    return `error: unknown tool "${name}". available: ${Object.keys(toolRegistry).join(", ")}`;
  }

  // try to parse json, recover if malformed
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    // attempt recovery from malformed args
    const recovered = recoverMalformedArgs(name, args);
    try {
      parsed = JSON.parse(recovered);
    } catch {
      return `error: invalid json for ${name}`;
    }
  }

  // sanitize and coerce types before validation
  if (parsed && typeof parsed === "object") {
    parsed = sanitizeArgs(parsed as Record<string, unknown>, name);
  }

  try {
    const validated = tool.schema.parse(parsed);
    return await tool.handler(validated, userId);
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
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
