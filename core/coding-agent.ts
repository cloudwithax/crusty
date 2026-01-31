import { OpenAI } from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import {
  generateOpenAITools,
  executeTool,
  cleanupTools,
} from "../tools/registry.ts";
import { debug } from "../utils/debug.ts";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { v4 as uuid } from "uuid";

// environment
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const INFERENCE_RPM_LIMIT = parseInt(process.env.INFERENCE_RPM_LIMIT || "40", 10);

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 60 * 1000, // longer timeout for coding tasks
});

// rate limiter
class RateLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((ts) => now - ts < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const wait = this.windowMs - (now - this.timestamps[0]!) + 10;
      await new Promise((r) => setTimeout(r, wait));
      return this.acquire();
    }
    this.timestamps.push(now);
  }
}

const rateLimiter = new RateLimiter(INFERENCE_RPM_LIMIT);

// react system prompt - emphasizes thought before action
const REACT_SYSTEM_PROMPT = `you are a coding agent that implements software projects step by step.

you operate in a ReAct loop: Thought -> Action -> Observation -> repeat

CRITICAL RULES:
1. ALWAYS output your Thought before taking any action
2. each Thought should explain WHAT you're doing and WHY
3. after each tool result (Observation), reflect on what you learned
4. work methodically through the plan - one step at a time
5. if something fails, reason about why and try a different approach
6. when the task is complete, output a final summary

WORKSPACE RULES:
- you are working in an ISOLATED workspace directory
- NEVER access files outside your workspace
- NEVER access /app or any parent directories
- all file paths should be relative to your workspace root
- the workspace will be cleaned up after you finish

OUTPUT FORMAT:
Thought: [your reasoning about what to do next]
[then call a tool OR provide final answer]

AFTER receiving a tool result:
Observation: [brief note about what you learned]
Thought: [reasoning for next step]
[continue...]

available tools: read, write, edit, glob, grep, bash (if enabled)

remember: think first, act second. no rushing.`;

// protected paths that the coding agent should never touch
const PROTECTED_PATHS = [
  "/app",
  "/home",
  "/etc",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/root",
];

// check if a path is trying to escape the workspace
function isPathProtected(path: string, workspace: string): boolean {
  const resolved = join(workspace, path).replace(/\/+/g, "/");
  
  // must stay within workspace
  if (!resolved.startsWith(workspace)) return true;
  
  // check against protected paths
  for (const protected_path of PROTECTED_PATHS) {
    if (resolved.startsWith(protected_path) && !protected_path.startsWith(workspace)) {
      return true;
    }
  }
  
  return false;
}

// planning prompt
const PLANNING_PROMPT = `you are a senior software architect. analyze the coding request and create a detailed implementation plan.

your plan must include:
1. UNDERSTANDING - restate the problem in your own words
2. REQUIREMENTS - list specific technical requirements
3. FILE STRUCTURE - what files need to be created/modified
4. IMPLEMENTATION STEPS - numbered, actionable steps (be specific!)
5. VERIFICATION - how to verify the implementation works

be thorough but practical. the plan will be executed by a coding agent with these tools:
- read: read file contents
- write: create/overwrite files  
- edit: search/replace in files
- glob: find files by pattern
- grep: search file contents
- bash: run shell commands (if enabled)

output your plan in markdown format.`;

export interface CodingCallbacks {
  onThought?: (thought: string) => Promise<void>;
  onAction?: (tool: string, preview: string) => Promise<void>;
  onObservation?: (result: string) => Promise<void>;
  onPlanReady?: (plan: string) => Promise<void>;
  onComplete?: (summary: string) => Promise<void>;
  onWorkspaceCreated?: (path: string) => Promise<void>;
  onUploadReady?: (url: string) => Promise<void>;
  onTyping?: () => Promise<void>;
}

export class CodingAgent {
  private workspace: string;
  private workspaceId: string;

  constructor() {
    // create isolated workspace in /tmp
    this.workspaceId = uuid().slice(0, 8);
    this.workspace = `/tmp/crusty-workspace-${this.workspaceId}`;
    
    if (!existsSync(this.workspace)) {
      mkdirSync(this.workspace, { recursive: true });
    }
    
    debug(`[coding] created workspace: ${this.workspace}`);
  }

  getWorkspace(): string {
    return this.workspace;
  }

  // phase 1: create detailed plan
  async plan(task: string, callbacks?: CodingCallbacks): Promise<string> {
    debug("[coding] generating plan...");
    
    if (callbacks?.onTyping) await callbacks.onTyping();

    await rateLimiter.acquire();
    
    if (callbacks?.onWorkspaceCreated) {
      await callbacks.onWorkspaceCreated(this.workspace);
    }

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: PLANNING_PROMPT },
        { role: "user", content: `workspace directory: ${this.workspace}\n\ntask:\n${task}` },
      ],
      temperature: 0.7,
    });

    const plan = response.choices[0]?.message?.content || "failed to generate plan";
    
    if (callbacks?.onPlanReady) {
      await callbacks.onPlanReady(plan);
    }

    debug(`[coding] plan generated: ${plan.length} chars`);
    return plan;
  }

  // phase 2: execute plan using react loop
  async execute(task: string, plan: string, callbacks?: CodingCallbacks): Promise<string> {
    debug("[coding] starting react execution loop...");

    const tools = generateOpenAITools();
    
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: REACT_SYSTEM_PROMPT },
      { 
        role: "user", 
        content: `## task\n${task}\n\n## plan\n${plan}\n\n## workspace\n${this.workspace}\n\nIMPORTANT: all file operations must use absolute paths starting with ${this.workspace}/\n\nbegin implementation. start with a Thought about your first step.`
      },
    ];

    let iterations = 0;
    const maxIterations = 50; // safety limit
    let finalSummary = "";

    // react loop: continue until agent says done or hits limit
    while (iterations < maxIterations) {
      iterations++;
      debug(`[coding] react iteration ${iterations}`);

      if (callbacks?.onTyping) await callbacks.onTyping();

      await rateLimiter.acquire();

      let response;
      try {
        response = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? "auto" : undefined,
          temperature: 0.3, // lower temp for more focused execution
        });
      } catch (err) {
        debug(`[coding] api error: ${err}`);
        return `error during execution: ${err instanceof Error ? err.message : String(err)}`;
      }

      const choice = response.choices[0];
      if (!choice) break;

      const message = choice.message;
      const content = message.content || "";
      const toolCalls = message.tool_calls || [];

      // extract and emit thought
      if (content.trim()) {
        const thoughtMatch = content.match(/Thought:\s*(.+?)(?=\n|$)/is);
        if (thoughtMatch && callbacks?.onThought) {
          await callbacks.onThought(thoughtMatch[1]!.trim());
        }
        debug(`[coding] thought: ${content.slice(0, 150)}...`);
      }

      // add assistant message
      messages.push({
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      // no tools = agent is done
      if (toolCalls.length === 0) {
        finalSummary = content;
        break;
      }

      // execute each tool (action phase)
      for (const toolCall of toolCalls) {
        const fn = (toolCall as { function: { name: string; arguments: string } }).function;
        const name = fn.name;
        let args = fn.arguments;

        // validate and rewrite paths to stay within workspace
        try {
          const parsed = JSON.parse(args);
          
          // check for path-based arguments
          for (const key of ["path", "workdir"]) {
            if (parsed[key] && typeof parsed[key] === "string") {
              const path = parsed[key] as string;
              
              // if relative path, make it absolute within workspace
              if (!path.startsWith("/")) {
                parsed[key] = join(this.workspace, path);
              }
              
              // block protected paths
              if (isPathProtected(parsed[key], this.workspace)) {
                debug(`[coding] BLOCKED: ${name} tried to access protected path: ${path}`);
                messages.push({
                  role: "tool",
                  content: `error: access denied. you can only access files within your workspace: ${this.workspace}`,
                  tool_call_id: toolCall.id,
                });
                continue;
              }
            }
          }
          
          // block commands that might escape workspace
          if (name === "bash_execute" && parsed.command) {
            const cmd = parsed.command as string;
            // block cd to parent or absolute paths outside workspace
            if (/cd\s+[./]*\.\./.test(cmd) || /cd\s+\/(?!tmp\/crusty)/.test(cmd)) {
              messages.push({
                role: "tool",
                content: `error: cannot cd outside workspace. stay within ${this.workspace}`,
                tool_call_id: toolCall.id,
              });
              continue;
            }
            // set workdir to workspace if not specified
            if (!parsed.workdir) {
              parsed.workdir = this.workspace;
            }
          }
          
          args = JSON.stringify(parsed);
        } catch {
          // ignore parse errors, let executeTool handle it
        }

        // parse args for preview
        let preview = "";
        try {
          const parsed = JSON.parse(args);
          preview = Object.values(parsed)[0]?.toString().slice(0, 60) || "";
        } catch {
          preview = args.slice(0, 60);
        }

        debug(`[coding] action: ${name}(${preview}...)`);
        
        if (callbacks?.onAction) {
          await callbacks.onAction(name, preview);
        }

        // execute
        const result = await executeTool(name, args, 0);
        
        // truncate long results for display
        const displayResult = result.length > 200 
          ? `${result.slice(0, 200)}... (+${result.length - 200} chars)`
          : result;

        debug(`[coding] observation: ${displayResult}`);
        
        if (callbacks?.onObservation) {
          await callbacks.onObservation(displayResult);
        }

        // add tool result (observation)
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        });
      }
    }

    if (iterations >= maxIterations) {
      finalSummary = `reached iteration limit (${maxIterations}). partial progress made.`;
    }

    if (callbacks?.onComplete) {
      await callbacks.onComplete(finalSummary);
    }

    debug(`[coding] completed in ${iterations} iterations`);
    return finalSummary;
  }

  // main entry: plan then execute
  async run(task: string, callbacks?: CodingCallbacks): Promise<{ plan: string; result: string; workspace: string; uploadUrl?: string }> {
    const plan = await this.plan(task, callbacks);
    const result = await this.execute(task, plan, callbacks);
    
    // try to upload workspace to 0x0.st
    let uploadUrl: string | undefined;
    try {
      uploadUrl = await this.uploadWorkspace();
      if (uploadUrl && callbacks?.onUploadReady) {
        await callbacks.onUploadReady(uploadUrl);
      }
    } catch (err) {
      debug(`[coding] upload failed: ${err}`);
    }
    
    return { plan, result, workspace: this.workspace, uploadUrl };
  }

  // upload workspace as tarball to 0x0.st (anonymous file hosting)
  async uploadWorkspace(): Promise<string | undefined> {
    try {
      // create tarball
      const tarPath = `/tmp/crusty-${this.workspaceId}.tar.gz`;
      const { execSync } = await import("child_process");
      
      execSync(`tar -czf ${tarPath} -C ${this.workspace} .`, { stdio: "pipe" });
      debug(`[coding] created tarball: ${tarPath}`);
      
      // upload to 0x0.st
      const result = execSync(`curl -s -F "file=@${tarPath}" https://0x0.st`, { 
        encoding: "utf-8",
        timeout: 30000,
      });
      
      const url = result.trim();
      if (url.startsWith("http")) {
        debug(`[coding] uploaded to: ${url}`);
        
        // cleanup tarball
        rmSync(tarPath, { force: true });
        
        return url;
      }
    } catch (err) {
      debug(`[coding] upload error: ${err}`);
    }
    return undefined;
  }

  // cleanup workspace
  async cleanup(): Promise<void> {
    await cleanupTools();
    
    // optionally remove workspace (keep for now so user can inspect)
    // rmSync(this.workspace, { recursive: true, force: true });
    debug(`[coding] workspace preserved at: ${this.workspace}`);
  }

  // force cleanup workspace
  destroyWorkspace(): void {
    if (existsSync(this.workspace)) {
      rmSync(this.workspace, { recursive: true, force: true });
      debug(`[coding] workspace destroyed: ${this.workspace}`);
    }
  }
}

// detect if a message is a coding task using llm
export async function isCodingTask(message: string): Promise<boolean> {
  // quick regex pre-filter for obvious non-coding messages
  const obviouslyNot = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|what|how|why|when|where|who)[\s!?.]*$/i;
  if (obviouslyNot.test(message.trim())) {
    return false;
  }

  // ask the model
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `you are a task classifier. determine if the user message is asking you to write, create, modify, fix, or work on code/software.

coding tasks include:
- creating apps, scripts, bots, websites, tools
- writing functions, classes, modules
- fixing bugs, refactoring code
- setting up projects, configs, environments
- implementing features or apis

NOT coding tasks:
- general questions or explanations
- browsing/searching the web
- casual conversation
- asking about concepts without implementation

respond with only "yes" or "no".`
        },
        { role: "user", content: message }
      ],
      max_tokens: 3,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content?.toLowerCase().trim();
    debug(`[coding detection] "${message.slice(0, 50)}..." -> ${answer}`);
    return answer === "yes";
  } catch (err) {
    debug(`[coding detection] error: ${err}`);
    return false; // fail safe to normal chat
  }
}
