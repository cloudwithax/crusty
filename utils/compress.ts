// utils/compress.ts
// compresses tool output to reduce context bloat

import { debug } from "./debug.ts";

export interface CompressionOptions {
  maxLength?: number;
  preserveStart?: number;
  preserveEnd?: number;
  summarizeMiddle?: boolean;
}

const DEFAULT_OPTIONS: Required<CompressionOptions> = {
  maxLength: 2000,
  preserveStart: 500,
  preserveEnd: 300,
  summarizeMiddle: true,
};

// compress tool output while preserving key information
export function compressToolOutput(
  output: string,
  toolName: string,
  options?: CompressionOptions
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // already small enough
  if (output.length <= opts.maxLength) {
    return output;
  }

  // tool-specific compression strategies
  const strategy = getCompressionStrategy(toolName);

  if (strategy) {
    const compressed = strategy(output, opts);
    if (compressed.length <= opts.maxLength) {
      debug(
        `[compress] ${toolName}: ${output.length} -> ${compressed.length} chars (strategy)`
      );
      return compressed;
    }
  }

  // fallback: truncate with ellipsis
  const start = output.slice(0, opts.preserveStart);
  const end = output.slice(-opts.preserveEnd);
  const omittedChars = output.length - opts.preserveStart - opts.preserveEnd;

  const compressed = `${start}\n\n[... ${omittedChars} characters omitted ...]\n\n${end}`;
  debug(
    `[compress] ${toolName}: ${output.length} -> ${compressed.length} chars (truncate)`
  );
  return compressed;
}

// get tool-specific compression strategy
function getCompressionStrategy(
  toolName: string
): ((output: string, opts: Required<CompressionOptions>) => string) | null {
  const strategies: Record<
    string,
    (output: string, opts: Required<CompressionOptions>) => string
  > = {
    // browser tools - extract key content
    browser_read: (output, opts) => {
      // extract title and main content, skip navigation/footer
      const lines = output.split("\n");
      const meaningful = lines.filter((line) => {
        const trimmed = line.trim();
        // skip empty lines and short navigation-like lines
        if (trimmed.length < 10) return false;
        // skip common navigation patterns
        if (
          /^(home|about|contact|menu|nav|footer|cookie|privacy|terms)/i.test(
            trimmed
          )
        )
          return false;
        return true;
      });

      // take first N meaningful lines
      const maxLines = Math.floor(opts.maxLength / 80);
      return meaningful.slice(0, maxLines).join("\n");
    },

    // file reads - preserve structure
    read: (output, opts) => {
      const lines = output.split("\n");
      if (lines.length <= 50) return output;

      // keep first 30 and last 10 lines
      const head = lines.slice(0, 30).join("\n");
      const tail = lines.slice(-10).join("\n");
      const omitted = lines.length - 40;

      return `${head}\n\n[... ${omitted} lines omitted ...]\n\n${tail}`;
    },

    // bash output - focus on results
    bash_execute: (output, opts) => {
      const lines = output.split("\n");

      // check for error patterns at end
      const lastLines = lines.slice(-20);
      const hasError = lastLines.some((l) =>
        /error|failed|exception|traceback/i.test(l)
      );

      if (hasError) {
        // preserve error context
        return lines.slice(-30).join("\n");
      }

      // otherwise take head and tail
      if (lines.length > 40) {
        const head = lines.slice(0, 20).join("\n");
        const tail = lines.slice(-15).join("\n");
        return `${head}\n\n[... ${lines.length - 35} lines omitted ...]\n\n${tail}`;
      }

      return output;
    },

    // web search - extract snippets only
    web_search: (output, opts) => {
      // extract just the title and snippet from each result
      const results: string[] = [];
      const resultPattern = /(?:^|\n)(\d+\.\s+.+?)(?=\n\d+\.|$)/gs;
      let match;

      while ((match = resultPattern.exec(output)) !== null) {
        const result = match[1]!.trim();
        // take first 200 chars of each result
        results.push(result.slice(0, 200));
        if (results.length >= 5) break;
      }

      return results.length > 0
        ? results.join("\n\n")
        : output.slice(0, opts.maxLength);
    },

    // glob/list - show sample of results
    bash_list_dir: (output, opts) => {
      const lines = output.split("\n").filter((l) => l.trim());
      if (lines.length <= 30) return output;

      const head = lines.slice(0, 20).join("\n");
      return `${head}\n\n... and ${lines.length - 20} more files`;
    },

    glob: (output, opts) => {
      const lines = output.split("\n").filter((l) => l.trim());
      if (lines.length <= 30) return output;

      const head = lines.slice(0, 25).join("\n");
      return `${head}\n\n... and ${lines.length - 25} more matches`;
    },

    // deep research output is already synthesized, keep most of it
    deep_research: (output, opts) => {
      if (output.length <= 8000) return output;
      return output.slice(0, 8000) + "\n\n[report truncated for context management]";
    },
  };

  return strategies[toolName] || null;
}

// extract key information from tool results for logging
export function extractToolSummary(toolName: string, output: string): string {
  const maxLen = 100;

  // error detection
  if (/^error:/i.test(output)) {
    return output.slice(0, maxLen);
  }

  // success indicators
  if (output.includes("success") || output.includes("completed")) {
    const match = output.match(/(success|completed)[^\n]*/i);
    if (match) return match[0].slice(0, maxLen);
  }

  // first meaningful line
  const firstLine = output.split("\n").find((l) => l.trim().length > 10);
  return (firstLine || output).slice(0, maxLen);
}
