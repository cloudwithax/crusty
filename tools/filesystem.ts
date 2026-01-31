import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { debug } from "../utils/debug.ts";

// nanocode-inspired minimal filesystem tools
// read, write, edit, glob, grep - nothing more

const MAX_OUTPUT = 8000;

function truncate(text: string, max: number = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n... [${text.length - max} chars truncated] ...\n\n${text.slice(-half)}`;
}

// read file with optional line range
const ReadSchema = z.object({
  path: z.string().describe("absolute path to file"),
  offset: z.number().optional().describe("start line (0-indexed)"),
  limit: z.number().optional().describe("max lines to read"),
});

async function read(args: z.infer<typeof ReadSchema>): Promise<string> {
  try {
    const lines = readFileSync(args.path, "utf-8").split("\n");
    const offset = args.offset ?? 0;
    const limit = args.limit ?? lines.length;
    const selected = lines.slice(offset, offset + limit);
    
    // line-numbered output like nanocode
    const numbered = selected
      .map((line, idx) => `${String(offset + idx + 1).padStart(4)}| ${line}`)
      .join("\n");
    
    return truncate(numbered);
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// write file (overwrite)
const WriteSchema = z.object({
  path: z.string().describe("absolute path to file"),
  content: z.string().describe("content to write"),
});

async function write(args: z.infer<typeof WriteSchema>): Promise<string> {
  try {
    writeFileSync(args.path, args.content);
    return "ok";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// edit file (replace old with new)
const EditSchema = z.object({
  path: z.string().describe("absolute path to file"),
  old: z.string().describe("text to find (must be unique unless all=true)"),
  new: z.string().describe("replacement text"),
  all: z.boolean().optional().describe("replace all occurrences"),
});

async function edit(args: z.infer<typeof EditSchema>): Promise<string> {
  try {
    const text = readFileSync(args.path, "utf-8");
    
    if (!text.includes(args.old)) {
      return "error: old_string not found";
    }
    
    const count = text.split(args.old).length - 1;
    if (!args.all && count > 1) {
      return `error: old_string appears ${count} times, must be unique (use all=true)`;
    }
    
    const replacement = args.all
      ? text.replaceAll(args.old, args.new)
      : text.replace(args.old, args.new);
    
    writeFileSync(args.path, replacement);
    return "ok";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// glob - find files by pattern, sorted by mtime
const GlobSchema = z.object({
  pat: z.string().describe("glob pattern like **/*.ts"),
  path: z.string().optional().describe("base directory (default: cwd)"),
});

function walkDir(dir: string, pattern: RegExp, results: { path: string; mtime: number }[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // skip node_modules and .git
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walkDir(fullPath, pattern, results);
      } else if (pattern.test(entry.name)) {
        try {
          const stat = statSync(fullPath);
          results.push({ path: fullPath, mtime: stat.mtimeMs });
        } catch {
          // skip files we cant stat
        }
      }
    }
  } catch {
    // skip dirs we cant read
  }
}

function globPatternToRegex(pattern: string): RegExp {
  // simple glob to regex: * -> [^/]*, ** -> .*, ? -> .
  const escaped = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

async function glob(args: z.infer<typeof GlobSchema>): Promise<string> {
  try {
    const basePath = args.path || process.cwd();
    const pattern = globPatternToRegex(args.pat.split("/").pop() || "*");
    const results: { path: string; mtime: number }[] = [];
    
    walkDir(basePath, pattern, results);
    
    // sort by mtime descending
    results.sort((a, b) => b.mtime - a.mtime);
    
    const paths = results.slice(0, 50).map((r) => relative(basePath, r.path) || r.path);
    return paths.join("\n") || "none";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// grep - search files for regex pattern
const GrepSchema = z.object({
  pat: z.string().describe("regex pattern to search"),
  path: z.string().optional().describe("file or directory to search (default: cwd)"),
});

function grepFile(filePath: string, pattern: RegExp): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const hits: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        hits.push(`${filePath}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
        if (hits.length >= 10) break; // max 10 per file
      }
    }
    return hits;
  } catch {
    return [];
  }
}

function grepDir(dir: string, pattern: RegExp, results: string[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= 100) break;
      
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        grepDir(fullPath, pattern, results);
      } else {
        // only search text-ish files
        const ext = entry.name.split(".").pop()?.toLowerCase() || "";
        const textExts = ["ts", "tsx", "js", "jsx", "json", "md", "txt", "yaml", "yml", "toml", "sh", "bash", "py", "go", "rs", "html", "css", "scss", "svelte", "vue"];
        if (textExts.includes(ext) || !entry.name.includes(".")) {
          results.push(...grepFile(fullPath, pattern));
        }
      }
    }
  } catch {
    // skip unreadable dirs
  }
}

async function grep(args: z.infer<typeof GrepSchema>): Promise<string> {
  try {
    const pattern = new RegExp(args.pat, "i");
    const target = args.path || process.cwd();
    const results: string[] = [];
    
    const stat = statSync(target);
    if (stat.isFile()) {
      results.push(...grepFile(target, pattern));
    } else {
      grepDir(target, pattern, results);
    }
    
    return truncate(results.join("\n") || "no matches");
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// export as tool definitions
export const filesystemTools = {
  read: {
    description: "read file contents with optional line range. returns line-numbered output.",
    schema: ReadSchema,
    handler: read,
  },
  write: {
    description: "write content to file (overwrites existing).",
    schema: WriteSchema,
    handler: write,
  },
  edit: {
    description: "replace old text with new in file. old must be unique unless all=true.",
    schema: EditSchema,
    handler: edit,
  },
  glob: {
    description: "find files by glob pattern, sorted by modification time.",
    schema: GlobSchema,
    handler: glob,
  },
  grep: {
    description: "search files for regex pattern. returns file:line: match format.",
    schema: GrepSchema,
    handler: grep,
  },
};

export async function cleanupFilesystem(): Promise<void> {
  debug("[filesystem] cleanup (no-op)");
}
