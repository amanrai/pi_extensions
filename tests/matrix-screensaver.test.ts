import assert from "node:assert/strict";
import { test } from "node:test";
import { IdleMatrix, MATRIX_IDLE_MS, MATRIX_FRAME_MS } from "../extensions/matrix-screensaver/idle.ts";
import { MatrixRain } from "../extensions/matrix-screensaver/rain.ts";
import { fakeMatrixTui } from "./matrix-fixture.ts";

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
function random(seed = 42) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
}

test("rain fills exact dimensions using only ASCII cells and standard SGR colors", () => {
  const rain = new MatrixRain(() => 24, random());
  const frame = rain.render(80);
  assert.equal(frame.length, 24);
  assert.ok(frame.every((line) => plain(line).length === 80));
  assert.ok(frame.every((line) => /^[\x20-\x7e]*$/.test(plain(line))));
  assert.ok(frame.some((line) => /[A-Z0-9]/.test(plain(line))));
  assert.ok(frame.every((line) => line.startsWith("\x1b[40m") && line.endsWith("\x1b[0m")));
  assert.doesNotMatch(frame.join(""), /\x1b\[(?:\d+)?[HJ]/, "The component does not clear/move the terminal itself");
});

test("rain animation changes frames while rendering itself is stable", () => {
  const rain = new MatrixRain(() => 20, random());
  const before = rain.render(40);
  assert.deepEqual(rain.render(40), before);
  for (let i = 0; i < 10; i++) rain.tick();
  assert.notDeepEqual(rain.render(40), before);
  for (let i = 0; i < 1000; i++) rain.tick();
  assert.ok(rain.render(40).every((line) => plain(line).length === 40));
});

test("rain handles narrow terminals, resizing, and zero dimensions", () => {
  let rows = 12;
  const rain = new MatrixRain(() => rows, random());
  for (const width of [1, 2, 120, 8]) {
    rows = width < 3 ? 1 : 35;
    const frame = rain.render(width);
    assert.equal(frame.length, rows);
    assert.ok(frame.every((line) => plain(line).length === width));
  }
  rows = 0;
  assert.deepEqual(rain.render(80), []);
  rows = 1;
  assert.equal(plain(rain.render(0)[0]), "");
  assert.equal(plain(rain.render(-5)[0]), "");
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`enabled saver waits a full minute and owns a viewport overlay (${mode})`, (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
    const fake = fakeMatrixTui(mode);
    const controller = new IdleMatrix(fake.tui, () => true);
    t.after(() => controller.stop());
    t.mock.timers.tick(MATRIX_IDLE_MS - 1);
    assert.equal(controller.active, false);
    t.mock.timers.tick(1);
    assert.equal(controller.active, true);
    assert.deepEqual(fake.entries[0].options, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
    const renders = fake.counts().renders;
    t.mock.timers.tick(MATRIX_FRAME_MS * 3);
    assert.ok(fake.counts().renders > renders);
    assert.equal(fake.entries[0].component.render(80).length, 24);
  });
}

test("user/model/tool activity restarts the quiet period and cancels active animation", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const fake = fakeMatrixTui();
  const controller = new IdleMatrix(fake.tui, () => true);
  t.after(() => controller.stop());
  t.mock.timers.tick(50_000);
  controller.activity();
  t.mock.timers.tick(59_999);
  assert.equal(controller.active, false);
  t.mock.timers.tick(1);
  assert.equal(controller.active, true);
  controller.activity();
  const renders = fake.counts().renders;
  assert.equal(controller.active, false);
  t.mock.timers.tick(59_999);
  assert.equal(fake.counts().renders, renders);
  t.mock.timers.tick(1);
  assert.equal(fake.counts().shows, 2);
});

test("active work, drafts, and pending messages prevent display until eligible", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const fake = fakeMatrixTui();
  let eligible = false;
  const controller = new IdleMatrix(fake.tui, () => eligible);
  t.after(() => controller.stop());
  t.mock.timers.tick(MATRIX_IDLE_MS);
  assert.equal(controller.active, false);
  t.mock.timers.tick(1000);
  assert.equal(controller.active, false);
  eligible = true;
  t.mock.timers.tick(1000);
  assert.equal(controller.active, true);
  eligible = false;
  t.mock.timers.tick(MATRIX_FRAME_MS);
  assert.equal(controller.active, false, "Work resuming dismisses it even without a new keyboard event");
});

test("an existing overlay is never covered; a later dialog is never popped", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const fake = fakeMatrixTui();
  const component = { render: () => ["other dialog"], invalidate() {} };
  const other = fake.tui.showOverlay(component);
  const controller = new IdleMatrix(fake.tui, () => true);
  t.after(() => controller.stop());
  t.mock.timers.tick(MATRIX_IDLE_MS);
  assert.equal(fake.counts().shows, 1);
  assert.equal(controller.active, false);
  other.hide();
  t.mock.timers.tick(1000);
  assert.equal(controller.active, true);
  const later = fake.tui.showOverlay(component);
  t.mock.timers.tick(MATRIX_FRAME_MS);
  assert.equal(controller.active, false);
  assert.equal(later.isFocused(), true);
  assert.equal(fake.entries.at(-1)?.closed, false);
  later.hide();
});

test("only the wake-up input belonging to the saver is consumed", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const fake = fakeMatrixTui();
  const controller = new IdleMatrix(fake.tui, () => true);
  t.after(() => controller.stop());
  assert.equal(controller.input(), false);
  t.mock.timers.tick(MATRIX_IDLE_MS);
  assert.equal(controller.input(), true);
  assert.equal(controller.active, false);
  assert.equal(controller.input(), false, "Subsequent input is delivered normally");
  t.mock.timers.tick(MATRIX_IDLE_MS);
  const other = fake.tui.showOverlay({ render: () => [], invalidate() {} });
  assert.equal(controller.input(), false, "An input intended for another dialog passes through");
  assert.equal(other.isFocused(), true);
  other.hide();
});

test("disable/dispose cancels all timers and removes only the owned overlay", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const fake = fakeMatrixTui();
  const controller = new IdleMatrix(fake.tui, () => true);
  t.mock.timers.tick(MATRIX_IDLE_MS);
  const other = fake.tui.showOverlay({ render: () => [], invalidate() {} });
  controller.stop();
  controller.stop();
  controller.activity();
  const counts = fake.counts();
  t.mock.timers.tick(MATRIX_IDLE_MS * 60);
  assert.deepEqual(fake.counts(), counts);
  assert.equal(other.isFocused(), true);
  other.hide();
});

test("empty terminal dimensions defer display safely", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const fake = fakeMatrixTui();
  fake.terminal.rows = 0;
  const controller = new IdleMatrix(fake.tui, () => true);
  t.after(() => controller.stop());
  t.mock.timers.tick(MATRIX_IDLE_MS);
  assert.equal(controller.active, false);
  fake.terminal.rows = 1;
  t.mock.timers.tick(1000);
  assert.equal(controller.active, true);
});

test("rendering failures stop the saver without retry loops", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const fake = fakeMatrixTui();
  fake.tui.showOverlay = () => { throw new Error("renderer unavailable"); };
  const errors: unknown[] = [];
  const controller = new IdleMatrix(fake.tui, () => true, (error) => errors.push(error));
  t.mock.timers.tick(MATRIX_IDLE_MS);
  assert.equal(controller.active, false);
  assert.equal(errors.length, 1);
  t.mock.timers.tick(MATRIX_IDLE_MS * 2);
  assert.equal(errors.length, 1);
  controller.stop();
});
