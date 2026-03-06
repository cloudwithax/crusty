import { z } from "zod";

// ------------------------------------------------------------------
// types
// ------------------------------------------------------------------

interface BrowserState {
  currentUrl?: string;
  pageTitle?: string;
}

interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}


// ------------------------------------------------------------------
// schemas
// ------------------------------------------------------------------

const NavigateSchema = z.object({
  url: z.string().describe("The URL to navigate to"),
});

const SnapshotSchema = z.object({
  mode: z
    .enum(["full", "interactive"])
    .optional()
    .describe(
      "full: interactive elements + page content (default). interactive: only actionable elements for a compact view",
    ),
});

const ActSchema = z.object({
  ref: z
    .string()
    .describe("Element ref from the last browser_snapshot (e.g. 'e5')"),
  action: z
    .enum([
      "click",
      "type",
      "fill",
      "hover",
      "select",
      "check",
      "uncheck",
      "focus",
      "clear",
    ])
    .describe("Action to perform on the element"),
  value: z.string().optional().describe("Value for type/fill/select actions"),
  submit: z
    .boolean()
    .optional()
    .describe("Press Enter after typing (for type/fill actions)"),
});

const ScrollSchema = z.object({
  direction: z.enum(["up", "down"]).describe("Direction to scroll"),
  amount: z.number().optional().describe("Pixels to scroll (default: 500)"),
});

const TabsSchema = z.object({
  action: z
    .enum(["list", "new", "close", "switch"])
    .describe("Tab action to perform"),
  id: z
    .string()
    .optional()
    .describe("Tab ID for close/switch actions (from browser_tabs list)"),
  url: z.string().optional().describe("URL to open in new tab"),
});

const WaitSchema = z.object({
  condition: z
    .enum(["text", "url", "selector", "networkidle"])
    .describe(
      "text: wait for text to appear on page. url: wait for URL to contain value. selector: wait for CSS selector to be visible. networkidle: wait for network to be idle",
    ),
  value: z
    .string()
    .optional()
    .describe(
      "Text to find, URL substring to match, or CSS selector to wait for",
    ),
  timeoutMs: z
    .number()
    .optional()
    .describe("Max wait time in ms (default: 10000)"),
});

const EmptySchema = z.object({});

const WebSearchSchema = z.object({
  query: z.string().describe("The search query to look up"),
});

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

// validate url before attempting navigation
function validateUrl(url: string): { valid: boolean; error?: string } {
  if (!url || url.length < 8) {
    return { valid: false, error: "URL is too short or empty" };
  }

  if (!/^https?:\/\//i.test(url)) {
    return { valid: false, error: "URL must start with http:// or https://" };
  }

  if (/[{}[\]<>|\\^`]/.test(url)) {
    return { valid: false, error: "URL contains invalid characters" };
  }

  try {
    const parsed = new URL(url);
    if (!parsed.hostname || parsed.hostname.length < 3) {
      return { valid: false, error: "URL has invalid hostname" };
    }
  } catch {
    return { valid: false, error: "URL is malformed and cannot be parsed" };
  }

  return { valid: true };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotFooter(): string {
  return '\n---\nUse browser_act with a ref to interact. Example: {"ref": "e5", "action": "click"} or {"ref": "e12", "action": "type", "value": "search term"}\nRefs expire on page changes. Re-run browser_snapshot after navigation or dynamic updates.';
}

// ------------------------------------------------------------------
// agent-browser cli runner
// ------------------------------------------------------------------

async function runCmd(
  args: string[],
  opts?: { ignoreError?: boolean },
): Promise<string> {
  const proc = Bun.spawn(["agent-browser", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0 && !opts?.ignoreError) {
    const errMsg = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(
      `agent-browser ${args[0] ?? ""} failed: ${errMsg}. is agent-browser installed? run: npm install -g agent-browser`,
    );
  }

  return stdout.trim();
}

// ------------------------------------------------------------------
// browser manager - controls browser via agent-browser cli
// ------------------------------------------------------------------

class BrowserManager {
  private _active = false;
  private _activeTabId: string | null = null;

  // ---- lifecycle ----

  async launch(): Promise<void> {
    // agent-browser daemon starts automatically on first command
    this._active = true;
  }

  async close(): Promise<void> {
    try {
      await runCmd(["close"], { ignoreError: true });
    } catch {
      // ignore cleanup errors
    }
    this._active = false;
    this._activeTabId = null;
  }

  isActive(): boolean {
    return this._active;
  }

  // ---- navigation ----

  async navigate(url: string): Promise<BrowserState> {
    await runCmd(["open", url]);
    if (!this._active) this._active = true;
    return this.getState();
  }

  // ---- snapshot ----
  // returns the accessibility tree as formatted text from agent-browser
  // refs are stable element identifiers (e0, e1...) for all interactions

  async snapshot(mode: "full" | "interactive" = "full"): Promise<string> {
    const args = mode === "interactive" ? ["snapshot", "-i"] : ["snapshot"];
    const output = await runCmd(args);

    if (!output) {
      return "[No snapshot content. The page may be loading or empty.]\n" + snapshotFooter();
    }

    return output + snapshotFooter();
  }

  // ---- ref-based actions ----
  // all interactions use element refs from the last snapshot
  // refs are prefixed with @ when passed to agent-browser commands

  async act(
    ref: string,
    action: string,
    value?: string,
    submit?: boolean,
  ): Promise<string> {
    // normalize ref: agent-browser expects @eN format
    const r = ref.startsWith("@") ? ref : `@${ref}`;

    switch (action) {
      case "click":
        await runCmd(["click", r]);
        break;

      case "check":
        await runCmd(["check", r]);
        break;

      case "uncheck":
        await runCmd(["uncheck", r]);
        break;

      case "type":
        await runCmd(["type", r, value || ""]);
        if (submit) await this.pressEnter();
        break;

      case "fill":
        await runCmd(["fill", r, value || ""]);
        if (submit) await this.pressEnter();
        break;

      case "hover":
        await runCmd(["hover", r]);
        break;

      case "select":
        await runCmd(["select", r, value || ""]);
        break;

      case "focus":
        await runCmd(["focus", r]);
        break;

      case "clear":
        await runCmd(["fill", r, ""]);
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const state = await this.getState();
    return `Action "${action}" performed on ref [${ref}]. Page: ${state.pageTitle} (${state.currentUrl})`;
  }

  // submit the active form by trying requestSubmit first, then Enter keydown
  private async pressEnter(): Promise<void> {
    await runCmd([
      "eval",
      "document.activeElement?.form?.requestSubmit() ?? void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))",
    ], { ignoreError: true });
  }

  // ---- scroll ----

  async scroll(
    direction: "up" | "down",
    amount = 500,
  ): Promise<BrowserState> {
    const delta = direction === "down" ? amount : -amount;
    await runCmd(["eval", `window.scrollBy(0, ${delta})`]);
    return this.getState();
  }

  // ---- content extraction ----

  async getContent(): Promise<{
    content: string;
    quality: "good" | "low" | "empty";
  }> {
    const raw = await runCmd(["get", "text", "body"], { ignoreError: true });
    const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 8000);

    const wordCount = cleaned
      .split(/\s+/)
      .filter((w: string) => w.length > 2).length;

    if (cleaned.length < 50 || wordCount < 10) {
      return { content: cleaned, quality: "empty" };
    }

    const captchaIndicators = [
      /cloudflare/i,
      /please verify you are (a )?human/i,
      /checking your browser/i,
      /just a moment/i,
      /attention required/i,
      /enable cookies/i,
      /security check/i,
      /complete the security check/i,
      /ray id:/i,
      /hcaptcha/i,
      /recaptcha/i,
      /turnstile/i,
      /challenge-running/i,
      /cf-browser-verification/i,
      /ddos protection/i,
      /bot protection/i,
      /are you a robot/i,
      /prove you('re| are) human/i,
    ];

    const isCaptchaPage = captchaIndicators.some((pattern) =>
      pattern.test(cleaned),
    );
    if (isCaptchaPage) {
      return {
        content: `[CAPTCHA/CHALLENGE DETECTED] The page is showing a bot protection challenge. This usually means:\n1. The site has aggressive anti-bot protection\n2. The IP might be flagged\n3. Try a different site or wait before retrying\n\nRaw page content:\n${cleaned}`,
        quality: "low",
      };
    }

    const lowQualityIndicators = [
      /please enable javascript/i,
      /loading\.\.\./i,
      /access denied/i,
      /403 forbidden/i,
      /browser.*not supported/i,
      /please wait/i,
      /one moment/i,
    ];

    const hasLowQualityIndicator = lowQualityIndicators.some((pattern) =>
      pattern.test(cleaned),
    );
    if (hasLowQualityIndicator || wordCount < 50) {
      return { content: cleaned, quality: "low" };
    }

    return { content: cleaned, quality: "good" };
  }

  // ---- tab management ----

  async getTabs(): Promise<TabInfo[]> {
    // try json output first, fall back to empty on parse failure
    const output = await runCmd(["--json", "tab"], { ignoreError: true });
    if (!output) return [];

    try {
      const data = JSON.parse(output) as Array<{
        index?: number;
        id?: number | string;
        url?: string;
        title?: string;
        active?: boolean;
      }>;
      return data.map((t, i) => ({
        id: String(t.index ?? t.id ?? i + 1),
        url: t.url || "about:blank",
        title: t.title || "(untitled)",
        active: Boolean(t.active),
      }));
    } catch {
      return [];
    }
  }

  async newTab(url?: string): Promise<TabInfo> {
    const args = url ? ["tab", "new", url] : ["tab", "new"];
    await runCmd(args);

    const tabs = await this.getTabs();
    const active = tabs.find((t) => t.active) ?? tabs[tabs.length - 1];
    if (!active) throw new Error("failed to open new tab");

    this._activeTabId = active.id;
    return active;
  }

  async switchTab(tabId: string): Promise<void> {
    await runCmd(["tab", tabId]);
    this._activeTabId = tabId;
  }

  async closeTab(tabId?: string): Promise<void> {
    const targetId = tabId || this._activeTabId;
    if (!targetId) throw new Error("No active tab to close");

    const args = ["tab", "close", targetId];
    await runCmd(args);

    if (targetId === this._activeTabId) {
      const tabs = await this.getTabs();
      const active = tabs.find((t) => t.active);
      this._activeTabId = active ? active.id : null;
    }
  }

  // ---- wait conditions ----

  async waitFor(
    condition: string,
    value?: string,
    timeoutMs: number = 10000,
  ): Promise<{ success: boolean; message: string }> {
    try {
      switch (condition) {
        case "text": {
          if (!value)
            return { success: false, message: "No text value provided" };
          const startTime = Date.now();
          while (Date.now() - startTime < timeoutMs) {
            const text = await this.getPageText();
            if (text.includes(value)) {
              return { success: true, message: `Text "${value}" found on page` };
            }
            await delay(500);
          }
          return {
            success: false,
            message: `Timed out after ${timeoutMs}ms waiting for text: "${value}"`,
          };
        }

        case "url": {
          if (!value)
            return { success: false, message: "No URL value provided" };
          const startTime = Date.now();
          while (Date.now() - startTime < timeoutMs) {
            const state = await this.getState();
            if (state.currentUrl?.includes(value)) {
              return { success: true, message: `URL now contains "${value}"` };
            }
            await delay(500);
          }
          return {
            success: false,
            message: `Timed out after ${timeoutMs}ms waiting for URL to contain: "${value}"`,
          };
        }

        case "selector": {
          if (!value)
            return { success: false, message: "No selector provided" };
          // use agent-browser's native element wait
          await runCmd(["wait", value]);
          return { success: true, message: `Element "${value}" is now visible` };
        }

        case "networkidle": {
          await runCmd(["wait", "--load", "networkidle"]);
          return { success: true, message: "Network is idle" };
        }

        default:
          return {
            success: false,
            message: `Unknown condition: ${condition}`,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Wait failed: ${msg}` };
    }
  }

  // ---- evaluate ----

  async evaluate(expression: string): Promise<unknown> {
    const result = await runCmd(["eval", expression]);
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }

  // ---- state ----

  async getState(): Promise<BrowserState> {
    const [url, title] = await Promise.all([
      runCmd(["get", "url"], { ignoreError: true }).catch(() => ""),
      runCmd(["get", "title"], { ignoreError: true }).catch(() => ""),
    ]);
    return {
      currentUrl: url || undefined,
      pageTitle: title || undefined,
    };
  }

  // ---- internal helpers ----

  private async getPageText(): Promise<string> {
    return runCmd(["get", "text", "body"], { ignoreError: true }).catch(() => "");
  }

}

// singleton
const browserManager = new BrowserManager();

// ------------------------------------------------------------------
// tool definitions
// ------------------------------------------------------------------

export const browserTools = {
  browser_navigate: {
    description: `Navigate to a URL. You MUST call browser_snapshot immediately after this to see the page. Do not use browser_get_content as your first action after navigation - always snapshot first.

For simple page reads (articles, docs), prefer web_fetch - it navigates and extracts content in one step.

FORMAT: {"url": "https://example.com"}`,
    schema: NavigateSchema,
    handler: async (args: z.infer<typeof NavigateSchema>, _userId: number) => {
      const validation = validateUrl(args.url);
      if (!validation.valid) {
        return `[Error] Cannot navigate: ${validation.error}. URL provided: "${args.url}". Please provide a valid URL.`;
      }

      if (!browserManager.isActive()) await browserManager.launch();
      const state = await browserManager.navigate(args.url);
      return `Navigated to ${state.currentUrl} - "${state.pageTitle}"\n\nCall browser_snapshot to see the page and get element refs for interaction.`;
    },
  },

  browser_snapshot: {
    description: `YOUR PRIMARY WAY TO SEE ANY WEB PAGE. Returns a structured view of all interactive elements (links, buttons, inputs) and content, each with a ref (e.g. e0, e5). You MUST call this after every browser_navigate and after any action that changes the page.

REQUIRED workflow:
1. browser_navigate -> browser_snapshot (see the page)
2. browser_act with ref (interact)
3. browser_snapshot again (see result)

Never skip this step. Never guess at page structure without a snapshot.
Refs expire on page changes - always re-snapshot after navigation or dynamic updates.`,
    schema: SnapshotSchema,
    handler: async (args: z.infer<typeof SnapshotSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      return await browserManager.snapshot(args.mode || "full");
    },
  },

  browser_act: {
    description: `Perform an action on a page element using its ref from browser_snapshot.

Actions:
- click: click the element
- type: clear the field and type text (human-like keystroke delay)
- fill: set value directly (fast, good for forms)
- hover: mouse hover (triggers tooltips, dropdowns)
- select: select an option from a dropdown
- check/uncheck: toggle a checkbox
- focus: focus the element
- clear: clear an input field

Examples:
- Click a link: {"ref": "e3", "action": "click"}
- Type in search: {"ref": "e5", "action": "type", "value": "query", "submit": true}
- Fill a form field: {"ref": "e7", "action": "fill", "value": "john@example.com"}
- Hover for dropdown: {"ref": "e2", "action": "hover"}

If a ref is stale (page changed), re-run browser_snapshot first.`,
    schema: ActSchema,
    handler: async (args: z.infer<typeof ActSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      return await browserManager.act(
        args.ref,
        args.action,
        args.value,
        args.submit,
      );
    },
  },

  browser_scroll: {
    description:
      "Scroll the current page up or down. After scrolling, call browser_snapshot to see newly visible content and get fresh refs.",
    schema: ScrollSchema,
    handler: async (args: z.infer<typeof ScrollSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      const state = await browserManager.scroll(args.direction, args.amount);
      return `Scrolled ${args.direction}${args.amount ? ` ${args.amount}px` : ""}. Page: ${state.pageTitle}. Run browser_snapshot to see updated content.`;
    },
  },

  browser_get_content: {
    description:
      "Extract readable text from the current page. Use this after browser_navigate when you need the full prose text of an article or document. For page structure and interaction, use browser_snapshot + browser_act instead.",
    schema: EmptySchema,
    handler: async (_args: unknown, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      const { content, quality } = await browserManager.getContent();

      if (quality === "empty") {
        return `[Warning: Page returned very little content - may be loading, blocked, or requires javascript. Try browser_wait or browser_snapshot instead.]\n\nPage content:\n${content}`;
      }

      if (quality === "low") {
        return `[Warning: Page content quality is low - may be behind a paywall, captcha, or loading screen. Consider trying a different source.]\n\nPage content:\n${content}`;
      }

      return `Page content:\n${content}`;
    },
  },

  browser_tabs: {
    description: `Manage browser tabs. Actions:
- list: show all open tabs with their IDs
- new: open a new tab (optionally with a URL)
- close: close a tab by ID (closes active tab if no ID given)
- switch: switch to a different tab by ID`,
    schema: TabsSchema,
    handler: async (args: z.infer<typeof TabsSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();

      switch (args.action) {
        case "list": {
          const tabs = await browserManager.getTabs();
          if (tabs.length === 0) return "No open tabs.";
          return (
            "Open tabs:\n" +
            tabs
              .map(
                (t) =>
                  `${t.active ? "> " : "  "}[${t.id}] ${t.title || "(untitled)"} - ${t.url}`,
              )
              .join("\n")
          );
        }

        case "new": {
          const tab = await browserManager.newTab(args.url);
          return `Opened new tab [${tab.id}]: ${tab.title || "(untitled)"} - ${tab.url}`;
        }

        case "close": {
          await browserManager.closeTab(args.id);
          const remaining = await browserManager.getTabs();
          return `Tab closed. ${remaining.length} tab(s) remaining.`;
        }

        case "switch": {
          if (!args.id) return "[Error] Tab ID required for switch action.";
          await browserManager.switchTab(args.id);
          const tabs = await browserManager.getTabs();
          const active = tabs.find((t) => t.active);
          return active
            ? `Switched to tab [${active.id}]: ${active.title} - ${active.url}`
            : "Switched tab.";
        }

        default:
          return `[Error] Unknown tab action: ${args.action}`;
      }
    },
  },

  browser_wait: {
    description: `Wait for a condition before proceeding. Useful after clicking elements that trigger async loading.

Conditions:
- text: wait for specific text to appear on the page
- url: wait for URL to contain a substring (good for redirects)
- selector: wait for a CSS selector to become visible
- networkidle: wait for all network requests to finish

Example: {"condition": "text", "value": "Results loaded", "timeoutMs": 5000}`,
    schema: WaitSchema,
    handler: async (args: z.infer<typeof WaitSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      const result = await browserManager.waitFor(
        args.condition,
        args.value,
        args.timeoutMs,
      );
      return result.success
        ? `[OK] ${result.message}`
        : `[Timeout] ${result.message}`;
    },
  },

  browser_launch: {
    description:
      "Start the browser. Other browser tools auto-launch if needed - only call this to explicitly pre-start the browser.",
    schema: EmptySchema,
    handler: async (_args: unknown, _userId: number) => {
      await browserManager.launch();
      return "Browser launched successfully";
    },
  },

  browser_close: {
    description:
      "Close the browser and free up resources. Use when completely done with web browsing.",
    schema: EmptySchema,
    handler: async (_args: unknown, _userId: number) => {
      await browserManager.close();
      return "Browser closed";
    },
  },

  web_search: {
    description:
      "Search the web using DuckDuckGo. Use this FIRST when the user asks to look something up, search for something, find information, research topics, verify facts, etc. Returns an interactive snapshot of results - use browser_act to click through to pages you want to read.",
    schema: WebSearchSchema,
    handler: async (args: z.infer<typeof WebSearchSchema>, _userId: number) => {
      const query = args.query?.trim();
      if (!query || query.length < 2) {
        return "[Error] Invalid search query. Please provide a valid search term.";
      }

      if (!browserManager.isActive()) await browserManager.launch();

      const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
      await browserManager.navigate(searchUrl);
      return await browserManager.snapshot("full");
    },
  },
};

// ------------------------------------------------------------------
// exports
// ------------------------------------------------------------------

export async function cleanupBrowser(): Promise<void> {
  await browserManager.close();
}

// navigate to a url and extract readable text - used by web_fetch
export async function fetchPageWithBrowser(url: string): Promise<{
  content: string;
  quality: "good" | "low" | "empty";
  currentUrl?: string;
  pageTitle?: string;
}> {
  if (!browserManager.isActive()) await browserManager.launch();
  await browserManager.navigate(url);
  const { content, quality } = await browserManager.getContent();
  const state = await browserManager.getState();
  return { content, quality, currentUrl: state.currentUrl, pageTitle: state.pageTitle };
}

export type BrowserTools = typeof browserTools;

