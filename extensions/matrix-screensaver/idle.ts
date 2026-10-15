import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { MatrixRain } from "./rain.ts";

export const MATRIX_IDLE_MS = 60_000;
export const MATRIX_FRAME_MS = 80;

/** Own only this overlay. Never pop another extension's dialog off the UI stack. */
export class IdleMatrix {
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private frameTimer: ReturnType<typeof setInterval> | undefined;
  private handle: OverlayHandle | undefined;
  private rain: MatrixRain | undefined;
  private stopped = false;
  private lastActivity = Date.now();

  private tui: TUI;
  private canRun: () => boolean;
  private onError: (error: unknown) => void;
  constructor(tui: TUI, canRun: () => boolean, onError: (error: unknown) => void = () => {}) {
    this.tui = tui;
    this.canRun = canRun;
    this.onError = onError;
    this.schedule(MATRIX_IDLE_MS);
  }

  get active() { return Boolean(this.handle); }

  activity() {
    if (this.stopped) return;
    this.lastActivity = Date.now();
    this.hide();
    this.schedule(MATRIX_IDLE_MS);
  }

  /** The wake-up input is swallowed only while our own overlay owns focus. */
  input() {
    const consume = Boolean(this.handle?.isFocused());
    this.activity();
    return consume;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.hide();
  }

  private hide() {
    clearInterval(this.frameTimer);
    this.frameTimer = undefined;
    this.rain = undefined;
    const handle = this.handle;
    this.handle = undefined;
    handle?.hide();
  }

  private schedule(delay: number) {
    clearTimeout(this.idleTimer);
    if (this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.stopped) return;
      try {
        const remaining = MATRIX_IDLE_MS - (Date.now() - this.lastActivity);
        if (remaining > 0) { this.schedule(remaining); return; }
        if (!this.canRun() || this.tui.hasOverlay() || this.tui.terminal.columns < 1 || this.tui.terminal.rows < 1) {
          this.schedule(1000);
          return;
        }
        this.rain = new MatrixRain(() => this.tui.terminal.rows);
        this.handle = this.tui.showOverlay(this.rain, {
          width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0,
        });
        this.frameTimer = setInterval(() => {
          if (this.stopped) return;
          try {
            if (!this.canRun() || !this.handle?.isFocused()) { this.activity(); return; }
            this.rain?.tick();
            this.tui.requestRender();
          } catch (error) { this.fail(error); }
        }, MATRIX_FRAME_MS);
        this.frameTimer.unref?.();
      } catch (error) { this.fail(error); }
    }, delay);
    this.idleTimer.unref?.();
  }

  private fail(error: unknown) {
    this.stop();
    this.onError(error);
  }
}
