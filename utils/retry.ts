// retry utilities with exponential backoff

import { debug } from "./debug.ts";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 10,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  retryOn: isRetryableError,
};

// determine if an error is retryable
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  const err = error as Record<string, unknown>;

  // openai sdk error codes
  const status = err.status as number | undefined;
  if (status) {
    // 429 = rate limit, 500-503 = server errors
    if (status === 429 || (status >= 500 && status <= 503)) {
      return true;
    }
  }

  // network and transient errors
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("econnaborted") ||
      message.includes("enotfound") ||
      message.includes("epipe") ||
      message.includes("network") ||
      message.includes("socket hang up") ||
      message.includes("fetch failed") ||
      message.includes("aborted") ||
      message.includes("connection") ||
      message.includes("ssl") ||
      message.includes("tls")
    ) {
      return true;
    }
  }

  return false;
}

// calculate delay with exponential backoff + jitter
function calculateDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponentialDelay = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs * 0.5; // up to 50% jitter
  return Math.min(exponentialDelay + jitter, maxMs);
}

// wrap an async function with retry logic
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxRetries || !opts.retryOn(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      const errorHint = error instanceof Error ? error.message.slice(0, 80) : "unknown";
      debug(
        `[retry] attempt ${attempt + 1}/${opts.maxRetries} failed (${errorHint}), retrying in ${Math.round(delay / 1000)}s`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

// simple sleep utility
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// create a retryable version of an async function
export function retryable<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: RetryOptions
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => withRetry(() => fn(...args), options);
}
