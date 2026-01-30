import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  loadConfig,
  getBootstrapFiles,
  loadBootstrapFile,
  applyHooks,
  buildSystemPrompt,
  createSoulTemplate,
  ensureSoulTemplate,
  type BootstrapConfig,
  type BootstrapFile,
  type InjectionResult,
} from "./bootstrap.ts";
import { existsSync, mkdirSync, rmdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Helper to create temp directory for tests
function createTempDir(): string {
  const tempDir = join(tmpdir(), `bootstrap-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

// Helper to cleanup temp directory
function cleanupTempDir(tempDir: string): void {
  try {
    const files = require("fs").readdirSync(tempDir);
    for (const file of files) {
      unlinkSync(join(tempDir, file));
    }
    rmdirSync(tempDir);
  } catch {
    // ignore cleanup errors
  }
}

describe("bootstrap system", () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = createTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  describe("loadConfig", () => {
    it("should return default values when no env vars set", () => {
      // Clear relevant env vars
      delete process.env.AGENTS_BOOTSTRAP_MAX_CHARS;
      delete process.env.AGENTS_SOUL_EVIL_ENABLED;
      delete process.env.AGENTS_SOUL_EVIL_CHANCE;

      const config = loadConfig();

      expect(config.bootstrapMaxChars).toBe(20000);
      expect(config.hooks.soulEvil.enabled).toBe(false);
      expect(config.hooks.soulEvil.chance).toBe(0.1);
      expect(config.hooks.soulEvil.window?.start).toBe("22:00");
      expect(config.hooks.soulEvil.window?.end).toBe("06:00");
      expect(config.hooks.soulEvil.window?.timezone).toBe("America/New_York");
    });

    it("should load values from environment variables", () => {
      process.env.AGENTS_BOOTSTRAP_MAX_CHARS = "15000";
      process.env.AGENTS_SOUL_EVIL_ENABLED = "true";
      process.env.AGENTS_SOUL_EVIL_CHANCE = "0.5";
      process.env.AGENTS_SOUL_EVIL_WINDOW_START = "20:00";
      process.env.AGENTS_SOUL_EVIL_WINDOW_END = "04:00";
      process.env.AGENTS_SOUL_EVIL_TIMEZONE = "Europe/London";

      const config = loadConfig();

      expect(config.bootstrapMaxChars).toBe(15000);
      expect(config.hooks.soulEvil.enabled).toBe(true);
      expect(config.hooks.soulEvil.chance).toBe(0.5);
      expect(config.hooks.soulEvil.window?.start).toBe("20:00");
      expect(config.hooks.soulEvil.window?.end).toBe("04:00");
      expect(config.hooks.soulEvil.window?.timezone).toBe("Europe/London");

      // Cleanup
      delete process.env.AGENTS_BOOTSTRAP_MAX_CHARS;
      delete process.env.AGENTS_SOUL_EVIL_ENABLED;
      delete process.env.AGENTS_SOUL_EVIL_CHANCE;
      delete process.env.AGENTS_SOUL_EVIL_WINDOW_START;
      delete process.env.AGENTS_SOUL_EVIL_WINDOW_END;
      delete process.env.AGENTS_SOUL_EVIL_TIMEZONE;
    });
  });

  describe("getBootstrapFiles", () => {
    it("should return files in correct order", () => {
      const files = getBootstrapFiles();
      const names = files.map((f) => f.name);

      expect(names).toEqual([
        "SOUL.md",
        "TOOLS.md",
        "IDENTITY.md",
        "USER.md",
        "HEARTBEAT.md",
        "BOOTSTRAP.md",
      ]);
    });

    it("should mark SOUL.md as required", () => {
      const files = getBootstrapFiles();

      const soulFile = files.find((f) => f.name === "SOUL.md");
      const toolsFile = files.find((f) => f.name === "TOOLS.md");

      expect(soulFile?.required).toBe(true);
      expect(toolsFile?.required).toBe(false);
    });
  });

  describe("loadBootstrapFile", () => {
    it("should load file content successfully", async () => {
      const testContent = "# Test Content\n\nThis is a test file.";
      const filePath = join(tempDir, "test.md");
      await Bun.write(filePath, testContent);

      const file: BootstrapFile = {
        name: "test.md",
        path: filePath,
        required: false,
      };

      const result = await loadBootstrapFile(file, 20000);

      expect(result.name).toBe("test.md");
      expect(result.content).toBe(testContent);
      expect(result.rawChars).toBe(testContent.length);
      expect(result.injectedChars).toBe(testContent.length);
      expect(result.truncated).toBe(false);
      expect(result.missing).toBe(false);
    });

    it("should return missing marker when file does not exist", async () => {
      const file: BootstrapFile = {
        name: "nonexistent.md",
        path: join(tempDir, "nonexistent.md"),
        required: false,
      };

      const result = await loadBootstrapFile(file, 20000);

      expect(result.name).toBe("nonexistent.md");
      expect(result.content).toBe("[missing file: nonexistent.md]");
      expect(result.rawChars).toBe(0);
      expect(result.injectedChars).toBe("[missing file: nonexistent.md]".length);
      expect(result.truncated).toBe(false);
      expect(result.missing).toBe(true);
    });

    it("should truncate content when it exceeds maxChars", async () => {
      const longContent = "a".repeat(100);
      const filePath = join(tempDir, "long.md");
      await Bun.write(filePath, longContent);

      const file: BootstrapFile = {
        name: "long.md",
        path: filePath,
        required: false,
      };

      const result = await loadBootstrapFile(file, 50);

      expect(result.truncated).toBe(true);
      expect(result.rawChars).toBe(100);
      expect(result.content).toContain("... [truncated: 100 -> 50]");
      expect(result.injectedChars).toBeLessThanOrEqual(50 + "... [truncated: 100 -> 50]".length);
    });

    it("should create SOUL.md from template if missing and required", async () => {
      // Create cogs directory
      const cogsDir = join(tempDir, "cogs");
      mkdirSync(cogsDir, { recursive: true });

      // Change to temp dir so ensureSoulTemplate creates in right place
      process.chdir(tempDir);

      const soulPath = join(cogsDir, "SOUL.md");
      const file: BootstrapFile = {
        name: "SOUL.md",
        path: soulPath,
        required: true,
      };

      // File should not exist initially
      expect(existsSync(soulPath)).toBe(false);

      // Load should create it
      const result = await loadBootstrapFile(file, 20000);

      // File should now exist
      expect(existsSync(soulPath)).toBe(true);
      expect(result.missing).toBe(false);
      expect(result.content).toContain("# Soul");
    });
  });

  describe("applyHooks", () => {
    it("should not modify files when soul-evil is disabled", async () => {
      const config: BootstrapConfig = {
        bootstrapMaxChars: 20000,
        hooks: {
          soulEvil: {
            enabled: false,
            chance: 1.0, // Would trigger if enabled
          },
        },
      };

      const files: InjectionResult[] = [
        {
          name: "SOUL.md",
          content: "original soul content",
          rawChars: 21,
          injectedChars: 21,
          truncated: false,
          missing: false,
        },
      ];

      const result = await applyHooks(files, config);

      expect(result[0]?.content).toBe("original soul content");
    });

    it("should not modify files when outside time window", async () => {
      const config: BootstrapConfig = {
        bootstrapMaxChars: 20000,
        hooks: {
          soulEvil: {
            enabled: true,
            chance: 1.0,
            window: {
              start: "00:00", // Midnight
              end: "00:01", // 1 minute later
              timezone: "America/New_York",
            },
          },
        },
      };

      const files: InjectionResult[] = [
        {
          name: "SOUL.md",
          content: "original soul content",
          rawChars: 21,
          injectedChars: 21,
          truncated: false,
          missing: false,
        },
      ];

      const result = await applyHooks(files, config);

      // Should not swap since we're not at midnight
      expect(result[0]?.content).toBe("original soul content");
    });

    it("should swap SOUL.md with SOUL_EVIL.md when conditions met", async () => {
      // Create SOUL_EVIL.md
      const evilContent = "evil soul content";
      await Bun.write(join(tempDir, "SOUL_EVIL.md"), evilContent);

      // Create a config that will definitely trigger (chance = 1.0)
      // Use a time window that includes current time
      const now = new Date();
      const currentHour = now.getHours();
      const startHour = (currentHour - 1 + 24) % 24;
      const endHour = (currentHour + 1) % 24;

      const config: BootstrapConfig = {
        bootstrapMaxChars: 20000,
        hooks: {
          soulEvil: {
            enabled: true,
            chance: 1.0, // Always trigger
            window: {
              start: `${startHour.toString().padStart(2, "0")}:00`,
              end: `${endHour.toString().padStart(2, "0")}:00`,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          },
        },
      };

      const files: InjectionResult[] = [
        {
          name: "SOUL.md",
          content: "original soul content",
          rawChars: 21,
          injectedChars: 21,
          truncated: false,
          missing: false,
        },
      ];

      const result = await applyHooks(files, config);

      expect(result[0]?.content).toBe(evilContent);
    });
  });

  describe("buildSystemPrompt", () => {
    it("should combine core instructions with bootstrap results", () => {
      const coreInstructions = "# Core\n\nCore instructions here";
      const bootstrapResults: InjectionResult[] = [
        {
          name: "SOUL.md",
          content: "# Soul\n\nPersona definition",
          rawChars: 24,
          injectedChars: 24,
          truncated: false,
          missing: false,
        },
        {
          name: "TOOLS.md",
          content: "# Tools\n\nTool guidelines",
          rawChars: 22,
          injectedChars: 22,
          truncated: false,
          missing: false,
        },
      ];

      const prompt = buildSystemPrompt(coreInstructions, bootstrapResults);

      expect(prompt).toContain("# Core");
      expect(prompt).toContain("# Soul");
      expect(prompt).toContain("# Tools");
      expect(prompt.indexOf("# Core")).toBeLessThan(prompt.indexOf("# Soul")!);
      expect(prompt.indexOf("# Soul")).toBeLessThan(prompt.indexOf("# Tools")!);
    });

    it("should skip empty content", () => {
      const coreInstructions = "# Core";
      const bootstrapResults: InjectionResult[] = [
        {
          name: "SOUL.md",
          content: "",
          rawChars: 0,
          injectedChars: 0,
          truncated: false,
          missing: false,
        },
        {
          name: "TOOLS.md",
          content: "   ", // whitespace only
          rawChars: 3,
          injectedChars: 3,
          truncated: false,
          missing: false,
        },
      ];

      const prompt = buildSystemPrompt(coreInstructions, bootstrapResults);

      expect(prompt).toBe("# Core");
    });
  });

  describe("createSoulTemplate", () => {
    it("should return valid markdown with required sections", () => {
      const template = createSoulTemplate();

      expect(template).toContain("# Soul");
      expect(template).toContain("## Tone/Voice");
      expect(template).toContain("## Boundaries");
      expect(template).toContain("## How to be Helpful");
    });
  });

  describe("ensureSoulTemplate", () => {
    it("should create SOUL.md if it does not exist", async () => {
      const cogsDir = join(tempDir, "cogs");
      mkdirSync(cogsDir, { recursive: true });
      process.chdir(tempDir);

      const soulPath = join(cogsDir, "SOUL.md");
      expect(existsSync(soulPath)).toBe(false);

      await ensureSoulTemplate();

      expect(existsSync(soulPath)).toBe(true);
      const content = await Bun.file(soulPath).text();
      expect(content).toContain("# Soul");
    });

    it("should not overwrite existing SOUL.md", async () => {
      const cogsDir = join(tempDir, "cogs");
      mkdirSync(cogsDir, { recursive: true });
      process.chdir(tempDir);

      const soulPath = join(cogsDir, "SOUL.md");
      const existingContent = "# Custom Soul\n\nMy custom content";
      await Bun.write(soulPath, existingContent);

      await ensureSoulTemplate();

      const content = await Bun.file(soulPath).text();
      expect(content).toBe(existingContent);
    });
  });

  describe("determinism", () => {
    it("should produce identical output for same inputs", async () => {
      const testContent = "# Test\n\nConsistent content";
      const filePath = join(tempDir, "test.md");
      await Bun.write(filePath, testContent);

      const file: BootstrapFile = {
        name: "test.md",
        path: filePath,
        required: false,
      };

      const result1 = await loadBootstrapFile(file, 20000);
      const result2 = await loadBootstrapFile(file, 20000);

      expect(result1.content).toBe(result2.content);
      expect(result1.rawChars).toBe(result2.rawChars);
      expect(result1.injectedChars).toBe(result2.injectedChars);
      expect(result1.truncated).toBe(result2.truncated);
      expect(result1.missing).toBe(result2.missing);
    });

    it("should produce identical system prompts for same inputs", () => {
      const coreInstructions = "# Core\n\nInstructions";
      const bootstrapResults: InjectionResult[] = [
        {
          name: "SOUL.md",
          content: "# Soul",
          rawChars: 6,
          injectedChars: 6,
          truncated: false,
          missing: false,
        },
      ];

      const prompt1 = buildSystemPrompt(coreInstructions, bootstrapResults);
      const prompt2 = buildSystemPrompt(coreInstructions, bootstrapResults);

      expect(prompt1).toBe(prompt2);
    });
  });
});
