import type { z } from "zod";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { filesystemTools, cleanupFilesystem } from "./filesystem.ts";
import { bashTools, cleanupBash, DOCKER_ENV } from "./bash.ts";
import { browserTools, cleanupBrowser } from "./browser.ts";

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

export async function executeTool(name: string, args: string, userId: number = 0): Promise<string> {
  const tool = toolRegistry[name];
  if (!tool) {
    return `error: unknown tool "${name}". available: ${Object.keys(toolRegistry).join(", ")}`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return `error: invalid json for ${name}`;
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
