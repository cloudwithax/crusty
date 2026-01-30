import { z } from "zod";
import { skillRegistry } from "../core/skills.ts";

// schema for skill tool
const skillSchema = z.object({
  name: z.string().describe("the name of the skill to load"),
});

// schema for reading a file from a skill
const readSkillFileSchema = z.object({
  skill_name: z.string().describe("the name of the skill"),
  filename: z.string().describe("the filename to read from the skill directory"),
});

// handler for loading a skill
async function handleSkill(args: { name: string }): Promise<string> {
  const content = await skillRegistry.loadSkillContent(args.name);

  if (!content) {
    const available = skillRegistry.listSkills();
    if (available.length === 0) {
      return `[Error] No skills are currently available. Skills can be added to .crusty/skills/, cogs/skills/, or ~/.config/crusty/skills/`;
    }
    return `[Error] Skill "${args.name}" not found. Available skills: ${available.join(", ")}`;
  }

  return content;
}

// handler for reading a skill file
async function handleReadSkillFile(args: {
  skill_name: string;
  filename: string;
}): Promise<string> {
  const content = await skillRegistry.readSkillFile(args.skill_name, args.filename);

  if (!content) {
    return `[Error] Could not read file "${args.filename}" from skill "${args.skill_name}". The file may not exist or the skill was not found.`;
  }

  return content;
}

// export tool definitions
export const skillTools = {
  skill: {
    description: `Load a skill to get detailed instructions for a specific type of task. Skills contain step-by-step guides, best practices, and examples.

HOW TO USE:
1. Check the available skills in your system prompt (listed under "Available Skills")
2. When the user's request matches a skill's description, CALL THIS TOOL FIRST before doing the task
3. Read the skill content that is returned - it will tell you exactly how to proceed
4. Follow the skill's instructions to complete the task

WHEN TO LOAD A SKILL:
- Before using bash/shell tools -> load the "bash" skill
- When you see a task that matches any available skill description -> load that skill
- When you're unsure how to approach a task and a relevant skill exists -> load it

PARAMETER:
- name (required): The exact name of the skill to load (e.g., "bash")

The skill content will be returned as text. Read it carefully and follow its guidance.`,
    schema: skillSchema,
    handler: handleSkill,
  },
  read_skill_file: {
    description: `Read an additional file bundled with a skill. Some skills include templates, examples, or reference files in their directory.

WHEN TO USE:
- When a loaded skill mentions you should read a specific file
- When you need a template or example from a skill

PARAMETERS:
- skill_name (required): The name of the skill that contains the file
- filename (required): The filename to read from the skill directory`,
    schema: readSkillFileSchema,
    handler: handleReadSkillFile,
  },
};
