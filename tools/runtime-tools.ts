import { z } from "zod";

export type ToolDefinition = {
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, userId: number) => Promise<string>;
};

const dynamicToolRegistry: Record<string, ToolDefinition> = {};
let dynamicToolRegistryVersion = 0;

export function getDynamicTools(): Record<string, ToolDefinition> {
  return { ...dynamicToolRegistry };
}

export function getDynamicToolsVersion(): number {
  return dynamicToolRegistryVersion;
}

export function registerDynamicTools(
  tools: Record<string, ToolDefinition>,
): void {
  for (const [name, definition] of Object.entries(tools)) {
    dynamicToolRegistry[name] = definition;
  }

  dynamicToolRegistryVersion += 1;
}

export function clearDynamicTools(prefix?: string): void {
  let changed = false;

  for (const name of Object.keys(dynamicToolRegistry)) {
    if (!prefix || name.startsWith(prefix)) {
      delete dynamicToolRegistry[name];
      changed = true;
    }
  }

  if (changed) {
    dynamicToolRegistryVersion += 1;
  }
}
