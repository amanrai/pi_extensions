const CODING_OPEN = "<coding>";
const CODING_CLOSE = "</coding>";
const BODY_LIMIT = 1200;

/** Markdown fences INSIDE JSON string bodies must not be mistaken for response fences. */
export function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in inference response");
  return JSON.parse(text.slice(start, end + 1));
}

/** Apply coding-note markers once, reserving room for both before truncation. */
export function formatUpdateBody(body: string, coding = false, limit = BODY_LIMIT): string {
  let text = body.trim();
  while (text.startsWith(CODING_OPEN) && text.endsWith(CODING_CLOSE)) {
    text = text.slice(CODING_OPEN.length, -CODING_CLOSE.length).trim();
  }
  if (!text) return "";
  if (!coding) return text.slice(0, limit);
  const contentLimit = limit - CODING_OPEN.length - CODING_CLOSE.length;
  return `${CODING_OPEN}${text.slice(0, contentLimit).trimEnd()}${CODING_CLOSE}`;
}
