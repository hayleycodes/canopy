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

// Run a turn (seed if no parentId, fork otherwise) and stream it.
// Callbacks: onToken(text) as tokens arrive, onNode(node) when the turn lands,
// onError(msg). Returns a function that aborts the stream.
export function runTurn({ prompt, parentId = null, mode = "default" }, { onToken, onNode, onError, onPermission }) {
  const params = new URLSearchParams({ prompt });
  if (parentId) params.set("parentId", parentId);
  if (mode !== "default") params.set("mode", mode);

  const es = new EventSource(`/api/stream?${params.toString()}`);

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

  return () => es.close();
}

// Answer a permission prompt the server raised. behavior: "allow" | "deny".
export async function answerPermission(requestId, behavior) {
  await fetch("/api/permission/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, behavior }),
  });
}
