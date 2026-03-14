import { describe, test, expect } from "bun:test";
import { parseToolCalls } from "./tool-parser";
import type { ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";

// helper to get function tool calls (we know all our tool calls are function calls)
function getFunctionCalls(
  result: ReturnType<typeof parseToolCalls>,
): ChatCompletionMessageFunctionToolCall[] {
  if (!result) return [];
  return result.toolCalls.filter(
    (tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === "function",
  );
}

describe("tool parser", () => {
  test("returns null for content without tool calls", () => {
    const content = "this is just regular text without any tool calls";
    const result = parseToolCalls(content);
    expect(result).toBeNull();
  });

  test("returns null for empty content", () => {
    const result = parseToolCalls("");
    expect(result).toBeNull();
  });

  // kimi k2 format
  describe("kimi k2", () => {
    test("parses single tool call", () => {
      const content = `<|tool_calls_section_begin|><|tool_call_begin|>{"name":"get_weather","arguments":{"location":"paris"}}<|tool_call_end|><|tool_calls_section_end|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("kimi-k2");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("get_weather");
      expect(calls[0]!.function.arguments).toBe('{"location":"paris"}');
    });

    test("parses multiple tool calls", () => {
      const content = `<|tool_calls_section_begin|><|tool_call_begin|>{"name":"get_weather","arguments":{"location":"paris"}}<|tool_call_end|><|tool_call_begin|>{"name":"get_time","arguments":{"timezone":"utc"}}<|tool_call_end|><|tool_calls_section_end|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.function.name).toBe("get_weather");
      expect(calls[1]!.function.name).toBe("get_time");
    });
  });

  // deepseek format
  describe("deepseek", () => {
    test("parses with fullwidth characters", () => {
      const content = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather\n\`\`\`json\n{"location":"tokyo"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("deepseek");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("get_weather");
    });
  });

  // mistral format
  describe("mistral", () => {
    test("parses bracket format", () => {
      const content = `[TOOL_CALLS] [{"name":"get_weather","arguments":{"location":"london"},"id":"abc123xyz"}]`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("mistral");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("get_weather");
      expect(calls[0]!.id).toBe("abc123xyz");
    });

    test("returns text content before tool calls", () => {
      const content = `Let me check the weather for you.[TOOL_CALLS] [{"name":"get_weather","arguments":{}}]`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.textContent).toBe("Let me check the weather for you.");
    });
  });

  // phi-4 format
  describe("phi-4", () => {
    test("parses tag format with array", () => {
      const content = `<|tool_calls|>[{"name":"search","arguments":{"query":"typescript"}}]<|/tool_calls|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("phi-4");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("search");
    });
  });

  // granite 3.x format
  describe("granite 3", () => {
    test("parses single tool call tag", () => {
      const content = `<|tool_call|>{"name":"read_file","arguments":{"path":"/src/index.ts"}}`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("granite-3");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("read_file");
    });

    test("parses nested tool wrapper", () => {
      const content = `<|tool_call|>{"tool":{"name":"execute","arguments":{"command":"ls"}}}`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      const calls = getFunctionCalls(result);
      expect(calls[0]!.function.name).toBe("execute");
    });
  });

  // internlm format
  describe("internlm", () => {
    test("parses action tags with parameters", () => {
      const content = `<|action_start|><|plugin|>{"name":"browser_navigate","parameters":{"url":"https://example.com"}}<|action_end|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("internlm");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("browser_navigate");
    });
  });

  // functionary v3 format
  describe("functionary v3", () => {
    test("parses function tags", () => {
      const content = `<function=get_weather>{"location":"new york"}</function>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("functionary-v3");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("get_weather");
    });

    test("parses multiple function calls", () => {
      const content = `<function=step1>{"key":"value1"}</function><function=step2>{"key":"value2"}</function>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.function.name).toBe("step1");
      expect(calls[1]!.function.name).toBe("step2");
    });
  });

  // functionary v2 format
  describe("functionary v2", () => {
    test("parses from/recipient tags", () => {
      const content = `<|from|>assistant<|recipient|>get_weather<|content|>{"location":"seattle"}<|from|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("functionary-v2");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("get_weather");
    });

    test("skips 'all' recipient", () => {
      const content = `<|from|>assistant<|recipient|>all<|content|>final text response<|from|>`;
      const result = parseToolCalls(content);
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(0);
    });
  });

  // cohere command-r format
  describe("cohere", () => {
    test("parses action code block", () => {
      const content = `Action: \`\`\`json\n[{"tool_name":"search","parameters":{"query":"test"}}]\n\`\`\``;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("cohere");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("search");
    });

    test("skips directly_answer pseudo-tool", () => {
      const content = `Action: \`\`\`json\n[{"tool_name":"directly_answer"}]\n\`\`\``;
      const result = parseToolCalls(content);
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(0);
    });
  });

  // glm-4 python format
  describe("glm-4 python", () => {
    test("parses python code block", () => {
      const content = `\`\`\`python\ntool_call(name="get_weather", arguments={"location":"berlin"})\n\`\`\``;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("glm-4-python");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("get_weather");
    });

    test("converts python literals to json", () => {
      const content = `\`\`\`python\ntool_call(name="test", arguments={"flag":True,"value":None})\n\`\`\``;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      const calls = getFunctionCalls(result);
      const args = JSON.parse(calls[0]!.function.arguments || "{}");
      expect(args.flag).toBe(true);
      expect(args.value).toBeNull();
    });
  });

  // granite 20b format
  describe("granite 20b", () => {
    test("parses function_call tag", () => {
      const content = `<function_call> {"name":"execute_script","arguments":{"script":"main.py"}}`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("granite-20b");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("execute_script");
    });
  });

  // llama pythonic format
  describe("llama pythonic", () => {
    test("parses python_tag with function call", () => {
      const content = `<|python_tag|>brave_search.call(query="latest news")<|eom_id|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("llama-python");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("brave_search");
    });

    test("parses list of function calls", () => {
      const content = `<|python_tag|>[get_weather(location="paris"), get_time(timezone="utc")]<|eom_id|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.function.name).toBe("get_weather");
      expect(calls[1]!.function.name).toBe("get_time");
    });
  });

  // qwen/hermes format
  describe("qwen hermes", () => {
    test("parses tool_call tags with json", () => {
      const content = `<|tool_call|>{"name":"read_file","arguments":{"path":"config.json"}}<|/tool_call|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.format).toBe("qwen-hermes");
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("read_file");
    });
  });

  // edge cases and special handling
  describe("edge cases", () => {
    test("handles malformed json gracefully", () => {
      const content = `<|tool_call|>{"name":"test","arguments":{invalid}}<|/tool_call|>`;
      const result = parseToolCalls(content);
      // should return null because json parsing fails
      expect(result).toBeNull();
    });

    test("handles missing tool name", () => {
      const content = `<|tool_call|>{"arguments":{"key":"value"}}<|/tool_call|>`;
      const result = parseToolCalls(content);
      // should return null because name is required
      expect(result).toBeNull();
    });

    test("handles empty tool arguments", () => {
      const content = `<|tool_call|>{"name":"test"}<|/tool_call|>`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      const calls = getFunctionCalls(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.function.name).toBe("test");
      expect(calls[0]!.function.arguments).toBe("{}");
    });

    test("strips text content correctly", () => {
      const content = `Here's what I found:<|tool_call|>{"name":"search"}<|/tool_call|>That's the result.`;
      const result = parseToolCalls(content);
      expect(result).not.toBeNull();
      expect(result?.textContent).toBe(
        "Here's what I found:That's the result.",
      );
    });
  });
});
