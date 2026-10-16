import { randomUUID } from "node:crypto";

export const FLUSH_IDLE_MS = 30_000;
export const RECAP_IDLE_MS = 30 * 60_000;
export const RECAP_LOOKBACK_MS = 12 * 60 * 60_000;

export type Activity = { sequence: number; at: number; scope: string; session: string; role: string; text: string };
export type RecapPart = { id: string; title: string; body: string; verified?: boolean; createdAt?: string; goals?: { id: string; title: string }[] };
export type RecapSender = {
  from: string; identity: string; machine: string; repo: string; goalPath?: string;
  task: { key: string; title: string; description: string };
};
export type RecapDelivery = {
  id: string; source: "idle-recap" | "manual-recap"; scope: string; through: number;
  start: number; end: number; parts: RecapPart[]; sender?: RecapSender;
};

/** One live Pi SessionManager owns a window, not one saved session or identity. */
export class WindowActivity {
  readonly id = randomUUID();
  sequence = 0;
  lastActivityAt = 0;
  events: Activity[] = [];
  checkpoints = new Map<string, number>();
  reviewed = new Map<string, number>();
  pending = new Map<string, RecapDelivery>();

  touch(now = Date.now()) { this.lastActivityAt = now; }

  record(scope: string, session: string, role: string, text: string, now = Date.now()) {
    this.touch(now);
    this.prune(now);
    if (text.trim()) this.events.push({ sequence: ++this.sequence, at: now, scope, session, role, text });
  }

  prune(now = Date.now()) {
    this.events = this.events.filter((event) => event.at >= now - RECAP_LOOKBACK_MS);
  }

  snapshot(scope: string, now = Date.now()) {
    this.prune(now);
    const events = this.events.filter((event) => event.scope === scope && event.at <= now);
    const checkpoint = Math.max(this.checkpoints.get(scope) ?? 0, this.reviewed.get(scope) ?? 0);
    return { events, checkpoint, through: this.sequence, start: now - RECAP_LOOKBACK_MS, end: now,
      hasNewWork: events.some((event) => event.sequence > checkpoint) };
  }

  complete(delivery: RecapDelivery) {
    if (!delivery.parts.length || !delivery.parts.every((part) => part.verified)) throw new Error("Recap is not fully verified");
    this.checkpoints.set(delivery.scope, Math.max(this.checkpoints.get(delivery.scope) ?? 0, delivery.through));
    if (this.pending.get(delivery.scope) === delivery) this.pending.delete(delivery.scope);
  }
}

// Weak keys isolate SDK windows too. The SessionManager survives /new, /resume,
// /fork and /reload; a fresh Pi process never imports another window's history.
const WINDOW_KEY = Symbol.for("scryer.comms.window-activity.v1");
export function windowActivity(owner: object): WindowActivity {
  const globals = globalThis as any;
  const windows: WeakMap<object, WindowActivity> = globals[WINDOW_KEY] ??= new WeakMap();
  let activity = windows.get(owner);
  if (!activity) { activity = new WindowActivity(); windows.set(owner, activity); }
  return activity;
}

/** Lossless character chunks, including oversized individual messages/tool results. */
export function sourceChunks(events: readonly Activity[], checkpoint: number, limit = 16_000) {
  let source = "";
  const ranges = events.map((event) => {
    const start = source.length;
    source += `${source ? "\n" : ""}${JSON.stringify({ newSinceRecap: event.sequence > checkpoint, ...event })}`;
    return { start, end: source.length, sequence: event.sequence, newSinceRecap: event.sequence > checkpoint };
  });
  const chunks: { text: string; records: { sequence: number; newSinceRecap: boolean }[] }[] = [];
  limit = Math.max(2, limit);
  for (let at = 0; at < source.length;) {
    let end = Math.min(source.length, at + limit);
    // Never split a Unicode surrogate pair. Repeated record headers preserve
    // new-work eligibility even in the middle of an oversized tool result.
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
    chunks.push({ text: source.slice(at, end), records: ranges.filter((range) => range.start < end && range.end > at)
      .map(({ sequence, newSinceRecap }) => ({ sequence, newSinceRecap })) });
    at = end;
  }
  return chunks;
}

/** Two independent quiet-period timers. Background comms calls are not activity. */
export function idleTimers(options: {
  activity: WindowActivity; canRun: () => boolean;
  flush: () => Promise<void>; recap: () => Promise<void>;
  onError: (kind: string, error: unknown) => void;
}) {
  let stopped = false;
  let generation = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let recapTimer: ReturnType<typeof setTimeout> | undefined;
  let flushBusy = false;
  let recapBusy = false;
  const clear = () => { clearTimeout(flushTimer); clearTimeout(recapTimer); };
  function schedule(kind: "flush" | "recap", delay: number) {
    const epoch = generation;
    const timer = setTimeout(async () => {
      if (stopped || epoch !== generation) return;
      const threshold = kind === "flush" ? FLUSH_IDLE_MS : RECAP_IDLE_MS;
      const remaining = threshold - (Date.now() - options.activity.lastActivityAt);
      if (remaining > 0 || !options.canRun() || (kind === "flush" ? flushBusy : recapBusy)) {
        schedule(kind, Math.max(1000, remaining));
        return;
      }
      if (kind === "flush") flushBusy = true; else recapBusy = true;
      try { await options[kind](); }
      catch (error) {
        options.onError(kind, error);
        // Retry transient model/service failures without pretending a recap was sent.
        if (!stopped && epoch === generation) schedule(kind, FLUSH_IDLE_MS);
      } finally { if (kind === "flush") flushBusy = false; else recapBusy = false; }
    }, delay);
    timer.unref?.();
    if (kind === "flush") flushTimer = timer; else recapTimer = timer;
  }
  return {
    reset() {
      if (stopped) return;
      clear();
      generation++;
      schedule("flush", Math.max(0, FLUSH_IDLE_MS - (Date.now() - options.activity.lastActivityAt)));
      schedule("recap", Math.max(0, RECAP_IDLE_MS - (Date.now() - options.activity.lastActivityAt)));
    },
    stop() { stopped = true; generation++; clear(); },
  };
}
