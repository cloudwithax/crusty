import type { z } from "zod";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { browserTools, cleanupBrowser } from "./browser.ts";
import { todoTools, cleanupTodos } from "./todo.ts";
import { skillTools } from "./skill.ts";
import { bashTools, cleanupBash, DOCKER_ENV } from "./bash.ts";
import { hookTools } from "./hooks.ts";

// Common tool definition format - each tool has description, zod schema, and handler
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolDefinition = {
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, userId: number) => Promise<string>;
};

// Registry of all available tools - bash tools only available in docker
const toolRegistry: Record<string, ToolDefinition> = {
  ...browserTools,
  ...todoTools,
  ...skillTools,
  ...hookTools,
  ...(DOCKER_ENV ? bashTools : {}),
};

/**
 * Convert Zod schema to OpenAI tool parameter format
 */
function zodSchemaToOpenAIParameters(schema: z.ZodType): Record<string, unknown> {
  // Get the shape if it's an object schema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape = (schema as any).shape;

  if (!shape) {
    return { type: "object", properties: {} };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodType;
    const description = zodType.description;

    // Determine the JSON schema type from Zod type
    let type = "string";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zodTypeName = (zodType as any)._def?.typeName;

    if (zodTypeName === "ZodEnum") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enumValues = (zodType as any)._def?.values;
      properties[key] = {
        type: "string",
        enum: enumValues,
        description,
      };
    } else if (zodTypeName === "ZodNumber") {
      type = "number";
      properties[key] = { type, description };
    } else if (zodTypeName === "ZodBoolean") {
      type = "boolean";
      properties[key] = { type, description };
    } else if (zodTypeName === "ZodArray") {
      type = "array";
      properties[key] = { type, description };
    } else if (zodTypeName === "ZodObject") {
      type = "object";
      properties[key] = { type, description };
    } else {
      // Default to string for ZodString and others
      properties[key] = { type: "string", description };
    }

    // Check if field is required (not optional)
    if (zodTypeName !== "ZodOptional") {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Generate OpenAI-compatible tool definitions from the registry
 */
export function generateOpenAITools(): ChatCompletionTool[] {
  return Object.entries(toolRegistry).map(([name, tool]) => ({
    type: "function" as const,
    function: {
      name,
      description: tool.description,
      parameters: zodSchemaToOpenAIParameters(tool.schema),
    },
  }));
}

/**
 * Execute a tool by name with the given arguments
 */
export async function executeTool(name: string, args: string, userId: number = 0): Promise<string> {
  const tool = toolRegistry[name];
  if (!tool) {
    return `[Error] Unknown tool: ${name}. Available tools: ${Object.keys(toolRegistry).join(", ")}`;
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(args);
  } catch (parseError) {
    return `[Error] Invalid JSON in arguments for ${name}. Received: ${args.slice(0, 100)}. Please provide valid JSON arguments.`;
  }

  // coerce mistyped values before validation
  // models sometimes pass strings when booleans/numbers expected, or null for optional fields
  if (parsedArgs && typeof parsedArgs === "object") {
    const obj = parsedArgs as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      // null -> undefined (zod .optional() doesnt accept null)
      if (val === null) {
        delete obj[key];
      }
      // string booleans -> actual booleans
      else if (val === "true") obj[key] = true;
      else if (val === "false" || val === "") obj[key] = false;
      // string numbers -> actual numbers (only if its a clean numeric string)
      else if (typeof val === "string" && val !== "" && !isNaN(Number(val)) && val.trim() === val) {
        obj[key] = Number(val);
      }
    }
  }

  try {
    const validatedArgs = tool.schema.parse(parsedArgs);
    return await tool.handler(validatedArgs, userId);
  } catch (error) {
    if (error instanceof Error) {
      // provide actionable feedback based on error type
      const msg = error.message;

      if (msg.includes("Required") || msg.includes("required")) {
        return `[Error] Missing required argument for ${name}. ${msg}. Please provide all required parameters.`;
      }

      if (msg.includes("Invalid enum") || msg.includes("Expected")) {
        return `[Error] Invalid argument value for ${name}. ${msg}. Check the allowed values and try again.`;
      }

      // navigation/network errors should suggest alternatives
      if (msg.includes("timeout") || msg.includes("net::ERR")) {
        return `[Error] Network issue with ${name}: ${msg}. The page may be slow or unavailable. Consider trying a different URL.`;
      }

      return `[Error] ${name} failed: ${msg}`;
    }
    return `[Error] ${name} failed: ${String(error)}`;
  }
}

/**
 * Get list of available tool names
 */
export function getAvailableTools(): string[] {
  return Object.keys(toolRegistry);
}

/**
 * Cleanup all tools (close browsers, connections, etc.)
 */
export async function cleanupTools(): Promise<void> {
  await cleanupBrowser();
  await cleanupTodos();
  await cleanupBash();
}

// Re-export tool types for extension
export type { ToolDefinition };
