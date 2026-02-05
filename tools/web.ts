import { z } from "zod";

// ------------------------------------------------------------------
// schemas
// ------------------------------------------------------------------

const WebFetchSchema = z.object({
  url: z.string().describe("URL to fetch and extract content from"),
  maxChars: z
    .number()
    .optional()
    .describe("Maximum characters to return (default: 12000)"),
});

// ------------------------------------------------------------------
// html-to-text converter
// converts raw html into readable text without requiring a browser
// handles headings, links, lists, code blocks, and html entities
// ------------------------------------------------------------------

function htmlToReadableText(html: string): { title: string; content: string } {
  // extract title from <title> tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.replace(/\s+/g, " ").trim() : "";

  let content = html;

  // strip non-content elements entirely
  content = content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // convert headings to markdown-style for readability
  content = content.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level: string, text: string) => {
      const cleaned = text.replace(/<[^>]+>/g, "").trim();
      if (!cleaned) return "";
      return "\n" + "#".repeat(parseInt(level)) + " " + cleaned + "\n";
    },
  );

  // convert links to "text (url)" format for context
  content = content.replace(
    /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, text: string) => {
      const linkText = text.replace(/<[^>]+>/g, "").trim();
      if (!linkText) return "";
      // skip anchor-only and javascript links
      if (href.startsWith("#") || href.startsWith("javascript:"))
        return linkText;
      return `${linkText} (${href})`;
    },
  );

  // convert lists
  content = content.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (_match, text: string) => {
      const cleaned = text.replace(/<[^>]+>/g, "").trim();
      return cleaned ? `\n- ${cleaned}` : "";
    },
  );

  // convert block elements to paragraph breaks
  content = content.replace(
    /<\/?(p|div|section|article|blockquote|table|tr|br)[^>]*>/gi,
    "\n",
  );
  content = content.replace(/<\/?(ul|ol|dl|thead|tbody|tfoot)[^>]*>/gi, "\n");

  // convert table cells to spaces
  content = content.replace(/<\/?(td|th)[^>]*>/gi, " | ");

  // preserve code blocks with minimal formatting
  content = content.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, code: string) => {
      const cleaned = code.replace(/<[^>]+>/g, "").trim();
      return "\n```\n" + cleaned + "\n```\n";
    },
  );

  // strip all remaining html tags
  content = content.replace(/<[^>]+>/g, "");

  // decode common html entities
  content = content
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "--")
    .replace(/&ndash;/g, "-")
    .replace(/&hellip;/g, "...")
    .replace(/&copy;/g, "(c)")
    .replace(/&reg;/g, "(R)")
    .replace(/&trade;/g, "(TM)")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCharCode(parseInt(code)),
    );

  // clean up whitespace - collapse runs of spaces, limit consecutive newlines
  content = content
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, content };
}

// ------------------------------------------------------------------
// tool definitions
// ------------------------------------------------------------------

export const webTools = {
  web_fetch: {
    description: `PREFERRED tool for reading web pages. Fetches a URL and extracts readable text WITHOUT launching a browser. Much faster than browser_navigate.

Use this FIRST when you need to read a web page. Only fall back to browser_navigate + browser_snapshot if:
- the page requires JavaScript rendering
- you need to interact with the page (click, type, fill forms)
- web_fetch returns empty/broken content

Best for: articles, documentation, API responses, search result pages, static HTML.

FORMAT: {"url": "https://example.com"}`,
    schema: WebFetchSchema,
    handler: async (args: z.infer<typeof WebFetchSchema>, _userId: number) => {
      const maxChars = args.maxChars || 12000;
      const url = args.url?.trim();

      if (!url) {
        return "[Error] No URL provided.";
      }

      if (!/^https?:\/\//i.test(url)) {
        return `[Error] URL must start with http:// or https://. Got: "${url}"`;
      }

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; Crusty/1.0; +https://github.com/clxudiaea/crusty)",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          return `[Error] HTTP ${response.status}: ${response.statusText}. URL: ${url}`;
        }

        const contentType = response.headers.get("content-type") || "";

        // json responses - return raw
        if (contentType.includes("application/json")) {
          const json = await response.text();
          return `Content from ${url} (JSON):\n${json.slice(0, maxChars)}${json.length > maxChars ? "\n\n[truncated]" : ""}`;
        }

        // plain text - return as-is
        if (
          contentType.includes("text/plain") &&
          !contentType.includes("html")
        ) {
          const text = await response.text();
          return `Content from ${url} (text):\n${text.slice(0, maxChars)}${text.length > maxChars ? "\n\n[truncated]" : ""}`;
        }

        // non-html content types - warn
        if (
          !contentType.includes("text/html") &&
          !contentType.includes("application/xhtml")
        ) {
          return `[Warning] Content type is "${contentType}" which may not be readable. URL: ${url}`;
        }

        // html - convert to readable text
        const html = await response.text();
        const { title, content } = htmlToReadableText(html);

        if (!content || content.length < 10) {
          return `[Warning] Page returned very little readable content. It may be a JavaScript-heavy site that requires browser rendering. Use browser_navigate + browser_snapshot instead.\n\nURL: ${url}`;
        }

        const truncated = content.slice(0, maxChars);
        const header = title
          ? `Title: ${title}\nURL: ${url}\n\n`
          : `URL: ${url}\n\n`;

        return `${header}${truncated}${content.length > maxChars ? "\n\n[content truncated]" : ""}`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("timeout") || msg.includes("abort")) {
          return `[Error] Request timed out after 15 seconds. URL: ${url}`;
        }
        if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
          return `[Error] Could not resolve hostname. URL: ${url}`;
        }
        if (msg.includes("ECONNREFUSED")) {
          return `[Error] Connection refused. URL: ${url}`;
        }
        return `[Error] Failed to fetch: ${msg}. URL: ${url}`;
      }
    },
  },
};
