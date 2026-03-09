// strip reasoning tags from model responses (supports various reasoning formats)
// common patterns: <think>, <thought>, <thinking>, <reasoning>, <reflection>, etc
export function stripReasoningTags(text: string): string {
  const reasoningPatterns = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thought>[\s\S]*?<\/thought>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<reason>[\s\S]*?<\/reason>/gi,
    /<reflection>[\s\S]*?<\/reflection>/gi,
    /<internal>[\s\S]*?<\/internal>/gi,
    /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
    /<chain_of_thought>[\s\S]*?<\/chain_of_thought>/gi,
    /<cot>[\s\S]*?<\/cot>/gi,
  ];

  let result = text;
  for (const pattern of reasoningPatterns) {
    result = result.replace(pattern, "");
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

// strip provider-specific special tokens that sometimes leak into response content
// e.g. kimi k2 pipe-delimited tokens: <|tool_call_end|>, <|tool_calls_section_end|>
export function stripProviderArtifacts(text: string): string {
  let result = text;

  // kimi k2: strip complete tool call sections
  result = result.replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, "");
  result = result.replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g, "");

  // kimi k2: strip any orphan pipe-delimited special tokens
  result = result.replace(/<\|[a-z_]+\|>/g, "");

  // kimi k2: strip python-style content block arrays that leak into text
  // e.g. [{'type': 'text', 'text': ''}] or [{"type": "text", "text": ""}]
  result = result.replace(/^\s*\[[\s\S]*?'type'\s*:\s*'(?:text|image_url)'[\s\S]*?\]\s*/g, "");
  result = result.replace(/^\s*\[[\s\S]*?"type"\s*:\s*"(?:text|image_url)"[\s\S]*?\]\s*/g, "");

  return result.trim();
}
