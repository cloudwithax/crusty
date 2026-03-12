import { describe, expect, it } from "bun:test";
import {
  MessageDebouncer,
  getInboundMessageDebounceMs,
  getInboundTypingGraceMs,
  joinBufferedText,
} from "./inbound-debounce.ts";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("inbound debounce", () => {
  it("parses debounce config from the environment", () => {
    expect(
      getInboundMessageDebounceMs({
        INBOUND_MESSAGE_DEBOUNCE_MS: "2500",
      } as NodeJS.ProcessEnv),
    ).toBe(2500);

    expect(
      getInboundTypingGraceMs({
        INBOUND_TYPING_GRACE_MS: "900",
      } as NodeJS.ProcessEnv),
    ).toBe(900);
  });

  it("joins buffered message text with paragraph breaks", () => {
    expect(joinBufferedText(["first part", "  second part  ", ""])).toBe(
      "first part\n\nsecond part",
    );
  });

  it("batches rapid messages into one flush", async () => {
    const flushed: string[][] = [];
    const debouncer = new MessageDebouncer<string>({
      debounceMs: 25,
      typingGraceMs: 40,
      onFlush: ({ items }) => {
        flushed.push(items);
      },
    });

    debouncer.enqueue("user", "one");
    await wait(10);
    debouncer.enqueue("user", "two");
    await wait(40);

    expect(flushed).toEqual([["one", "two"]]);
  });

  it("waits for typing activity to settle before flushing", async () => {
    const flushed: string[][] = [];
    const debouncer = new MessageDebouncer<string>({
      debounceMs: 20,
      typingGraceMs: 60,
      onFlush: ({ items }) => {
        flushed.push(items);
      },
    });

    debouncer.enqueue("user", "draft");
    await wait(10);
    debouncer.markTyping("user");
    await wait(30);

    expect(flushed).toEqual([]);

    await wait(40);

    expect(flushed).toEqual([["draft"]]);
  });

  it("honors typing signals that arrive before the first message", async () => {
    const flushed: string[][] = [];
    const debouncer = new MessageDebouncer<string>({
      debounceMs: 20,
      typingGraceMs: 60,
      onFlush: ({ items }) => {
        flushed.push(items);
      },
    });

    debouncer.markTyping("user");
    await wait(10);
    debouncer.enqueue("user", "hello");
    await wait(25);

    expect(flushed).toEqual([]);

    await wait(40);

    expect(flushed).toEqual([["hello"]]);
  });
});
