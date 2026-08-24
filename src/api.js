// Thin client over the local server. The browser only ever speaks to /api.

export async function fetchConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`config ${res.status}`);
  return res.json();
}

export async function fetchGraph() {
  const res = await fetch("/api/graph");
  if (!res.ok) throw new Error(`graph ${res.status}`);
  return res.json();
}

export async function resetGraph() {
  await fetch("/api/reset", { method: "POST" });
}

// Run a turn (seed if no parentId, fork otherwise) and stream it. The prompt is
// POSTed to register the turn (so long prompts don't hit URL limits); we then
// open an EventSource on the returned turnId.
// Callbacks: onToken(text) as tokens arrive, onNode(node) when the turn lands,
// onError(msg). Returns a function that aborts the turn — safe to call before the
// stream has even opened.
export function runTurn({ prompt, parentId = null, mode = "default", images = [] }, { onToken, onNode, onError, onPermission, onStart }) {
  let es = null;
  let aborted = false;

  (async () => {
    let turnId;
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, parentId, mode, images }),
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

// Switch a live turn to auto-approve: from now on the server allows every
// permission request for this turn (and any already waiting) without asking.
export async function setTurnAuto(turnId, enabled) {
  await fetch("/api/permission/auto", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnId, enabled }),
  });
}
