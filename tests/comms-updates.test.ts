import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUpdateBody } from "../extensions/comms/updates.ts";

test("non-coding updates retain plain bodies", () => {
  assert.equal(formatUpdateBody("  A general discussion.  "), "A general discussion.");
});

test("coding notes have opening and closing markers", () => {
  assert.equal(formatUpdateBody("  Implemented the change.  ", true), "<coding>Implemented the change.</coding>");
});

test("existing tags are preserved once, even without an explicit coding flag", () => {
  const body = "<coding>Implemented the change.</coding>";
  assert.equal(formatUpdateBody(body), body);
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
  assert.equal(formatUpdateBody(`<coding>${long}</coding>`), body);
  assert.equal(formatUpdateBody(long).length, 1200);
});

test("empty content stays empty so existing update validation rejects it", () => {
  for (const body of ["", "  ", "<coding></coding>", "<coding>  </coding>"]) {
    assert.equal(formatUpdateBody(body, true), "");
  }
});

test("multiline note content is preserved inside its wrapper", () => {
  const body = "Changed API behavior.\n\nTests passed; deployment remains pending.";
  assert.equal(formatUpdateBody(body, true), `<coding>${body}</coding>`);
});
