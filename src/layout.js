// Tidy-ish tree layout with no external dep. Given the flat node list from the
// server, assign each node an {x, y}: y by depth from its root, x by a left-to-
// right walk of the leaves, with parents centered over their children.
//
// Good enough for the scaffold; swap in dagre/elk later if trees get dense.

const H_GAP = 260; // horizontal spacing between sibling columns
const V_GAP = 150; // vertical spacing between depths

export function layoutTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map(nodes.map((n) => [n.id, []]));
  const roots = [];
  for (const n of nodes) {
    if (n.parentId && children.has(n.parentId)) children.get(n.parentId).push(n.id);
    else roots.push(n.id);
  }

  const pos = new Map();
  let cursor = 0; // next free leaf column

  function place(id, depth) {
    const kids = children.get(id);
    let x;
    if (kids.length === 0) {
      x = cursor++;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    pos.set(id, { x: x * H_GAP, y: depth * V_GAP });
    return x;
  }

  roots.forEach((r) => place(r, 0));
  return byId.size ? pos : new Map();
}
