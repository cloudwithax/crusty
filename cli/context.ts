import { existsSync } from "fs";
import { join } from "path";
import {
  loadConfig,
  getBootstrapFiles,
  loadBootstrapFile,
  type InjectionResult,
} from "../core/bootstrap.ts";

const COGS_PATH = join(import.meta.dir, "..", "cogs");

// Simple prompt function for Bun
async function prompt(question: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  return new Promise((resolve) => {
    stdout.write(`${question}: `);

    let input = "";

    const onData = (data: Buffer) => {
      const char = data.toString();

      if (char === "\n" || char === "\r") {
        stdout.write("\n");
        stdin.removeListener("data", onData);
        resolve(input.trim());
      } else if (char === "\u0003") {
        process.exit();
      } else if (char === "\u007F") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write("\b \b");
        }
      } else {
        input += char;
        stdout.write(char);
      }
    };

    stdin.on("data", onData);
  });
}

// Format file size for display
function formatChars(chars: number): string {
  return chars.toLocaleString();
}

// List all context files with their stats
async function listContext(): Promise<void> {
  console.log("\n=== Context Files ===\n");

  const config = loadConfig();
  const files = getBootstrapFiles();

  console.log(`Bootstrap Max Chars: ${formatChars(config.bootstrapMaxChars)}\n`);

  // Load all bootstrap files
  const results = await Promise.all(
    files.map((file) => loadBootstrapFile(file, config.bootstrapMaxChars)),
  );

  // Also check cogs directory files
  const cogFiles = ["identity", "memory", "runtime", "soul"];
  const cogResults: InjectionResult[] = [];

  for (const cogName of cogFiles) {
    const cogPath = join(COGS_PATH, `${cogName}.md`);
    // Check case-insensitively for the file
    const cogDir = require("fs").readdirSync(COGS_PATH);
    const actualFile = cogDir.find(
      (f: string) => f.toLowerCase() === `${cogName}.md`.toLowerCase(),
    );

    if (actualFile) {
      const actualPath = join(COGS_PATH, actualFile);
      const file = Bun.file(actualPath);
      const content = await file.text();
      cogResults.push({
        name: `cogs/${actualFile}`,
        content,
        rawChars: content.length,
        injectedChars: content.length,
        truncated: false,
        missing: false,
      });
    } else {
      cogResults.push({
        name: `cogs/${cogName}.md`,
        content: "",
        rawChars: 0,
        injectedChars: 0,
        truncated: false,
        missing: true,
      });
    }
  }

  // Display bootstrap files
  console.log("Bootstrap Files:");
  console.log("-".repeat(70));
  console.log(
    `${"File".padEnd(20)} ${"Raw".padStart(10)} ${"Injected".padStart(10)} ${"Status".padStart(15)}`,
  );
  console.log("-".repeat(70));

  for (const result of results) {
    const status = result.missing
      ? "missing"
      : result.truncated
        ? "truncated"
        : "ok";
    console.log(
      `${result.name.padEnd(20)} ${formatChars(result.rawChars).padStart(10)} ${formatChars(result.injectedChars).padStart(10)} ${status.padStart(15)}`,
    );
  }

  // Display cog files
  console.log("\nCog Files:");
  console.log("-".repeat(70));
  console.log(
    `${"File".padEnd(20)} ${"Raw".padStart(10)} ${"Injected".padStart(10)} ${"Status".padStart(15)}`,
  );
  console.log("-".repeat(70));

  for (const result of cogResults) {
    const status = result.missing ? "missing" : "ok";
    console.log(
      `${result.name.padEnd(20)} ${formatChars(result.rawChars).padStart(10)} ${formatChars(result.injectedChars).padStart(10)} ${status.padStart(15)}`,
    );
  }

  // Summary
  const totalRaw = [...results, ...cogResults].reduce(
    (sum, r) => sum + r.rawChars,
    0,
  );
  const totalInjected = [...results, ...cogResults].reduce(
    (sum, r) => sum + r.injectedChars,
    0,
  );

  console.log("-".repeat(70));
  console.log(
    `${"TOTAL".padEnd(20)} ${formatChars(totalRaw).padStart(10)} ${formatChars(totalInjected).padStart(10)}`,
  );
  console.log();
}

// Show detailed view of a specific file
async function showContextDetail(filename: string): Promise<void> {
  console.log(`\n=== Context Detail: ${filename} ===\n`);

  const config = loadConfig();

  // Determine file path
  let filePath: string;
  if (filename.startsWith("cogs/")) {
    filePath = join(COGS_PATH, filename.replace("cogs/", ""));
  } else {
    filePath = join(process.cwd(), filename);
  }

  // Check if it's a bootstrap file
  const bootstrapFiles = getBootstrapFiles();
  const isBootstrapFile = bootstrapFiles.some((f) => f.name === filename);

  if (isBootstrapFile) {
    const file = bootstrapFiles.find((f) => f.name === filename)!;
    const result = await loadBootstrapFile(file, config.bootstrapMaxChars);

    console.log(`File: ${result.name}`);
    console.log(`Path: ${file.path}`);
    console.log(`Raw Characters: ${formatChars(result.rawChars)}`);
    console.log(`Injected Characters: ${formatChars(result.injectedChars)}`);
    console.log(`Truncated: ${result.truncated ? "yes" : "no"}`);
    console.log(`Missing: ${result.missing ? "yes" : "no"}`);
    console.log();
    console.log("=".repeat(70));
    console.log("INJECTED CONTENT:");
    console.log("=".repeat(70));
    console.log();
    console.log(result.content);
    console.log();
    console.log("=".repeat(70));
  } else if (existsSync(filePath)) {
    const file = Bun.file(filePath);
    const content = await file.text();

    console.log(`File: ${filename}`);
    console.log(`Path: ${filePath}`);
    console.log(`Raw Characters: ${formatChars(content.length)}`);
    console.log(`Injected Characters: ${formatChars(content.length)}`);
    console.log(`Truncated: no`);
    console.log(`Missing: no`);
    console.log();
    console.log("=".repeat(70));
    console.log("CONTENT:");
    console.log("=".repeat(70));
    console.log();
    console.log(content);
    console.log();
    console.log("=".repeat(70));
  } else {
    console.log(`File not found: ${filename}`);
    console.log(`Checked path: ${filePath}`);
  }

  console.log();
}

// Show full system prompt preview
async function showSystemPrompt(): Promise<void> {
  console.log("\n=== System Prompt Preview ===\n");

  const { loadBootstrapSystem } = await import("../core/bootstrap.ts");

  // Build core instructions similar to agent.ts
  const now = new Date();
  const timeString = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  // Load cogs
  const loadCog = (cogName: string): string => {
    try {
      const cogPath = join(COGS_PATH, `${cogName}.md`);
      const content = require("fs").readFileSync(cogPath, "utf-8");
      return content.replace(/^# .*\n+/, "").trim();
    } catch {
      return "";
    }
  };

  const identityCog = loadCog("identity");
  const memoryCog = loadCog("memory");
  const runtimeCog = loadCog("runtime");

  const processedRuntimeCog = runtimeCog
    .replace(/\{\{CURRENT_TIME\}\}/g, timeString)
    .replace(/\{\{WORKING_DIR\}\}/g, process.cwd());

  const coreInstructions = `# Identity\n\n${identityCog}\n\n# Memory\n\n${memoryCog}\n\n# Runtime\n\n${processedRuntimeCog}`;

  const { prompt, results } = await loadBootstrapSystem(coreInstructions);

  console.log(`Total Prompt Length: ${formatChars(prompt.length)} characters\n`);

  console.log("Bootstrap Injection Order:");
  console.log("-".repeat(50));
  for (const result of results) {
    const status = result.missing
      ? "[missing]"
      : result.truncated
        ? "[truncated]"
        : "";
    console.log(`  ${result.name} (${formatChars(result.injectedChars)} chars) ${status}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("FULL SYSTEM PROMPT:");
  console.log("=".repeat(70));
  console.log();
  console.log(prompt);
  console.log();
  console.log("=".repeat(70));
  console.log();
}

// Main CLI handler
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "list") {
    await listContext();
  } else if (command === "detail") {
    const filename = args[1];
    if (!filename) {
      console.log("Usage: bun cli/context.ts detail <filename>");
      console.log("Example: bun cli/context.ts detail SOUL.md");
      console.log("Example: bun cli/context.ts detail cogs/identity.md");
      process.exit(1);
    }
    await showContextDetail(filename);
  } else if (command === "prompt") {
    await showSystemPrompt();
  } else {
    console.log("Unknown command. Available commands:");
    console.log("  list              - Show all context files with stats");
    console.log("  detail <filename> - Show injected rendering with markers");
    console.log("  prompt            - Show full system prompt preview");
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}
