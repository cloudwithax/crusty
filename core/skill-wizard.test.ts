import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import {
  startWizard,
  hasActiveWizard,
  cancelWizard,
  processWizardInput,
  generateSkillContent,
  writeSkill,
  listSkillNames,
  type SkillDraft,
} from "./skill-wizard.ts";

const TEST_USER_ID = 999999;
const TEST_SKILL_DIR = join(process.cwd(), "cogs", "skills", "wizard-test-skill");

describe("skill wizard", () => {
  beforeEach(() => {
    // ensure clean state
    cancelWizard(TEST_USER_ID);
    if (existsSync(TEST_SKILL_DIR)) {
      rmSync(TEST_SKILL_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    cancelWizard(TEST_USER_ID);
    if (existsSync(TEST_SKILL_DIR)) {
      rmSync(TEST_SKILL_DIR, { recursive: true });
    }
  });

  describe("startWizard", () => {
    test("should return first question about name", () => {
      const question = startWizard(TEST_USER_ID);
      expect(question).toContain("named");
      expect(hasActiveWizard(TEST_USER_ID)).toBe(true);
    });
  });

  describe("hasActiveWizard", () => {
    test("should return false when no wizard started", () => {
      expect(hasActiveWizard(TEST_USER_ID)).toBe(false);
    });

    test("should return true when wizard is active", () => {
      startWizard(TEST_USER_ID);
      expect(hasActiveWizard(TEST_USER_ID)).toBe(true);
    });
  });

  describe("cancelWizard", () => {
    test("should cancel active wizard", () => {
      startWizard(TEST_USER_ID);
      expect(cancelWizard(TEST_USER_ID)).toBe(true);
      expect(hasActiveWizard(TEST_USER_ID)).toBe(false);
    });

    test("should return false when no wizard to cancel", () => {
      expect(cancelWizard(TEST_USER_ID)).toBe(false);
    });
  });

  describe("processWizardInput", () => {
    test("should validate skill name format", () => {
      startWizard(TEST_USER_ID);

      // invalid name with special characters
      const result = processWizardInput(TEST_USER_ID, "my_skill!");
      expect(result.done).toBe(false);
      expect(result.response).toContain("alphanumeric");
    });

    test("should reject empty name", () => {
      startWizard(TEST_USER_ID);

      const result = processWizardInput(TEST_USER_ID, "   ");
      expect(result.done).toBe(false);
      expect(result.response).toContain("empty");
    });

    test("should accept valid name and proceed to description", () => {
      startWizard(TEST_USER_ID);

      const result = processWizardInput(TEST_USER_ID, "wizard-test-skill");
      expect(result.done).toBe(false);
      expect(result.response).toContain("do");
    });

    test("should handle cancel input", () => {
      startWizard(TEST_USER_ID);

      const result = processWizardInput(TEST_USER_ID, "cancel");
      expect(result.done).toBe(true);
      expect(result.response).toContain("cancelled");
      expect(hasActiveWizard(TEST_USER_ID)).toBe(false);
    });

    test("should complete wizard after all steps", () => {
      startWizard(TEST_USER_ID);

      // step 1: name
      processWizardInput(TEST_USER_ID, "wizard-test-skill");
      // step 2: description
      processWizardInput(TEST_USER_ID, "a test skill for wizard testing");
      // step 3: when to use
      processWizardInput(TEST_USER_ID, "when testing the wizard");
      // step 4: workflow (skip)
      processWizardInput(TEST_USER_ID, "skip");
      // step 5: tips (done)
      const result = processWizardInput(TEST_USER_ID, "done");

      expect(result.done).toBe(true);
      expect(result.skill).toBeDefined();
      expect(result.skill?.name).toBe("wizard-test-skill");
      expect(result.skill?.description).toBe("a test skill for wizard testing");
    });
  });

  describe("generateSkillContent", () => {
    test("should generate valid SKILL.md content", () => {
      const draft: SkillDraft = {
        name: "test-skill",
        description: "does cool things",
        whenToUse: "when you need cool things",
        workflow: "step 1, step 2",
        tips: "be cool",
      };

      const content = generateSkillContent(draft);

      expect(content).toContain("---");
      expect(content).toContain("name: test-skill");
      expect(content).toContain("description: does cool things");
      expect(content).toContain("## what this skill does");
      expect(content).toContain("## when to use this skill");
      expect(content).toContain("## workflow");
      expect(content).toContain("## tips");
    });

    test("should omit empty sections", () => {
      const draft: SkillDraft = {
        name: "minimal-skill",
        description: "minimal description",
        whenToUse: "",
        workflow: "",
        tips: "",
      };

      const content = generateSkillContent(draft);

      expect(content).toContain("name: minimal-skill");
      expect(content).not.toContain("## when to use");
      expect(content).not.toContain("## workflow");
      expect(content).not.toContain("## tips");
    });
  });

  describe("writeSkill", () => {
    test("should create skill directory and file", async () => {
      const draft: SkillDraft = {
        name: "wizard-test-skill",
        description: "test skill",
        whenToUse: "testing",
        workflow: "",
        tips: "",
      };

      const result = await writeSkill(draft);

      expect(result.success).toBe(true);
      expect(existsSync(TEST_SKILL_DIR)).toBe(true);
      expect(existsSync(join(TEST_SKILL_DIR, "SKILL.md"))).toBe(true);
    });
  });

  describe("listSkillNames", () => {
    test("should include created skills", async () => {
      const draft: SkillDraft = {
        name: "wizard-test-skill",
        description: "test skill",
        whenToUse: "",
        workflow: "",
        tips: "",
      };

      await writeSkill(draft);
      const skills = listSkillNames();

      expect(skills).toContain("wizard-test-skill");
    });
  });
});
