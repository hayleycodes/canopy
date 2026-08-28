// Dummy data for screenshots. Loaded only when the page URL carries `?demo`
// (see api.js), so the app renders a full, believable forest with no server and
// no Claude CLI running. Node shapes match what the server emits from
// /api/graph — summary headers (kind:"summary") with the real root hung beneath,
// each turn carrying prompt/result/tokens. Enough variety to show the features
// off: forks, a review that auto-splits into finding cards, a pinned tree, an
// error-paste node, and per-node token counts.

// A tree: its summary header + the nodes under it, wired by parentId. `order`
// keeps trees left-to-right in a predictable slot order.
function tree({ root, title, pinned = false, order, nodes }) {
  const summaryId = `summary-${root}`;
  return [
    { id: summaryId, parentId: null, kind: "summary", label: title, rootId: root, pinned, order },
    ...nodes.map((n) => ({
      ...n,
      parentId: n.parentId ?? summaryId, // the root hangs beneath its summary
      order: n.order ?? order,
    })),
  ];
}

const graph = [
  // ── Tree 1: a real fork — one prompt, two branches explored in parallel ──
  ...tree({
    root: "d1a11111",
    title: "Add a dark-mode toggle to settings",
    order: 0,
    nodes: [
      {
        id: "d1a11111",
        prompt: "Add a dark-mode toggle to the settings page",
        label: "Add a dark-mode toggle to the settings page",
        result:
          "Added a `ThemeToggle` to the settings panel. It flips a `data-theme` " +
          "attribute on `<html>` and the existing CSS variables do the rest — no " +
          "component-level changes needed.",
        tokens: { context: 18450, output: 1240 },
      },
      {
        id: "d1a22222",
        parentId: "d1a11111",
        prompt: "Persist the choice to localStorage",
        label: "Persist the choice to localStorage",
        result:
          "The toggle now reads `localStorage.theme` on mount and writes it on " +
          "change, falling back to the system preference the first time.",
        tokens: { context: 22100, output: 890 },
      },
      {
        id: "d1a33333",
        parentId: "d1a11111",
        prompt: "Actually — use a system-preference media query instead",
        label: "Actually — use a system-preference media query instead",
        result:
          "Dropped the manual toggle and switched to `@media (prefers-color-scheme: " +
          "dark)`. The theme now tracks the OS setting automatically; simpler, but " +
          "you lose the manual override.",
        tokens: { context: 21030, output: 1520 },
      },
      {
        id: "d1a44444",
        parentId: "d1a22222",
        prompt: "Add a test for the persistence",
        label: "Add a test for the persistence",
        result:
          "Added `theme.test.jsx`: it renders the toggle, clicks it, and asserts " +
          "`localStorage.theme === 'dark'`, then re-mounts and asserts the class " +
          "is restored. Passing.",
        tokens: { context: 24870, output: 760 },
      },
    ],
  }),

  // ── Tree 2: a review reply that auto-splits into per-finding cards ──
  ...tree({
    root: "d2b11111",
    title: "Review the payments diff",
    order: 1,
    nodes: [
      {
        id: "d2b11111",
        prompt: "Review the diff on the payments branch",
        label: "Review the diff on the payments branch",
        result:
          "Reviewed the diff — I found 3 issues:\n\n" +
          "1. **Race condition on retry** — `charge()` can double-charge when the " +
          "network retry fires before the first response lands. See server/pay.mjs:88.\n\n" +
          "2. **Missing idempotency key** — the Stripe call at server/pay.mjs:120 " +
          "doesn't pass an idempotency key, so a replayed request creates a second " +
          "charge.\n\n" +
          "3. **Unvalidated amount** — the client-supplied amount is trusted directly " +
          "at routes/checkout.js:45; a negative value would issue a refund.",
        tokens: { context: 41200, output: 2310 },
      },
    ],
  }),

  // ── Tree 3: pinned, started from a pasted stack trace, then fixed ──
  ...tree({
    root: "d3c11111",
    title: "Fix the TypeError in the tree renderer",
    pinned: true,
    order: 2,
    nodes: [
      {
        id: "d3c11111",
        prompt:
          "TypeError: Cannot read properties of undefined (reading 'map')\n" +
          "    at renderTree (src/App.jsx:334:22)\n" +
          "    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:15486:18)\n" +
          "    at mountIndeterminateComponent (node_modules/react-dom/cjs/react-dom.development.js:20103:13)",
        label: "TypeError: Cannot read properties of undefined",
        result:
          "`allNodes` was undefined on the first render before the graph loaded. " +
          "Guarded the map with `(allNodes ?? [])` and defaulted the state to an " +
          "empty array. The crash is gone.",
        tokens: { context: 15980, output: 640 },
      },
      {
        id: "d3c22222",
        parentId: "d3c11111",
        prompt: "Add a regression test that renders with an empty graph",
        label: "Add a regression test that renders with an empty graph",
        result:
          "Added a test that mounts `<App />` with an empty graph response and " +
          "asserts it renders the empty state instead of throwing. Green.",
        tokens: { context: 19240, output: 580 },
      },
    ],
  }),

  // ── Tree 4: a fan-out proposal — offers "⑂ spin up 3" to launch parallel branches ──
  ...tree({
    root: "d4d11111",
    title: "Make the review page update live",
    order: 3,
    nodes: [
      {
        id: "d4d11111",
        prompt: "go with option A. Also make the carousel glide, and the box still resizes after selecting a pig",
        label: "go with option A. Also make the carousel glide…",
        result:
          "This is three distinct pieces of work. Let me parallelize the " +
          "investigation — I'll have subagents dig into (1) the Realtime setup, " +
          "(2) the glide animation, and (3) the resize bug.\n\n" +
          "## 1. Live updates — Supabase Realtime\n\n" +
          "`sighting-candidates.service.ts:42` — add a `subscribeToPendingCandidates()` " +
          "channel and reconcile incoming rows against local state.\n\n" +
          "## 2. Gliding carousel\n\n" +
          "Replace the single remounted card (`key={c.id}` forces a jarring swap) with " +
          "a track: all cards in a flex row inside a clipped viewport, translated on index.\n\n" +
          "## 3. The residual resize-on-select\n\n" +
          "`.reviewSave` reserves `min-height: 40px`, but the label baseline still nudges " +
          "the row a pixel on select. Always render the save row's contents and toggle " +
          "visibility instead of mounting/unmounting.",
        tokens: { context: 74000, output: 35000 },
      },
    ],
  }),
];

export const DEMO_GRAPH = { nodes: graph, edges: [] };
export const DEMO_CONFIG = {
  defaultWorkspace: "/Users/you/projects/acme-checkout",
  recent: ["/Users/you/projects/acme-checkout", "/Users/you/projects/acme-web"],
};
