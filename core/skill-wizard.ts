import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// wizard step definitions
export interface WizardStep {
  question: string;
  field: keyof SkillDraft;
  validate?: (input: string) => string | null; // returns error message or null if valid
}

// draft skill being built through the wizard
export interface SkillDraft {
  name: string;
  description: string;
  whenToUse: string;
  workflow: string;
  tips: string;
}

// wizard state for a user
export interface WizardState {
  step: number;
  draft: Partial<SkillDraft>;
  startedAt: number;
}

// active wizards by user id
const activeWizards = new Map<number, WizardState>();

// wizard steps in order (max 5 questions)
const WIZARD_STEPS: WizardStep[] = [
  {
    question: "what should this skill be named?\n\n(use lowercase with hyphens, eg: code-review, git-release)",
    field: "name",
    validate: (input) => {
      const name = input.trim().toLowerCase();
      if (!name) return "name cannot be empty";
      if (name.length > 64) return "name must be 64 characters or less";
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        return "name must be lowercase alphanumeric with hyphens (eg: my-skill)";
      }
      // check if skill already exists
      const skillDir = join(process.cwd(), "cogs", "skills", name);
      if (existsSync(skillDir)) {
        return `skill "${name}" already exists`;
      }
      return null;
    },
  },
  {
    question: "what should this skill do?\n\n(describe the core functionality in a sentence or two)",
    field: "description",
    validate: (input) => {
      const desc = input.trim();
      if (!desc) return "description cannot be empty";
      if (desc.length > 500) return "description should be under 500 characters";
      return null;
    },
  },
  {
    question: "when should this skill be used?\n\n(describe the triggers or situations that call for this skill)",
    field: "whenToUse",
    validate: (input) => {
      if (!input.trim()) return "please provide some usage guidance";
      return null;
    },
  },
  {
    question: "what workflow or steps should the skill follow?\n\n(list the key steps, or type 'skip' to leave blank)",
    field: "workflow",
  },
  {
    question: "any tips or best practices to include?\n\n(type 'skip' to leave blank, or 'done' to finish early)",
    field: "tips",
  },
];

// start a new wizard session for a user
export function startWizard(userId: number): string {
  activeWizards.set(userId, {
    step: 0,
    draft: {},
    startedAt: Date.now(),
  });

  return WIZARD_STEPS[0]!.question;
}

// check if user has an active wizard
export function hasActiveWizard(userId: number): boolean {
  return activeWizards.has(userId);
}

// cancel the wizard for a user
export function cancelWizard(userId: number): boolean {
  return activeWizards.delete(userId);
}

// process user input for the current wizard step
export function processWizardInput(
  userId: number,
  input: string,
): { done: boolean; response: string; skill?: SkillDraft } {
  const state = activeWizards.get(userId);
  if (!state) {
    return { done: true, response: "no active skill wizard. use /skill new to start." };
  }

  const currentStep = WIZARD_STEPS[state.step];
  if (!currentStep) {
    activeWizards.delete(userId);
    return { done: true, response: "wizard error - please start over with /skill new" };
  }

  const trimmedInput = input.trim();

  // handle early exit
  if (trimmedInput.toLowerCase() === "cancel") {
    activeWizards.delete(userId);
    return { done: true, response: "skill creation cancelled." };
  }

  // handle skip/done on optional fields
  const isOptionalField = currentStep.field === "workflow" || currentStep.field === "tips";
  if (isOptionalField && ["skip", "done"].includes(trimmedInput.toLowerCase())) {
    if (trimmedInput.toLowerCase() === "done" || state.step === WIZARD_STEPS.length - 1) {
      // finish early
      return finishWizard(userId, state);
    }
    // skip this field, move to next
    state.step++;
    const nextStep = WIZARD_STEPS[state.step];
    if (nextStep) {
      return { done: false, response: nextStep.question };
    }
    return finishWizard(userId, state);
  }

  // validate input if validator exists
  if (currentStep.validate) {
    const error = currentStep.validate(trimmedInput);
    if (error) {
      return { done: false, response: `${error}\n\ntry again:` };
    }
  }

  // store the answer
  state.draft[currentStep.field] = trimmedInput;

  // move to next step
  state.step++;

  // check if we're done
  if (state.step >= WIZARD_STEPS.length) {
    return finishWizard(userId, state);
  }

  // return next question
  const nextStep = WIZARD_STEPS[state.step];
  return { done: false, response: nextStep!.question };
}

// finish the wizard and create the skill
function finishWizard(
  userId: number,
  state: WizardState,
): { done: boolean; response: string; skill?: SkillDraft } {
  activeWizards.delete(userId);

  const draft = state.draft;

  // validate required fields
  if (!draft.name || !draft.description) {
    return {
      done: true,
      response: "skill creation incomplete - missing name or description. use /skill new to start over.",
    };
  }

  const skill: SkillDraft = {
    name: draft.name,
    description: draft.description,
    whenToUse: draft.whenToUse || "",
    workflow: draft.workflow || "",
    tips: draft.tips || "",
  };

  return { done: true, response: "", skill };
}

// generate SKILL.md content from a draft
export function generateSkillContent(skill: SkillDraft): string {
  const lines = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "license: MIT",
    "---",
    "",
    "## what this skill does",
    "",
    skill.description,
    "",
  ];

  if (skill.whenToUse) {
    lines.push("## when to use this skill", "", skill.whenToUse, "");
  }

  if (skill.workflow) {
    lines.push("## workflow", "", skill.workflow, "");
  }

  if (skill.tips) {
    lines.push("## tips", "", skill.tips, "");
  }

  return lines.join("\n");
}

// create the skill directory and write SKILL.md
export async function writeSkill(skill: SkillDraft): Promise<{ success: boolean; path: string; error?: string }> {
  const skillsDir = join(process.cwd(), "cogs", "skills");
  const skillDir = join(skillsDir, skill.name);
  const skillPath = join(skillDir, "SKILL.md");

  try {
    // ensure directories exist
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
    }
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }

    // write the skill file
    const content = generateSkillContent(skill);
    await Bun.write(skillPath, content);

    return { success: true, path: skillPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, path: skillPath, error: message };
  }
}

// list available skills for display
export function listSkillNames(): string[] {
  const skillsDir = join(process.cwd(), "cogs", "skills");
  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    const { readdirSync, statSync } = require("fs");
    const entries = readdirSync(skillsDir) as string[];
    return entries.filter((entry: string) => {
      const entryPath = join(skillsDir, entry);
      return statSync(entryPath).isDirectory() && existsSync(join(entryPath, "SKILL.md"));
    });
  } catch {
    return [];
  }
}
