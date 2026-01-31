import { existsSync, readdirSync, statSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { debug } from "../utils/debug.ts";

// skill metadata extracted from frontmatter
export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
}

// full skill definition with content
export interface Skill {
  meta: SkillMetadata;
  content: string;
  path: string;
  directory: string;
  scope: "project" | "global";
}

// skill summary for system prompt injection
export interface SkillSummary {
  name: string;
  description: string;
  scope: "project" | "global";
}

// skill discovery locations in priority order (project takes precedence)
const SKILL_LOCATIONS = [
  // project-local locations
  { path: ".crusty/skills", scope: "project" as const },
  { path: "cogs/skills", scope: "project" as const },
  { path: ".claude/skills", scope: "project" as const }, // claude code compatibility
  // global locations
  {
    path: join(homedir(), ".config", "crusty", "skills"),
    scope: "global" as const,
    absolute: true,
  },
  {
    path: join(homedir(), ".claude", "skills"),
    scope: "global" as const,
    absolute: true,
  }, // claude code compatibility
];

// parse yaml frontmatter from skill.md content
function parseFrontmatter(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } | null {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return null;
  }

  const [, yamlContent, body] = match;
  if (!yamlContent) {
    return null;
  }

  // simple yaml parser for the key fields we need
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlContent.split("\n");
  let currentKey = "";
  let inMetadata = false;
  const metadataObj: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // check for metadata block
    if (trimmed === "metadata:") {
      inMetadata = true;
      continue;
    }

    if (inMetadata) {
      // nested metadata key-value
      const nestedMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
      if (nestedMatch && line.startsWith("  ")) {
        const [, key, value] = nestedMatch;
        if (key && value) {
          metadataObj[key] = value.replace(/^["']|["']$/g, "");
        }
        continue;
      } else {
        // end of metadata block
        inMetadata = false;
        frontmatter.metadata = metadataObj;
      }
    }

    // top-level key-value
    const keyValueMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (keyValueMatch) {
      const [, key, value] = keyValueMatch;
      if (key) {
        currentKey = key;
        // handle multiline values or simple values
        if (value && value.trim()) {
          frontmatter[key] = value.replace(/^["']|["']$/g, "");
        }
      }
    } else if (currentKey && trimmed) {
      // continuation of previous value
      const existing = frontmatter[currentKey];
      if (typeof existing === "string") {
        frontmatter[currentKey] = existing + " " + trimmed;
      }
    }
  }

  if (Object.keys(metadataObj).length > 0 && !frontmatter.metadata) {
    frontmatter.metadata = metadataObj;
  }

  return { frontmatter, body: body || "" };
}

// validate skill name format per agent skills spec
function isValidSkillName(name: string): boolean {
  if (!name || name.length > 64) return false;
  // lowercase alphanumeric with single hyphen separators, no leading/trailing hyphens
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

// load a single skill from its directory
async function loadSkill(
  skillDir: string,
  scope: "project" | "global",
): Promise<Skill | null> {
  const skillPath = join(skillDir, "SKILL.md");

  if (!existsSync(skillPath)) {
    return null;
  }

  try {
    const content = await Bun.file(skillPath).text();
    const parsed = parseFrontmatter(content);

    if (!parsed) {
      debug(`[Skills] No frontmatter in ${skillPath}`);
      return null;
    }

    const { frontmatter, body } = parsed;
    const name = String(frontmatter.name || basename(skillDir));
    const description = String(frontmatter.description || "");

    if (!description) {
      debug(`[Skills] Missing description in ${skillPath}`);
      return null;
    }

    // validate name format, fall back to directory name if invalid
    const validName = isValidSkillName(name) ? name : basename(skillDir).toLowerCase();

    const meta: SkillMetadata = {
      name: validName,
      description,
      license: frontmatter.license ? String(frontmatter.license) : undefined,
      compatibility: frontmatter.compatibility
        ? String(frontmatter.compatibility)
        : undefined,
      metadata:
        frontmatter.metadata &&
        typeof frontmatter.metadata === "object"
          ? (frontmatter.metadata as Record<string, string>)
          : undefined,
    };

    return {
      meta,
      content: body.trim(),
      path: skillPath,
      directory: skillDir,
      scope,
    };
  } catch (error) {
    debug(`[Skills] Error loading ${skillPath}:`, error);
    return null;
  }
}

// discover all skills from configured locations
export async function discoverSkills(): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  const baseDir = process.cwd();

  for (const location of SKILL_LOCATIONS) {
    const searchPath = location.absolute
      ? location.path
      : join(baseDir, location.path);

    if (!existsSync(searchPath)) {
      continue;
    }

    try {
      const entries = readdirSync(searchPath);

      for (const entry of entries) {
        const entryPath = join(searchPath, entry);
        const stat = statSync(entryPath);

        if (!stat.isDirectory()) {
          continue;
        }

        const skill = await loadSkill(entryPath, location.scope);
        if (skill && !skills.has(skill.meta.name)) {
          // project skills take precedence over global (first wins)
          skills.set(skill.meta.name, skill);
        }
      }
    } catch (error) {
      debug(`[Skills] Error scanning ${searchPath}:`, error);
    }
  }

  return skills;
}

// get skill summaries for system prompt injection
export function getSkillSummaries(skills: Map<string, Skill>): SkillSummary[] {
  return Array.from(skills.values()).map((skill) => ({
    name: skill.meta.name,
    description: skill.meta.description,
    scope: skill.scope,
  }));
}

// build skills section for system prompt
export function buildSkillsPromptSection(
  summaries: SkillSummary[],
): string {
  if (summaries.length === 0) {
    return "";
  }

  const lines = [
    "# Available Skills",
    "",
    "IMPORTANT: Skills contain detailed instructions for specific tasks. You MUST load the relevant skill BEFORE attempting tasks that match a skill's description.",
    "",
    "<available_skills>",
  ];

  for (const summary of summaries) {
    lines.push(`  <skill>`);
    lines.push(`    <name>${summary.name}</name>`);
    lines.push(`    <description>${summary.description}</description>`);
    lines.push(`    <scope>${summary.scope}</scope>`);
    lines.push(`  </skill>`);
  }

  lines.push("</available_skills>");
  lines.push("");
  lines.push("## How to Use Skills");
  lines.push("");
  lines.push("1. BEFORE starting a task, check if it matches any skill description above");
  lines.push("2. If it matches, call the `skill` tool with the skill name: skill({ name: \"skill-name\" })");
  lines.push("3. Read the returned instructions carefully");
  lines.push("4. Follow those instructions to complete the task");
  lines.push("");
  lines.push("Example: If the user asks you to run a shell command, first load the bash skill:");
  lines.push("  -> Call: skill({ name: \"bash\" })");
  lines.push("  -> Read the instructions");
  lines.push("  -> Then execute the command following the skill's guidance");

  return lines.join("\n");
}

// skill registry singleton
class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private initialized = false;

  async initialize(force: boolean = false): Promise<void> {
    if (this.initialized && !force) return;

    this.skills = await discoverSkills();
    this.initialized = true;

    const count = this.skills.size;
    if (count > 0) {
      console.log(
        `[Skills] Discovered ${count} skill(s): ${Array.from(this.skills.keys()).join(", ")}`,
      );
    }
  }

  // force re-discovery of skills
  async refresh(): Promise<void> {
    await this.initialize(true);
  }

  getSummaries(): SkillSummary[] {
    return getSkillSummaries(this.skills);
  }

  getPromptSection(): string {
    return buildSkillsPromptSection(this.getSummaries());
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  listSkills(): string[] {
    return Array.from(this.skills.keys());
  }

  // load skill content for injection into conversation
  async loadSkillContent(name: string): Promise<string | null> {
    const skill = this.skills.get(name);
    if (!skill) {
      return null;
    }

    // build full skill context including any referenced files
    let content = `# Skill: ${skill.meta.name}\n\n${skill.content}`;

    // if skill references other files, note their availability
    const fileRefs = skill.content.match(/`([^`]+\.(md|txt|py|ts|js))`/g);
    if (fileRefs && fileRefs.length > 0) {
      const refFiles = fileRefs.map((ref) => ref.replace(/`/g, ""));
      const existingRefs = refFiles.filter((f) =>
        existsSync(join(skill.directory, f)),
      );

      if (existingRefs.length > 0) {
        content += `\n\n## Supporting Files\n\nThis skill includes the following supporting files that you can read if needed:\n`;
        for (const ref of existingRefs) {
          content += `- \`${ref}\`\n`;
        }
      }
    }

    return content;
  }

  // read a file from within a skill directory
  async readSkillFile(
    skillName: string,
    filename: string,
  ): Promise<string | null> {
    const skill = this.skills.get(skillName);
    if (!skill) {
      return null;
    }

    const filePath = join(skill.directory, filename);

    // security: ensure file is within skill directory
    const resolvedPath = join(skill.directory, filename);
    if (!resolvedPath.startsWith(skill.directory)) {
      return null;
    }

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      return await Bun.file(filePath).text();
    } catch {
      return null;
    }
  }

  // add a skill loaded from a url (no file backing, just in-memory)
  addUrlSkill(name: string, description: string, content: string, sourceUrl: string): boolean {
    // dont overwrite existing skills
    if (this.skills.has(name)) {
      return false;
    }

    const skill: Skill = {
      meta: {
        name,
        description,
      },
      content,
      path: sourceUrl,
      directory: "",
      scope: "project",
    };

    this.skills.set(name, skill);
    debug(`[Skills] Added URL skill: ${name} from ${sourceUrl}`);
    return true;
  }

  // check if a skill exists
  hasSkill(name: string): boolean {
    return this.skills.has(name);
  }
}

export const skillRegistry = new SkillRegistry();
