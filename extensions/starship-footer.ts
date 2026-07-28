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
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
interface PMProject { id: string; name: string; }

const PM_API_BASE_URL = process.env.PI_PM_API_BASE_URL ?? "http://100.105.192.98:43210";
const PM_REFRESH_INTERVAL_MS = 30_000;
const PM_RENDER_TICK_MS = 1_000;
const PM_CACHE_DIR = join(homedir(), ".pi", "agent", "scryer");
const PM_PROJECT_CACHE_PATH = join(PM_CACHE_DIR, "projects.json");

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

async function fetchPMProjects(signal?: AbortSignal): Promise<PMProject[]> {
  const response = await fetch(`${PM_API_BASE_URL}/api/projects`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const projects = await response.json() as Array<{ id?: unknown; name?: unknown }>;
  return projects
    .filter((project): project is { id: string; name: string } =>
      typeof project.id === "string" && typeof project.name === "string",
    )
    .map(({ id, name }) => ({ id, name }));
}

function formatSecondsRemaining(targetTime: number | null): string {
  if (!targetTime) return "--s";
  const seconds = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
  return `${seconds}s`;
}

async function writePMProjectCache(projects: PMProject[]) {
  await mkdir(PM_CACHE_DIR, { recursive: true });
  await writeFile(PM_PROJECT_CACHE_PATH, JSON.stringify({
    base_url: PM_API_BASE_URL,
    updated_at: new Date().toISOString(),
    refresh_interval_ms: PM_REFRESH_INTERVAL_MS,
    projects,
  }, null, 2) + "\n", "utf8");
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let starshipPrompt: string | null = null;
  let pr: PRInfo | null             = null;
  let thinkingLevel: string         = "off";
  let lastRenderWidth               = 120;
  let requestRender: (() => void) | undefined;
  let pmProjects: PMProject[]       = [];
  let pmProjectError: string | null = null;
  let pmCacheError: string | null   = null;
  let pmUpdating                    = false;
  let pmNextUpdateAt: number | null = null;
  let pmRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let pmRenderTimer: ReturnType<typeof setInterval> | undefined;
  let pmAbortController: AbortController | undefined;

  async function refreshStarship(cwd: string, width: number) {
    starshipPrompt = await fetchStarshipPrompt(cwd, width);
    requestRender?.();
  }

  async function refreshPMProjects() {
    pmAbortController?.abort();
    const controller = new AbortController();
    pmAbortController = controller;
    pmUpdating = true;
    requestRender?.();

    try {
      pmProjects = await fetchPMProjects(controller.signal);
      pmProjectError = null;
      try {
        await writePMProjectCache(pmProjects);
        pmCacheError = null;
      } catch (error) {
        pmCacheError = error instanceof Error ? error.message : String(error);
      }
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        pmProjectError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (pmAbortController === controller) {
        pmUpdating = false;
        pmNextUpdateAt = Date.now() + PM_REFRESH_INTERVAL_MS;
        requestRender?.();
      }
    }
  }

  async function refreshAll(ctx: ExtensionContext) {
    [pr] = await Promise.all([
      fetchPR(ctx.cwd),
      refreshStarship(ctx.cwd, lastRenderWidth).then(() => null),
    ]);
    requestRender?.();
  }

  function stopPMTimers() {
    if (pmRefreshTimer) clearInterval(pmRefreshTimer);
    if (pmRenderTimer) clearInterval(pmRenderTimer);
    pmRefreshTimer = undefined;
    pmRenderTimer = undefined;
    pmAbortController?.abort();
    pmAbortController = undefined;
  }

  function startPMTimers() {
    stopPMTimers();
    refreshPMProjects();
    pmRefreshTimer = setInterval(refreshPMProjects, PM_REFRESH_INTERVAL_MS);
    pmRenderTimer = setInterval(() => requestRender?.(), PM_RENDER_TICK_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = pi.getThinkingLevel();
    refreshAll(ctx);
    startPMTimers();
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

          // const pmStatus = pmProjectError
          //   ? yellow(`(Scryer offline, retry in ${formatSecondsRemaining(pmNextUpdateAt)})`)
          //   : pmCacheError
          //     ? yellow(`(tracking ${pmProjects.length} projects in Scryer, cache write failed, updates in ${formatSecondsRemaining(pmNextUpdateAt)})`)
          //     : green(`(tracking ${pmProjects.length} projects in Scryer, updates in ${formatSecondsRemaining(pmNextUpdateAt)})`);
          // leftParts.push(" " + (pmUpdating ? yellow("updating Scryer…") : pmStatus));

          const left = leftParts.join("");
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
          return lines;
        },
      };
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    refreshAll(ctx);
  });

  pi.on("thinking_level_select", async (event, _ctx) => {
    thinkingLevel = event.level;
    requestRender?.();
  });

  pi.on("session_shutdown", () => {
    stopPMTimers();
    requestRender = undefined;
  });
}
