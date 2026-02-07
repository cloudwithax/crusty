// core/planner.ts
// lightweight cognitive planning layer
// adds plan -> act -> verify loop for complex tasks

import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { debug } from "../utils/debug.ts";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const SUMMARIZE_MODEL = process.env.SUMMARIZE_MODEL || "gpt-4o-mini";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 15 * 1000,
});

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
  availableTools: string[]
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
    const response = await openai.chat.completions.create({
      model: SUMMARIZE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    // extract json from response (handle markdown code blocks)
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1]!.trim();
    }

    const plan = JSON.parse(jsonStr) as TaskPlan;
    debug(
      `[planner] created plan: ${plan.intent} (${plan.complexity}, ${plan.estimated_steps} steps)`
    );
    return plan;
  } catch (err) {
    debug(`[planner] failed:`, err);
    return null;
  }
}

// verify if the task has been completed based on tool results
export async function verifyCompletion(
  originalIntent: string,
  toolResults: string[],
  assistantResponse: string
): Promise<VerificationResult> {
  // skip verification for empty results
  if (toolResults.length === 0) {
    return { is_complete: true, confidence: 0.8 };
  }

  const systemPrompt = `you verify if an ai assistant has completed a task. respond with json only:
{
  "is_complete": true/false,
  "confidence": 0.0-1.0,
  "missing_info": "what's still needed if incomplete",
  "suggested_next_step": "specific action if incomplete"
}

be practical - if the core request is addressed, consider it complete even if minor details could be added.`;

  const userPrompt = `original intent: ${originalIntent}

tool results summary:
${toolResults
  .slice(-3)
  .map((r, i) => `${i + 1}. ${r.slice(0, 200)}...`)
  .join("\n")}

assistant's response: ${assistantResponse.slice(0, 500)}

is this complete?`;

  try {
    const response = await openai.chat.completions.create({
      model: SUMMARIZE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 150,
      temperature: 0.2,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return { is_complete: true, confidence: 0.6 };

    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1]!.trim();
    }

    return JSON.parse(jsonStr) as VerificationResult;
  } catch (err) {
    debug(`[planner] verification failed:`, err);
    return { is_complete: true, confidence: 0.5 };
  }
}

// classify message intent for routing
export type MessageIntent = "chat" | "task" | "question" | "command";

export function classifyIntent(message: string): MessageIntent {
  const msg = message.toLowerCase().trim();

  // commands - explicit instructions
  if (
    /^(do|make|create|build|write|edit|delete|run|execute|search|find|browse|open|read)\b/.test(
      msg
    )
  ) {
    return "command";
  }

  // questions
  if (
    msg.includes("?") ||
    /^(what|where|when|who|why|how|is|are|can|could|would|should|does|do)\b/.test(
      msg
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
