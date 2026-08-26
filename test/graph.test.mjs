import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { addNode, getNode, labelFor, reset } from "../server/graph.mjs";

beforeEach(() => reset());

test("labelFor collapses whitespace", () => {
  assert.equal(labelFor("  hello   world \n"), "hello world");
});

test("labelFor truncates long prompts with an ellipsis", () => {
  const label = labelFor("x".repeat(100));
  assert.equal(label.length, 60); // 59 chars + "…"
  assert.ok(label.endsWith("…"));
});

test("labelFor of empty/nullish is an empty string", () => {
  assert.equal(labelFor(""), "");
  assert.equal(labelFor(null), "");
  assert.equal(labelFor(undefined), "");
});

test("addNode/getNode round-trips a node", () => {
  const node = addNode({ sessionId: "s1", parentId: null, prompt: "hi", result: "yo" });
  assert.equal(node.id, "s1");
  assert.equal(node.label, "hi");
  assert.equal(getNode("s1").result, "yo");
});

test("getNode returns null for an unknown id", () => {
  assert.equal(getNode("nope"), null);
});

test("finalResult defaults to the full result but keeps an explicit final block", () => {
  const joined = addNode({ sessionId: "f1", prompt: "hi", result: "narrate\n\nanswer" });
  assert.equal(joined.finalResult, "narrate\n\nanswer"); // falls back to result when unset
  const split = addNode({ sessionId: "f2", prompt: "hi", result: "narrate\n\nanswer", finalResult: "answer" });
  assert.equal(split.finalResult, "answer"); // detection keys on this, not the joined narration
});

test("the in-memory graph is bounded — oldest entries are evicted", () => {
  for (let i = 0; i < 250; i++) {
    addNode({ sessionId: `s${i}`, parentId: null, prompt: `p${i}`, result: "" });
  }
  // Cap is 200: the earliest inserts are gone, the latest survive.
  assert.equal(getNode("s0"), null);
  assert.ok(getNode("s249"));
});
