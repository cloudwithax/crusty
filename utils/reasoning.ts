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
  result = result.replace(
    /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g,
    "",
  );
  result = result.replace(
    /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g,
    "",
  );

  // kimi k2: strip any orphan pipe-delimited special tokens
  result = result.replace(/<\|[a-z_]+\|>/g, "");

  // kimi k2: extract text from content-part wrappers that leak into response
  // handles both array and bare object forms with single or double quotes
  // e.g. {'type': 'text', 'text': '...'} or [{"type": "text", "text": "..."}]
  result = extractFromContentParts(result);

  return result.trim();
}

// extract actual text from content-part wrapper objects that some models emit as text
// kimi k2 via nvidia nim commonly wraps responses like:
//   {'type': 'text', 'text': "actual message here"}
//   [{'type': 'text', 'text': "actual message here"}]
// also handles double-quoted json variants
function extractFromContentParts(text: string): string {
  // match single-quoted python-style: {'type': 'text', 'text': "..."} or {'type': 'text', 'text': '...'}
  const singleQuotePattern =
    /^\s*\[?\s*\{\s*'type'\s*:\s*'text'\s*,\s*'text'\s*:\s*(?:"([\s\S]*?)"|'([\s\S]*?)')\s*\}\s*\]?\s*$/;
  // match double-quoted json-style: {"type": "text", "text": "..."}
  const doubleQuotePattern =
    /^\s*\[?\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"([\s\S]*?)"\s*\}\s*\]?\s*$/;

  let match = text.match(singleQuotePattern);
  if (match) {
    return match[1] ?? match[2] ?? "";
  }

  match = text.match(doubleQuotePattern);
  if (match) {
    // unescape json string escapes
    return match[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }

  return text;
}
