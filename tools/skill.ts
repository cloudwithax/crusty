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
    description:
      "Load a skill to get specialized instructions for a specific type of task. Skills are like mini-guides that tell you how to handle certain domains (e.g., coding, research, writing). Use this when you recognize the user's request matches an available skill. The skill content will give you step-by-step instructions and best practices.",
    schema: skillSchema,
    handler: handleSkill,
  },
  read_skill_file: {
    description:
      "Read an additional file bundled with a skill. Some skills include templates, examples, or reference files. Use this when a loaded skill mentions you should read a specific file from its directory.",
    schema: readSkillFileSchema,
    handler: handleReadSkillFile,
  },
};
