const DEFAULT_MESSAGE_DEBOUNCE_MS = 1200;
const DEFAULT_TYPING_GRACE_MS = 1800;

interface DebounceEntry<T> {
  items: T[];
  lastMessageAt: number;
  typingUntil: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface DebouncedBatch<T> {
  key: string;
  items: T[];
}

export interface MessageDebouncerOptions<T> {
  debounceMs?: number;
  typingGraceMs?: number;
  onFlush: (batch: DebouncedBatch<T>) => void | Promise<void>;
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

export function getInboundMessageDebounceMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseDurationMs(
    env.INBOUND_MESSAGE_DEBOUNCE_MS,
    DEFAULT_MESSAGE_DEBOUNCE_MS,
  );
}

export function getInboundTypingGraceMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseDurationMs(env.INBOUND_TYPING_GRACE_MS, DEFAULT_TYPING_GRACE_MS);
}

export function joinBufferedText(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export class MessageDebouncer<T> {
  private readonly debounceMs: number;
  private readonly typingGraceMs: number;
  private readonly onFlush: (batch: DebouncedBatch<T>) => void | Promise<void>;
  private readonly entries = new Map<string, DebounceEntry<T>>();

  constructor(options: MessageDebouncerOptions<T>) {
    this.debounceMs = options.debounceMs ?? getInboundMessageDebounceMs();
    this.typingGraceMs = options.typingGraceMs ?? getInboundTypingGraceMs();
    this.onFlush = options.onFlush;
  }

  enqueue(key: string, item: T): void {
    const entry = this.getOrCreateEntry(key);
    entry.items.push(item);
    entry.lastMessageAt = Date.now();
    this.schedule(key, entry);
  }

  markTyping(key: string): void {
    const entry = this.getOrCreateEntry(key);
    entry.typingUntil = Math.max(
      entry.typingUntil,
      Date.now() + this.typingGraceMs,
    );
    this.schedule(key, entry);
  }

  clear(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    this.entries.delete(key);
  }

  clearAll(): void {
    for (const key of this.entries.keys()) {
      this.clear(key);
    }
  }

  private getOrCreateEntry(key: string): DebounceEntry<T> {
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }

    const entry: DebounceEntry<T> = {
      items: [],
      lastMessageAt: 0,
      typingUntil: 0,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private schedule(key: string, entry: DebounceEntry<T>): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    const now = Date.now();
    const dueAt = this.getDueAt(entry);
    const delay = Math.max(0, dueAt - now);

    entry.timer = setTimeout(() => {
      void this.flushIfReady(key);
    }, delay);
  }

  private getDueAt(entry: DebounceEntry<T>): number {
    const messageDueAt =
      entry.items.length > 0 ? entry.lastMessageAt + this.debounceMs : 0;
    return Math.max(messageDueAt, entry.typingUntil);
  }

  private async flushIfReady(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }

    entry.timer = undefined;

    const now = Date.now();
    const dueAt = this.getDueAt(entry);
    if (dueAt > now) {
      this.schedule(key, entry);
      return;
    }

    this.entries.delete(key);

    if (entry.items.length === 0) {
      return;
    }

    await this.onFlush({
      key,
      items: entry.items,
    });
  }
}
