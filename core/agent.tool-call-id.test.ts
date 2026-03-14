import { describe, it, expect } from "bun:test";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import { ensureToolCallIds, sanitizeToolCallHistoryMessages } from "./agent.ts";

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

  it("repairs assistant and tool message ids in history", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "",
            type: "function",
            function: {
              name: "web_fetch",
              arguments: '{"url":"https://example.com"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: " ",
        content: "ok",
      },
    ] as any[];

    const sanitized = sanitizeToolCallHistoryMessages(messages as any);

    expect(sanitized).toHaveLength(2);
    const assistant = sanitized[0] as any;
    const tool = sanitized[1] as any;

    expect(assistant.tool_calls[0].id).toMatch(/^tc_\d+_0$/);
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it("drops orphan tool messages without any resolvable tool_call_id", () => {
    const messages = [
      {
        role: "user",
        content: "hello",
      },
      {
        role: "tool",
        tool_call_id: "",
        content: "stale tool output",
      },
    ] as any[];

    const sanitized = sanitizeToolCallHistoryMessages(messages as any);

    expect(sanitized).toHaveLength(1);
    expect((sanitized[0] as any).role).toBe("user");
  });
});
