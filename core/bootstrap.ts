import { existsSync } from "fs";
import { join } from "path";
import { skillRegistry } from "./skills.ts";

// configuration interface
export interface BootstrapConfig {
  bootstrapMaxChars: number;
  hooks: {
    soulEvil: {
      enabled: boolean;
      chance: number;
      window?: {
        start: string;
        end: string;
        timezone: string;
      };
    };
  };
}

// bootstrap file definition
export interface BootstrapFile {
  name: string;
  path: string;
  required: boolean;
}

// injection result
export interface InjectionResult {
  name: string;
  content: string;
  rawChars: number;
  injectedChars: number;
  truncated: boolean;
  missing: boolean;
}

// default configuration values
const DEFAULT_MAX_CHARS = 20000;
const DEFAULT_SOUL_EVIL_CHANCE = 0.1;
const DEFAULT_SOUL_EVIL_WINDOW_START = "22:00";
const DEFAULT_SOUL_EVIL_WINDOW_END = "06:00";
const DEFAULT_SOUL_EVIL_TIMEZONE = "America/New_York";

// bootstrap file order (soul.md -> tools.md -> identity.md -> user.md -> heartbeat.md -> bootstrap.md)
const BOOTSTRAP_FILE_ORDER = [
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];

// load configuration from environment variables with defaults
export function loadConfig(): BootstrapConfig {
  const maxChars = parseInt(
    process.env.AGENTS_BOOTSTRAP_MAX_CHARS || String(DEFAULT_MAX_CHARS),
    10,
  );

  const soulEvilEnabled =
    process.env.AGENTS_SOUL_EVIL_ENABLED === "true";
  const soulEvilChance = parseFloat(
    process.env.AGENTS_SOUL_EVIL_CHANCE || String(DEFAULT_SOUL_EVIL_CHANCE),
  );
  const soulEvilWindowStart =
    process.env.AGENTS_SOUL_EVIL_WINDOW_START ||
    DEFAULT_SOUL_EVIL_WINDOW_START;
  const soulEvilWindowEnd =
    process.env.AGENTS_SOUL_EVIL_WINDOW_END || DEFAULT_SOUL_EVIL_WINDOW_END;
  const soulEvilTimezone =
    process.env.AGENTS_SOUL_EVIL_TIMEZONE || DEFAULT_SOUL_EVIL_TIMEZONE;

  return {
    bootstrapMaxChars: isNaN(maxChars) ? DEFAULT_MAX_CHARS : maxChars,
    hooks: {
      soulEvil: {
        enabled: soulEvilEnabled,
        chance: isNaN(soulEvilChance) ? DEFAULT_SOUL_EVIL_CHANCE : soulEvilChance,
        window: {
          start: soulEvilWindowStart,
          end: soulEvilWindowEnd,
          timezone: soulEvilTimezone,
        },
      },
    },
  };
}

// get list of bootstrap files in priority order
export function getBootstrapFiles(): BootstrapFile[] {
  const baseDir = process.cwd();
  const cogsDir = join(baseDir, "cogs");

  return BOOTSTRAP_FILE_ORDER.map((name) => {
    // soul.md, heartbeat.md, and identity.md live in cogs directory
    const isCogFile = name === "SOUL.md" || name === "HEARTBEAT.md" || name === "IDENTITY.md";
    const filePath = isCogFile ? join(cogsDir, name) : join(baseDir, name);

    return {
      name,
      path: filePath,
      required: name === "SOUL.md",
    };
  });
}

// check if current time is within the soul-evil window
function isInSoulEvilWindow(config: BootstrapConfig): boolean {
  const window = config.hooks.soulEvil.window;
  if (!window) return false;

  try {
    const now = new Date();
    const timeString = now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      timeZone: window.timezone,
    });

    const [currentHour, currentMinute] = timeString.split(":").map(Number);
    const [startHour, startMinute] = window.start.split(":").map(Number);
    const [endHour, endMinute] = window.end.split(":").map(Number);

    const currentMinutes = (currentHour || 0) * 60 + (currentMinute || 0);
    const startMinutes = (startHour || 0) * 60 + (startMinute || 0);
    const endMinutes = (endHour || 0) * 60 + (endMinute || 0);

    // handle overnight windows (e.g., 22:00 to 06:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } catch {
    return false;
  }
}

// substitute template variables in content
function substituteTemplateVars(content: string): string {
  const now = new Date();
  const timezone = process.env.HEARTBEAT_TIMEZONE || "America/New_York";

  const replacements: Record<string, string> = {
    "{{CURRENT_TIME}}": now.toLocaleTimeString("en-US", { hour12: true, timeZone: timezone }),
    "{{CURRENT_DATE}}": now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: timezone }),
    "{{CURRENT_DATETIME}}": now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: timezone }),
    "{{CURRENT_TIMESTAMP}}": now.toISOString(),
    "{{TIMEZONE}}": timezone,
    "{{WORKING_DIR}}": process.cwd(),
  };

  let result = content;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

// helper to read file content with truncation
async function readFileWithTruncation(
  filePath: string,
  fileName: string,
  maxChars: number,
): Promise<InjectionResult> {
  const fileObj = Bun.file(filePath);
  let rawContent = await fileObj.text();
  rawContent = substituteTemplateVars(rawContent);
  const rawChars = rawContent.length;

  if (rawContent.length > maxChars) {
    const truncatedContent = rawContent.substring(0, maxChars);
    const truncationMarker = `... [truncated: ${rawChars} -> ${maxChars}]`;
    const finalContent = truncatedContent + truncationMarker;

    return {
      name: fileName,
      content: finalContent,
      rawChars,
      injectedChars: finalContent.length,
      truncated: true,
      missing: false,
    };
  }

  return {
    name: fileName,
    content: rawContent,
    rawChars,
    injectedChars: rawChars,
    truncated: false,
    missing: false,
  };
}

// load a single bootstrap file with truncation handling
export async function loadBootstrapFile(
  file: BootstrapFile,
  maxChars: number,
): Promise<InjectionResult> {
  // check if file exists
  if (!existsSync(file.path)) {
    // for soul.md, create from template if missing
    if (file.name === "SOUL.md") {
      await ensureSoulTemplate();
      // retry after template creation
      if (existsSync(file.path)) {
        return readFileWithTruncation(file.path, file.name, maxChars);
      }
    }

    return {
      name: file.name,
      content: `[missing file: ${file.name}]`,
      rawChars: 0,
      injectedChars: `[missing file: ${file.name}]`.length,
      truncated: false,
      missing: true,
    };
  }

  try {
    return await readFileWithTruncation(file.path, file.name, maxChars);
  } catch {
    return {
      name: file.name,
      content: `[missing file: ${file.name}]`,
      rawChars: 0,
      injectedChars: `[missing file: ${file.name}]`.length,
      truncated: false,
      missing: true,
    };
  }
}

// apply hooks to bootstrap files (e.g., soul-evil swap)
export async function applyHooks(
  files: InjectionResult[],
  config: BootstrapConfig,
): Promise<InjectionResult[]> {
  // check if soul-evil hook should activate
  const soulEvilShouldActivate =
    config.hooks.soulEvil.enabled &&
    isInSoulEvilWindow(config) &&
    Math.random() < config.hooks.soulEvil.chance;

  if (!soulEvilShouldActivate) {
    return files;
  }

  // look for soul_evil.md file in project root or cogs directory
  const rootPath = join(process.cwd(), "SOUL_EVIL.md");
  const cogsPath = join(process.cwd(), "cogs", "SOUL_EVIL.md");
  const soulEvilPath = existsSync(rootPath) ? rootPath : cogsPath;
  if (!existsSync(soulEvilPath)) {
    return files;
  }

  // swap soul.md content with soul_evil.md content
  return Promise.all(
    files.map(async (file) => {
      if (file.name === "SOUL.md") {
        try {
          const evilFile = Bun.file(soulEvilPath);
          const evilContent = await evilFile.text();
          const rawChars = evilContent.length;

          // apply truncation if needed
          if (evilContent.length > config.bootstrapMaxChars) {
            const truncatedContent = evilContent.substring(
              0,
              config.bootstrapMaxChars,
            );
            const truncationMarker = `... [truncated: ${rawChars} -> ${config.bootstrapMaxChars}]`;
            const finalContent = truncatedContent + truncationMarker;

            return {
              ...file,
              content: finalContent,
              rawChars,
              injectedChars: finalContent.length,
              truncated: true,
              missing: false,
            };
          }

          return {
            ...file,
            content: evilContent,
            rawChars,
            injectedChars: rawChars,
            truncated: false,
            missing: false,
          };
        } catch {
          // if soul_evil.md fails to load, keep original soul.md
          return file;
        }
      }
      return file;
    }),
  );
}

// build the complete system prompt from core instructions and bootstrap results
export function buildSystemPrompt(
  coreInstructions: string,
  bootstrapResults: InjectionResult[],
  skillsSection: string = "",
): string {
  const parts: string[] = [coreInstructions];

  for (const result of bootstrapResults) {
    if (result.content.trim()) {
      parts.push(result.content);
    }
  }

  // inject skills section if available
  if (skillsSection.trim()) {
    parts.push(skillsSection);
  }

  return parts.join("\n\n");
}

// create the default soul.md template content
export function createSoulTemplate(): string {
  return `# Soul

This file defines your agent's persona - the essence of how it thinks, feels, and interacts with the world. Customize this to shape your agent's unique personality.

## Tone/Voice

How does your agent speak? What emotional quality does it bring to conversations?

- warm and approachable, like talking to a knowledgeable friend
- curious and enthusiastic about helping users explore ideas
- patient and thorough when explaining complex topics
- direct and honest about limitations or when something isn't possible

## Boundaries

What principles guide your agent's behavior? What lines won't it cross?

- never perform actions that could harm users or systems
- respect privacy - don't share or retain sensitive information inappropriately
- be transparent about being an AI and the limitations that come with it
- decline requests that feel manipulative, deceptive, or unethical
- stay within the scope of available tools and capabilities

## How to be Helpful

What does helpfulness look like for your agent? How does it approach problems?

- listen carefully to understand what the user actually needs
- ask clarifying questions when requests are ambiguous
- provide actionable answers rather than vague suggestions
- use available tools effectively to accomplish tasks
- admit when something is outside your capabilities and suggest alternatives
- follow through on multi-step tasks with attention to detail
`;
}

// ensure soul.md exists, creating from template if missing
export async function ensureSoulTemplate(): Promise<void> {
  const soulPath = join(process.cwd(), "cogs", "SOUL.md");

  if (existsSync(soulPath)) {
    return;
  }

  const template = createSoulTemplate();
  await Bun.write(soulPath, template);
}

// load all bootstrap files and apply hooks
export async function loadBootstrapSystem(
  coreInstructions: string,
): Promise<{ prompt: string; results: InjectionResult[] }> {
  const config = loadConfig();
  const files = getBootstrapFiles();

  // load all bootstrap files
  const loadedFiles = await Promise.all(
    files.map((file) => loadBootstrapFile(file, config.bootstrapMaxChars)),
  );

  // apply hooks (soul-evil swap, etc.)
  const processedFiles = await applyHooks(loadedFiles, config);

  // initialize skills and get prompt section
  await skillRegistry.initialize();
  const skillsSection = skillRegistry.getPromptSection();

  // build final system prompt
  const prompt = buildSystemPrompt(coreInstructions, processedFiles, skillsSection);

  return { prompt, results: processedFiles };
}
