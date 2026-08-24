// Tidy-ish tree layout with no external dep. Given the flat node list from the
// server, assign each node an {x, y}: trees sit side by side (horizontal), each
// top-aligned, with children dropping one level per depth.
//
// Each tree is laid out INDEPENDENTLY and then dropped into a fixed horizontal
// slot it keeps across renders (via the caller-supplied `slots` cache). This is
// deliberate: an earlier version walked every tree with one shared left-to-right
// cursor, so adding a node anywhere reflowed the whole row — trees slid sideways
// under the camera and appeared to vanish. Now a tree's slot is assigned once and
// never shifts when another tree changes; forking only reflows that one tree
// within its own slot.

const H_GAP = 260; // horizontal spacing between sibling columns
const V_GAP = 150; // vertical spacing between depths
const TREE_GAP = 1.5; // gap between trees, in column units

// `slots` (rootId -> base column) is a persistent map the caller keeps across
// renders so each tree keeps its horizontal position. The default fresh Map makes
// this a stateless one-off layout (used by tests).
export function layoutTree(nodes, slots = new Map()) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map(nodes.map((n) => [n.id, []]));
  const roots = [];
  for (const n of nodes) {
    if (n.parentId && children.has(n.parentId)) children.get(n.parentId).push(n.id);
    else roots.push(n.id);
  }

  // Stable order — by creation order (`order`), then id — so newly appearing
  // trees claim slots left to right in a predictable order.
  roots.sort((a, b) => {
    const oa = byId.get(a)?.order ?? 0;
    const ob = byId.get(b)?.order ?? 0;
    return oa - ob || (a < b ? -1 : a > b ? 1 : 0);
  });

  // Lay out each tree in local (per-tree) coordinates: local column + y, plus the
  // tree each node belongs to and the tree's width in columns.
  const local = new Map(); // id -> { lx, y }
  const nodeRoot = new Map(); // id -> rootId
  const width = new Map(); // rootId -> column width
  for (const root of roots) {
    let cursor = 0; // next free leaf column, LOCAL to this tree
    function place(id, depth) {
      nodeRoot.set(id, root);
      const kids = children.get(id);
      let lx;
      if (kids.length === 0) {
        lx = cursor++;
      } else {
        const xs = kids.map((k) => place(k, depth + 1));
        lx = (xs[0] + xs[xs.length - 1]) / 2;
      }
      local.set(id, { lx, y: depth * V_GAP });
      return lx;
    }
    place(root, 0);
    width.set(root, Math.max(cursor, 1));
  }

  // Forget slots for trees that no longer exist so the cache can't grow forever.
  for (const key of [...slots.keys()]) if (!width.has(key)) slots.delete(key);

  // Rightmost column already claimed by a slotted tree.
  let rightEdge = 0;
  for (const [id, base] of slots) rightEdge = Math.max(rightEdge, base + width.get(id));

  // Give any tree without a slot yet (new trees) one to the right of everything
  // already placed. Existing trees keep the slot they had.
  for (const root of roots) {
    if (slots.has(root)) continue;
    const base = slots.size === 0 ? 0 : rightEdge + TREE_GAP;
    slots.set(root, base);
    rightEdge = base + width.get(root);
  }

  // Compose absolute positions from each node's local column + its tree's slot.
  const pos = new Map();
  for (const [id, lp] of local) {
    const base = slots.get(nodeRoot.get(id)) ?? 0;
    pos.set(id, { x: (base + lp.lx) * H_GAP, y: lp.y });
  }
  return byId.size ? pos : new Map();
}
