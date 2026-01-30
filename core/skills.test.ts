import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  discoverSkills,
  getSkillSummaries,
  buildSkillsPromptSection,
  skillRegistry,
} from "./skills.ts";

const TEST_SKILLS_DIR = join(process.cwd(), "cogs", "skills");
const TEST_SKILL_DIR = join(TEST_SKILLS_DIR, "test-skill");
const TEST_SKILL_PATH = join(TEST_SKILL_DIR, "SKILL.md");

const VALID_SKILL_CONTENT = `---
name: test-skill
description: a test skill for unit testing the skills system
license: MIT
metadata:
  audience: testers
---

## test instructions

this is a test skill.
`;

const SKILL_WITHOUT_DESCRIPTION = `---
name: broken-skill
---

no description here
`;

describe("skills system", () => {
  describe("discoverSkills", () => {
    beforeEach(() => {
      if (!existsSync(TEST_SKILL_DIR)) {
        mkdirSync(TEST_SKILL_DIR, { recursive: true });
      }
    });

    afterEach(() => {
      if (existsSync(TEST_SKILL_DIR)) {
        rmSync(TEST_SKILL_DIR, { recursive: true });
      }
    });

    test("should discover valid skills", async () => {
      writeFileSync(TEST_SKILL_PATH, VALID_SKILL_CONTENT);

      const skills = await discoverSkills();
      const testSkill = skills.get("test-skill");

      expect(testSkill).toBeDefined();
      expect(testSkill?.meta.name).toBe("test-skill");
      expect(testSkill?.meta.description).toBe(
        "a test skill for unit testing the skills system",
      );
      expect(testSkill?.meta.license).toBe("MIT");
    });

    test("should skip skills without description", async () => {
      writeFileSync(TEST_SKILL_PATH, SKILL_WITHOUT_DESCRIPTION);

      const skills = await discoverSkills();
      const brokenSkill = skills.get("broken-skill");

      expect(brokenSkill).toBeUndefined();
    });

    test("should parse skill content body correctly", async () => {
      writeFileSync(TEST_SKILL_PATH, VALID_SKILL_CONTENT);

      const skills = await discoverSkills();
      const testSkill = skills.get("test-skill");

      expect(testSkill?.content).toContain("## test instructions");
      expect(testSkill?.content).toContain("this is a test skill.");
    });

    test("should set scope to project for project-local skills", async () => {
      writeFileSync(TEST_SKILL_PATH, VALID_SKILL_CONTENT);

      const skills = await discoverSkills();
      const testSkill = skills.get("test-skill");

      expect(testSkill?.scope).toBe("project");
    });
  });

  describe("getSkillSummaries", () => {
    test("should return summaries for all skills", async () => {
      if (!existsSync(TEST_SKILL_DIR)) {
        mkdirSync(TEST_SKILL_DIR, { recursive: true });
      }
      writeFileSync(TEST_SKILL_PATH, VALID_SKILL_CONTENT);

      const skills = await discoverSkills();
      const summaries = getSkillSummaries(skills);

      const testSummary = summaries.find((s) => s.name === "test-skill");
      expect(testSummary).toBeDefined();
      expect(testSummary?.description).toBe(
        "a test skill for unit testing the skills system",
      );

      rmSync(TEST_SKILL_DIR, { recursive: true });
    });
  });

  describe("buildSkillsPromptSection", () => {
    test("should return empty string when no skills", () => {
      const section = buildSkillsPromptSection([]);
      expect(section).toBe("");
    });

    test("should build xml-formatted skills list", () => {
      const summaries = [
        { name: "skill-a", description: "does thing a", scope: "project" as const },
        { name: "skill-b", description: "does thing b", scope: "global" as const },
      ];

      const section = buildSkillsPromptSection(summaries);

      expect(section).toContain("<available_skills>");
      expect(section).toContain("<name>skill-a</name>");
      expect(section).toContain("<description>does thing a</description>");
      expect(section).toContain("<scope>project</scope>");
      expect(section).toContain("<name>skill-b</name>");
      expect(section).toContain("<scope>global</scope>");
      expect(section).toContain("</available_skills>");
    });
  });
});
