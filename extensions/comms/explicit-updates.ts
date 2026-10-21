import { isDeepStrictEqual } from "node:util";
export type ExplicitUpdate = {
  id: string; from: string; kind: string; title: string; body: string;
  metadata: Record<string, unknown> & { v2meta: {
    identity: string; foldersTouched: string[]; goals: { id: string; title: string }[];
  } };
};
export type ExplicitUpdateResult = {
  status: "sent" | "already_stored" | "failed";
  id: string; from: string; verified: boolean; http_requests: number; error?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requiredKeys(value: unknown, keys: string[], extra = false): asserts value is Record<string, unknown> {
  if (!object(value) || keys.some(key => !Object.hasOwn(value, key)) || (!extra && Object.keys(value).some(key => !keys.includes(key)))) throw new Error(`Supply explicit fields: ${keys.join(", ")}. No defaults are inferred.`);
}
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim(); }
export function validateExplicitUpdate(value: unknown, sender: { from: string; identity: string }): asserts value is ExplicitUpdate {
  requiredKeys(value, ["id", "from", "kind", "title", "body", "metadata"]);
  if (typeof value.id !== "string" || !uuid.test(value.id) || typeof value.from !== "string" || !uuid.test(value.from)) throw new Error("id and from must be explicit UUIDs.");
  if (!text(value.kind) || !text(value.title) || !text(value.body)) throw new Error("kind, title and body must be explicit nonblank strings.");
  requiredKeys(value.metadata, ["v2meta"], true);
  requiredKeys(value.metadata.v2meta, ["identity", "foldersTouched", "goals"]);
  const meta = value.metadata.v2meta;
  if (!text(sender.from) || !text(sender.identity) || value.from !== sender.from || meta.identity !== sender.identity) throw new Error("Explicit from/identity must match this session's producer and full startup identity; no substitution or impersonation.");
  for (const key of ["identities", "created_by", "command_runner", "file_modifier", "version-manager"]) if (Object.hasOwn(value.metadata, key)) throw new Error("Send only the startup identity name, not identity lists or full .scryer records.");
  if (!Array.isArray(meta.foldersTouched) || meta.foldersTouched.some(folder => typeof folder !== "string" || !/^[^:]+:(?:\/|[a-z]:[\\/])/i.test(folder))) throw new Error("foldersTouched must be an explicit array of machine:absolute_path strings (or []).");
  if (!Array.isArray(meta.goals)) throw new Error("goals must be an explicit array (or []).");
  const seen = new Set<string>();
  for (const goal of meta.goals) {
    requiredKeys(goal, ["id", "title"]);
    if (typeof goal.id !== "string" || !uuid.test(goal.id) || !text(goal.title) || seen.has(goal.id.toLowerCase())) throw new Error("Each explicit Goal requires a unique UUID and nonblank title.");
    seen.add(goal.id.toLowerCase());
  }
}
export async function sendExplicitUpdate(payload: ExplicitUpdate, options: {
  baseUrl: string; sender: { from: string; identity: string }; signal?: AbortSignal; fetch?: typeof fetch;
}): Promise<ExplicitUpdateResult> {
  validateExplicitUpdate(payload, options.sender);
  // Freeze the supplied JSON before awaiting; do not normalize, truncate, infer,
  // generate IDs, read session Goals, wrap coding tags, mirror PM or reset recaps.
  const body = JSON.stringify(payload), submitted: ExplicitUpdate = JSON.parse(body);
  options.signal?.throwIfAborted();
  const base = options.baseUrl.replace(/\/$/, "");
  let requests = 0;
  const result: ExplicitUpdateResult = { status: "failed", id: submitted.id, from: submitted.from, verified: false, http_requests: 0 };
  const signal = () => AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
  try {
    requests++;
    const response = await (options.fetch ?? fetch)(`${base}/api/updates`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: signal() });
    if (!response.ok && response.status !== 409) throw new Error(`Interaction service HTTP ${response.status}.`);
    options.signal?.throwIfAborted(); requests++;
    const read = await (options.fetch ?? fetch)(`${base}/api/updates?from=${encodeURIComponent(submitted.from)}&limit=500`, { method: "GET", headers: { Accept: "application/json" }, signal: signal() });
    if (!read.ok) throw new Error(`Update read-back HTTP ${read.status}.`);
    const page = await read.json();
    if (!object(page) || !Array.isArray(page.updates)) throw new Error("Invalid update read-back.");
    const stored = page.updates.find((update: any) => update?.id === submitted.id);
    if (!stored || stored.from !== submitted.from || stored.kind !== submitted.kind || stored.title !== submitted.title || stored.body !== submitted.body || !isDeepStrictEqual(stored.metadata, submitted.metadata)) throw new Error("Stored update not found or differs from the explicit payload; delivery/conflict is unverified.");
    result.status = response.status === 409 ? "already_stored" : "sent";
    result.verified = true;
  } catch (error) {
    result.error = `${error instanceof Error ? error.message : String(error)} Update may already be stored. Inspect this id before another send; no automatic repost/retry or rollback was attempted.`;
  }
  result.http_requests = requests;
  return result;
}
