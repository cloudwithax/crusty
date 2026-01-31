import { z } from "zod";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";

// enable stealth mode to avoid bot detection
// this patches chromium to mask automation signals like navigator.webdriver,
// randomizes fingerprints, and makes the browser appear more human-like
puppeteer.use(StealthPlugin());

// Schema definitions for browser tools
const NavigateSchema = z.object({
  url: z.string().describe("The URL to navigate to"),
});

const ClickSchema = z.object({
  selector: z.string().describe("CSS selector for the element to click"),
});

const TypeSchema = z.object({
  selector: z.string().describe("CSS selector for the input field"),
  text: z.string().describe("Text to type"),
});

const ScrollSchema = z.object({
  direction: z.enum(["up", "down"]).describe("Direction to scroll"),
});

const EmptySchema = z.object({});

const WebSearchSchema = z.object({
  query: z.string().describe("The search query to look up"),
});

// Browser state interface
interface BrowserState {
  currentUrl?: string;
  pageTitle?: string;
}

type SearchProviderId = "duckduckgo_lite";

type RawSearchResult = {
  title: string;
  url?: string;
  snippet?: string;
};

type SearchResult = RawSearchResult & {
  source: string;
};

type SearchProvider = {
  id: SearchProviderId;
  label: string;
  buildUrl: (query: string) => string;
};

const MAX_RESULTS_PER_PROVIDER = 10;

const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    id: "duckduckgo_lite",
    label: "duckduckgo lite",
    buildUrl: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  },
];

// realistic user agents to rotate through
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

// common screen resolutions to randomize
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];

// helper to add human-like random delay
function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeUrl(value?: string, base?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("#")) return undefined;
  if (trimmed.startsWith("javascript:")) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (!base) return trimmed;

  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

function unwrapDuckDuckGoUrl(value?: string): string | undefined {
  const normalized = normalizeUrl(value, "https://duckduckgo.com");
  if (!normalized) return undefined;

  try {
    const parsed = new URL(normalized);
    const direct = parsed.searchParams.get("uddg");
    if (direct) return decodeURIComponent(direct);
  } catch {
    return normalized;
  }

  return normalized;
}

function detectSearchBlock(_provider: SearchProviderId, title: string, text: string): string | undefined {
  const haystack = `${title} ${text}`.toLowerCase();

  const genericIndicators = [
    "access denied",
    "forbidden",
    "blocked",
    "captcha",
    "verify you are human",
    "checking your browser",
    "security check",
    "not a bot",
    "proof-of-work",
    "rate limit",
  ];

  for (const indicator of genericIndicators) {
    if (haystack.includes(indicator)) {
      return "Blocked by bot protection or rate limiting";
    }
  }

  return undefined;
}

function getProviderBaseUrl(provider: SearchProviderId): string | undefined {
  switch (provider) {
    case "duckduckgo_lite":
      return "https://duckduckgo.com";
    default:
      return undefined;
  }
}

function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const result of results) {
    const urlKey = result.url ? result.url.toLowerCase() : "";
    const key = `${urlKey}|${result.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }

  return deduped;
}

function formatSearchResults(results: SearchResult[]): string {
  return results
    .map((result) => {
      let entry = `- ${result.title}`;
      if (result.url) entry += `\n  URL: ${result.url}`;
      entry += `\n  Source: ${result.source}`;
      if (result.snippet) entry += `\n  ${result.snippet}`;
      return entry;
    })
    .join("\n\n");
}

// Browser Manager class
class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async launch(): Promise<void> {
    // pick random user agent and viewport for this session
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
    const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]!;

    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--lang=en-US,en",
        `--window-size=${viewport.width},${viewport.height}`,
      ],
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport(viewport);
    await this.page.setUserAgent(userAgent);

    // set extra http headers to look more legitimate
    await this.page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    });

    // comprehensive browser property spoofing to evade detection
    // this code runs in the browser context, not node
    await this.page.evaluateOnNewDocument(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const g = globalThis as any;

      // remove webdriver property completely
      Object.defineProperty(g.navigator, "webdriver", { get: () => undefined });
      
      // delete the property from the prototype chain as well
      delete g.Navigator.prototype.webdriver;

      // spoof plugins to look like a real chrome browser
      Object.defineProperty(g.navigator, "plugins", {
        get: () => {
          const plugins = [
            { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
            { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
            { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
          ];
          const pluginArray = plugins as any;
          pluginArray.item = (i: number) => plugins[i];
          pluginArray.namedItem = (name: string) => plugins.find(p => p.name === name);
          pluginArray.refresh = () => {};
          return pluginArray;
        },
      });

      // spoof languages
      Object.defineProperty(g.navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      // spoof hardware concurrency (cpu cores) - pick realistic values
      Object.defineProperty(g.navigator, "hardwareConcurrency", {
        get: () => [4, 8, 12, 16][Math.floor(Math.random() * 4)],
      });

      // spoof device memory
      Object.defineProperty(g.navigator, "deviceMemory", {
        get: () => [4, 8, 16][Math.floor(Math.random() * 3)],
      });

      // spoof platform to match user agent
      Object.defineProperty(g.navigator, "platform", {
        get: () => "Win32",
      });

      // fix chrome object detection (headless chrome lacks this)
      g.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {},
      };

      // spoof permissions api to avoid detection
      const originalQuery = g.Permissions.prototype.query;
      g.Permissions.prototype.query = function(parameters: any) {
        if (parameters.name === "notifications") {
          return Promise.resolve({ state: "denied", onchange: null });
        }
        return originalQuery.call(this, parameters);
      };

      // spoof webgl vendor and renderer
      const getParameterProto = g.WebGLRenderingContext.prototype.getParameter;
      g.WebGLRenderingContext.prototype.getParameter = function(parameter: any) {
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) {
          return "Google Inc. (NVIDIA)";
        }
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446) {
          return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)";
        }
        return getParameterProto.call(this, parameter);
      };

      // apply same spoofing to webgl2
      const getParameterProto2 = g.WebGL2RenderingContext.prototype.getParameter;
      g.WebGL2RenderingContext.prototype.getParameter = function(parameter: any) {
        if (parameter === 37445) {
          return "Google Inc. (NVIDIA)";
        }
        if (parameter === 37446) {
          return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)";
        }
        return getParameterProto2.call(this, parameter);
      };

      // prevent iframe contentwindow detection
      const elementProto = g.HTMLIFrameElement.prototype;
      const originalContentWindow = Object.getOwnPropertyDescriptor(elementProto, "contentWindow");
      if (originalContentWindow) {
        Object.defineProperty(elementProto, "contentWindow", {
          get: function() {
            return originalContentWindow.get?.call(this);
          },
        });
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  async navigate(url: string): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not launched");
    // small random delay before navigation to appear more human
    await randomDelay(100, 500);
    await this.page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // random delay after page load like a human would pause to look
    await randomDelay(300, 800);
    return this.getState();
  }

  async click(selector: string): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not launched");
    // random delay before clicking like a human finding the element
    await randomDelay(100, 400);
    await this.page.click(selector);
    await this.page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {
      // ignore timeout, page may not have network activity
    });
    return this.getState();
  }

  async type(selector: string, text: string): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not launched");
    // random delay before typing
    await randomDelay(100, 300);
    // clear existing content first, then type
    await this.page.click(selector, { count: 3 }); // triple click to select all
    // type with human-like delay between keystrokes (50-150ms per char)
    await this.page.type(selector, text, { delay: 50 + Math.random() * 100 });
    return this.getState();
  }

  async scroll(direction: "up" | "down"): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not launched");
    // random delay before scrolling
    await randomDelay(100, 300);
    const scrollAmount = direction === "up" ? -500 : 500;
    await this.page.evaluate((amount: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).scrollBy(0, amount);
    }, scrollAmount);
    // small pause after scroll like a human reading
    await randomDelay(200, 500);
    return this.getState();
  }

  async getContent(): Promise<{ content: string; quality: "good" | "low" | "empty" }> {
    if (!this.page) throw new Error("Browser not launched");
    const rawContent = await this.page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      const body = doc.body.cloneNode(true) as { querySelectorAll: (s: string) => Array<{ remove: () => void }>; innerText: string };
      // remove non-content elements
      const junk = body.querySelectorAll("script, style, nav, footer, header, iframe, noscript, svg, [role='navigation'], [role='banner'], [aria-hidden='true']");
      junk.forEach((el: { remove: () => void }) => el.remove());
      return body.innerText;
    });

    // clean up the content - collapse whitespace and trim
    const cleaned = rawContent.replace(/\s+/g, " ").trim().slice(0, 8000);

    // determine content quality based on length and meaningfulness
    const wordCount = cleaned.split(/\s+/).filter((w: string) => w.length > 2).length;

    if (cleaned.length < 50 || wordCount < 10) {
      return { content: cleaned, quality: "empty" };
    }

    // check for captcha/challenge pages - these need special handling
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

    const isCaptchaPage = captchaIndicators.some((pattern) => pattern.test(cleaned));
    if (isCaptchaPage) {
      return { 
        content: `[CAPTCHA/CHALLENGE DETECTED] The page is showing a bot protection challenge. This usually means:\n1. The site has aggressive anti-bot protection\n2. The IP might be flagged\n3. Try a different site or wait before retrying\n\nRaw page content:\n${cleaned}`, 
        quality: "low" 
      };
    }

    // check for signs of blocked/loading content
    const lowQualityIndicators = [
      /please enable javascript/i,
      /loading\.\.\./i,
      /access denied/i,
      /403 forbidden/i,
      /browser.*not supported/i,
      /please wait/i,
      /one moment/i,
    ];

    const hasLowQualityIndicator = lowQualityIndicators.some((pattern) => pattern.test(cleaned));
    if (hasLowQualityIndicator || wordCount < 50) {
      return { content: cleaned, quality: "low" };
    }

    return { content: cleaned, quality: "good" };
  }

  async getState(): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not launched");
    return {
      currentUrl: this.page.url(),
      pageTitle: await this.page.title(),
    };
  }

  async getTextSnapshot(): Promise<{ title: string; text: string }> {
    if (!this.page) throw new Error("Browser not launched");
    const snapshot = await this.page.evaluate(() => {
      const doc = (globalThis as any).document;
      return {
        title: doc.title || "",
        text: doc.body?.innerText || "",
      };
    });

    const title = snapshot.title.replace(/\s+/g, " ").trim();
    const text = snapshot.text.replace(/\s+/g, " ").trim().slice(0, 8000);
    return { title, text };
  }

  isActive(): boolean {
    return this.browser !== null && this.page !== null;
  }

  // extract search results for supported html search providers
  async extractSearchResults(provider: SearchProviderId): Promise<RawSearchResult[]> {
    if (!this.page) throw new Error("Browser not launched");

    if (provider === "duckduckgo_lite") {
      const results = await this.page.evaluate(() => {
        const doc = (globalThis as any).document;
        const searchResults: Array<{ title: string; url?: string; snippet?: string }> = [];
        const links = doc.querySelectorAll("a.result-link");

        for (const link of links) {
          const title = link.textContent?.trim();
          const url = link.getAttribute("href") || undefined;
          const row = link.closest("tr");
          const snippetEl = row?.nextElementSibling?.querySelector(".result-snippet");
          const snippet = snippetEl?.textContent?.trim();

          if (title && (url || snippet)) {
            searchResults.push({ title, url, snippet });
          }
        }

        return searchResults;
      });

      return results || [];
    }

    return [];
  }
}

// Create singleton instance
const browserManager = new BrowserManager();

// validate url before attempting navigation
function validateUrl(url: string): { valid: boolean; error?: string } {
  // check for obviously malformed urls
  if (!url || url.length < 8) {
    return { valid: false, error: "URL is too short or empty" };
  }

  // must start with http:// or https://
  if (!/^https?:\/\//i.test(url)) {
    return { valid: false, error: "URL must start with http:// or https://" };
  }

  // check for obviously broken urls (truncated, garbage characters)
  if (/[{}[\]<>|\\^`]/.test(url)) {
    return { valid: false, error: "URL contains invalid characters" };
  }

  // check for incomplete urls (ends with just protocol or domain with no path indicator)
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

// Tool definitions using a common format
export const browserTools = {
  browser_navigate: {
    description: "Navigate to a specific URL in the browser. Use this when you already know the exact URL to visit (e.g., user gives you a link, you found a URL in search results, or you want to go to a specific website like amazon.com or target.com). ALWAYS use web_search first if you need to find URLs. After navigating, use browser_get_content to read the page.",
    schema: NavigateSchema,
    handler: async (args: z.infer<typeof NavigateSchema>, _userId: number) => {
      // validate url before attempting navigation
      const validation = validateUrl(args.url);
      if (!validation.valid) {
        return `[Error] Cannot navigate: ${validation.error}. URL provided: "${args.url}". Please provide a valid URL.`;
      }

      if (!browserManager.isActive()) await browserManager.launch();
      const state = await browserManager.navigate(args.url);
      return `Navigated to ${state.currentUrl} - "${state.pageTitle}"`;
    },
  },

  browser_click: {
    description: "Click an element on the current page using a CSS selector. Use this to interact with buttons, links, form elements, etc. You must first use browser_navigate or web_search to load a page. Common selectors: 'button', 'a[href*=\"text\"]', '#id', '.class', 'input[type=\"submit\"]'. After clicking, use browser_get_content to see the updated page.",
    schema: ClickSchema,
    handler: async (args: z.infer<typeof ClickSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      const state = await browserManager.click(args.selector);
      return `Clicked element. Now at ${state.currentUrl} - "${state.pageTitle}"`;
    },
  },

  browser_type: {
    description: "Type text into an input field on the current page. Use this to fill out forms, search boxes, login fields, etc. Requires a CSS selector for the input element and the text to type. Common selectors: 'input[name=\"q\"]', 'input[type=\"text\"]', 'textarea', '#search'. The field will be cleared before typing.",
    schema: TypeSchema,
    handler: async (args: z.infer<typeof TypeSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      await browserManager.type(args.selector, args.text);
      return `Typed text into ${args.selector}`;
    },
  },

  browser_scroll: {
    description: "Scroll the current page up or down to see more content. Use this when you need to see content below the fold, load more results, or navigate through long pages. Call browser_get_content after scrolling to read the newly visible content. Scroll 'down' to see more content, 'up' to go back.",
    schema: ScrollSchema,
    handler: async (args: z.infer<typeof ScrollSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      const state = await browserManager.scroll(args.direction);
      return `Scrolled ${args.direction}. Current page: ${state.pageTitle}`;
    },
  },

  browser_get_content: {
    description: "Extract and read the text content of the current page in the browser. ALWAYS call this after browser_navigate, browser_click, or browser_scroll to actually see what's on the page. This returns the page text without HTML markup. Use this to read articles, product info, search results, prices, reviews, etc.",
    schema: EmptySchema,
    handler: async (_args: unknown, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      const { content, quality } = await browserManager.getContent();

      if (quality === "empty") {
        return `[Warning: Page returned very little content - may be loading, blocked, or requires javascript. Consider scrolling, waiting, or trying a different URL.]\n\nPage content:\n${content}`;
      }

      if (quality === "low") {
        return `[Warning: Page content quality is low - may be behind a paywall, captcha, or loading screen. Consider trying a different source.]\n\nPage content:\n${content}`;
      }

      return `Page content:\n${content}`;
    },
  },

  browser_launch: {
    description: "Start the browser. You usually don't need to call this manually - other browser tools will auto-launch if needed. Only use if you want to explicitly start the browser before doing anything.",
    schema: EmptySchema,
    handler: async (_args: unknown, _userId: number) => {
      await browserManager.launch();
      return "Browser launched successfully";
    },
  },

  browser_close: {
    description: "Close the browser and free up resources. Use this when you're completely done with web browsing and won't need to visit any more pages. This clears all browser state.",
    schema: EmptySchema,
    handler: async (_args: unknown, _userId: number) => {
      await browserManager.close();
      return "Browser closed";
    },
  },

  web_search: {
    description: "Search the web using DuckDuckGo Lite. THIS IS YOUR PRIMARY TOOL FOR FINDING INFORMATION ONLINE. Use this FIRST when the user asks you to: look something up, search for something, find information, check prices, compare products, find stores, research topics, get current info, verify facts, find reviews, locate businesses, etc. Returns search results that you can read directly. If you need more details from a specific result, use browser_navigate to visit that URL.",
    schema: WebSearchSchema,
    handler: async (args: z.infer<typeof WebSearchSchema>, _userId: number) => {
      // validate query isnt empty or garbage
      const query = args.query?.trim();
      if (!query || query.length < 2) {
        return "[Error] Invalid search query. Please provide a valid search term.";
      }

      if (!browserManager.isActive()) await browserManager.launch();

      const providerResults: Array<{
        provider: SearchProvider;
        results: SearchResult[];
        error?: string;
      }> = [];

      for (const provider of SEARCH_PROVIDERS) {
        try {
          await browserManager.navigate(provider.buildUrl(query));
          const rawResults = await browserManager.extractSearchResults(provider.id);

          const normalizedResults: SearchResult[] = [];
          const baseUrl = getProviderBaseUrl(provider.id);
          for (const result of rawResults) {
            const title = normalizeText(result.title);
            const snippet = normalizeText(result.snippet);
            const url = provider.id === "duckduckgo_lite"
              ? unwrapDuckDuckGoUrl(result.url)
              : normalizeUrl(result.url, baseUrl);

            if (!title || (!url && !snippet)) continue;

            normalizedResults.push({
              title,
              url,
              snippet,
              source: provider.label,
            });

            if (normalizedResults.length >= MAX_RESULTS_PER_PROVIDER) break;
          }

          let error: string | undefined;
          if (normalizedResults.length === 0) {
            const snapshot = await browserManager.getTextSnapshot();
            error = detectSearchBlock(provider.id, snapshot.title, snapshot.text);
          }

          providerResults.push({ provider, results: normalizedResults, error });
          await randomDelay(150, 400);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          providerResults.push({ provider, results: [], error: msg });
        }
      }

      const aggregatedResults = dedupeSearchResults(
        providerResults.flatMap((entry) => entry.results)
      );

      if (aggregatedResults.length === 0) {
        const errors = providerResults
          .map((entry) => entry.error)
          .filter((value): value is string => Boolean(value));

        if (errors.length > 0) {
          return `[Search failed: ${errors.join(" | ")}. Try again or use a different query.]`;
        }

        return `[Search failed: no results found for "${query}". Try rephrasing the query.]`;
      }

      let response = `Search results for "${query}":\n\n${formatSearchResults(aggregatedResults)}`;

      const failures = providerResults.filter((entry) => entry.results.length === 0);
      if (failures.length > 0) {
        response += "\n\nNotes:";
        for (const failure of failures) {
          const reason = failure.error ? `Search failed: ${failure.error}` : "No results returned";
          response += `\n- ${failure.provider.label}: ${reason}`;
        }
      }

      return response;
    },
  },
};

// Export cleanup function
export async function cleanupBrowser(): Promise<void> {
  await browserManager.close();
}

// Type for the tools object
export type BrowserTools = typeof browserTools;
