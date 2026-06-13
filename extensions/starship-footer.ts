/**
 * Starship + pi footer extension
 *
 * Left side  — delegates entirely to `starship prompt` so colours, icons, and
 *              segments match your shell exactly. Appends PR #N (clickable) if
 *              there is an open PR for the current branch.
 *
 * Right side — anthropic → Claude Haiku 4.5 ◆ medium  ↑12k ↓4k $0.042
 *
 * Prerequisites: starship and gh must be in PATH.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readScryerState } from "./scryer/state.ts";
import { readLastTouchlogEntry, type TouchLogEntry } from "./scryer/touchlog.ts";
import type { RecorderState } from "./scryer/types.ts";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Colour helpers (right side only) ────────────────────────────────────────

const bold    = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim     = (s: string) => `\x1b[2m${s}\x1b[22m`;
const magenta = (s: string) => `\x1b[95m${s}\x1b[39m`;
const cyan    = (s: string) => `\x1b[96m${s}\x1b[39m`;
const green   = (s: string) => `\x1b[92m${s}\x1b[39m`;
const yellow  = (s: string) => `\x1b[93m${s}\x1b[39m`;

function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function formatPwd(cwd: string): string {
  const home = homedir();
  return cwd === home ? "~" : cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
}

// ── Data fetching ────────────────────────────────────────────────────────────

interface PRInfo { number: number; url: string; }

function ago(ts?: number): string | null {
  if (!ts) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function freshness(state: RecorderState): string | null {
  if (state.activeTaskTitle && state.lastUpdateAt) return `updated ${ago(state.lastUpdateAt)}`;
  if (state.lastSaveAt) return `saved ${ago(state.lastSaveAt)}`;
  if (state.lastSaveAttemptAt) return `attempted ${ago(state.lastSaveAttemptAt)}`;
  return null;
}

function formatScryerContext(state?: RecorderState): string | null {
  if (!state) return null;
  const suffix = freshness(state);
  const tail = suffix ? dim(` · ${suffix}`) : "";
  if (state.activeProjectName && state.activeTaskTitle) {
    return `${green("●")} ${green(`◇ ${state.activeProjectName} / ${state.activeTaskTitle}`)}${tail}`;
  }
  if (state.activeProjectName && state.noTicketForSession) {
    return `${yellow("○")} ${yellow(`◇ ${state.activeProjectName} / no ticket`)}${tail}`;
  }
  if (state.activeProjectName) {
    return `${yellow("○")} ${yellow(`◇ ${state.activeProjectName} / pick ticket`)}${tail}`;
  }
  if (state.noProjectForSession) return `${dim("○ ◇ no Scryer project")}${tail}`;
  return `${yellow("○")} ${yellow("◇ pick Scryer project")}${tail}`;
}

async function fetchScryerContext(ctx: ExtensionContext): Promise<string | null> {
  try {
    return formatScryerContext(await readScryerState(ctx));
  } catch {
    return null;
  }
}

async function fetchStarshipPrompt(cwd: string, width: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "starship",
      [
        "prompt",
        `--terminal-width=${width}`,
        "--status=0",
        "--keymap=",
        "--pipestatus=0",
        "--cmd-duration=0",
        "--jobs=0",
      ],
      // Pass PWD so starship picks up the correct directory context
      { cwd, timeout: 3000, env: { ...process.env, PWD: cwd, STARSHIP_SHELL: "bash" } },
    );
    // For two-line prompts starship emits info on line 1, ❯ on line 2.
    // Taking only line 1 drops the prompt character naturally.
    const firstLine = stdout.split("\n")[0] ?? "";
    // bash format: \[ and \] are non-printing markers; ESC is already present
    //   inside them, so just strip the markers.
    // zsh format:  %{ and %} wrap content WITHOUT ESC; add ESC when stripping.
    const ansi = firstLine
      .replace(/\\\[/g, "")         // bash: remove \[ (ESC already inside)
      .replace(/\\\]/g, "")         // bash: remove \]
      .replace(/%\{/g,  "\x1b")     // zsh:  %{ → ESC
      .replace(/%\}/g,  "");         // zsh:  remove %}
    // Strip trailing ANSI reset codes first (starship appends them after the
    // last segment's trailing space), then trim the remaining whitespace.
    const clean = ansi
      .replace(/(\x1b\[[0-9;]*m)+$/g, "")
      .trimEnd();
    return clean || null;
  } catch { return null; }
}

async function fetchPR(cwd: string): Promise<PRInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh", ["pr", "view", "--json", "number,url"],
      { cwd, timeout: 5000 },
    );
    const { number, url } = JSON.parse(stdout.trim());
    return (number && url) ? { number, url } : null;
  } catch { return null; }
}

function formatTouchLine(entry: TouchLogEntry | null): string | null {
  if (!entry) return null;
  const when = ago(entry.timestamp);
  const short = entry.hash.slice(0, 7);
  return dim(`↳ ${entry.repoName || basename(entry.repoRoot)} ${short} ${entry.subject}${when ? ` · ${when}` : ""}`);
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let starshipPrompt: string | null = null;
  let pr: PRInfo | null             = null;
  let lastTouch: TouchLogEntry | null = null;
  let scryerContext: string | null  = null;
  let thinkingLevel: string         = "off";
  let lastRenderWidth               = 120;
  let requestRender: (() => void) | undefined;
  let scryerPoll: NodeJS.Timeout | undefined;

  async function refreshStarship(cwd: string, width: number) {
    starshipPrompt = await fetchStarshipPrompt(cwd, width);
    requestRender?.();
  }

  async function refreshScryer(ctx: ExtensionContext) {
    const next = await fetchScryerContext(ctx);
    if (next !== scryerContext) {
      scryerContext = next;
      requestRender?.();
    }
  }

  async function refreshTouch(ctx: ExtensionContext) {
    lastTouch = await readLastTouchlogEntry(ctx) ?? null;
    requestRender?.();
  }

  async function refreshAll(ctx: ExtensionContext) {
    [pr] = await Promise.all([
      fetchPR(ctx.cwd),
      refreshTouch(ctx).then(() => null),
      refreshStarship(ctx.cwd, lastRenderWidth).then(() => null),
      refreshScryer(ctx).then(() => null),
    ]);
    requestRender?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = pi.getThinkingLevel();
    refreshAll(ctx);
    if (scryerPoll) clearInterval(scryerPoll);
    scryerPoll = setInterval(() => refreshScryer(ctx), 2000);

    ctx.ui.setFooter((tui, _theme, footerData) => {
      requestRender = () => tui.requestRender();

      const unsub = footerData.onBranchChange(() => refreshAll(ctx));

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // Re-fetch starship if the terminal was resized
          if (width !== lastRenderWidth) {
            lastRenderWidth = width;
            refreshStarship(ctx.cwd, width);
          }

          // ── Left: starship output + PR ───────────────────────────────────
          const leftParts: string[] = [];

          leftParts.push(bold(cyan(formatPwd(ctx.cwd))));

          if (starshipPrompt) leftParts.push(" " + starshipPrompt);

          if (pr) {
            leftParts.push(" " + hyperlink(pr.url, bold(cyan(`PR #${pr.number}`))));
          }

          const left = leftParts.join("");
          const scryerLine = scryerContext;

          // ── Right: model ◆ thinking  ↑in ↓out $cost ────────────────────
          const rightParts: string[] = [];

          if (ctx.model) {
            rightParts.push(dim(ctx.model.provider + " → ") + bold(magenta(ctx.model.name)));
          }

          if (thinkingLevel !== "off") {
            rightParts.push(" " + dim("◆ ") + cyan(`${thinkingLevel} thinking`) + " " + dim("◆"));
          }

          let inputTok = 0, outputTok = 0, totalCost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              inputTok  += m.usage.input;
              outputTok += m.usage.output;
              totalCost += m.usage.cost.total;
            }
          }

          if (inputTok > 0 || outputTok > 0) {
            const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
            const isCodexSubscription = ctx.model?.provider.toLowerCase().includes("codex");
            rightParts.push(
              ` ${cyan(`↑${fmt(inputTok)}`)}`,
              ` ${green(`↓${fmt(outputTok)}`)}`,
            );
            // Codex subscription usage is quota-based, not billed from the
            // per-token estimate shown by pi, so don't show a misleading cost.
            if (isCodexSubscription) {
              rightParts.push(` ${yellow("sub")}`);
            } else {
              rightParts.push(` ${yellow(`$${totalCost.toFixed(3)}`)}`);
            }
          }

          const right = rightParts.join("");
          const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
          const lines = [truncateToWidth(left + gap + right, width)];
          if (scryerLine) lines.push(truncateToWidth(scryerLine, width));
          const touchLine = formatTouchLine(lastTouch);
          if (touchLine) lines.push(truncateToWidth(touchLine, width));
          return lines;
        },
      };
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    refreshAll(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (scryerPoll) clearInterval(scryerPoll);
    scryerPoll = undefined;
  });

  pi.on("thinking_level_select", async (event, _ctx) => {
    thinkingLevel = event.level;
    requestRender?.();
  });
}
