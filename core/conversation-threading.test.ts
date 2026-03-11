import { describe, expect, it } from "bun:test";
import {
  buildImessageThreadId,
  buildTelegramMessageReference,
  buildTelegramThreadId,
  shouldReuseActiveThread,
} from "./conversation-threading.ts";

describe("conversation threading", () => {
  it("builds stable telegram references", () => {
    expect(buildTelegramMessageReference(123, 456)).toBe("telegram:123:456");
    expect(buildTelegramThreadId(123, 456)).toBe("telegram:123:456");
  });

  it("builds stable imessage thread ids", () => {
    const first = buildImessageThreadId("+1 (555) 123-4567", "handle-1");
    const second = buildImessageThreadId("15551234567", "handle-1");
    const different = buildImessageThreadId("15551234567", "handle-2");

    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  it("reuses active threads inside the activity window", () => {
    const now = Date.now();

    expect(shouldReuseActiveThread(now - 5 * 60 * 1000, now)).toBe(true);
    expect(shouldReuseActiveThread(now - 45 * 60 * 1000, now)).toBe(false);
  });
});
