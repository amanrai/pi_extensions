import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";

export function fakeMatrixTui(mode: "regular" | "fullscreen" = "regular") {
  const entries: { component: Component; focused: boolean; closed: boolean; options?: OverlayOptions }[] = [];
  let shows = 0, hides = 0, renders = 0;
  const terminal = { rows: 24, columns: 80 };
  const tui = {
    mode, terminal,
    hasOverlay: () => entries.some((entry) => !entry.closed),
    showOverlay(component: Component, options?: OverlayOptions) {
      shows++;
      entries.forEach((entry) => { entry.focused = false; });
      const entry = { component, options, focused: true, closed: false };
      entries.push(entry);
      return {
        isFocused: () => entry.focused && !entry.closed,
        hide() {
          if (entry.closed) return;
          hides++;
          entry.closed = true;
          entry.focused = false;
          const previous = entries.filter((candidate) => !candidate.closed).at(-1);
          if (previous) previous.focused = true;
        },
      };
    },
    requestRender() { renders++; },
  };
  return { tui: tui as unknown as TUI, entries, terminal,
    counts: () => ({ shows, hides, renders }) };
}
