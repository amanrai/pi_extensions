import { resolve } from "node:path";
import { detectGitRepo } from "./repository.ts";

export type IdentityRegistration = { name: string; session: string; location: string; repo?: string };
type Options = {
  name: string;
  session: string;
  directory: string;
  machine: string;
  serviceUrl: string;
  intervalMs?: number;
  detectRepo?: (directory: string) => Promise<string | undefined>;
  post?: (body: IdentityRegistration, signal: AbortSignal) => Promise<void>;
  onRepo?: (repo: string) => Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

/** Background, session-scoped registration. No network wait enters the update path. */
export function startIdentityRegistration(options: Options) {
  const abort = new AbortController();
  let stopped = false;
  let running: Promise<void> | undefined;
  let acknowledged: string | undefined;
  let repo: string | undefined;
  const location = `machine:${options.machine}@${resolve(options.directory)}`;
  const post = options.post ?? (async (body: IdentityRegistration, signal: AbortSignal) => {
    const response = await fetch(`${options.serviceUrl.replace(/\/$/, "")}/api/identities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    // Drain success and error responses so retries can reuse the connection.
    // Acknowledgment requires no response fields.
    await response.arrayBuffer();
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Identity registration HTTP ${response.status}`);
    }
  });
  async function run() {
    const detected = await (options.detectRepo ?? detectGitRepo)(options.directory);
    if (stopped) return;
    if (detected && detected !== repo) {
      await options.onRepo?.(detected);
      if (stopped) return;
      repo = detected;
    }
    const body: IdentityRegistration = {
      name: options.name, session: options.session, location, ...(repo ? { repo } : {}),
    };
    const fingerprint = JSON.stringify(body);
    if (fingerprint === acknowledged) return;
    await post(body, abort.signal);
    if (!stopped) acknowledged = fingerprint;
  }
  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = run().catch(async (error) => {
      if (!stopped) {
        // Logging must not turn a failed background retry into an unhandled rejection.
        try { await options.onError?.(error); } catch { /* Try again on the next tick. */ }
      }
    }).finally(() => { running = undefined; });
    return running;
  }
  // Poll both failed registrations and changing Git metadata. Acknowledged,
  // unchanged payloads do not generate repeated HTTP requests. A fresh controller
  // always registers again, including reload/resume of the same Pi session.
  const timer = setInterval(() => { void refresh(); }, options.intervalMs ?? 30_000);
  timer.unref();
  void refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
      abort.abort();
    },
  };
}
