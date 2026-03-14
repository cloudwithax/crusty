import { describe, it, expect } from "bun:test";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import { ensureToolCallIds } from "./agent.ts";

describe("ensureToolCallIds", () => {
  it("repairs missing and blank tool call ids", () => {
    const toolCalls = [
      {
        id: "",
        type: "function",
        function: {
          name: "web_fetch",
          arguments: '{"url":"https://example.com"}',
        },
      },
      {
        id: "   ",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"path":"/tmp/file.txt"}',
        },
      },
      {
        id: "existing-id-1",
        type: "function",
        function: {
          name: "bash_execute",
          arguments: '{"command":"pwd"}',
        },
      },
    ] as ChatCompletionMessageToolCall[];

    const normalized = ensureToolCallIds(toolCalls);

    expect(normalized.repairedCount).toBe(2);
    expect(normalized.toolCalls).toHaveLength(3);

    expect(normalized.toolCalls[0]?.id).toMatch(/^tc_\d+_0$/);
    expect(normalized.toolCalls[1]?.id).toMatch(/^tc_\d+_1$/);
    expect(normalized.toolCalls[2]?.id).toBe("existing-id-1");
  });

  it("does not change tool calls when all ids are valid", () => {
    const toolCalls = [
      {
        id: "call-a",
        type: "function",
        function: {
          name: "web_search",
          arguments: '{"query":"bun"}',
        },
      },
      {
        id: "call-b",
        type: "function",
        function: {
          name: "browser_snapshot",
          arguments: "{}",
        },
      },
    ] as ChatCompletionMessageToolCall[];

    const normalized = ensureToolCallIds(toolCalls);

    expect(normalized.repairedCount).toBe(0);
    expect(normalized.toolCalls[0]?.id).toBe("call-a");
    expect(normalized.toolCalls[1]?.id).toBe("call-b");
  });
});
