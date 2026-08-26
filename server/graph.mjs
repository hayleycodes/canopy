// The session graph — Canopy's single source of truth.
//
// An in-memory tree of nodes, one per Claude session. Each node remembers who it
// forked from (parentId), the prompt that created it, the assistant's reply, and
// a short label for the canvas. This is deliberately ephemeral for the scaffold;
// persistence (disk / sqlite) is a later concern.

let nodes = new Map(); // session_id -> node
let seq = 0;

// Cap the in-memory graph. Disk is the source of truth (see index.mjs), so these
// entries only backfill just-finished turns whose .jsonl hasn't flushed yet —
// keeping the most recent handful is plenty, and stops unbounded growth.
const MAX_NODES = 200;

// A one-line label for the canvas. The design wants a one-sentence *summary* of
// the exchange; generating that is its own turn, so for now we fall back to the
// prompt. Swapping in a real summarizer is a localized change here. Exported so
// the disk reader (store.mjs) labels nodes identically.
export function labelFor(prompt) {
  const clean = (prompt || "").replace(/\s+/g, " ").trim();
  return clean.length > 60 ? clean.slice(0, 59) + "…" : clean;
}

// Context/output for the just-finished turn, from the CLI's final result usage
// (same shape as a transcript message's usage). Mirrors store.tokensForTail so a
// live node and its later disk-reconstructed twin read identically.
function tokensFromUsage(u) {
  if (!u) return null;
  const context =
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0);
  return { context, output: u.output_tokens || 0 };
}

export function addNode({ sessionId, parentId = null, prompt, result, finalResult = "", questions = [], usage = null }) {
  const node = {
    id: sessionId,
    parentId,
    order: seq++,
    prompt,
    label: labelFor(prompt),
    result: result ?? "",
    // Just the turn's final assistant block. `result` joins every block (narration,
    // scratchpad, answer) for display, but a review's findings live only in the
    // final answer — split detection keys on this so it doesn't grab a scratchpad
    // list or absorb trailing wrap-up. Falls back to the full result if unset.
    finalResult: finalResult || result || "",
    // Resolved AskUserQuestion Q&A raised during this turn (matches store.mjs), so
    // the freshly-finished node shows it before its .jsonl flushes to disk.
    questions,
    tokens: tokensFromUsage(usage),
  };
  nodes.set(sessionId, node);
  // Evict oldest-inserted entries once over the cap (Map keeps insertion order).
  while (nodes.size > MAX_NODES) nodes.delete(nodes.keys().next().value);
  return node;
}

export function getNode(id) {
  return nodes.get(id) ?? null;
}

// The whole graph as plain data for the client: flat node list + parent edges.
export function snapshot() {
  const list = [...nodes.values()].sort((a, b) => a.order - b.order);
  const edges = list
    .filter((n) => n.parentId)
    .map((n) => ({ id: `${n.parentId}->${n.id}`, source: n.parentId, target: n.id }));
  return { nodes: list, edges };
}

export function reset() {
  nodes = new Map();
  seq = 0;
}
