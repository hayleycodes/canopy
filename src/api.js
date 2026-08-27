// Thin client over the local server. The browser only ever speaks to /api.

import { DEMO_GRAPH, DEMO_CONFIG } from "./demoData.js";

// Screenshot/demo mode: open the app with `?demo` and it renders a hardcoded
// dummy forest with no server or Claude CLI running (see demoData.js). Only the
// two read calls below are stubbed — enough to paint the canvas for a screenshot.
const DEMO =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("demo");

// Which repo this tab is for. One server serves any repo; each tab pins itself to
// a workspace via its ?ws= URL param, so two tabs can hold two repos at once and
// the URL says which is which. Null until the boot sequence resolves a default.
export function getWorkspace() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("ws");
}

export async function fetchConfig() {
  if (DEMO) return DEMO_CONFIG;
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`config ${res.status}`);
  return res.json();
}

// Validate a repo path and record it as recently-opened. Returns the canonical
// path to pin the tab to, plus the refreshed recent list. Used by the switcher.
export async function openWorkspace(path) {
  const res = await fetch("/api/workspaces/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `open ${res.status}`);
  }
  return res.json();
}

export async function fetchGraph(workspace) {
  if (DEMO) return DEMO_GRAPH;
  const res = await fetch(`/api/graph?workspace=${encodeURIComponent(workspace)}`);
  if (!res.ok) throw new Error(`graph ${res.status}`);
  return res.json();
}

export async function resetGraph(workspace) {
  await fetch("/api/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace }),
  });
}

// Run a turn (seed if no parentId, fork otherwise) and stream it. The prompt is
// POSTed to register the turn (so long prompts don't hit URL limits); we then
// open an EventSource on the returned turnId.
// Callbacks: onToken(text) as tokens arrive, onNode(node) when the turn lands,
// onError(msg). Returns a function that aborts the turn — safe to call before the
// stream has even opened.
export function runTurn({ prompt, parentId = null, mode = "default", images = [], workspace }, { onToken, onNode, onError, onPermission, onStart }) {
  let es = null;
  let aborted = false;

  (async () => {
    let turnId;
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, parentId, mode, images, workspace }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `turn ${res.status}`);
      }
      turnId = (await res.json()).turnId;
    } catch (e) {
      if (!aborted) onError?.(e.message);
      return;
    }
    if (aborted) return; // aborted while the POST was in flight
    // Hand the server turnId back so callers can act on the live turn (e.g.
    // switch it to auto-approve mid-flight).
    onStart?.(turnId);

    es = new EventSource(`/api/stream?turnId=${encodeURIComponent(turnId)}`);
    es.addEventListener("token", (e) => onToken?.(JSON.parse(e.data).text));
    es.addEventListener("permission", (e) => onPermission?.(JSON.parse(e.data)));
    es.addEventListener("node", (e) => {
      onNode?.(JSON.parse(e.data));
      es.close();
    });
    es.addEventListener("error", (e) => {
      // A payload means the server reported a turn error; otherwise it's a
      // transport drop (EventSource fires a bare error on close too).
      const msg = e.data ? JSON.parse(e.data).message : "stream disconnected";
      onError?.(msg);
      es.close();
    });
  })();

  return () => {
    aborted = true;
    es?.close();
  };
}

// Answer a permission prompt the server raised. behavior: "allow" | "deny".
// updatedInput (optional) overrides the tool input on allow — used by
// AskUserQuestion to feed the human's picks back as the tool's answers.
export async function answerPermission(requestId, behavior, updatedInput) {
  await fetch("/api/permission/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, behavior, updatedInput }),
  });
}

// Pin or unpin a conversation by its root id. A pinned tree stays on the canvas
// even after MAX_TREES newer conversations would otherwise push it off.
export async function setPin(rootId, pinned, workspace) {
  await fetch("/api/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootId, pinned, workspace }),
  });
}

// Archive or unarchive a conversation by its root id. An archived tree drops off
// the canvas (its transcript is kept) and shows in the drawer, where unarchiving
// brings it back.
export async function setArchive(rootId, archived, workspace) {
  await fetch("/api/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootId, archived, workspace }),
  });
}

// Switch a live turn to auto-approve: from now on the server allows every
// permission request for this turn (and any already waiting) without asking.
export async function setTurnAuto(turnId, enabled) {
  await fetch("/api/permission/auto", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnId, enabled }),
  });
}
