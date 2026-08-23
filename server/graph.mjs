// The session graph — Canopy's single source of truth.
//
// An in-memory tree of nodes, one per Claude session. Each node remembers who it
// forked from (parentId), the prompt that created it, the assistant's reply, and
// a short label for the canvas. This is deliberately ephemeral for the scaffold;
// persistence (disk / sqlite) is a later concern.

let nodes = new Map(); // session_id -> node
let seq = 0;

// A one-line label for the canvas. The design wants a one-sentence *summary* of
// the exchange; generating that is its own turn, so for now we fall back to the
// prompt. Swapping in a real summarizer is a localized change here.
function labelFor(prompt) {
  const clean = (prompt || "").replace(/\s+/g, " ").trim();
  return clean.length > 60 ? clean.slice(0, 59) + "…" : clean;
}

export function addNode({ sessionId, parentId = null, prompt, result }) {
  const node = {
    id: sessionId,
    parentId,
    order: seq++,
    prompt,
    label: labelFor(prompt),
    result: result ?? "",
    createdAt: null, // Date.now() is intentionally left to the caller if needed
  };
  nodes.set(sessionId, node);
  return node;
}

export function getNode(id) {
  return nodes.get(id) ?? null;
}

export function updateNode(id, patch) {
  const node = nodes.get(id);
  if (!node) return null;
  Object.assign(node, patch);
  return node;
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
