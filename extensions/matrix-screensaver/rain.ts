import type { Component } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const BLACK = "\x1b[40m";
const COLORS = ["\x1b[22;2;32m", "\x1b[22;32m", "\x1b[22;1;32m", "\x1b[22;1;37m"];
const GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@#$%&*+=<>:;";
type Stream = { head: number; length: number; speed: number; glyphs: string[] };

/** ASCII cells and standard ANSI colors work without a font, binary, or OS dependency. */
export class MatrixRain implements Component {
  private width = 0;
  private height = 0;
  private streams: (Stream | undefined)[] = [];

  private rows: () => number;
  private random: () => number;
  constructor(rows: () => number, random: () => number = Math.random) {
    this.rows = rows;
    this.random = random;
  }

  private glyph() { return GLYPHS[Math.floor(this.random() * GLYPHS.length)] ?? "0"; }

  private stream(height: number, initial: boolean): Stream {
    return {
      head: initial ? this.random() * height : -1 - this.random() * height * 0.8,
      length: Math.max(3, Math.floor(height * (0.2 + this.random() * 0.55))),
      speed: 0.3 + this.random() * 0.7,
      glyphs: Array.from({ length: height }, () => this.glyph()),
    };
  }

  tick() {
    for (let column = 0; column < this.streams.length; column++) {
      let stream = this.streams[column];
      if (!stream) continue;
      stream.head += stream.speed;
      if (stream.head - stream.length > this.height) stream = this.streams[column] = this.stream(this.height, false);
      if (this.height && this.random() < 0.25) stream.glyphs[Math.floor(this.random() * this.height)] = this.glyph();
    }
  }

  render(width: number): string[] {
    width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const rows = this.rows();
    const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.streams = Array.from({ length: width }, (_, column) =>
        column % 2 === 0 ? this.stream(height, true) : undefined);
    }
    const lines: string[] = [];
    for (let row = 0; row < height; row++) {
      let line = BLACK;
      let lastColor = -1;
      for (const stream of this.streams) {
        const distance = stream ? Math.floor(stream.head) - row : -1;
        if (!stream || distance < 0 || distance >= stream.length) { line += " "; continue; }
        const color = distance === 0 ? 3 : distance < 3 ? 2 : distance < stream.length * 0.55 ? 1 : 0;
        if (color !== lastColor) { line += COLORS[color]; lastColor = color; }
        line += stream.glyphs[row] ?? "0";
      }
      lines.push(line + RESET);
    }
    return lines;
  }

  invalidate() {}
}
