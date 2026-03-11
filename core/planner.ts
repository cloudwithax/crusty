// core/planner.ts
// lightweight cognitive planning layer
// adds plan -> act -> verify loop for complex tasks

import { nativeChatCompletion } from "./api.ts";
import { debug } from "../utils/debug.ts";
import { withRetry } from "../utils/retry.ts";

const SUMMARIZE_MODEL =
  process.env.SUMMARIZE_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

export interface PlanStep {
  tool: string;
  purpose: string;
  args_hint?: Record<string, unknown>;
}

export interface TaskPlan {
  intent: string;
  complexity: "simple" | "moderate" | "complex";
  needs_tools: boolean;
  needs_clarification: boolean;
  clarifying_question?: string;
  tool_plan: PlanStep[];
  success_criteria: string;
  estimated_steps: number;
  work_mode?: "default" | "coding_project";
}

export interface VerificationResult {
  is_complete: boolean;
  confidence: number;
  missing_info?: string;
  suggested_next_step?: string;
}

// extract a json object from model output, stripping tool call tags, thinking
// blocks, markdown fences, and other non-json noise that models interleave
function extractJson(raw: string): string | null {
  let text = raw;

  // strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  // strip known interleaved tool call and reasoning tags
  // covers openai-style, anthropic-style, deepseek, qwen, mistral, etc
  text = text.replace(
    /<\|?(tool_call|toolcall|function_call|tool_use|invoke|action|thinking|think|reasoning|reflection|scratch|pad|inner_monologue|antml:[\w]+)[^>]*>[\s\S]*?<\/?\|?\1[^>]*>/gi,
    "",
  );

  // strip self-closing and orphan tags that didnt have a closing pair
  text = text.replace(
    /<\|?(tool_call|toolcall|function_call|tool_use|invoke|action|thinking|think|reasoning|reflection|scratch|pad|inner_monologue|antml:[\w]+)[^>]*\/?>/gi,
    "",
  );

  // strip the crusty custom tool call format
  text = text.replace(
    /<\|toolcallsectionbegin\|>[\s\S]*?<\|toolcallsectionend\|>/g,
    "",
  );

  text = text.trim();

  // isolate the json object
  const braceStart = text.indexOf("{");
  if (braceStart === -1) return null;
  if (braceStart > 0) {
    text = text.slice(braceStart);
  }
  const braceEnd = text.lastIndexOf("}");
  if (braceEnd === -1) return null;
  if (braceEnd < text.length - 1) {
    text = text.slice(0, braceEnd + 1);
  }

  return text;
}

// determine if a message is simple enough to skip planning
function isSimpleQuery(message: string): boolean {
  const simple_patterns = [
    /^(hi|hello|hey|thanks|thank you|ok|okay|sure|got it|bye|goodbye)\b/i,
    /^(what time|what's the time|what is the time)/i,
    /^(who are you|what are you|what's your name)/i,
  ];

  const msg = message.trim();
  if (msg.length < 30 && simple_patterns.some((p) => p.test(msg))) {
    return true;
  }

  // short messages without question marks or complex structure
  if (msg.length < 20 && !msg.includes("?") && msg.split(" ").length < 5) {
    return true;
  }

  return false;
}

// create a plan for handling the user's request
export async function createPlan(
  userMessage: string,
  conversationContext: string,
  availableTools: string[],
): Promise<TaskPlan | null> {
  // skip planning for simple queries
  if (isSimpleQuery(userMessage)) {
    debug("[planner] skipping - simple query");
    return null;
  }

  const systemPrompt = `you are a task planner for an ai assistant. analyze the user's request and create a structured plan.

available tools: ${availableTools.join(", ")}

respond with valid json only, no markdown:
{
  "intent": "brief description of what user wants",
  "complexity": "simple" | "moderate" | "complex",
  "needs_tools": true/false,
  "needs_clarification": true/false,
  "clarifying_question": "question to ask if needs_clarification is true",
  "tool_plan": [{"tool": "tool_name", "purpose": "why this tool"}],
  "success_criteria": "how to know the task is complete",
  "estimated_steps": number,
  "work_mode": "default" | "coding_project"
}

guidelines:
- set needs_clarification=true only if critical info is missing
- for simple questions, set needs_tools=false
- tool_plan should be minimal - only essential tools
- be practical, not overly thorough
- set work_mode to "coding_project" when the user wants to create or modify multiple files, add features to a codebase, integrate libraries, refactor across modules, or implement something in a repository
- set work_mode to "default" for simple scripts, one-off snippets, single file changes, questions, or non-coding tasks`;

  const userPrompt = `conversation context (recent):
${conversationContext.slice(-1000)}

user request: ${userMessage}

create plan:`;

  try {
    const response = await withRetry(
      () =>
        nativeChatCompletion({
          model: SUMMARIZE_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 400,
          temperature: 0.3,
        }),
      { maxRetries: 10, baseDelayMs: 1000 },
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const jsonStr = extractJson(content);
    if (!jsonStr) {
      debug("[planner] response was not valid json, skipping");
      return null;
    }

    const plan = JSON.parse(jsonStr) as TaskPlan;
    debug(
      `[planner] created plan: ${plan.intent} (${plan.complexity}, ${plan.estimated_steps} steps)`,
    );
    return plan;
  } catch (err) {
    debug(`[planner] failed:`, err);
    return null;
  }
}

// classify message intent for routing
export type MessageIntent = "chat" | "task" | "question" | "command";

export function classifyIntent(message: string): MessageIntent {
  const msg = message.toLowerCase().trim();

  // commands - explicit instructions
  if (
    /^(do|make|create|build|write|edit|delete|run|execute|search|find|browse|open|read)\b/.test(
      msg,
    )
  ) {
    return "command";
  }

  // questions
  if (
    msg.includes("?") ||
    /^(what|where|when|who|why|how|is|are|can|could|would|should|does|do)\b/.test(
      msg,
    )
  ) {
    return "question";
  }

  // task-like (longer, specific requests)
  if (msg.length > 50 && msg.split(" ").length > 8) {
    return "task";
  }

  // default to chat
  return "chat";
}
