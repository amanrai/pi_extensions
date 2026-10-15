import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { IdleMatrix, MATRIX_IDLE_MS, MATRIX_FRAME_MS } from "../extensions/matrix-screensaver/idle.ts";

const host = process.env.PI_TEST_AGENT_ROOT;
for (const renderer of ["TuiMainScreen", "TuiAltScreen"]) {
  test(`real ${renderer} paints/resizes Matrix and preserves editor/dialog input`, { skip: !host }, async (t) => {
    const api = await import(pathToFileURL(join(host!, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
    let input: (data: string) => void = () => {};
    let resize: () => void = () => {};
    const writes: string[] = [];
    const terminal = {
      rows: 12, columns: 50, kittyProtocolActive: false,
      start(onInput: (data: string) => void, onResize: () => void) { input = onInput; resize = onResize; },
      stop() {}, write(data: string) { writes.push(data); },
      hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
      setTitle() {}, setProgress() {}, setProgramStatus() {}, drainInput: async () => {},
    };
    const tui = new api[renderer](terminal);
    const received: string[] = [];
    const dialogKeys: string[] = [];
    const editor = { render: (width: number) => ["Saved conversation".slice(0, width), "Prompt >".slice(0, width)],
      invalidate() {}, handleInput: (data: string) => received.push(data) };
    tui.addChild(editor);
    tui.setFocus(editor);
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
    tui.start();
    tui.renderNow(true);
    const controller = new IdleMatrix(tui, () => true);
    const unsubscribe = tui.addInputListener(() => controller.input() ? { consume: true } : undefined);
    t.after(() => { controller.stop(); unsubscribe(); tui.stop(); });
    t.mock.timers.tick(MATRIX_IDLE_MS);
    assert.equal(controller.active, true);
    tui.renderNow(true);
    assert.ok(writes.some((write) => write.includes("\x1b[40m")), "Matrix paints through the real renderer");
    input("x");
    assert.equal(controller.active, false);
    assert.deepEqual(received, []);
    input("y");
    assert.deepEqual(received, ["y"], "Pi restores the original focused editor after waking");
    t.mock.timers.tick(MATRIX_IDLE_MS);
    const dialog = tui.showOverlay({ render: (width: number) => ["Unrelated dialog".slice(0, width)],
      invalidate() {}, handleInput: (data: string) => dialogKeys.push(data) }, { width: "100%" });
    t.mock.timers.tick(MATRIX_FRAME_MS);
    assert.equal(controller.active, false);
    assert.equal(dialog.isFocused(), true);
    input("z");
    assert.deepEqual(dialogKeys, ["z"], "Closing the saver never removes somebody else's prompt");
    dialog.hide();
    controller.activity();
    t.mock.timers.tick(MATRIX_IDLE_MS);
    terminal.rows = 3;
    terminal.columns = 2;
    resize();
    assert.doesNotThrow(() => tui.renderNow(true));
    terminal.rows = 30;
    terminal.columns = 100;
    resize();
    assert.doesNotThrow(() => tui.renderNow(true));
    assert.equal(controller.active, true);
    input("\r");
    assert.equal(controller.active, false);
    assert.deepEqual(received, ["y"], "Wake-up Enter cannot submit a message");
  });
}
