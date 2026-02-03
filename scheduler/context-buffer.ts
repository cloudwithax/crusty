// recent context buffer for self-review
// extracted to avoid circular dependencies between agent and heartbeat

let recentContextBuffer: string[] = [];
const MAX_CONTEXT_ENTRIES = 10;

// add context to the buffer (called from agent after interactions)
export function addRecentContext(context: string): void {
  recentContextBuffer.push(context);
  if (recentContextBuffer.length > MAX_CONTEXT_ENTRIES) {
    recentContextBuffer.shift();
  }
}

// get the recent context as a single string
export function getRecentContext(): string {
  return recentContextBuffer.join("\n\n---\n\n");
}

// clear recent context buffer
export function clearRecentContext(): void {
  recentContextBuffer = [];
}
