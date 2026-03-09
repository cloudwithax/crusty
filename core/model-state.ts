// single source of truth for the active model at runtime
// kept in a separate module to avoid circular imports between agent and tools

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { debug } from "../utils/debug.ts";

let activeModel = process.env.OPENAI_MODEL || "gpt-4o";

export function getCurrentModel(): string {
  return activeModel;
}

export function setCurrentModel(modelId: string): void {
  activeModel = modelId;
}

// persist the model choice to .env so it survives restarts
export function persistModelToEnv(modelId: string): void {
  const envPath = join(import.meta.dirname || process.cwd(), "..", ".env");
  try {
    const content = readFileSync(envPath, "utf-8");
    const updated = content.replace(
      /^OPENAI_MODEL=.*$/m,
      `OPENAI_MODEL=${modelId}`,
    );

    if (updated === content && !content.includes("OPENAI_MODEL=")) {
      // key doesnt exist yet, append it
      writeFileSync(envPath, content.trimEnd() + `\nOPENAI_MODEL=${modelId}\n`);
    } else {
      writeFileSync(envPath, updated);
    }

    // sync process.env so getCurrentModel reflects the env default correctly
    process.env.OPENAI_MODEL = modelId;
    debug(`[model-state] persisted model "${modelId}" to .env`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    debug(`[model-state] failed to persist model to .env: ${msg}`);
  }
}
