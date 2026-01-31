import { z } from "zod";
import { spawn } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { debug } from "../utils/debug.ts";

// only enable when running inside docker container
export const DOCKER_ENV = process.env.CRUSTY_DOCKER === "true";

// blocked commands and patterns - destructive or privilege escalation
const BLOCKED_PATTERNS = [
  // privilege escalation
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bdoas\b/i,
  /\bpkexec\b/i,
  
  // destructive filesystem ops
  /\brm\s+(-[a-z]*)?.*(\s+\/|\s+~|\s+\.\.)/, // rm with root/home/parent paths
  /\brm\s+-[a-z]*r[a-z]*f/i, // rm -rf variants
  /\brm\s+-[a-z]*f[a-z]*r/i, // rm -fr variants
  /\bmkfs\b/i,
  /\bdd\s+.*of\s*=\s*\/dev/i, // dd to devices
  /\bshred\b/i,
  /\bwipe\b/i,
  
  // system control
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\binit\s+[0-6]/i,
  /\bsystemctl\s+(reboot|poweroff|halt)/i,
  
  // dangerous system modifications
  /\bchmod\s+.*777/i,
  /\bchown\s+.*\//i, // chown on root paths
  /\b>\s*\/dev\/sd[a-z]/i, // writing to block devices
  /\b>\s*\/etc\//i, // overwriting etc files
  /\b>\s*\/boot\//i, // overwriting boot files
  
  // network/firewall manipulation
  /\biptables\s+-F/i, // flush iptables
  /\bufw\s+disable/i,
  
  // package manager with remove
  /\bapt\s+.*remove/i,
  /\bapt-get\s+.*remove/i,
  /\bdpkg\s+--purge/i,
  
  // fork bombs and resource exhaustion
  /:\(\)\s*{\s*:\|:\s*&\s*}\s*;?\s*:/,
  /\bfork\s*\(\)/i,
];

function isCommandBlocked(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Command blocked: matches restricted pattern ${pattern.toString()}`;
    }
  }
  return null;
}

const BashExecuteSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .coerce.number()
    .optional()
    .describe("Timeout in milliseconds (default: 30000, max: 120000)"),
  workdir: z
    .string()
    .optional()
    .describe("Working directory for command execution (default: /app)"),
});

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function getShellCandidates(): string[] {
  const candidates: string[] = [];

  if (process.env.CRUSTY_SHELL?.trim()) {
    candidates.push(process.env.CRUSTY_SHELL.trim());
  }

  candidates.push("/bin/bash");
  candidates.push("/usr/bin/bash");
  candidates.push("bash");
  candidates.push("/bin/sh");
  candidates.push("/usr/bin/sh");
  candidates.push("sh");

  return [...new Set(candidates)];
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function executeCommand(
  command: string,
  timeout: number = 30000,
  workdir: string = "/app"
): Promise<CommandResult> {
  const maxTimeout = 120000;
  const actualTimeout = Math.min(timeout, maxTimeout);

  const actualWorkdir = existsSync(workdir) ? workdir : process.cwd();

  const candidates = getShellCandidates().filter((candidate) => {
    if (candidate.startsWith("/")) return isExecutableFile(candidate);
    return true;
  });

  const executeWithShell = async (
    shell: string
  ): Promise<{ result: CommandResult; missingShell: boolean }> => {
    return await new Promise((resolve) => {
      const proc = spawn(shell, ["-c", command], {
        cwd: actualWorkdir,
        env: process.env,
        timeout: actualTimeout,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, actualTimeout);

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeoutId);
        resolve({
          result: {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code,
            timedOut,
          },
          missingShell: false,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({
          result: {
            stdout: "",
            stderr: err.message,
            exitCode: 1,
            timedOut: false,
          },
          missingShell: (err as NodeJS.ErrnoException).code === "ENOENT",
        });
      });
    });
  };

  let lastResult: CommandResult | null = null;

  for (const shell of candidates) {
    const { result, missingShell } = await executeWithShell(shell);
    lastResult = result;

    if (missingShell) {
      debug(`[bash] shell not found: ${shell}`);
      continue;
    }

    debug(`[bash] executing via ${shell}: ${command}`);
    return result;
  }

  return (
    lastResult ?? {
      stdout: "",
      stderr: "no usable shell found",
      exitCode: 1,
      timedOut: false,
    }
  );
}

// truncate output to prevent massive responses
function truncateOutput(output: string, maxLength: number = 4000): string {
  if (output.length <= maxLength) return output;
  const half = Math.floor(maxLength / 2);
  return `${output.slice(0, half)}\n\n... [truncated ${output.length - maxLength} characters] ...\n\n${output.slice(-half)}`;
}

export const bashTools = {
  bash_execute: {
    description: `Execute an arbitrary shell command in the terminal (prefers bash when available, falls back to sh). This is your primary tool for running shell commands, scripts, and system utilities.

WHEN TO USE:
- Running programs or scripts (python, node, bun, etc.)
- Installing packages (apt install, bun add, pip install)
- Searching file contents (grep, find, etc.)
- Checking system state (ps, df, free, env)
- Chaining multiple commands together with && or |
- Any command not covered by the specialized file tools below

PARAMETERS:
- command (required): The full bash command to run. Can include pipes, redirects, and chained commands.
- timeout (optional): Max execution time in ms. Default 30000 (30s), max 120000 (2min). Use higher values for long-running tasks.
- workdir (optional): Directory to run the command in. Default is /app (the project root directory).

BLOCKED: sudo, rm -rf, reboot, shutdown, and other destructive/privilege escalation commands are blocked for safety.

EXAMPLES:
- "grep -r 'TODO' ." to search for TODOs
- "bun run build" to run a build script
- "ps aux | grep node" to find node processes
- "cat package.json | jq '.dependencies'" to inspect JSON`,
    schema: BashExecuteSchema,
    handler: async (args: z.infer<typeof BashExecuteSchema>, _userId: number) => {
      if (!DOCKER_ENV) {
        return "[Error] bash_execute is only available when shell access is enabled.";
      }

      const blocked = isCommandBlocked(args.command);
      if (blocked) {
        return `[Error] ${blocked}`;
      }

      const result = await executeCommand(
        args.command,
        args.timeout ?? 30000,
        args.workdir ?? "/app"
      );

      if (result.timedOut) {
        return `[Timeout] Command exceeded timeout limit.\n\nPartial stdout:\n${truncateOutput(result.stdout)}\n\nPartial stderr:\n${truncateOutput(result.stderr)}`;
      }

      const parts: string[] = [];

      if (result.stdout) {
        parts.push(`stdout:\n\`\`\`\n${truncateOutput(result.stdout)}\n\`\`\``);
      }

      if (result.stderr) {
        parts.push(`stderr:\n\`\`\`\n${truncateOutput(result.stderr)}\n\`\`\``);
      }

      parts.push(`exit code: ${result.exitCode}`);

      return parts.join("\n\n") || "Command completed with no output.";
    },
  },

  bash_read_file: {
    description: `Read the contents of a file from the filesystem. Use this instead of bash_execute with cat when you just need to view a file's contents.

WHEN TO USE:
- Viewing configuration files (package.json, .env, tsconfig.json, etc.)
- Reading source code files to understand their contents
- Checking log files or output files
- Any time you need to see what's inside a single file

PARAMETERS:
- path (required): The absolute path to the file, e.g. "/app/package.json" or "/app/src/index.ts"
- lines (optional): Only read the first N lines. Useful for large files or log files where you only need the beginning.

OUTPUT: Returns the file contents wrapped in a code block. Large files are automatically truncated to prevent massive responses.

EXAMPLES:
- path: "/app/package.json" to read the package manifest
- path: "/app/.env" to check environment configuration
- path: "/var/log/app.log", lines: 50 to read the first 50 lines of a log`,
    schema: z.object({
      path: z
        .string()
        .describe(
          "Absolute path to the file to read, e.g. /app/package.json or /app/src/index.ts"
        ),
      lines: z
        .coerce.number()
        .optional()
        .describe(
          "Only read the first N lines from the file. Omit to read the entire file. Useful for large files."
        ),
    }),
    handler: async (args: { path: string; lines?: number }, _userId: number) => {
      if (!DOCKER_ENV) {
        return "[Error] bash_read_file is only available when shell access is enabled.";
      }

      const cmd = args.lines ? `head -n ${args.lines} "${args.path}"` : `cat "${args.path}"`;

      const result = await executeCommand(cmd);

      if (result.exitCode !== 0) {
        return `[Error] Failed to read file: ${result.stderr || "Unknown error"}`;
      }

      return `\`\`\`\n${truncateOutput(result.stdout)}\n\`\`\``;
    },
  },

  bash_write_file: {
    description: `Write content to a file on the filesystem. Creates the file if it does not exist. By default, overwrites the entire file.

WHEN TO USE:
- Creating new files (scripts, configs, source code, etc.)
- Updating/replacing existing file contents
- Adding content to the end of a file (use append: true)
- Saving output or generated content to disk

PARAMETERS:
- path (required): Absolute path where the file should be written, e.g. "/app/output.txt" or "/app/src/newfile.ts"
- content (required): The full text content to write. This is written exactly as provided, including whitespace and newlines.
- append (optional): Set to true to ADD content to the end of an existing file instead of replacing it. Default is false (overwrite).

BEHAVIOR:
- If append is false (default): File is completely replaced with new content
- If append is true: Content is added to the end of the existing file
- Parent directories must already exist (use bash_execute with mkdir -p first if needed)

EXAMPLES:
- path: "/app/test.sh", content: "#!/bin/bash\\necho hello" to create a shell script
- path: "/app/notes.txt", content: "new entry\\n", append: true to add a line to a log`,
    schema: z.object({
      path: z
        .string()
        .describe(
          "Absolute path where the file should be written, e.g. /app/output.txt or /app/src/newfile.ts"
        ),
      content: z
        .string()
        .describe(
          "The full text content to write to the file. Written exactly as provided including all whitespace and newlines."
        ),
      append: z
        .coerce.boolean()
        .optional()
        .describe(
          "Set to true to ADD content to the END of an existing file. Default false means the file is completely replaced/overwritten."
        ),
    }),
    handler: async (
      args: { path: string; content: string; append?: boolean },
      _userId: number
    ) => {
      if (!DOCKER_ENV) {
        return "[Error] bash_write_file is only available when shell access is enabled.";
      }

      // use heredoc to handle special characters safely
      const operator = args.append ? ">>" : ">";
      const cmd = `cat ${operator} "${args.path}" << 'CRUSTY_EOF'\n${args.content}\nCRUSTY_EOF`;

      const result = await executeCommand(cmd);

      if (result.exitCode !== 0) {
        return `[Error] Failed to write file: ${result.stderr || "Unknown error"}`;
      }

      return `done: wrote ${args.content.length} bytes to ${args.path}`;
    },
  },

  bash_list_dir: {
    description: `List the contents of a directory, showing files and subdirectories with their details (permissions, size, modification date).

WHEN TO USE:
- Exploring the filesystem to understand project structure
- Finding files in a directory before reading or modifying them
- Checking what files exist before creating new ones
- Verifying file permissions or ownership

PARAMETERS:
- path (required): The directory path to list, e.g. "/app" or "/app/src". Must be a directory, not a file.
- all (optional): Set to true to include hidden files (files starting with a dot like .env, .gitignore). Default is false.

OUTPUT: Returns an ls -l style listing showing:
- File type and permissions (drwxr-xr-x, -rw-r--r--, etc.)
- Owner and group
- File size in bytes
- Last modification date
- Filename

EXAMPLES:
- path: "/app" to list the project root directory
- path: "/app/src", all: true to list source files including hidden ones like .eslintrc
- path: "/etc" to explore system configuration directory`,
    schema: z.object({
      path: z
        .string()
        .describe(
          "The directory path to list, e.g. /app or /app/src. Must be a directory, not a file."
        ),
      all: z
        .coerce.boolean()
        .optional()
        .describe(
          "Set to true to include hidden files (dotfiles like .env, .gitignore). Default is false, which hides dotfiles."
        ),
    }),
    handler: async (args: { path: string; all?: boolean }, _userId: number) => {
      if (!DOCKER_ENV) {
        return "[Error] bash_list_dir is only available when shell access is enabled.";
      }

      const flags = args.all ? "-la" : "-l";
      const result = await executeCommand(`ls ${flags} "${args.path}"`);

      if (result.exitCode !== 0) {
        return `[Error] Failed to list directory: ${result.stderr || "Unknown error"}`;
      }

      return `\`\`\`\n${truncateOutput(result.stdout)}\n\`\`\``;
    },
  },
};

export async function cleanupBash(): Promise<void> {
  // nothing persistent to clean up
  debug("[bash] cleanup called (no-op)");
}

export type BashTools = typeof bashTools;
