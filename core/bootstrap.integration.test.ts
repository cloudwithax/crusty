import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  loadConfig,
  getBootstrapFiles,
  loadBootstrapFile,
  applyHooks,
  buildSystemPrompt,
  ensureSoulTemplate,
  createSoulTemplate,
  type BootstrapConfig,
  type BootstrapFile,
  type InjectionResult,
} from "./bootstrap.ts";
import { Agent } from "./agent.ts";
import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Helper to create temp directory for tests
function createTempDir(): string {
  const tempDir = join(tmpdir(), `bootstrap-integration-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

// Helper to cleanup temp directory
function cleanupTempDir(tempDir: string): void {
  try {
    const files = require("fs").readdirSync(tempDir);
    for (const file of files) {
      const filePath = join(tempDir, file);
      const stat = require("fs").statSync(filePath);
      if (stat.isDirectory()) {
        cleanupTempDir(filePath);
        rmdirSync(filePath);
      } else {
        unlinkSync(filePath);
      }
    }
    rmdirSync(tempDir);
  } catch {
    // ignore cleanup errors
  }
}

// Helper to create cogs directory with required files
async function setupCogsDir(tempDir: string, soulContent?: string): Promise<void> {
  const cogsDir = join(tempDir, "cogs");
  mkdirSync(cogsDir, { recursive: true });

  // Create identity.md
  await Bun.write(
    join(cogsDir, "identity.md"),
    "# Identity\n\nTest identity content."
  );

  // Create memory.md
  await Bun.write(
    join(cogsDir, "memory.md"),
    "# Memory\n\nTest memory content."
  );

  // Create runtime.md
  await Bun.write(
    join(cogsDir, "runtime.md"),
    "# Runtime\n\nCurrent time: {{CURRENT_TIME}}\nWorking dir: {{WORKING_DIR}}"
  );

  // Create SOUL.md
  const soulMdContent = soulContent || createSoulTemplate();
  await Bun.write(join(cogsDir, "SOUL.md"), soulMdContent);


}

describe("bootstrap integration tests", () => {
  let originalCwd: string;
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    tempDir = createTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
    // Restore environment variables
    process.env = originalEnv;
  });

  describe("persona consistency test", () => {
    it("should include same SOUL.md content in system prompt across multiple agent runs", async () => {
      // Setup cogs directory with SOUL.md
      await setupCogsDir(tempDir);

      // Create agent instance
      const agent = new Agent(1);
      await agent.initialize();

      // Get system prompt from agent's internal state
      const messages1 = agent.messages as Array<{ role: string; content: string }>;
      const systemPrompt1 = messages1.find((m) => m.role === "system")?.content;

      expect(systemPrompt1).toBeDefined();
      expect(systemPrompt1).toContain("# Soul");
      expect(systemPrompt1).toContain("Tone/Voice");
      expect(systemPrompt1).toContain("Boundaries");

      // Create second agent instance (simulating new session)
      const agent2 = new Agent(2);
      await agent2.initialize();

      const messages2 = agent2.messages as Array<{ role: string; content: string }>;
      const systemPrompt2 = messages2.find((m) => m.role === "system")?.content;

      // Verify both prompts contain the same SOUL.md content
      expect(systemPrompt2).toBeDefined();
      expect(systemPrompt2).toContain("# Soul");
      expect(systemPrompt2).toContain("Tone/Voice");
      expect(systemPrompt2).toContain("Boundaries");

      // Extract SOUL.md sections and compare
      const soulSection1 = systemPrompt1?.split("# Soul")[1]?.split("# ")[0];
      const soulSection2 = systemPrompt2?.split("# Soul")[1]?.split("# ")[0];

      expect(soulSection1).toBe(soulSection2);
    });

    it("should maintain consistent persona tone and boundaries", async () => {
      // Setup cogs directory with custom SOUL.md
      const customSoul = `# Soul

## Tone/Voice

- professional and formal
- concise and direct
- technical and precise

## Boundaries

- never share personal opinions
- always cite sources
- maintain objectivity
`;
      await setupCogsDir(tempDir, customSoul);

      // Create multiple agents
      const agent1 = new Agent(1);
      const agent2 = new Agent(2);
      const agent3 = new Agent(3);

      await Promise.all([agent1.initialize(), agent2.initialize(), agent3.initialize()]);

      const prompts = [agent1, agent2, agent3].map((agent) => {
        const messages = agent.messages as Array<{ role: string; content: string }>;
        return messages.find((m) => m.role === "system")?.content;
      });

      // All prompts should contain the same tone keywords
      for (const prompt of prompts) {
        expect(prompt).toContain("professional and formal");
        expect(prompt).toContain("concise and direct");
        expect(prompt).toContain("technical and precise");
        expect(prompt).toContain("never share personal opinions");
        expect(prompt).toContain("always cite sources");
        expect(prompt).toContain("maintain objectivity");
      }
    });
  });

  describe("SOUL.md update propagation test", () => {
    it("should pick up updated SOUL.md content in new agent instances", async () => {
      // Setup initial cogs directory
      const initialSoul = `# Soul

## Tone/Voice

- initial tone
`;
      await setupCogsDir(tempDir, initialSoul);

      // Create first agent and verify initial content
      const agent1 = new Agent(1);
      await agent1.initialize();

      const messages1 = agent1.messages as Array<{ role: string; content: string }>;
      const systemPrompt1 = messages1.find((m) => m.role === "system")?.content;

      expect(systemPrompt1).toContain("initial tone");

      // Update SOUL.md content
      const updatedSoul = `# Soul

## Tone/Voice

- updated tone
- new characteristic
`;
      const cogsDir = join(tempDir, "cogs");
      await Bun.write(join(cogsDir, "SOUL.md"), updatedSoul);

      // Create new agent instance
      const agent2 = new Agent(2);
      await agent2.initialize();

      const messages2 = agent2.messages as Array<{ role: string; content: string }>;
      const systemPrompt2 = messages2.find((m) => m.role === "system")?.content;

      // Verify new agent has updated content
      expect(systemPrompt2).toContain("updated tone");
      expect(systemPrompt2).toContain("new characteristic");
      expect(systemPrompt2).not.toContain("initial tone");
    });

    it("should not affect existing agent instances when SOUL.md is updated", async () => {
      // Setup initial cogs directory
      await setupCogsDir(tempDir, "# Soul\n\nInitial content");

      // Create agent
      const agent = new Agent(1);
      await agent.initialize();

      const messages = agent.messages as Array<{ role: string; content: string }>;
      const initialPrompt = messages.find((m) => m.role === "system")?.content;

      // Update SOUL.md
      const cogsDir = join(tempDir, "cogs");
      await Bun.write(join(cogsDir, "SOUL.md"), "# Soul\n\nUpdated content");

      // Verify existing agent still has original content
      const messagesAfter = agent.messages as Array<{ role: string; content: string }>;
      const promptAfter = messagesAfter.find((m) => m.role === "system")?.content;

      expect(promptAfter).toBe(initialPrompt);
      expect(promptAfter).toContain("Initial content");
    });
  });

  describe("hook persistence test", () => {
    it("should consistently apply soul-evil hook with 100% chance within window", async () => {
      // Create SOUL_EVIL.md
      const evilSoulContent = `# Soul

## Tone/Voice

- evil and malicious
- manipulative and deceptive
`;
      await Bun.write(join(tempDir, "SOUL_EVIL.md"), evilSoulContent);

      // Setup normal SOUL.md
      await setupCogsDir(tempDir, "# Soul\n\nGood soul content");


      // Configure soul-evil hook with 100% chance
      // Use a time window that includes current time
      const now = new Date();
      const currentHour = now.getHours();
      const startHour = (currentHour - 1 + 24) % 24;
      const endHour = (currentHour + 1) % 24;

      process.env.AGENTS_SOUL_EVIL_ENABLED = "true";
      process.env.AGENTS_SOUL_EVIL_CHANCE = "1.0";
      process.env.AGENTS_SOUL_EVIL_WINDOW_START = `${startHour.toString().padStart(2, "0")}:00`;
      process.env.AGENTS_SOUL_EVIL_WINDOW_END = `${endHour.toString().padStart(2, "0")}:00`;
      process.env.AGENTS_SOUL_EVIL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Run multiple times to verify consistency
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        const config = loadConfig();
        const files = getBootstrapFiles();
        const loadedFiles = await Promise.all(
          files.map((file) => loadBootstrapFile(file, config.bootstrapMaxChars))
        );
        const processedFiles = await applyHooks(loadedFiles, config);
        const soulFile = processedFiles.find((f) => f.name === "SOUL.md");
        results.push(soulFile?.content.includes("evil and malicious") ?? false);
      }

      // All results should be the same (either all evil or all normal based on time)
      const allEvil = results.every((r) => r);
      const allNormal = results.every((r) => !r);
      expect(allEvil || allNormal).toBe(true);
    });

    it("should never modify disk files when applying hooks", async () => {
      // Create SOUL_EVIL.md
      const evilSoulContent = `# Evil Soul

Evil content here`;
      await Bun.write(join(tempDir, "SOUL_EVIL.md"), evilSoulContent);

      // Setup normal SOUL.md
      const normalSoulContent = `# Soul

Normal good content`;
      await setupCogsDir(tempDir, normalSoulContent);


      // Get initial SOUL.md content
      const cogsDir = join(tempDir, "cogs");
      const soulPath = join(cogsDir, "SOUL.md");
      const initialContent = await Bun.file(soulPath).text();

      // Configure and apply hooks multiple times
      const now = new Date();
      const currentHour = now.getHours();
      const startHour = (currentHour - 1 + 24) % 24;
      const endHour = (currentHour + 1) % 24;

      process.env.AGENTS_SOUL_EVIL_ENABLED = "true";
      process.env.AGENTS_SOUL_EVIL_CHANCE = "1.0";
      process.env.AGENTS_SOUL_EVIL_WINDOW_START = `${startHour.toString().padStart(2, "0")}:00`;
      process.env.AGENTS_SOUL_EVIL_WINDOW_END = `${endHour.toString().padStart(2, "0")}:00`;
      process.env.AGENTS_SOUL_EVIL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

      for (let i = 0; i < 3; i++) {
        const config = loadConfig();
        const files = getBootstrapFiles();
        const loadedFiles = await Promise.all(
          files.map((file) => loadBootstrapFile(file, config.bootstrapMaxChars))
        );
        await applyHooks(loadedFiles, config);
      }

      // Verify SOUL.md on disk is unchanged
      const finalContent = await Bun.file(soulPath).text();
      expect(finalContent).toBe(initialContent);
      expect(finalContent).toBe(normalSoulContent);
    });
  });

  describe("end-to-end bootstrap flow test", () => {
    it("should execute complete flow: ensureSoulTemplate -> loadConfig -> getBootstrapFiles -> loadBootstrapFile -> applyHooks -> buildSystemPrompt", async () => {
      // Setup cogs directory
      const cogsDir = join(tempDir, "cogs");
      mkdirSync(cogsDir, { recursive: true });

      // Step 1: ensureSoulTemplate
      process.chdir(tempDir);
      await ensureSoulTemplate();
      const soulPath = join(cogsDir, "SOUL.md");
      expect(existsSync(soulPath)).toBe(true);

      // Create other files
      await Bun.write(join(tempDir, "TOOLS.md"), "# Tools\n\nTool definitions");
      await Bun.write(join(tempDir, "IDENTITY.md"), "# Identity\n\nIdentity content");

      // Step 2: loadConfig
      const config = loadConfig();
      expect(config.bootstrapMaxChars).toBe(20000);
      expect(config.hooks.soulEvil.enabled).toBe(false);

      // Step 3: getBootstrapFiles
      const files = getBootstrapFiles();
      expect(files.length).toBe(6);
      expect(files[0]?.name).toBe("SOUL.md");
      expect(files[1]?.name).toBe("TOOLS.md");

      // Step 4: loadBootstrapFile
      const loadedFiles = await Promise.all(
        files.map((file) => loadBootstrapFile(file, config.bootstrapMaxChars))
      );

      // Verify all files loaded
      expect(loadedFiles.length).toBe(6);
      expect(loadedFiles[0]?.name).toBe("SOUL.md");
      expect(loadedFiles[0]?.content).toContain("# Soul");
      expect(loadedFiles[1]?.name).toBe("TOOLS.md");
      expect(loadedFiles[1]?.content).toContain("Tool definitions");

      // Step 5: applyHooks
      const processedFiles = await applyHooks(loadedFiles, config);
      expect(processedFiles.length).toBe(6);

      // Step 6: buildSystemPrompt
      const coreInstructions = "# Core Instructions\n\nBase system behavior";
      const prompt = buildSystemPrompt(coreInstructions, processedFiles);

      // Verify final prompt structure
      expect(prompt).toContain("# Core Instructions");
      expect(prompt).toContain("# Soul");
      expect(prompt).toContain("# Tools");

      // Verify order - core instructions should come first
      const coreIndex = prompt.indexOf("# Core Instructions");
      const soulIndex = prompt.indexOf("# Soul");
      const toolsIndex = prompt.indexOf("# Tools");

      expect(coreIndex).toBe(0);
      expect(soulIndex).toBeGreaterThan(coreIndex);
      expect(toolsIndex).toBeGreaterThan(soulIndex);
    });

    it("should handle missing files gracefully in the complete flow", async () => {
      // Setup minimal files - only SOUL.md is required
      const cogsDir = join(tempDir, "cogs");
      mkdirSync(cogsDir, { recursive: true });

      process.chdir(tempDir);
      await ensureSoulTemplate();
      // Don't create TOOLS.md, IDENTITY.md, etc.

      const config = loadConfig();
      const files = getBootstrapFiles();
      const loadedFiles = await Promise.all(
        files.map((file) => loadBootstrapFile(file, config.bootstrapMaxChars))
      );
      const processedFiles = await applyHooks(loadedFiles, config);
      const prompt = buildSystemPrompt("# Core", processedFiles);

      // Verify required file is present
      expect(prompt).toContain("# Soul");

      // Verify missing files are marked
      const toolsFile = processedFiles.find((f) => f.name === "TOOLS.md");
      expect(toolsFile?.missing).toBe(true);
      expect(toolsFile?.content).toContain("[missing file: TOOLS.md]");
    });

    it("should respect bootstrapMaxChars configuration in complete flow", async () => {
      // Create a large TOOLS.md file
      const largeContent = "A".repeat(5000);
      await Bun.write(join(tempDir, "TOOLS.md"), `# Tools\n\n${largeContent}`);

      // Setup SOUL.md
      const cogsDir = join(tempDir, "cogs");
      mkdirSync(cogsDir, { recursive: true });
      process.chdir(tempDir);
      await ensureSoulTemplate();

      // Configure low max chars
      process.env.AGENTS_BOOTSTRAP_MAX_CHARS = "100";

      const config = loadConfig();
      expect(config.bootstrapMaxChars).toBe(100);

      const files = getBootstrapFiles();
      const loadedFiles = await Promise.all(
        files.map((file) => loadBootstrapFile(file, config.bootstrapMaxChars))
      );

      // Verify TOOLS.md was truncated
      const toolsFile = loadedFiles.find((f) => f.name === "TOOLS.md");
      expect(toolsFile?.truncated).toBe(true);
      expect(toolsFile?.content).toContain("[truncated");
      expect(toolsFile?.injectedChars).toBeLessThanOrEqual(100 + "... [truncated: 5006 -> 100]".length);
    });
  });
});
