// single source of truth for the active model at runtime
// kept in a separate module to avoid circular imports between agent and tools

let activeModel = process.env.OPENAI_MODEL || "gpt-4o";

export function getCurrentModel(): string {
  return activeModel;
}

export function setCurrentModel(modelId: string): void {
  activeModel = modelId;
}
