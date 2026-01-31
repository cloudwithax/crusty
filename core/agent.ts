import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { readFileSync } from "fs";
import { join } from "path";
import {
  generateOpenAITools,
  executeTool,
  cleanupTools,
} from "../tools/registry.ts";
import {
  loadBootstrapSystem,
  type InjectionResult,
} from "./bootstrap.ts";
import {
  initSelfReview,
  checkForOverlaps,
  generateCounterCheckPrompt,
} from "../scheduler/self-review.ts";
import { addRecentContext } from "../scheduler/heartbeat.ts";
import { memoryService } from "../memory/service.ts";
import { debug } from "../utils/debug.ts";

// Environment configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const INFERENCE_RPM_LIMIT = parseInt(
  process.env.INFERENCE_RPM_LIMIT || "40",
  10,
);

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

// Initialize OpenAI client with 30 second timeout to prevent indefinite hangs
// 10s was too aggressive and caused spurious timeouts during normal operations
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 30 * 1000,
});

// rate limiter for inference api calls
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

    // remove timestamps outside the window
    this.timestamps = this.timestamps.filter((ts) => now - ts < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      // calculate wait time until the oldest request falls outside the window
      const oldestTimestamp = this.timestamps[0]!;
      const waitTime = this.windowMs - (now - oldestTimestamp) + 10; // +10ms buffer
      debug(`[Rate limit] waiting ${waitTime}ms before next api call`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      // recurse to recheck after waiting
      return this.acquire();
    }

    this.timestamps.push(now);
  }
}

const inferenceRateLimiter = new RateLimiter(INFERENCE_RPM_LIMIT);
debug(
  `[Rate limit] inference api limited to ${INFERENCE_RPM_LIMIT} requests per minute`,
);

// Cog loader - loads and assembles system prompt from cogs
function loadCogContent(cogName: string): string {
  try {
    const cogPath = join(import.meta.dir, "cogs", `${cogName}.md`);
    const content = readFileSync(cogPath, "utf-8");
    // Remove the H1 title and return the content
    return content.replace(/^# .*\n+/, "").trim();
  } catch {
    return "";
  }
}

// Build core instructions from traditional cogs (for backward compatibility)
function buildCoreInstructions(): string {
  const now = new Date();
  const timeString = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  // Load all cogs
  const identityCog = loadCogContent("identity");
  const memoryCog = loadCogContent("memory");
  const runtimeCog = loadCogContent("runtime");

  // Replace template variables in runtime cog
  const processedRuntimeCog = runtimeCog
    .replace(/\{\{CURRENT_TIME\}\}/g, timeString)
    .replace(/\{\{WORKING_DIR\}\}/g, process.cwd());

  // Assemble the core instructions from cogs
  return `# Identity\n\n${identityCog}\n\n# Memory\n\n${memoryCog}\n\n# Runtime\n\n${processedRuntimeCog}`;
}

// Get system prompt using bootstrap system
async function getSystemPrompt(): Promise<string> {
  const coreInstructions = buildCoreInstructions();
  const { prompt } = await loadBootstrapSystem(coreInstructions);
  return prompt;
}

// Parse text-based tool calls (for models that don't support native tool calling)
interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function parseTextToolCalls(content: string): {
  toolCalls: ParsedToolCall[];
  cleanContent: string;
} {
  const toolCalls: ParsedToolCall[] = [];

  // patterns to match various formats models might output:
  // format 1: <|toolcallsectionbegin|><|toolcallbegin|>name:id<|toolcallargumentbegin|>args<|toolcallend|><|toolcallsectionend|>
  // format 2: <|tool_calls_section_begin|><|tool_call_begin|>name:id<|tool_call_argument_begin|>args<|tool_call_end|><|tool_calls_section_end|>
  // format 3 (malformed): toolname{"args"}<|tool_call_end|>
  const sectionPatterns = [
    /<\|toolcallsectionbegin\|>([\s\S]*?)<\|toolcallsectionend\|>/g,
    /<\|tool_calls_section_begin\|>([\s\S]*?)<\|tool_calls_section_end\|>/g,
  ];
  const callPatterns = [
    /<\|toolcallbegin\|>([^<]+)<\|toolcallargumentbegin\|>([\s\S]*?)<\|toolcallend\|>/g,
    /<\|tool_call_begin\|>([^<]+)<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g,
  ];

  // try both formats
  for (let i = 0; i < sectionPatterns.length; i++) {
    const sectionPattern = sectionPatterns[i]!;
    const callPattern = callPatterns[i]!;

    const sectionMatches = content.matchAll(sectionPattern);
    for (const sectionMatch of sectionMatches) {
      const sectionContent = sectionMatch[1] || "";
      const callMatches = sectionContent.matchAll(callPattern);

      for (const callMatch of callMatches) {
        const nameAndId = callMatch[1] || "";
        const args = callMatch[2] || "{}";
        // Parse "functions.toolname:id" format
        const [fullName, id] = nameAndId.split(":");
        const name = (fullName || "").replace("functions.", "");

        toolCalls.push({
          id:
            id ||
            `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          name,
          arguments: args,
        });
      }
    }
  }

  // try to catch malformed tool calls like: toolname{"arg": "val"}<|tool_call_end|>
  // this handles models that skip the begin tags
  if (toolCalls.length === 0) {
    const malformedPattern =
      /(\w+)(\{[\s\S]*?\})(?:<\|tool_call_end\|>|<\|toolcallend\|>)/g;
    const matches = content.matchAll(malformedPattern);
    for (const match of matches) {
      const name = match[1] || "";
      const args = match[2] || "{}";
      // only add if it looks like a real tool name (has underscore like browser_navigate, send_status_update)
      if (
        name.includes("_") ||
        ["navigate", "click", "type", "scroll", "search"].some((t) =>
          name.toLowerCase().includes(t),
        )
      ) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          name,
          arguments: args,
        });
      }
    }
  }

  // remove all tool call sections and malformed patterns from content
  let cleanContent = content;
  cleanContent = cleanContent.replace(
    /<\|toolcallsectionbegin\|>[\s\S]*?<\|toolcallsectionend\|>/g,
    "",
  );
  cleanContent = cleanContent.replace(
    /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g,
    "",
  );
  // clean up partial/malformed tool call syntax
  cleanContent = cleanContent.replace(
    /\w+\{[\s\S]*?\}(?:<\|tool_call_end\|>|<\|toolcallend\|>)/g,
    "",
  );
  cleanContent = cleanContent.replace(/<\|tool_call[s_]*[a-z_]*\|>/gi, "");
  cleanContent = cleanContent.replace(/<\|toolcall[a-z]*\|>/gi, "");
  cleanContent = cleanContent.trim();

  return { toolCalls, cleanContent };
}

// attempt to recover valid json from malformed tool arguments
// tries to infer intent from partial/broken json based on tool name
function recoverMalformedArgs(toolName: string, brokenArgs: string): string {
  // extract any partial key-value pairs we can find
  const directionMatch = brokenArgs.match(/"?direction"?\s*[:=]\s*"?(up|down)/i);
  const urlMatch = brokenArgs.match(/"?url"?\s*[:=]\s*"?([^"}\s]+)/i);
  const selectorMatch = brokenArgs.match(/"?selector"?\s*[:=]\s*"([^"]+)"/i);
  const textMatch = brokenArgs.match(/"?text"?\s*[:=]\s*"([^"]+)"/i);

  // tool-specific recovery based on what we found
  if (toolName === "browser_scroll" && directionMatch) {
    return JSON.stringify({ direction: directionMatch[1]!.toLowerCase() });
  }

  if (toolName === "browser_navigate" && urlMatch) {
    return JSON.stringify({ url: urlMatch[1] });
  }

  if (toolName === "browser_click" && selectorMatch) {
    return JSON.stringify({ selector: selectorMatch[1] });
  }

  if (toolName === "browser_type" && selectorMatch && textMatch) {
    return JSON.stringify({ selector: selectorMatch[1], text: textMatch[1] });
  }

  // recover web_search queries from malformed json
  if (toolName === "web_search") {
    const queryMatch = brokenArgs.match(/"?query"?\s*[:=]\s*"([^"]+)"/i);
    if (queryMatch?.[1]) {
      return JSON.stringify({ query: queryMatch[1] });
    }
    // if no recoverable query, return error indicator so we dont search for garbage
    return JSON.stringify({ query: "" });
  }

  // default to empty object if we cant recover anything
  return "{}";
}

// sanitize tool calls by ensuring all arguments are valid json
// this prevents 400 errors when sending malformed tool calls back to the api
function sanitizeToolCalls(
  toolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>,
): Array<{
  id: string;
  type: string;
  function: { name: string; arguments: string };
}> {
  return toolCalls.map((tc) => {
    let args = tc.function.arguments;
    try {
      JSON.parse(args);
    } catch {
      debug(
        `[Warning: Malformed tool call arguments for ${tc.function.name}: ${args}]`,
      );
      const recovered = recoverMalformedArgs(tc.function.name, args);
      debug(`[Recovered args: ${recovered}]`);
      args = recovered;
    }
    return {
      ...tc,
      function: {
        ...tc.function,
        arguments: args,
      },
    };
  });
}

// sanitize argument values to fix common model quirks
// handles malformed urls, leading colons, extra quotes, etc
function sanitizeArgumentValues(argsString: string): string {
  try {
    const args = JSON.parse(argsString);
    let modified = false;

    for (const key of Object.keys(args)) {
      const value = args[key];
      if (typeof value !== "string") continue;

      let cleaned = value;

      // remove leading colons and whitespace (common model quirk)
      if (/^:\s*/.test(cleaned)) {
        cleaned = cleaned.replace(/^:\s*/, "");
        modified = true;
      }

      // remove leading garbage characters before urls (e.g., ">https://..." -> "https://...")
      const urlPrefixMatch = cleaned.match(/^[^a-zA-Z]*(https?:\/\/)/i);
      if (urlPrefixMatch?.[1] && urlPrefixMatch[0] !== urlPrefixMatch[1]) {
        cleaned = cleaned.slice(
          urlPrefixMatch[0].length - urlPrefixMatch[1].length,
        );
        modified = true;
      }

      // remove wrapping quotes from urls (e.g., "\"https://...\"" -> "https://...")
      if (/^["'].*["']$/.test(cleaned) && cleaned.includes("://")) {
        cleaned = cleaned.slice(1, -1);
        modified = true;
      }

      // fix escaped quotes in urls
      if (cleaned.includes('\\"') && cleaned.includes("://")) {
        cleaned = cleaned.replace(/\\"/g, "");
        modified = true;
      }

      if (modified) {
        debug(`[Sanitizing ${key}: "${value}" -> "${cleaned}"]`);
        args[key] = cleaned;
      }
    }

    return JSON.stringify(args);
  } catch {
    return argsString;
  }
}

// strip emojis from agent responses to comply with project guidelines
// covers most unicode emoji ranges including emoticons, symbols, and modifiers
function stripEmojis(text: string): string {
  return text.replace(
    /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]/gu,
    ""
  ).replace(/\s{2,}/g, " ").trim();
}

// domains and patterns to exclude from sources (analytics, trackers, non-informational)
const excludedUrlPatterns = [
  // analytics and tracking
  /googletagmanager\.com/i,
  /google-analytics\.com/i,
  /analytics\.google\.com/i,
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /googleadservices\.com/i,
  /facebook\.com\/tr/i,
  /connect\.facebook\.net/i,
  /pixel\.facebook\.com/i,
  /hotjar\.com/i,
  /clarity\.ms/i,
  /segment\.com/i,
  /segment\.io/i,
  /mixpanel\.com/i,
  /amplitude\.com/i,
  /heap\.io/i,
  /fullstory\.com/i,
  /newrelic\.com/i,
  /nr-data\.net/i,
  /sentry\.io/i,
  /bugsnag\.com/i,
  /rollbar\.com/i,
  /logrocket\.com/i,
  /mouseflow\.com/i,
  /crazyegg\.com/i,
  /optimizely\.com/i,
  /adobedtm\.com/i,
  /omtrdc\.net/i,
  /demdex\.net/i,
  /adsrvr\.org/i,
  /adnxs\.com/i,
  /criteo\.com/i,
  /taboola\.com/i,
  /outbrain\.com/i,
  /tiktok\.com\/i18n/i,
  /snap\.licdn\.com/i,
  /ads\.linkedin\.com/i,
  /bat\.bing\.com/i,
  /tags\.tiqcdn\.com/i,
  /cdn\.cookielaw\.org/i,
  /onetrust\.com/i,
  /cookiebot\.com/i,
  /consensu\.org/i,
  /quantserve\.com/i,
  /scorecardresearch\.com/i,
  /chartbeat\.com/i,
  /parsely\.com/i,
  /cdn\.branch\.io/i,
  /app\.link/i,
  /intercom\.io/i,
  /widget\.intercom\.io/i,
  /drift\.com/i,
  /zendesk\.com\/embeddable/i,
  /freshdesk\.com/i,
  /livechatinc\.com/i,
  /tawk\.to/i,
  /recaptcha/i,
  /gstatic\.com/i,
  /cloudflareinsights\.com/i,
  /plausible\.io/i,
  /matomo\./i,
  /piwik\./i,
  // cdn/asset urls that aren't informational
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /use\.typekit\.net/i,
  /kit\.fontawesome\.com/i,
  /cdnjs\.cloudflare\.com/i,
  /unpkg\.com/i,
  /jsdelivr\.net/i,
  // common non-content patterns
  /\.js(\?|$)/i,
  /\.css(\?|$)/i,
  /\.woff2?(\?|$)/i,
  /\.ttf(\?|$)/i,
  /\.png(\?|$)/i,
  /\.jpg(\?|$)/i,
  /\.gif(\?|$)/i,
  /\.svg(\?|$)/i,
  /\.ico(\?|$)/i,
  /\/api\//i,
  /\/ajax\//i,
  /\/pixel/i,
  /\/beacon/i,
  /\/track/i,
  /\/collect/i,
];

function isInformationalUrl(url: string): boolean {
  return !excludedUrlPatterns.some((pattern) => pattern.test(url));
}

// whimsical status messages for long-running operations
const thinkingMessages = [
  "still crunching on this one...",
  "the gears are turning...",
  "hold tight, almost there...",
  "digging through the internet...",
  "one sec, gathering intel...",
  "my claws are typing furiously...",
  "sifting through the digital sand...",
  "patience, good things take time...",
];

const browsingMessages = [
  "scuttling across the webpage...",
  "reading through the good stuff...",
  "my eyes are scanning...",
  "absorbing the knowledge...",
  "taking notes...",
  "this site has a lot going on...",
];

function getRandomMessage(messages: string[]): string {
  return messages[Math.floor(Math.random() * messages.length)] || messages[0]!;
}

// callback types for real-time updates during agent execution
export interface AgentCallbacks {
  onStatusUpdate?: (message: string) => Promise<void>;
  onTyping?: () => Promise<void>;
}

// Agent class
export class Agent {
  private _messages: ChatCompletionMessageParam[];
  private userId: number;
  private initialized: boolean = false;

  // getter for testing purposes
  get messages(): ChatCompletionMessageParam[] {
    return this._messages;
  }

  constructor(userId: number = 0) {
    this.userId = userId;
    this._messages = [];
  }

  // Initialize the agent with system prompt
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const systemPrompt = await getSystemPrompt();
    this._messages = [
      {
        role: "system",
        content: systemPrompt,
      },
    ];
    this.initialized = true;
  }

  async chat(userMessage: string, callbacks?: AgentCallbacks): Promise<string> {
    // Ensure agent is initialized
    await this.initialize();

    // check for overlaps with recent MISS patterns and inject counter-check if needed
    const overlaps = await checkForOverlaps(userMessage);
    if (overlaps.length > 0) {
      const counterCheckPrompt = generateCounterCheckPrompt(overlaps);
      debug(`[self-review] ${overlaps.length} pattern overlap(s) detected, injecting counter-check`);
      this._messages.push({ role: "system", content: counterCheckPrompt });
    }

    // build memory context from relevant past interactions
    const memoryContext = await memoryService.buildMemoryContext(this.userId, userMessage);
    if (memoryContext) {
      debug(`[memory] injecting relevant memory context`);
      this._messages.push({ role: "system", content: memoryContext });
    }

    // store this message as a memory for future recall
    await memoryService.storeMemory(this.userId, userMessage);

    // Add user message to memory
    this._messages.push({ role: "user", content: userMessage });

    // Generate tools dynamically from registry
    const tools = generateOpenAITools();

    const BASE_ITERATIONS = 5; // Starting iterations
    const MAX_ITERATIONS = 20; // Absolute maximum
    let remainingIterations = BASE_ITERATIONS;
    const responseChunks: string[] = []; // Accumulate responses across iterations
    const toolsUsed: string[] = []; // Track tools used for progress updates
    const collectedUrls: Set<string> = new Set(); // Track URLs from browser usage
    let totalIterations = 0;

    // Tool for agent to request more iterations
    const continueWorkingTool = {
      type: "function" as const,
      function: {
        name: "request_more_iterations",
        description:
          "Call this if you need more iterations to complete the task. Use when you have more tools to call or more work to do.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Brief explanation of why you need more iterations",
            },
          },
          required: ["reason"],
        },
      },
    };

    // Tool for agent to send status updates to user
    const statusUpdateTool = {
      type: "function" as const,
      function: {
        name: "send_status_update",
        description:
          "Send a status update to let the user know what you're doing. Call this FIRST before using any other tools, AND periodically throughout longer tasks (every 2-3 tool calls) to keep the user informed of progress. Examples: 'Let me check some mattress sites...', 'Found some options, comparing prices now...', 'Almost done, gathering the final details...'. Keep messages short and conversational (1 sentence).",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description:
                "A brief, friendly message about what you're about to do (e.g. 'Let me check some mattress review sites for you...')",
            },
          },
          required: ["message"],
        },
      },
    };

    // Add the special tools to available tools
    const allTools = [...tools, continueWorkingTool, statusUpdateTool];

    while (remainingIterations > 0 && totalIterations < MAX_ITERATIONS) {
      totalIterations++;
      remainingIterations--;

      debug(
        `\n--- Iteration ${totalIterations} (${remainingIterations} remaining) ---`,
      );

      // refresh typing indicator before each api call
      if (callbacks?.onTyping) {
        await callbacks.onTyping();
      }

      // Add iteration context to help agent decide
      const iterationContext =
        remainingIterations <= 2
          ? `\n[System: You have ${remainingIterations} iteration(s) remaining. If you need more time, call request_more_iterations. Otherwise, wrap up your response.]`
          : "";

      // Temporarily add iteration context if needed
      const messagesWithContext = iterationContext
        ? [
            ...this._messages,
            { role: "system" as const, content: iterationContext },
          ]
        : this._messages;

      // set up a one-time status update after 3 seconds for long api calls
      let apiStatusSent = false;
      const apiStatusTimeout = setTimeout(async () => {
        if (callbacks?.onStatusUpdate) {
          await callbacks.onStatusUpdate(getRandomMessage(thinkingMessages));
          apiStatusSent = true;
        }
      }, 3000);

      // Call OpenAI with tools
      await inferenceRateLimiter.acquire();
      let response;
      try {
        response = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: messagesWithContext,
          tools: allTools,
          tool_choice: "auto",
        });
      } catch (apiError) {
        clearTimeout(apiStatusTimeout);
        const errorMessage = apiError instanceof Error ? apiError.message : "Unknown error";
        debug(`[API error: ${errorMessage}]`);

        // if we have accumulated content, return it with an error note
        if (responseChunks.length > 0) {
          return responseChunks.join("\n\n") + "\n\n(I ran into an issue and had to stop early. Let me know if you'd like me to continue.)";
        }
        return "I ran into a connection issue while processing your request. Please try again.";
      }

      clearTimeout(apiStatusTimeout);
      if (apiStatusSent && callbacks?.onTyping) {
        await callbacks.onTyping();
      }

      const choice = response.choices[0];
      if (!choice) {
        debug("[No choice in response]");
        break; // Exit loop if no response
      }

      const message = choice.message;
      const content = message.content || "";

      debug("[Raw content]:", JSON.stringify(content));
      debug(
        "[Native tool_calls]:",
        message.tool_calls ? JSON.stringify(message.tool_calls) : "none",
      );

      // Check for text-based tool calls in content
      const { toolCalls: textToolCalls, cleanContent } =
        parseTextToolCalls(content);

      debug("[Parsed text tool calls]:", JSON.stringify(textToolCalls));
      debug("[Clean content]:", JSON.stringify(cleanContent));

      // Handle native tool calls OR text-based tool calls
      const hasNativeToolCalls =
        message.tool_calls && message.tool_calls.length > 0;
      const hasTextToolCalls = textToolCalls.length > 0;

      debug(
        `[hasNativeToolCalls: ${hasNativeToolCalls}, hasTextToolCalls: ${hasTextToolCalls}]`,
      );

      // Accumulate any meaningful content from this iteration
      const meaningfulContent = hasTextToolCalls ? cleanContent : content;
      if (meaningfulContent && meaningfulContent.trim()) {
        responseChunks.push(meaningfulContent.trim());
        
        // send intermediate content to user immediately if we have tools to execute
        // this lets the user see what the agent is saying before it goes off to work
        if ((hasNativeToolCalls || hasTextToolCalls) && callbacks?.onStatusUpdate) {
          const cleanedContent = stripEmojis(meaningfulContent.trim());
          if (cleanedContent.length > 0) {
            await callbacks.onStatusUpdate(cleanedContent);
          }
        }
      }

      if (!hasNativeToolCalls && !hasTextToolCalls) {
        // No tool calls - we're done
        this._messages.push({
          role: "assistant",
          content: content,
        });
        break;
      }

      // Use native tool calls if available, otherwise use parsed text tool calls
      const toolCallsToExecute = hasNativeToolCalls
        ? message.tool_calls!.map((tc) => {
            const func = (
              tc as unknown as { function: { name: string; arguments: string } }
            ).function;
            return { id: tc.id, name: func.name, arguments: func.arguments };
          })
        : textToolCalls;

      // Add assistant message to memory
      if (hasNativeToolCalls) {
        // sanitize tool calls to prevent 400 errors from malformed json arguments
        const sanitizedToolCalls = sanitizeToolCalls(
          message.tool_calls as unknown as Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>,
        );
        this._messages.push({
          role: "assistant",
          content: content,
          tool_calls: sanitizedToolCalls as typeof message.tool_calls,
        });
      } else {
        // For text-based tool calls, store as a regular assistant message with clean content
        this._messages.push({
          role: "assistant",
          content: cleanContent || "Let me help you with that.",
        });
      }

      // Execute each tool call and collect results
      const toolResults: string[] = [];
      for (const toolCall of toolCallsToExecute) {
        // refresh typing indicator before each tool execution
        if (callbacks?.onTyping) {
          await callbacks.onTyping();
        }

        debug(`[Executing tool: ${toolCall.name}]`, toolCall.arguments);

        // Handle the special request_more_iterations tool
        if (toolCall.name === "request_more_iterations") {
          let args: { reason?: string } = {};
          try {
            args = JSON.parse(toolCall.arguments || "{}");
          } catch (parseError) {
            debug(
              `[Warning: Failed to parse request_more_iterations arguments: ${toolCall.arguments}]`,
            );
          }

          const additionalIterations = 3;
          remainingIterations += additionalIterations;
          debug(
            `[Agent requested more iterations: "${args.reason || "no reason provided"}"] Added ${additionalIterations}, now ${remainingIterations} remaining`,
          );

          const result = `Granted ${additionalIterations} more iterations. You now have ${remainingIterations} iterations remaining.`;

          if (hasNativeToolCalls) {
            this._messages.push({
              role: "tool",
              content: result,
              tool_call_id: toolCall.id,
            });
          } else {
            toolResults.push(`[Tool: ${toolCall.name}]\n${result}`);
          }
          continue;
        }

        // Handle the status update tool
        if (toolCall.name === "send_status_update") {
          let args: { message?: string } = {};
          try {
            args = JSON.parse(toolCall.arguments || "{}");
          } catch (parseError) {
            debug(
              `[Warning: Failed to parse send_status_update arguments: ${toolCall.arguments}]`,
            );
          }

          debug(
            `[Agent status update: "${args.message || "no message"}"]`,
          );

          // actually send the status update to the user if callback provided
          if (callbacks?.onStatusUpdate && args.message) {
            await callbacks.onStatusUpdate(args.message);
          }

          const result = "Status sent to user.";

          if (hasNativeToolCalls) {
            this._messages.push({
              role: "tool",
              content: result,
              tool_call_id: toolCall.id,
            });
          } else {
            toolResults.push(`[Tool: ${toolCall.name}]\n${result}`);
          }
          continue;
        }

        toolsUsed.push(toolCall.name);

        // sanitize argument values to fix common model quirks before execution
        const sanitizedArgs = sanitizeArgumentValues(toolCall.arguments);

        // set up a one-time status update after 3 seconds for long-running tools
        // uses whimsical messages based on tool type
        let statusSent = false;
        const isBrowserTool = toolCall.name.startsWith("browser_");
        const statusTimeout = setTimeout(async () => {
          if (callbacks?.onStatusUpdate) {
            const msg = isBrowserTool
              ? getRandomMessage(browsingMessages)
              : getRandomMessage(thinkingMessages);
            await callbacks.onStatusUpdate(msg);
            statusSent = true;
          }
        }, 3000);

        const result = await executeTool(
          toolCall.name,
          sanitizedArgs,
          this.userId,
        );

        // clear the timeout if it hasn't fired yet
        clearTimeout(statusTimeout);

        // if we sent a status, refresh typing indicator
        if (statusSent && callbacks?.onTyping) {
          await callbacks.onTyping();
        }
        debug(`[Tool result (truncated)]:`, result.substring(0, 500));

        // collect urls from browser navigation
        if (toolCall.name === "browser_navigate") {
          try {
            const args = JSON.parse(sanitizedArgs);
            if (
              args.url &&
              args.url.startsWith("http") &&
              isInformationalUrl(args.url)
            ) {
              collectedUrls.add(args.url);
            }
          } catch {
            // ignore parse errors
          }
        }

        // extract urls from tool results (for search results, etc)
        const urlMatches = result.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/g);
        if (urlMatches) {
          for (const url of urlMatches.slice(0, 10)) {
            // clean up trailing punctuation
            const cleanUrl = url.replace(/[.,;:!?)]+$/, "");
            if (cleanUrl.length > 10 && isInformationalUrl(cleanUrl)) {
              collectedUrls.add(cleanUrl);
            }
          }
        }

        if (hasNativeToolCalls) {
          // Add tool result to memory for native tool calls
          this._messages.push({
            role: "tool",
            content: result,
            tool_call_id: toolCall.id,
          });
        } else {
          toolResults.push(`[Tool: ${toolCall.name}]\n${result}`);
        }
      }

      // For text-based tool calls, add results as a user message
      if (!hasNativeToolCalls && toolResults.length > 0) {
        this._messages.push({
          role: "user",
          content: `[Tool Results]\n${toolResults.join("\n\n")}`,
        });
      }

      // Loop continues to get next response after tool execution
    }

    // sources are now included inline via markdown links in the response
    // keeping the url collection for potential future use but not appending a separate section
    const sourcesSection = "";

    // if no tools were used, just return the response we already have
    // no need for a separate "final response" call
    if (toolsUsed.length === 0) {
      const lastResponse = responseChunks[responseChunks.length - 1];
      if (lastResponse) {
        // strip emojis and log interaction context for self-review
        const cleanedResponse = stripEmojis(lastResponse);
        addRecentContext(`user: ${userMessage}\n\nassistant: ${cleanedResponse}`);
        return cleanedResponse + sourcesSection;
      }
      return "I wasn't able to complete that request. Please try again.";
    }

    // tools were used - generate a final response summarizing what was done
    debug("\n--- Generating final response ---");

    // refresh typing indicator before final response generation
    if (callbacks?.onTyping) {
      await callbacks.onTyping();
    }

    this._messages.push({
      role: "user",
      content:
        "[System] Please provide a final response to the user summarizing what you found or accomplished. Do not call any more tools.",
    });

    // set up a one-time status update for final response generation
    let finalStatusSent = false;
    const finalStatusTimeout = setTimeout(async () => {
      if (callbacks?.onStatusUpdate) {
        // dont send a message here, we already sent plenty of updates during tool usage
        finalStatusSent = true;
      }
    }, 3000);

    // Make a final call WITHOUT tools to force a text response
    await inferenceRateLimiter.acquire();
    let finalResponse;
    try {
      finalResponse = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: this._messages,
      });
    } catch (apiError) {
      clearTimeout(finalStatusTimeout);
      const errorMessage = apiError instanceof Error ? apiError.message : "Unknown error";
      debug(`[Final response API error: ${errorMessage}]`);

      // return whatever we accumulated during tool usage
      if (responseChunks.length > 0) {
        return responseChunks.join("\n\n") + "\n\n(I had trouble generating a final summary, but here's what I found.)";
      }
      return "I ran into a connection issue while wrapping up. Please try again.";
    }

    clearTimeout(finalStatusTimeout);
    if (finalStatusSent && callbacks?.onTyping) {
      await callbacks.onTyping();
    }

    const finalChoice = finalResponse.choices[0];
    const finalContent = finalChoice?.message?.content || "";

    // clean any accidental tool call syntax from final response
    // important: don't fall back to uncleaned content, use responseChunks instead
    const { cleanContent: rawCleanFinal } = parseTextToolCalls(finalContent);
    
    // strip emojis to comply with project guidelines
    const cleanFinal = stripEmojis(rawCleanFinal);

    debug("[Final response]:", JSON.stringify(cleanFinal));

    if (cleanFinal.trim()) {
      const finalWithSources = cleanFinal + sourcesSection;
      this._messages.push({
        role: "assistant",
        content: finalWithSources,
      });
      // log interaction context for self-review
      addRecentContext(`user: ${userMessage}\n\nassistant: ${finalWithSources}`);
      return finalWithSources;
    }

    // fallback to last accumulated response if final response was empty or just tool calls
    const lastResponse = responseChunks[responseChunks.length - 1];
    if (lastResponse) {
      // log interaction context for self-review
      const cleanedLastResponse = stripEmojis(lastResponse);
      addRecentContext(`user: ${userMessage}\n\nassistant: ${cleanedLastResponse}`);
      return cleanedLastResponse + sourcesSection;
    }

    return "I wasn't able to complete that request. Please try again.";
  }

  getMemory(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  clearMemory(): void {
    const systemMessage = this._messages[0];
    this._messages = systemMessage ? [systemMessage] : [];
  }

  async cleanup(): Promise<void> {
    await cleanupTools();
  }
}
