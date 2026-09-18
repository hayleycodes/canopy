import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutTree } from "../src/layout.js";

test("empty input yields an empty map", () => {
  assert.equal(layoutTree([]).size, 0);
});

test("a lone root sits at the origin", () => {
  const pos = layoutTree([{ id: "r", parentId: null }]);
  assert.deepEqual(pos.get("r"), { x: 0, y: 0 });
});

test("children drop one depth and a parent centers over them", () => {
  const pos = layoutTree([
    { id: "r", parentId: null },
    { id: "a", parentId: "r" },
    { id: "b", parentId: "r" },
  ]);
  // Leaves take consecutive columns; depth sets y.
  assert.deepEqual(pos.get("a"), { x: 0, y: 150 });
  assert.deepEqual(pos.get("b"), { x: 260, y: 150 });
  // Parent x is the midpoint of its children's columns.
  assert.deepEqual(pos.get("r"), { x: 130, y: 0 });
});

test("a newer sibling lands to the right of an older one", () => {
  // `b` is authored before `a` in the array but has a higher `order` (created
  // later), so it should sit in the rightmost column — not wherever it appears
  // in the flat list.
  const pos = layoutTree([
    { id: "r", parentId: null, order: 0 },
    { id: "b", parentId: "r", order: 2 },
    { id: "a", parentId: "r", order: 1 },
  ]);
  assert.deepEqual(pos.get("a"), { x: 0, y: 150 });
  assert.deepEqual(pos.get("b"), { x: 260, y: 150 });
});

test("a pending child (order Infinity) lands rightmost", () => {
  const pos = layoutTree([
    { id: "r", parentId: null, order: 0 },
    { id: "pending", parentId: "r", order: Infinity },
    { id: "a", parentId: "r", order: 1 },
    { id: "b", parentId: "r", order: 2 },
  ]);
  assert.equal(pos.get("a").x, 0);
  assert.equal(pos.get("b").x, 260);
  assert.equal(pos.get("pending").x, 520);
});

test("trees pack left-to-right by creation order regardless of array order", () => {
  // `old` has the lowest order but is listed last; it should still sit leftmost.
  const pos = layoutTree([
    { id: "new1", parentId: null, order: 5 },
    { id: "new2", parentId: null, order: 9 },
    { id: "old", parentId: null, order: 1 },
  ]);
  // Separate trees sit a column plus the half-column TREE_GAP apart (1.5 * 260).
  assert.equal(pos.get("old").x, 0);
  assert.equal(pos.get("new1").x, 390);
  assert.equal(pos.get("new2").x, 780);
});

test("a reused slots map is repacked, so archiving a tree closes the gap", () => {
  const slots = new Map();
  layoutTree(
    [
      { id: "a", parentId: null, order: 1 },
      { id: "b", parentId: null, order: 2 },
      { id: "c", parentId: null, order: 3 },
    ],
    slots,
  );
  // Archive the middle tree: `b` is gone, so `c` slides left into its column
  // rather than leaving a hole where `b` was.
  const pos = layoutTree(
    [
      { id: "a", parentId: null, order: 1 },
      { id: "c", parentId: null, order: 3 },
    ],
    slots,
  );
  assert.equal(pos.get("a").x, 0);
  assert.equal(pos.get("c").x, 390);
});

test("a node whose parent is absent is treated as its own root", () => {
  const pos = layoutTree([{ id: "orphan", parentId: "missing" }]);
  assert.deepEqual(pos.get("orphan"), { x: 0, y: 0 });
});
