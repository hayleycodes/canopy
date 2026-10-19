import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseChains } from "../src/collapse.js";

// summary → a → b → c → d → e, with e forking into f and g.
const tree = [
  { id: "summary-a", parentId: null, kind: "summary", rootId: "a" },
  { id: "a", parentId: "summary-a" },
  { id: "b", parentId: "a" },
  { id: "c", parentId: "b" },
  { id: "d", parentId: "c" },
  { id: "e", parentId: "d" },
  { id: "f", parentId: "e" },
  { id: "g", parentId: "e" },
];
const ids = (nodes) => nodes.map((n) => n.id).sort();
// Fold these anchors as the app does: snapshot what each covers right now.
const fold = (graph, ...anchorIds) => {
  const { anchors } = collapseChains(graph, new Map());
  return new Map(anchorIds.map((id) => [id, new Set(anchors.get(id).ids)]));
};

test("nothing folded draws the tree as-is but reports every anchor", () => {
  const { nodes, anchors } = collapseChains(tree, new Map());
  assert.deepEqual(ids(nodes), ids(tree));
  // a and b have ≥2 foldable turns below (c only has d); only a is a top anchor.
  assert.deepEqual([...anchors.keys()], ["a", "b"]);
  assert.deepEqual(
    [...anchors].filter(([, v]) => v.top).map(([k]) => k),
    ["a"]
  );
});

test("folding a node hides the single-child run beneath it", () => {
  const { nodes } = collapseChains(tree, fold(tree, "a"));
  assert.deepEqual(ids(nodes), ["a", "chain-b", "e", "f", "g", "summary-a"]);
  const chain = nodes.find((n) => n.id === "chain-b");
  assert.equal(chain.parentId, "a");
  assert.equal(chain.anchorId, "a");
  assert.equal(chain.count, 3); // b, c, d
  assert.equal(nodes.find((n) => n.id === "e").parentId, "chain-b");
});

test("folding mid-chain keeps the anchor and folds only below it", () => {
  const { nodes } = collapseChains(tree, fold(tree, "b"));
  assert.deepEqual(ids(nodes), ["a", "b", "chain-c", "e", "f", "g", "summary-a"]);
});

test("an ancestor's fold swallows a nested one", () => {
  const { nodes } = collapseChains(tree, fold(tree, "a", "b"));
  assert.deepEqual(ids(nodes), ["a", "chain-b", "e", "f", "g", "summary-a"]);
});

test("a kept node splits the run, and a lone leftover doesn't fold", () => {
  const { nodes } = collapseChains(tree, fold(tree, "a"), new Set(["c"]));
  // b alone (run of 1) stays; d alone stays — nothing folds.
  assert.deepEqual(ids(nodes), ids(tree));
});

test("turns that arrive after folding stay visible", () => {
  // summary → a → b → c → d (leaf), folded at a; then the user replies at d.
  const before = tree.slice(0, 5);
  const folded = fold(before, "a");
  assert.deepEqual(ids(collapseChains(before, folded).nodes), ["a", "chain-b", "d", "summary-a"]);
  const after = [...before, { id: "x", parentId: "d" }, { id: "y", parentId: "x" }];
  // d now has a child, so it's foldable — but it wasn't covered by the fold.
  assert.deepEqual(ids(collapseChains(after, folded).nodes), ["a", "chain-b", "d", "summary-a", "x", "y"]);
});

test("a short tree has no anchors", () => {
  const short = tree.slice(0, 3); // summary → a → b
  assert.equal(collapseChains(short, new Map()).anchors.size, 0);
});
