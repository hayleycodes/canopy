// Tidy-ish tree layout with no external dep. Given the flat node list from the
// server, assign each node an {x, y}: trees sit side by side (horizontal), each
// top-aligned, with children dropping one level per depth.
//
// Each tree is laid out INDEPENDENTLY and then packed into a horizontal slot in
// creation order (oldest tree leftmost). The slots are recomputed from scratch on
// every layout, so the row always reads oldest→newest and archiving a tree lets
// the rest close the gap it left — a tree's column follows from its age, never
// from when it first appeared this session. (An earlier version pinned each slot
// on first sight and only appended new trees to the right; that kept forking from
// nudging neighbours, but it stranded an older tree wherever it happened to
// re-enter the canvas mid-session, out of age order.)

const H_GAP = 260; // horizontal spacing between sibling columns
const V_GAP = 50; // vertical gap between a card's bottom and its child's top
const DEFAULT_H = 100; // assumed card height before React Flow has measured it
const TREE_GAP = 0.5; // gap between trees, in column units

// `slots` (rootId -> base column) is rebuilt from scratch on every call and left
// populated for callers that want to inspect the final packing; positions no
// longer depend on what it held coming in. A default fresh Map keeps the tests as
// simple one-off layouts.
// `heights` (id -> measured pixel height) lets each child clear its actual
// parent instead of a fixed row height, so tall cards no longer overlap the
// row below. Unmeasured nodes fall back to DEFAULT_H (which keeps the simple
// depth*row spacing the tests assert).
export function layoutTree(nodes, slots = new Map(), heights = new Map()) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map(nodes.map((n) => [n.id, []]));
  const roots = [];
  for (const n of nodes) {
    if (n.parentId && children.has(n.parentId)) children.get(n.parentId).push(n.id);
    else roots.push(n.id);
  }

  // Stable order — by creation order (`order`), then id — so newly appearing
  // trees claim slots left to right in a predictable order.
  const byOrder = (a, b) => {
    const oa = byId.get(a)?.order ?? 0;
    const ob = byId.get(b)?.order ?? 0;
    return oa - ob || (a < b ? -1 : a > b ? 1 : 0);
  };
  roots.sort(byOrder);
  // Siblings, too — so a newly forked child (higher `order`, or a pending node
  // with order Infinity) lands in the rightmost column rather than wherever it
  // happened to sit in the flat node array. Reparenting (finding replies, merges)
  // otherwise leaves array position out of step with creation order.
  for (const kids of children.values()) kids.sort(byOrder);

  // Lay out each tree in local (per-tree) coordinates: local column + y, plus the
  // tree each node belongs to and the tree's width in columns.
  const local = new Map(); // id -> { lx, y }
  const nodeRoot = new Map(); // id -> rootId
  const width = new Map(); // rootId -> column width
  const heightOf = (id) => heights.get(id)?.height || DEFAULT_H;
  for (const root of roots) {
    let cursor = 0; // next free leaf column, LOCAL to this tree
    // First pass: horizontal columns (post-order so a parent centers on its kids).
    function place(id) {
      nodeRoot.set(id, root);
      const kids = children.get(id);
      let lx;
      if (kids.length === 0) {
        lx = cursor++;
      } else {
        const xs = kids.map((k) => place(k));
        lx = (xs[0] + xs[xs.length - 1]) / 2;
      }
      local.set(id, { lx, y: 0 });
      return lx;
    }
    place(root);
    // Second pass: vertical position. Each child sits below its parent's ACTUAL
    // bottom, so a tall card pushes its children (and their subtree) further down
    // instead of overlapping them.
    function drop(id, y) {
      local.get(id).y = y;
      const childY = y + heightOf(id) + V_GAP;
      for (const k of children.get(id)) drop(k, childY);
    }
    drop(root, 0);
    width.set(root, Math.max(cursor, 1));
  }

  // Pack the trees left-to-right in creation order (`roots` is already sorted by
  // `order`). Rebuilding from scratch each layout is what keeps the row in age
  // order and closes the gap when a tree is archived.
  slots.clear();
  let edge = 0;
  for (const root of roots) {
    slots.set(root, edge);
    edge += width.get(root) + TREE_GAP;
  }

  // Compose absolute positions from each node's local column + its tree's slot.
  const pos = new Map();
  for (const [id, lp] of local) {
    const base = slots.get(nodeRoot.get(id)) ?? 0;
    pos.set(id, { x: (base + lp.lx) * H_GAP, y: lp.y });
  }
  return byId.size ? pos : new Map();
}
