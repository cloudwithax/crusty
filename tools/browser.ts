import { z } from "zod";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";

// enable stealth mode to avoid bot detection
// patches chromium to mask automation signals like navigator.webdriver,
// randomizes fingerprints, and makes the browser appear more human-like
puppeteer.use(StealthPlugin());

// ------------------------------------------------------------------
// types
// ------------------------------------------------------------------

interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  text: string;
  type?: string;
  href?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  interactive: boolean;
}

interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
}

interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

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
  ref: z.number().describe("Element ref number from the last browser_snapshot"),
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
// constants
// ------------------------------------------------------------------

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

const MAX_RESULTS_PER_PROVIDER = 10;

const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    id: "duckduckgo_lite",
    label: "duckduckgo lite",
    buildUrl: (query) =>
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  },
];

// max interactive elements before we start trimming content
const MAX_INTERACTIVE_ELEMENTS = 100;
const MAX_CONTENT_ELEMENTS = 30;
const MAX_ELEMENT_TEXT_LENGTH = 120;

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

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

function detectSearchBlock(
  _provider: SearchProviderId,
  title: string,
  text: string,
): string | undefined {
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

// ------------------------------------------------------------------
// snapshot formatting
// ------------------------------------------------------------------

function formatSnapshot(snapshot: PageSnapshot): string {
  let output = `[Page] ${snapshot.title || "(untitled)"}\nURL: ${snapshot.url}\n`;

  const interactive = snapshot.elements.filter((e) => e.interactive);
  const content = snapshot.elements.filter((e) => !e.interactive);

  if (interactive.length > 0) {
    output += "\n--- Interactive Elements ---\n";
    for (const el of interactive) {
      output += formatElement(el) + "\n";
    }
  }

  if (content.length > 0) {
    output += "\n--- Page Content ---\n";
    for (const el of content) {
      output += formatElement(el) + "\n";
    }
  }

  if (interactive.length === 0 && content.length === 0) {
    output +=
      "\n[No interactive or content elements found. The page may be loading, empty, or blocked.]\n";
  }

  output +=
    '\n---\nUse browser_act with a ref number to interact. Example: {"ref": 3, "action": "click"} or {"ref": 5, "action": "type", "value": "search term"}\nRefs expire on page changes. Re-run browser_snapshot after navigation or dynamic updates.';

  return output;
}

function formatElement(el: SnapshotElement): string {
  let line = `[${el.ref}] ${el.role}`;

  // primary label: prefer name, fall back to text
  const label = el.name || el.text;
  if (label) {
    const truncated =
      label.length > MAX_ELEMENT_TEXT_LENGTH
        ? label.slice(0, MAX_ELEMENT_TEXT_LENGTH - 3) + "..."
        : label;
    line += ` "${truncated}"`;
  }

  // secondary annotations
  if (el.type && !["text", "submit"].includes(el.type)) {
    line += ` type=${el.type}`;
  }
  if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
  if (el.value) {
    const truncVal =
      el.value.length > 50 ? el.value.slice(0, 47) + "..." : el.value;
    line += ` value="${truncVal}"`;
  }
  if (el.href) {
    const shortHref =
      el.href.length > 60 ? el.href.slice(0, 57) + "..." : el.href;
    line += ` -> ${shortHref}`;
  }
  if (el.checked) line += " [checked]";
  if (el.disabled) line += " [disabled]";

  return line;
}

// ------------------------------------------------------------------
// in-page snapshot script
// runs inside the browser context via page.evaluate()
// ------------------------------------------------------------------

// the snapshot logic as a serializable function for page.evaluate
// returns an array of SnapshotElement-shaped objects
const SNAPSHOT_SCRIPT = `(snapshotMode) => {
  // clear previous refs
  document.querySelectorAll('[data-cref]').forEach(el => el.removeAttribute('data-cref'));

  const results = [];
  let counter = 1;

  // visibility check that accounts for position:fixed elements
  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  // infer aria role from html tag and attributes
  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'email' || type === 'password' || type === 'tel' || type === 'number') return 'textbox';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'filebutton';
      return 'textbox';
    }

    const roleMap = {
      'a': 'link', 'button': 'button', 'select': 'combobox', 'textarea': 'textbox',
      'summary': 'button', 'h1': 'heading', 'h2': 'heading', 'h3': 'heading',
      'h4': 'heading', 'h5': 'heading', 'h6': 'heading', 'p': 'text',
      'li': 'listitem', 'td': 'cell', 'th': 'columnheader', 'img': 'image',
      'label': 'label', 'blockquote': 'blockquote', 'pre': 'code',
      'figcaption': 'caption', 'nav': 'navigation', 'main': 'main',
    };

    return roleMap[tag] || tag;
  }

  // compute accessible name using the standard name computation algorithm (simplified)
  function getName(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    const ariaLabelledby = el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      const ids = ariaLabelledby.split(/\\s+/);
      const texts = ids.map(id => {
        const ref = document.getElementById(id);
        return ref ? (ref.innerText || '').trim() : '';
      }).filter(Boolean);
      if (texts.length) return texts.join(' ');
    }

    if (el.id) {
      const label = document.querySelector('label[for="' + el.id + '"]');
      if (label) return (label.innerText || '').trim();
    }

    const title = el.getAttribute('title');
    if (title) return title.trim();

    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();

    return '';
  }

  // interactive element selectors
  const interactiveSelector = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="combobox"]', '[role="listbox"]',
    '[tabindex]:not([tabindex="-1"])',
    'summary',
  ].join(', ');

  const maxInteractive = 100;
  let interactiveCount = 0;

  document.querySelectorAll(interactiveSelector).forEach(el => {
    if (interactiveCount >= maxInteractive) return;
    if (!isVisible(el)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (el.closest('[aria-hidden="true"]')) return;

    const ref = counter++;
    el.setAttribute('data-cref', String(ref));

    const role = getRole(el);
    const name = getName(el).slice(0, 120);
    const rawText = (el.innerText || el.textContent || '').trim();
    const text = rawText.slice(0, 120);

    results.push({
      ref,
      role,
      name,
      text: text !== name ? text : '',
      type: el.getAttribute('type') || undefined,
      href: el.tagName === 'A' ? (el.getAttribute('href') || undefined) : undefined,
      value: ('value' in el && el.value) ? String(el.value).slice(0, 80) : undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      checked: ('checked' in el && el.checked) ? true : undefined,
      disabled: (('disabled' in el && el.disabled) || el.getAttribute('aria-disabled') === 'true') ? true : undefined,
      interactive: true,
    });

    interactiveCount++;
  });

  // content elements only in full mode
  if (snapshotMode === 'full') {
    const contentSelector = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, figcaption';
    const maxContent = 30;
    let contentCount = 0;

    document.querySelectorAll(contentSelector).forEach(el => {
      if (contentCount >= maxContent) return;
      if (el.getAttribute('data-cref')) return;
      if (!isVisible(el)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (el.closest('[aria-hidden="true"]')) return;

      const rawText = (el.innerText || el.textContent || '').trim();
      if (!rawText || rawText.length < 3) return;

      const ref = counter++;
      el.setAttribute('data-cref', String(ref));

      results.push({
        ref,
        role: getRole(el),
        name: '',
        text: rawText.slice(0, 200),
        interactive: false,
      });

      contentCount++;
    });
  }

  return results;
}`;

// ------------------------------------------------------------------
// browser manager
// ------------------------------------------------------------------

class BrowserManager {
  private browser: Browser | null = null;
  private tabMap: Map<string, Page> = new Map();
  private activeTabId: string | null = null;
  private tabCounter = 0;
  private currentUserAgent: string = USER_AGENTS[0]!;
  private currentViewport = VIEWPORTS[0]!;

  private get page(): Page | null {
    if (!this.activeTabId) return null;
    return this.tabMap.get(this.activeTabId) || null;
  }

  // configure a new page with stealth settings
  private async configurePage(page: Page): Promise<void> {
    await page.setViewport(this.currentViewport);
    await page.setUserAgent(this.currentUserAgent);

    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    });

    // comprehensive browser property spoofing to evade detection
    await page.evaluateOnNewDocument(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const g = globalThis as any;

      Object.defineProperty(g.navigator, "webdriver", {
        get: () => undefined,
      });
      delete g.Navigator.prototype.webdriver;

      Object.defineProperty(g.navigator, "plugins", {
        get: () => {
          const plugins = [
            {
              name: "Chrome PDF Plugin",
              filename: "internal-pdf-viewer",
              description: "Portable Document Format",
            },
            {
              name: "Chrome PDF Viewer",
              filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
              description: "",
            },
            {
              name: "Native Client",
              filename: "internal-nacl-plugin",
              description: "",
            },
          ];
          const pluginArray = plugins as any;
          pluginArray.item = (i: number) => plugins[i];
          pluginArray.namedItem = (name: string) =>
            plugins.find((p) => p.name === name);
          pluginArray.refresh = () => {};
          return pluginArray;
        },
      });

      Object.defineProperty(g.navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      Object.defineProperty(g.navigator, "hardwareConcurrency", {
        get: () => [4, 8, 12, 16][Math.floor(Math.random() * 4)],
      });

      Object.defineProperty(g.navigator, "deviceMemory", {
        get: () => [4, 8, 16][Math.floor(Math.random() * 3)],
      });

      Object.defineProperty(g.navigator, "platform", {
        get: () => "Win32",
      });

      g.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {},
      };

      const originalQuery = g.Permissions.prototype.query;
      g.Permissions.prototype.query = function (parameters: any) {
        if (parameters.name === "notifications") {
          return Promise.resolve({ state: "denied", onchange: null });
        }
        return originalQuery.call(this, parameters);
      };

      const getParameterProto = g.WebGLRenderingContext.prototype.getParameter;
      g.WebGLRenderingContext.prototype.getParameter = function (
        parameter: any,
      ) {
        if (parameter === 37445) return "Google Inc. (NVIDIA)";
        if (parameter === 37446)
          return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)";
        return getParameterProto.call(this, parameter);
      };

      const getParameterProto2 =
        g.WebGL2RenderingContext.prototype.getParameter;
      g.WebGL2RenderingContext.prototype.getParameter = function (
        parameter: any,
      ) {
        if (parameter === 37445) return "Google Inc. (NVIDIA)";
        if (parameter === 37446)
          return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)";
        return getParameterProto2.call(this, parameter);
      };

      const elementProto = g.HTMLIFrameElement.prototype;
      const originalContentWindow = Object.getOwnPropertyDescriptor(
        elementProto,
        "contentWindow",
      );
      if (originalContentWindow) {
        Object.defineProperty(elementProto, "contentWindow", {
          get: function () {
            return originalContentWindow.get?.call(this);
          },
        });
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
  }

  async launch(): Promise<void> {
    this.currentUserAgent =
      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
    this.currentViewport =
      VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]!;

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
        `--window-size=${this.currentViewport.width},${this.currentViewport.height}`,
      ],
    });

    const defaultPage =
      (await this.browser.pages())[0] || (await this.browser.newPage());
    await this.configurePage(defaultPage);

    const tabId = `tab-${++this.tabCounter}`;
    this.tabMap.set(tabId, defaultPage);
    this.activeTabId = tabId;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.tabMap.clear();
      this.activeTabId = null;
      this.tabCounter = 0;
    }
  }

  // ---- navigation ----

  async navigate(url: string): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not launched");
    await randomDelay(100, 500);
    await this.page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await randomDelay(300, 800);
    return this.getState();
  }

  // ---- snapshot system ----
  // the core paradigm shift: returns a semantic tree of the page with numbered refs
  // the agent uses these refs for all interactions instead of css selectors

  async snapshot(mode: "full" | "interactive" = "full"): Promise<PageSnapshot> {
    if (!this.page) throw new Error("Browser not launched");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshotFn = new Function("return " + SNAPSHOT_SCRIPT)();
    const elements: SnapshotElement[] = await this.page.evaluate(
      snapshotFn,
      mode,
    );

    return {
      url: this.page.url(),
      title: await this.page.title(),
      elements,
    };
  }

  // ---- ref-based actions ----
  // all interactions go through element refs from the last snapshot
  // this eliminates the brittle css selector guessing game

  async act(
    ref: number,
    action: string,
    value?: string,
    submit?: boolean,
  ): Promise<string> {
    if (!this.page) throw new Error("Browser not launched");

    const selector = `[data-cref="${ref}"]`;
    const element = await this.page.$(selector);
    if (!element) {
      throw new Error(
        `Element ref [${ref}] not found. The page may have changed since the last snapshot. Run browser_snapshot to get fresh refs.`,
      );
    }

    await randomDelay(50, 200);

    switch (action) {
      case "click":
        await element.click();
        await this.page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        break;

      case "type":
        // select all existing text, then type new value with human-like delay
        await element.click({ count: 3 });
        await element.type(value || "", {
          delay: 30 + Math.random() * 50,
        });
        if (submit) await this.page.keyboard.press("Enter");
        await this.page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
        break;

      case "fill":
        // direct value assignment - faster than type but doesnt trigger keystroke events
        // dispatches input+change events to trigger frameworks like react
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await element.evaluate((el: any, val: string) => {
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, value || "");
        if (submit) await this.page.keyboard.press("Enter");
        break;

      case "hover":
        await element.hover();
        await randomDelay(200, 500);
        break;

      case "select":
        await element.select(value || "");
        break;

      case "check": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isChecked = await element.evaluate((el: any) => el.checked);
        if (!isChecked) await element.click();
        break;
      }

      case "uncheck": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wasChecked = await element.evaluate((el: any) => el.checked);
        if (wasChecked) await element.click();
        break;
      }

      case "focus":
        await element.focus();
        break;

      case "clear":
        await element.click({ count: 3 });
        await this.page.keyboard.press("Backspace");
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const state = await this.getState();
    return `Action "${action}" performed on ref [${ref}]. Page: ${state.pageTitle} (${state.currentUrl})`;
  }

  // ---- tab management ----

  async getTabs(): Promise<TabInfo[]> {
    const tabs: TabInfo[] = [];

    for (const [id, page] of this.tabMap) {
      try {
        tabs.push({
          id,
          url: page.url(),
          title: await page.title(),
          active: id === this.activeTabId,
        });
      } catch {
        // page may have been closed externally
        this.tabMap.delete(id);
      }
    }

    return tabs;
  }

  async newTab(url?: string): Promise<TabInfo> {
    if (!this.browser) throw new Error("Browser not launched");

    const page = await this.browser.newPage();
    await this.configurePage(page);

    const tabId = `tab-${++this.tabCounter}`;
    this.tabMap.set(tabId, page);
    this.activeTabId = tabId;

    if (url) {
      const validation = validateUrl(url);
      if (validation.valid) {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      }
    }

    return {
      id: tabId,
      url: page.url(),
      title: await page.title(),
      active: true,
    };
  }

  async switchTab(tabId: string): Promise<void> {
    const page = this.tabMap.get(tabId);
    if (!page) {
      throw new Error(
        `Tab "${tabId}" not found. Use browser_tabs with action "list" to see available tabs.`,
      );
    }
    this.activeTabId = tabId;
    await page.bringToFront();
  }

  async closeTab(tabId?: string): Promise<void> {
    const targetId = tabId || this.activeTabId;
    if (!targetId) throw new Error("No active tab to close");

    const page = this.tabMap.get(targetId);
    if (!page) throw new Error(`Tab "${targetId}" not found`);

    await page.close();
    this.tabMap.delete(targetId);

    // switch to another tab if we closed the active one
    if (targetId === this.activeTabId) {
      const remaining = [...this.tabMap.keys()];
      this.activeTabId =
        remaining.length > 0 ? remaining[remaining.length - 1]! : null;
    }
  }

  // ---- wait conditions ----

  async waitFor(
    condition: string,
    value?: string,
    timeoutMs: number = 10000,
  ): Promise<{ success: boolean; message: string }> {
    if (!this.page) throw new Error("Browser not launched");

    try {
      switch (condition) {
        case "text":
          if (!value)
            return { success: false, message: "No text value provided" };
          await this.page.waitForFunction(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (searchText: string) =>
              ((globalThis as any).document.body.innerText as string).includes(
                searchText,
              ),
            { timeout: timeoutMs },
            value,
          );
          return {
            success: true,
            message: `Text "${value}" found on page`,
          };

        case "url":
          if (!value)
            return { success: false, message: "No URL value provided" };
          await this.page.waitForFunction(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (urlSubstring: string) =>
              ((globalThis as any).location.href as string).includes(
                urlSubstring,
              ),
            { timeout: timeoutMs },
            value,
          );
          return {
            success: true,
            message: `URL now contains "${value}"`,
          };

        case "selector":
          if (!value)
            return { success: false, message: "No selector provided" };
          await this.page.waitForSelector(value, {
            visible: true,
            timeout: timeoutMs,
          });
          return {
            success: true,
            message: `Element "${value}" is now visible`,
          };

        case "networkidle":
          await this.page.waitForNetworkIdle({ timeout: timeoutMs });
          return { success: true, message: "Network is idle" };

        default:
          return { success: false, message: `Unknown condition: ${condition}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout") || msg.includes("Timeout")) {
        return {
          success: false,
          message: `Timed out after ${timeoutMs}ms waiting for ${condition}${value ? `: "${value}"` : ""}`,
        };
      }
      return { success: false, message: `Wait failed: ${msg}` };
    }
  }

  // ---- content extraction ----

  async scroll(
    direction: "up" | "down",
    amount?: number,
  ): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not launched");
    await randomDelay(100, 300);
    const scrollAmount = direction === "up" ? -(amount || 500) : amount || 500;
    await this.page.evaluate((amt: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).scrollBy(0, amt);
    }, scrollAmount);
    await randomDelay(200, 500);
    return this.getState();
  }

  async getContent(): Promise<{
    content: string;
    quality: "good" | "low" | "empty";
  }> {
    if (!this.page) throw new Error("Browser not launched");
    const rawContent = await this.page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      const body = doc.body.cloneNode(true) as {
        querySelectorAll: (s: string) => Array<{ remove: () => void }>;
        innerText: string;
      };
      const junk = body.querySelectorAll(
        "script, style, nav, footer, header, iframe, noscript, svg, [role='navigation'], [role='banner'], [aria-hidden='true']",
      );
      junk.forEach((el: { remove: () => void }) => el.remove());
      return body.innerText;
    });

    const cleaned = rawContent.replace(/\s+/g, " ").trim().slice(0, 8000);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // ---- search result extraction ----

  async extractSearchResults(
    provider: SearchProviderId,
  ): Promise<RawSearchResult[]> {
    if (!this.page) throw new Error("Browser not launched");

    if (provider === "duckduckgo_lite") {
      const results = await this.page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        const searchResults: Array<{
          title: string;
          url?: string;
          snippet?: string;
        }> = [];
        const links = doc.querySelectorAll("a.result-link");

        for (const link of links) {
          const title = link.textContent?.trim();
          const url = link.getAttribute("href") || undefined;
          const row = link.closest("tr");
          const snippetEl =
            row?.nextElementSibling?.querySelector(".result-snippet");
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

// singleton
const browserManager = new BrowserManager();

// ------------------------------------------------------------------
// tool definitions
// ------------------------------------------------------------------

export const browserTools = {
  browser_navigate: {
    description: `Navigate to a URL. You MUST call browser_snapshot immediately after this to see the page. Do not use browser_get_content as your first action after navigation - always snapshot first.

For simple page reads (articles, docs), prefer web_fetch instead - its faster and doesnt need a browser.

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
    description: `YOUR PRIMARY WAY TO SEE ANY WEB PAGE. Returns a structured view of all interactive elements (links, buttons, inputs) and content, each with a numbered ref. You MUST call this after every browser_navigate and after any action that changes the page.

REQUIRED workflow:
1. browser_navigate -> browser_snapshot (see the page)
2. browser_act with ref (interact)
3. browser_snapshot again (see result)

Never skip this step. Never guess at page structure without a snapshot.
Refs expire on page changes - always re-snapshot after navigation or dynamic updates.`,
    schema: SnapshotSchema,
    handler: async (args: z.infer<typeof SnapshotSchema>, _userId: number) => {
      if (!browserManager.isActive()) await browserManager.launch();
      const snapshot = await browserManager.snapshot(args.mode || "full");
      return formatSnapshot(snapshot);
    },
  },

  browser_act: {
    description: `Perform an action on a page element using its ref number from browser_snapshot.

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
- Click a link: {"ref": 3, "action": "click"}
- Type in search: {"ref": 5, "action": "type", "value": "query", "submit": true}
- Fill a form field: {"ref": 7, "action": "fill", "value": "john@example.com"}
- Hover for dropdown: {"ref": 2, "action": "hover"}

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
      "Extract readable text from the current page. ONLY use this AFTER browser_snapshot when you need the full prose text of articles or documentation. For page structure and interaction, ALWAYS use browser_snapshot + browser_act instead. For quick reads without a browser, prefer web_fetch.",
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
      "Search the web using DuckDuckGo. Use this FIRST when the user asks to look something up, search for something, find information, research topics, verify facts, etc. After getting results: use web_fetch for quick reads of simple pages, or browser_navigate + browser_snapshot for interactive sites.",
    schema: WebSearchSchema,
    handler: async (args: z.infer<typeof WebSearchSchema>, _userId: number) => {
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
          const rawResults = await browserManager.extractSearchResults(
            provider.id,
          );

          const normalizedResults: SearchResult[] = [];
          const baseUrl = getProviderBaseUrl(provider.id);
          for (const result of rawResults) {
            const title = normalizeText(result.title);
            const snippet = normalizeText(result.snippet);
            const url =
              provider.id === "duckduckgo_lite"
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
            error = detectSearchBlock(
              provider.id,
              snapshot.title,
              snapshot.text,
            );
          }

          providerResults.push({
            provider,
            results: normalizedResults,
            error,
          });
          await randomDelay(150, 400);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          providerResults.push({ provider, results: [], error: msg });
        }
      }

      const aggregatedResults = dedupeSearchResults(
        providerResults.flatMap((entry) => entry.results),
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

      const failures = providerResults.filter(
        (entry) => entry.results.length === 0,
      );
      if (failures.length > 0) {
        response += "\n\nNotes:";
        for (const failure of failures) {
          const reason = failure.error
            ? `Search failed: ${failure.error}`
            : "No results returned";
          response += `\n- ${failure.provider.label}: ${reason}`;
        }
      }

      return response;
    },
  },
};

// ------------------------------------------------------------------
// exports
// ------------------------------------------------------------------

export async function cleanupBrowser(): Promise<void> {
  await browserManager.close();
}

export type BrowserTools = typeof browserTools;
