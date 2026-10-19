// Consolidate long trees on the canvas: fold a run of plain single-child turns
// (A→B→C→D) beneath a node into one "+N turns" card, so a long linear
// conversation stops towering over the forest. View-only — the nodes are
// untouched, the inspector still reads the full thread, and unfolding brings them
// all back.
//
// A node can fold away only if it's an ordinary turn with exactly one child that
// isn't the tree's root (the first turn under the summary header) and isn't in
// `keep` (selected / streaming / merge-adjacent / etc — anything the caller needs
// on screen). Branch points (≥2 kids) and leaves (0 kids) never fold, so every
// fork in the tree stays visible.
//
// Folding is anchored on the node ABOVE a run: folding node X hides the foldable
// run under each of X's children. Any node with a run of ≥2 below it can anchor.

const MIN_RUN = 2; // folding a single node into a "+1" card saves nothing

// `collapsed` maps each folded anchor → the set of node ids it covered when it
// was folded (its anchor entry's `ids` at that moment). A fold only ever hides
// those, so turns that arrive later — a reply at the end of a folded run, a new
// branch off the anchor — stay visible rather than getting swallowed.
//
// Returns { nodes, anchors }. `nodes` is the list to draw (folded runs replaced by
// `kind: "chain"` cards, the node below each re-parented onto it). `anchors` maps
// every node that COULD fold → { rootId, top, ids }, where `top` marks the anchors
// a "fold the whole tree" needs (ones not themselves inside a foldable run) and
// `ids` is what folding it now would hide.
export function collapseChains(nodes, collapsed, keep = new Set()) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!kids.has(n.parentId)) kids.set(n.parentId, []);
    kids.get(n.parentId).push(n.id);
  }

  // Which tree each node is in, and how deep: climb to the summary header.
  const treeOf = (n) => {
    let cur = n;
    let depth = 0;
    while (cur && cur.kind !== "summary") {
      cur = cur.parentId ? byId.get(cur.parentId) : null;
      depth++;
    }
    return { rootId: cur?.rootId ?? null, depth };
  };

  const foldable = (n) => {
    if (!n || n.kind || keep.has(n.id)) return false;
    if ((kids.get(n.id) || []).length !== 1) return false;
    const parent = byId.get(n.parentId);
    return !!parent && parent.kind !== "summary";
  };

  // The foldable run hanging from `childId`, stopping at anything already hidden
  // or (given `only`) outside the set the fold covered when it was made.
  const runFrom = (childId, hidden, only) => {
    const run = [];
    let cur = byId.get(childId);
    while (foldable(cur) && !hidden.has(cur.id) && (!only || only.has(cur.id))) {
      run.push(cur);
      cur = byId.get(kids.get(cur.id)[0]);
    }
    return { run, next: cur };
  };

  const none = new Set();
  const anchors = new Map();
  for (const n of nodes) {
    if (n.kind === "summary") continue;
    const runs = (kids.get(n.id) || []).map((k) => runFrom(k, none).run).filter((r) => r.length >= MIN_RUN);
    if (!runs.length) continue;
    anchors.set(n.id, { rootId: treeOf(n).rootId, top: !foldable(n), ids: runs.flat().map((r) => r.id) });
  }

  // Fold top-down, so an ancestor's fold swallows any anchor inside its run.
  const order = [...collapsed.keys()].filter((id) => anchors.has(id)).sort((a, b) => treeOf(byId.get(a)).depth - treeOf(byId.get(b)).depth);
  const hidden = new Set();
  const reparent = new Map(); // id -> chain card id it now hangs under
  const chains = [];
  for (const anchorId of order) {
    if (hidden.has(anchorId)) continue;
    for (const k of kids.get(anchorId)) {
      const { run, next } = runFrom(k, hidden, collapsed.get(anchorId));
      if (run.length < MIN_RUN) continue;
      const chainId = `chain-${run[0].id}`;
      for (const r of run) hidden.add(r.id);
      reparent.set(next.id, chainId);
      chains.push({
        id: chainId,
        parentId: anchorId,
        kind: "chain",
        anchorId,
        count: run.length,
        label: run[0].label,
        prompt: "",
        result: "",
        order: run[0].order,
      });
    }
  }

  const out = [];
  for (const n of nodes) {
    if (hidden.has(n.id)) continue;
    out.push(reparent.has(n.id) ? { ...n, parentId: reparent.get(n.id) } : n);
  }
  return { nodes: [...out, ...chains], anchors };
}
