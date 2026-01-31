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
