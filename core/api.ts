import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

export interface NativeChatOptions {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  tool_choice?: any;
}

export interface NativeChatResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string;
      tool_calls?: ChatCompletionMessageToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export async function nativeChatCompletion(
  options: NativeChatOptions,
  signal?: AbortSignal
): Promise<NativeChatResponse> {
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  if (url.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/clxudiaea/crusty";
    headers["X-Title"] = "Crusty";
  }
  
  const payload = {
    ...options,
    stream: true,
    stream_options: { include_usage: true },
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    let errorBody = await response.text().catch(() => "Unknown error");
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.error) {
        const err = new Error(parsed.error.message || "API Error");
        (err as any).status = response.status;
        (err as any).error = parsed.error;
        throw err;
      }
    } catch (e) {
      if ((e as any).status) throw e;
    }
    
    const err = new Error(`HTTP ${response.status}: ${errorBody}`);
    (err as any).status = response.status;
    (err as any).error = errorBody;
    throw err;
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let content = "";
  const toolCallsMap = new Map<number, any>();
  let finalUsage: any = null;
  let buffer = "";

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return;

    try {
      const parsed = JSON.parse(data);

      if (parsed.usage) {
        finalUsage = parsed.usage;
      }

      const choice = parsed.choices?.[0];
      if (!choice) return;

      const delta = choice.delta;
      if (!delta) return;

      if (delta.content) {
        content += delta.content;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          if (!toolCallsMap.has(index)) {
            toolCallsMap.set(index, {
              id: tc.id,
              type: tc.type || "function",
              function: {
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || ""
              }
            });
          } else {
            const existing = toolCallsMap.get(index);
            if (tc.function?.arguments) {
              existing.function.arguments += tc.function.arguments;
            }
          }
        }
      }
    } catch (e) {
      // ignore JSON parse errors for incomplete chunks
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      processLine(line);
    }
  }

  if (buffer.trim()) {
    processLine(buffer);
  }

  const tool_calls = Array.from(toolCallsMap.values()) as ChatCompletionMessageToolCall[];

  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: content,
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
        }
      }
    ],
    usage: finalUsage
  };
}
