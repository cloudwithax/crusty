import { z } from "zod";
import { fetchPageWithBrowser } from "./browser.ts";

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
// tool definitions
// ------------------------------------------------------------------

export const webTools = {
  web_fetch: {
    description: `Fetch a URL and extract its readable text content using a real browser. Handles JavaScript-rendered pages, redirects, and dynamic content.

Use this to read articles, documentation, and pages after finding them via web_search.

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

      const { content, quality, currentUrl, pageTitle } =
        await fetchPageWithBrowser(url);

      const header = pageTitle
        ? `Title: ${pageTitle}\nURL: ${currentUrl || url}\n\n`
        : `URL: ${currentUrl || url}\n\n`;

      if (quality === "empty") {
        return `[Warning: Page returned very little content - may be loading, blocked, or requires interaction. Try browser_navigate + browser_snapshot instead.]\n\n${header}${content}`;
      }

      if (quality === "low") {
        return `[Warning: Page content quality is low - may be behind a paywall, captcha, or loading screen. Consider trying a different source.]\n\n${header}${content.slice(0, maxChars)}${content.length > maxChars ? "\n\n[content truncated]" : ""}`;
      }

      const truncated = content.slice(0, maxChars);
      return `${header}${truncated}${content.length > maxChars ? "\n\n[content truncated]" : ""}`;
    },
  },
};
