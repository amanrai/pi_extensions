const CODING_OPEN = "<coding>";
const CODING_CLOSE = "</coding>";
const BODY_LIMIT = 1200;

/** Apply coding-note markers once, reserving room for both before truncation. */
export function formatUpdateBody(body: string, coding = false): string {
  let text = body.trim();
  while (text.startsWith(CODING_OPEN) && text.endsWith(CODING_CLOSE)) {
    coding = true;
    text = text.slice(CODING_OPEN.length, -CODING_CLOSE.length).trim();
  }
  if (!text) return "";
  if (!coding) return text.slice(0, BODY_LIMIT);
  const contentLimit = BODY_LIMIT - CODING_OPEN.length - CODING_CLOSE.length;
  return `${CODING_OPEN}${text.slice(0, contentLimit).trimEnd()}${CODING_CLOSE}`;
}
