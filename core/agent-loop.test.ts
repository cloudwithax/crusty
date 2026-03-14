import { describe, test, expect } from "bun:test";
import { parseToolCalls } from "./tool-parser";
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

// integration tests for tool parsing stability in multi-step scenarios
// these tests verify that the parser handles complex real-world patterns
// without causing loops or rejections

describe("tool parsing stability - multi-step scenarios", () => {
  describe("sequential tool calls", () => {
    test("parses multiple sequential tool calls from same response", () => {
      // simulates a model returning multiple tool calls in sequence
      const content =
        '<|tool_calls_section_begin|><|tool_call_begin|>{"name":"read_file","arguments":{"path":"/src/index.ts"}}<|tool_call_end|><|tool_call_begin|>{"name":"bash_execute","arguments":{"command":"npm test"}}<|tool_call_end|><|tool_calls_section_end|>';

      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.format).toBe("kimi-k2");
      expect(result?.toolCalls).toHaveLength(2);

      expect(result?.toolCalls[0]?.type).toBe("function");
      expect(result?.toolCalls[0]?.function.name).toBe("read_file");

      expect(result?.toolCalls[1]?.type).toBe("function");
      expect(result?.toolCalls[1]?.function.name).toBe("bash_execute");
    });

    test("handles deeply nested json in tool arguments", () => {
      const nestedArgs = {
        config: {
          database: {
            host: "localhost",
            port: 5432,
            credentials: {
              user: "admin",
              password: "secret",
            },
          },
          options: {
            ssl: true,
            timeout: 30000,
          },
        },
      };

      const content =
        "<function=write_file>" + JSON.stringify(nestedArgs) + "</function>";
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.format).toBe("functionary-v3");
      expect(result?.toolCalls).toHaveLength(1);

      const args = JSON.parse(result?.toolCalls[0]?.function.arguments || "{}");
      expect(args.config.database.host).toBe("localhost");
      expect(args.config.database.credentials.user).toBe("admin");
    });

    test("parses tool calls with special characters in arguments", () => {
      const content =
        '<|tool_call|>{"name":"bash_execute","arguments":{"command":"echo \'hello \\"world\\"\' | grep -E \'\\\\d+\'"}}<|/tool_call|>';
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.format).toBe("qwen-hermes");

      const args = JSON.parse(result?.toolCalls[0]?.function.arguments || "{}");
      expect(args.command).toContain("hello");
      expect(args.command).toContain("grep");
    });
  });

  describe("format confusion prevention", () => {
    test("does not confuse kimi-k2 with deepseek format", () => {
      // kimi has <|tool_call_begin|> while deepseek has specialized characters
      const kimiContent =
        '<|tool_calls_section_begin|><|tool_call_begin|>{"name":"test"}<|tool_call_end|><|tool_calls_section_end|>';
      const result = parseToolCalls(kimiContent);

      expect(result?.format).toBe("kimi-k2");
      expect(result?.format).not.toBe("deepseek");
    });

    test("does not confuse granite-3 with qwen-hermes", () => {
      // granite-3 has no closing tag, qwen-hermes has <|/tool_call|>
      const graniteContent = '<|tool_call|>{"name":"test"}';
      const graniteResult = parseToolCalls(graniteContent);

      expect(graniteResult?.format).toBe("granite-3");

      const qwenContent = '<|tool_call|>{"name":"test"}<|/tool_call|>';
      const qwenResult = parseToolCalls(qwenContent);

      expect(qwenResult?.format).toBe("qwen-hermes");
    });

    test("does not confuse functionary v2 with functionary v3", () => {
      // v2 has <|from|> and <|recipient|> tags, v3 has <function=name>
      const v2Content =
        '<|from|>assistant<|recipient|>bash_execute<|content|>{"command":"ls"}<|from|>';
      const v2Result = parseToolCalls(v2Content);

      expect(v2Result?.format).toBe("functionary-v2");

      const v3Content = '<function=bash_execute>{"command":"ls"}</function>';
      const v3Result = parseToolCalls(v3Content);

      expect(v3Result?.format).toBe("functionary-v3");
    });
  });

  describe("edge cases that could cause loops", () => {
    test("handles empty tool call name gracefully", () => {
      const content = '<|tool_call|>{"name":"","arguments":{}}<|/tool_call|>';
      const result = parseToolCalls(content);

      // should return null or empty, not cause an error/loop
      expect(result).toBeNull();
    });

    test("handles tool call with only name, no arguments", () => {
      const content = '<|tool_call|>{"name":"bash_execute"}<|/tool_call|>';
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.toolCalls).toHaveLength(1);
      expect(result?.toolCalls[0]?.function.name).toBe("bash_execute");

      const args = JSON.parse(result?.toolCalls[0]?.function.arguments || "{}");
      expect(Object.keys(args)).toHaveLength(0);
    });

    test("handles malformed json in tool arguments", () => {
      const content =
        '<|tool_call|>{"name":"test","arguments":{broken json}}<|/tool_call|>';
      const result = parseToolCalls(content);

      // should fail to parse and return null
      expect(result).toBeNull();
    });

    test("handles unicode and special characters in tool names", () => {
      // tool names should be ascii, but parser shouldn't crash
      const content =
        '<|tool_call|>{"name":"test_工具","arguments":{}}<|/tool_call|>';
      const result = parseToolCalls(content);

      // parser should handle it without crashing
      expect(() => parseToolCalls(content)).not.toThrow();
    });

    test("handles extremely long tool arguments", () => {
      const longString = "a".repeat(100000);
      const content =
        '<|tool_call|>{"name":"write_file","arguments":{"content":"' +
        longString +
        '"}}<|/tool_call|>';

      // should not hang or crash
      const startTime = Date.now();
      const result = parseToolCalls(content);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(1000); // should parse in under 1 second
      expect(result).not.toBeNull();
    });

    test("handles circular references in parsed json safely", () => {
      // parser should not crash on deeply nested structures
      const deep = { a: { b: { c: { d: { e: { f: "value" } } } } } };
      const content =
        '<|tool_call|>{"name":"test","arguments":' +
        JSON.stringify(deep) +
        "}<|/tool_call|>";
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.toolCalls).toHaveLength(1);
    });
  });

  describe("text content preservation", () => {
    test("preserves text before and after tool calls", () => {
      const content =
        'Let me help you with that.<|tool_call|>{"name":"bash_execute","arguments":{"command":"ls"}}<|/tool_call|>That should show the files.';
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.textContent).toBe(
        "Let me help you with that.That should show the files.",
      );
      expect(result?.toolCalls).toHaveLength(1);
    });

    test("handles multiple tool calls with interleaved text", () => {
      const content =
        '<|tool_call|>{"name":"read","arguments":{}}<|/tool_call|>Now processing<|tool_call|>{"name":"write","arguments":{}}<|/tool_call|>Done';
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.toolCalls).toHaveLength(2);
      expect(result?.toolCalls[0]?.function.name).toBe("read");
      expect(result?.toolCalls[1]?.function.name).toBe("write");
    });

    test("strips all tool call markers from text", () => {
      const content =
        '[TOOL_CALLS] [{"name":"test1"}] some text [TOOL_CALLS] [{"name":"test2"}]';
      const result = parseToolCalls(content);

      // mistral format - should only parse first [TOOL_CALLS]
      expect(result).not.toBeNull();
      expect(result?.toolCalls).toHaveLength(1);
      expect(result?.toolCalls[0]?.function.name).toBe("test1");
    });
  });

  describe("real-world multi-step workflow simulation", () => {
    test("simulates read-process-write workflow", () => {
      // step 1: read file
      const readContent =
        '<|tool_call|>{"name":"read_file","arguments":{"path":"/src/main.ts"}}<|/tool_call|>';
      const readResult = parseToolCalls(readContent);

      expect(readResult).not.toBeNull();
      expect(readResult?.toolCalls).toHaveLength(1);
      expect(readResult?.toolCalls[0]?.function.name).toBe("read_file");

      const readArgs = JSON.parse(
        readResult?.toolCalls[0]?.function.arguments || "{}",
      );
      expect(readArgs.path).toBe("/src/main.ts");

      // step 2: process (no tool call, just text)
      const processContent = "I'll now process the file content...";
      const processResult = parseToolCalls(processContent);
      expect(processResult).toBeNull();

      // step 3: write result
      const writeContent =
        '<|tool_call|>{"name":"write_file","arguments":{"path":"/output/result.txt","content":"processed"}}<|/tool_call|>';
      const writeResult = parseToolCalls(writeContent);

      expect(writeResult).not.toBeNull();
      expect(writeResult?.toolCalls).toHaveLength(1);
      expect(writeResult?.toolCalls[0]?.function.name).toBe("write_file");

      const writeArgs = JSON.parse(
        writeResult?.toolCalls[0]?.function.arguments || "{}",
      );
      expect(writeArgs.path).toBe("/output/result.txt");
    });

    test("simulates research workflow with multiple searches", () => {
      // multiple sequential tool calls
      const content1 =
        '[TOOL_CALLS] [{"name":"web_search","arguments":{"query":"topic1"},"id":"search1"}]';
      const result1 = parseToolCalls(content1);

      expect(result1).not.toBeNull();
      expect(result1?.format).toBe("mistral");
      expect(result1?.toolCalls).toHaveLength(1);

      // second search based on first results
      const content2 =
        '[TOOL_CALLS] [{"name":"web_search","arguments":{"query":"topic2 details"},"id":"search2"}]';
      const result2 = parseToolCalls(content2);

      expect(result2).not.toBeNull();
      expect(result2?.toolCalls).toHaveLength(1);

      // final summary (no tool calls)
      const summaryContent = "Based on the research, here are the findings...";
      const summaryResult = parseToolCalls(summaryContent);
      expect(summaryResult).toBeNull();
    });

    test("simulates browser automation workflow", () => {
      // navigate
      const navContent =
        '<function=browser_navigate>{"url":"https://example.com"}</function>';
      const navResult = parseToolCalls(navContent);

      expect(navResult).not.toBeNull();
      expect(navResult?.format).toBe("functionary-v3");
      expect(navResult?.toolCalls).toHaveLength(1);

      // act
      const actContent =
        '<function=browser_act>{"action":"click","ref":"button.submit"}</function>';
      const actResult = parseToolCalls(actContent);

      expect(actResult).not.toBeNull();
      expect(actResult?.toolCalls[0]?.function.name).toBe("browser_act");

      // extract
      const extractContent = "<function=browser_snapshot>{}</function>";
      const extractResult = parseToolCalls(extractContent);

      expect(extractResult).not.toBeNull();
      expect(extractResult?.toolCalls[0]?.function.name).toBe(
        "browser_snapshot",
      );
    });
  });

  describe("error recovery scenarios", () => {
    test("recovers from interrupted tool call stream", () => {
      // simulates a partial/malformed tool call that might crash the parser
      const partialContent = '<|tool_call|>{"name":"test","arguments":{"fil';
      const result = parseToolCalls(partialContent);

      // should return null gracefully, not crash
      expect(result).toBeNull();
    });

    test("handles tool call with null arguments", () => {
      const content =
        '<|tool_call|>{"name":"test","arguments":null}<|/tool_call|>';
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.toolCalls).toHaveLength(1);

      const args = JSON.parse(result?.toolCalls[0]?.function.arguments || "{}");
      expect(Object.keys(args)).toHaveLength(0);
    });

    test("handles tool call with array arguments", () => {
      const content =
        '<|tool_call|>{"name":"test","arguments":["item1","item2"]}<|/tool_call|>';
      const result = parseToolCalls(content);

      // tools expect object arguments, but parser should handle arrays
      expect(result).not.toBeNull();
      expect(result?.toolCalls).toHaveLength(1);
    });

    test("handles duplicate tool calls", () => {
      // same tool called multiple times - should parse all of them
      const content =
        '<|tool_call|>{"name":"bash_execute","arguments":{"command":"ls"}}<|/tool_call|><|tool_call|>{"name":"bash_execute","arguments":{"command":"pwd"}}<|/tool_call|>';
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.toolCalls).toHaveLength(2);
      expect(result?.toolCalls[0]?.function.name).toBe("bash_execute");
      expect(result?.toolCalls[1]?.function.name).toBe("bash_execute");
    });

    test("handles tool call with unexpected fields", () => {
      // extra fields should be ignored
      const content =
        '<|tool_call|>{"name":"test","arguments":{},"id":"call123","type":"function","extra":"field"}<|/tool_call|>';
      const result = parseToolCalls(content);

      expect(result).not.toBeNull();
      expect(result?.toolCalls).toHaveLength(1);
      expect(result?.toolCalls[0]?.id).toBe("call123");
    });
  });

  describe("concurrent safety", () => {
    test("parser is stateless and can be called concurrently", async () => {
      // parse multiple different formats concurrently
      const inputs = [
        '<|tool_call|>{"name":"test1"}<|/tool_call|>',
        "<function=test2>{}</function>",
        '[TOOL_CALLS] [{"name":"test3"}]',
        '<|tool_calls_section_begin|><|tool_call_begin|>{"name":"test4"}<|tool_call_end|><|tool_calls_section_end|>',
      ];

      const results = await Promise.all(
        inputs.map((input) => Promise.resolve(parseToolCalls(input))),
      );

      // all should parse correctly without interference
      expect(results[0]).not.toBeNull();
      expect(results[0]?.toolCalls[0]?.function.name).toBe("test1");

      expect(results[1]).not.toBeNull();
      expect(results[1]?.toolCalls[0]?.function.name).toBe("test2");

      expect(results[2]).not.toBeNull();
      expect(results[2]?.toolCalls[0]?.function.name).toBe("test3");

      expect(results[3]).not.toBeNull();
      expect(results[3]?.toolCalls[0]?.function.name).toBe("test4");
    });

    test("parser does not modify input string", () => {
      const original = '<|tool_call|>{"name":"test"}<|/tool_call|>';
      const originalCopy = original.slice();

      parseToolCalls(original);

      // input should be unchanged
      expect(original).toBe(originalCopy);
    });
  });

  describe("detection accuracy", () => {
    test("does not false positive on similar text", () => {
      const falsePositives = [
        "This is just text with function= in it",
        "Some code with [TOOL_CALLS] string in a comment",
        "Documentation about <|tool_call|> syntax",
        "Explanation of <|tool_calls_section_begin|> format",
        "Let me <function=describe> how this works",
      ];

      for (const text of falsePositives) {
        const result = parseToolCalls(text);
        // should not detect these as tool calls
        expect(result).toBeNull();
      }
    });

    test("correctly identifies format even with variations", () => {
      // kimi-k2 should still be detected even with whitespace variations
      const variations = [
        '<|tool_calls_section_begin|>  <|tool_call_begin|>{"name":"test"}<|tool_call_end|><|tool_calls_section_end|>',
        '<|tool_calls_section_begin|><|tool_call_begin|>  {"name":"test"}<|tool_call_end|><|tool_calls_section_end|>',
        '<|tool_calls_section_begin|><|tool_call_begin|>{"name":"test"}  <|tool_call_end|><|tool_calls_section_end|>',
      ];

      for (const content of variations) {
        const result = parseToolCalls(content);
        expect(result).not.toBeNull();
        expect(result?.format).toBe("kimi-k2");
        expect(result?.toolCalls).toHaveLength(1);
        expect(result?.toolCalls[0]?.function.name).toBe("test");
      }
    });
  });
});
