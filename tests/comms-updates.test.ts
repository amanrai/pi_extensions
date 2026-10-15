import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUpdateBody, extractJson } from "../extensions/comms/updates.ts";

test("inference JSON parsing preserves code fences inside recap bodies", () => {
  const value = { newWork: true, parts: ["Command and result:\n```bash\nprintf '{example}'\n```\nValidated."] };
  const json = JSON.stringify(value);
  assert.deepEqual(extractJson(json), value);
  assert.deepEqual(extractJson(`\`\`\`json\n${json}\n\`\`\``), value);
  assert.throws(() => extractJson("not JSON"), /no JSON object/);
});

test("non-coding updates retain plain bodies", () => {
  assert.equal(formatUpdateBody("  A general discussion.  "), "A general discussion.");
});

test("coding notes have opening and closing markers", () => {
  assert.equal(formatUpdateBody("  Implemented the change.  ", true), "<coding>Implemented the change.</coding>");
});

test("existing tags do not override the evidence-based coding flag", () => {
  const body = "<coding>Implemented the change.</coding>";
  assert.equal(formatUpdateBody(body), "Implemented the change.");
  assert.equal(formatUpdateBody(body, true), body);
  assert.equal(formatUpdateBody(formatUpdateBody(body, true), true), body);
});

test("repeated outer wrappers collapse to one", () => {
  assert.equal(formatUpdateBody("<coding> <coding>Reviewed it.</coding> </coding>", true), "<coding>Reviewed it.</coding>");
});

test("truncation always leaves room for the closing marker", () => {
  const long = "a".repeat(2000);
  const body = formatUpdateBody(long, true);
  assert.equal(body.length, 1200);
  assert.ok(body.startsWith("<coding>"));
  assert.ok(body.endsWith("</coding>"));
  assert.equal(formatUpdateBody(`<coding>${long}</coding>`, true), body);
  assert.equal(formatUpdateBody(`<coding>${long}</coding>`, false), long.slice(0, 1200));
  assert.equal(formatUpdateBody(long).length, 1200);
});

test("empty content stays empty so existing update validation rejects it", () => {
  for (const body of ["", "  ", "<coding></coding>", "<coding>  </coding>"]) {
    assert.equal(formatUpdateBody(body, true), "");
  }
});

test("recap bodies bypass the ordinary limit without gaining coding tags", () => {
  const body = "Detailed history.\n".repeat(2000);
  assert.equal(formatUpdateBody(`<coding>${body}</coding>`, false, Infinity), body.trim());
});

test("multiline note content is preserved inside its wrapper", () => {
  const body = "Changed API behavior.\n\nTests passed; deployment remains pending.";
  assert.equal(formatUpdateBody(body, true), `<coding>${body}</coding>`);
});
