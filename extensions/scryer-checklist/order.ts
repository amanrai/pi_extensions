export type Move = { item_id: string; operation: "move_before" | "move_after"; anchor_id: string };
export type ReorderInput = { goal_id: string; moves: Move[] };
export type Item = { id: string; goal_id: string; title: string; display_order: number | null };
export type Actor = { actor_role: string; actor_instance_key: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).some(key => !expected.includes(key))) throw new Error("Unexpected field; use UUID-based moves, not indexes or titles.");
}
export function validateInput(value: unknown): asserts value is ReorderInput {
  if (!object(value)) throw new Error("Expected a JSON object.");
  keys(value, ["goal_id", "moves"]);
  if (typeof value.goal_id !== "string" || !uuid.test(value.goal_id)) throw new Error("goal_id must be a UUID.");
  if (!Array.isArray(value.moves) || value.moves.length === 0 || value.moves.length > 100) throw new Error("Supply 1–100 sequential moves.");
  for (const move of value.moves) {
    if (!object(move)) throw new Error("Each move must be an object.");
    keys(move, ["item_id", "operation", "anchor_id"]);
    if (typeof move.item_id !== "string" || !uuid.test(move.item_id) || typeof move.anchor_id !== "string" || !uuid.test(move.anchor_id)) throw new Error("item_id and anchor_id must be UUIDs.");
    if (move.operation !== "move_before" && move.operation !== "move_after") throw new Error("Use move_before or move_after.");
    if (move.item_id.toLowerCase() === move.anchor_id.toLowerCase()) throw new Error("An item cannot move relative to itself.");
  }
}
function parseItems(value: unknown, goal: string): Item[] {
  if (!Array.isArray(value)) throw new Error("JEPM returned a non-array checklist.");
  const seen = new Set<string>();
  return value.map(item => {
    if (!object(item) || typeof item.id !== "string" || !uuid.test(item.id) || typeof item.goal_id !== "string" || item.goal_id.toLowerCase() !== goal || typeof item.title !== "string" || !(item.display_order === null || Number.isSafeInteger(item.display_order))) throw new Error("JEPM returned an invalid checklist item.");
    const id = item.id.toLowerCase();
    if (seen.has(id)) throw new Error("JEPM returned duplicate item UUIDs.");
    seen.add(id);
    return { id, goal_id: goal, title: item.title, display_order: item.display_order as number | null };
  });
}
export function planOrder(items: Item[], moves: Move[]): Item[] {
  const order = [...items];
  for (const move of moves) {
    const index = order.findIndex(item => item.id === move.item_id.toLowerCase());
    const anchor = order.find(item => item.id === move.anchor_id.toLowerCase());
    if (index < 0 || !anchor) throw new Error("Every moved item and anchor must belong to this Goal's active checklist. Resolve UUIDs first; titles are not accepted.");
    const [item] = order.splice(index, 1);
    order.splice(order.indexOf(anchor) + (move.operation === "move_after" ? 1 : 0), 0, item);
  }
  return order;
}
export type OrderResult = {
  status: "reordered" | "unchanged" | "failed";
  before: { id: string; title: string }[];
  intended: { id: string; title: string }[];
  observed?: { id: string; title: string }[];
  confirmed_updates: string[];
  uncertain_item_id?: string;
  error?: string;
  inspection_error?: string;
  http_requests: number;
};
const summarize = (items: Item[]) => items.map(({ id, title }) => ({ id, title }));
const sameOrder = (a: Item[], b: Item[]) => a.length === b.length && a.every((item, i) => item.id === b[i].id);

// One queue per endpoint/Goal in this process; not a cross-instance lock or transaction.
const queues = new Map<string, Promise<unknown>>();
export async function reorderChecklist(input: ReorderInput, options: { baseUrl: string; actor: Actor; signal?: AbortSignal; fetch?: typeof fetch }): Promise<OrderResult> {
  validateInput(input);
  if (!options.actor.actor_role.trim() || !options.actor.actor_instance_key.trim()) throw new Error("Missing actor attribution.");
  const base = options.baseUrl.replace(/\/$/, "");
  const goal = input.goal_id.toLowerCase();
  const key = `${base}/${goal}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    let requests = 0;
    const request = async (path: string, body?: unknown) => {
      options.signal?.throwIfAborted();
      requests++;
      const response = await (options.fetch ?? fetch)(`${base}${path}`, {
        method: body === undefined ? "GET" : "PATCH",
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]),
      });
      if (!response.ok) throw new Error(`JEPM HTTP ${response.status}; no automatic retry.`);
      return response.json();
    };
    const read = async () => parseItems(await request(`/api/goals/${goal}/checklist-items`), goal);
    const items = await read(); // API order (including its null/tie semantics) is authoritative.
    const intended = planOrder(items, input.moves); // Validate every move before any write.
    const result: OrderResult = { status: "unchanged", before: summarize(items), intended: summarize(intended), confirmed_updates: [], http_requests: requests };
    if (sameOrder(items, intended)) return { ...result, observed: summarize(items) };
    try {
      for (const [position, item] of intended.entries()) {
        if (item.display_order === position) continue;
        // Once sent, even a failed response may have followed a committed write.
        options.signal?.throwIfAborted();
        result.uncertain_item_id = item.id;
        const saved = await request(`/api/goal-checklist-items/${item.id}`, { ...options.actor, display_order: position });
        if (!object(saved) || saved.id !== item.id || saved.goal_id !== goal || saved.display_order !== position) throw new Error("JEPM did not confirm the requested item position.");
        result.confirmed_updates.push(item.id);
        delete result.uncertain_item_id;
      }
      const observed = await read();
      result.observed = summarize(observed);
      if (!sameOrder(observed, intended) || observed.some((item, index) => item.display_order !== index)) throw new Error("Read-back differs from intended order; possible concurrent change. Inspect before acting again.");
      result.status = "reordered";
    } catch (error) {
      result.status = "failed";
      result.error = `${error instanceof Error ? error.message : String(error)} Order may be partial or uncertain. Inspect; do not blindly retry. No rollback was attempted.`;
      if (!result.observed && !options.signal?.aborted) {
        try { result.observed = summarize(await read()); }
        catch (inspection) { result.inspection_error = inspection instanceof Error ? inspection.message : String(inspection); }
      }
    }
    return { ...result, http_requests: requests };
  });
  queues.set(key, run);
  try { return await run; }
  finally { if (queues.get(key) === run) queues.delete(key); }
}
