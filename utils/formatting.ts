// strip markdown formatting from text, producing clean plain text
// designed for platforms that dont render markdown (imessage, sms, etc)
export function stripMarkdown(text: string): string {
  let result = text;

  // remove code blocks but keep the content
  // handles fenced blocks with optional language specifier
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, "$1");

  // remove inline code backticks but keep content
  result = result.replace(/`([^`]+)`/g, "$1");

  // remove images, keep alt text
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

  // convert links to "text (url)" format so the url isnt lost
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // remove heading markers
  result = result.replace(/^#{1,6}\s+/gm, "");

  // remove bold/italic markers (order matters: bold+italic first, then bold, then italic)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  result = result.replace(/___(.+?)___/g, "$1");
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  result = result.replace(/~~(.+?)~~/g, "$1");

  // remove horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");

  // remove blockquote markers but keep content
  result = result.replace(/^>\s?/gm, "");

  // remove unordered list markers, preserve indentation structure
  result = result.replace(/^(\s*)[-*+]\s+/gm, "$1");

  // clean up ordered list markers (keep the number for readability)
  result = result.replace(/^(\s*)\d+\.\s+/gm, "$1");

  // collapse excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}
