// Canopy local server — holds the session graph and is the only thing that
// shells out to Claude Code. The browser never touches the CLI directly.
//
// Everything runs on localhost, against the user's own account auth carried by
// the CLI. No API key, nothing hosted. (See DESIGN.md §3.)
//
// Endpoints:
//   GET  /api/config              — server config (which workspace turns run in)
//   GET  /api/graph               — the whole session tree as JSON
//   GET  /api/stream?prompt&...    — run a turn (seed or fork) over SSE, live tokens
//   POST /api/reset               — clear the in-memory graph
//   POST /api/permission/ask       — (from the MCP gate) raise a prompt, block for it
//   POST /api/permission/answer    — (from the UI) resolve a pending prompt
//
// A turn with no parentId seeds a root; with parentId it forks that node.

import { createServer } from "node:http";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runStream } from "./engine.mjs";
import { addNode, getNode, snapshot, reset } from "./graph.mjs";
import { loadWorkspaceGraph, sessionExists } from "./store.mjs";

const PORT = process.env.PORT || 8787;
// Show only the N most recently active trees so a busy day's conversations don't
// bury the canvas (older ones stay on disk, resumable). Override with env.
const MAX_TREES = Number(process.env.CANOPY_MAX_TREES || 5);

// Live turns and their in-flight permission prompts. A turn's SSE stream is how
// we raise a prompt to the human; a pending entry is the promise the MCP gate is
// blocked on until they click. Both are keyed so answers route back correctly.
const activeTurns = new Map(); // turnId    -> SSE `send` fn
const pendingPerms = new Map(); // requestId -> { resolve, input, turnId }

// The repo every turn operates in — where forks read/edit code and where a
// future --ide connection points. Resolve once at startup so it's unambiguous.
//   --workspace <path>  >  CANOPY_WORKSPACE  >  where the server was launched
function resolveWorkspace() {
  const flagIdx = process.argv.indexOf("--workspace");
  const raw =
    (flagIdx !== -1 && process.argv[flagIdx + 1]) || process.env.CANOPY_WORKSPACE || process.cwd();
  return resolve(raw);
}
const WORKSPACE = resolveWorkspace();

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// Pull whatever assistant text we can out of a stream-json event. The exact
// shape shifts across CLI versions, so we stay loose and best-effort — the
// authoritative final text always arrives on the terminal `result` event.
function extractToken(evt) {
  // Anthropic streaming delta (content_block_delta) surfaced through the CLI.
  if (evt.type === "stream_event" && evt.event?.delta?.text) return evt.event.delta.text;
  if (evt.delta?.text) return evt.delta.text;
  // Whole assistant message chunk.
  const content = evt.message?.content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === "text").map((c) => c.text).join("");
  }
  return "";
}

// GET /api/stream — the workhorse. Seeds or forks, streams tokens as SSE, and on
// completion records the new node in the graph and emits it.
async function handleStream(req, res, url) {
  const prompt = url.searchParams.get("prompt");
  const parentId = url.searchParams.get("parentId") || null;
  const mode = url.searchParams.get("mode") || "default";

  if (!prompt) return sendJson(res, 400, { error: "prompt is required" });
  // The parent may live only on disk (started in VS Code, or before this server
  // came up) and never entered the in-memory graph — accept either source.
  if (parentId && !getNode(parentId) && !sessionExists(WORKSPACE, parentId)) {
    return sendJson(res, 404, { error: `unknown parentId: ${parentId}` });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Swallow socket errors: once the client disconnects, writes to this response
  // emit EPIPE/ECONNRESET, which would otherwise crash the whole server.
  res.on("error", () => {});

  // Guarded write — never touch the socket after the client is gone.
  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };

  // Register this turn so the MCP permission gate can raise prompts on it.
  const turnId = randomUUID();
  activeTurns.set(turnId, send);
  send("start", { parentId, turnId });

  // If the browser goes away mid-turn, abort the turn (kills the CLI child so it
  // isn't orphaned) and deny anything still waiting on a permission decision.
  const ac = new AbortController();
  req.on("close", () => {
    ac.abort();
    activeTurns.delete(turnId);
    for (const [id, p] of pendingPerms) {
      if (p.turnId === turnId) {
        pendingPerms.delete(id);
        p.resolve({ behavior: "deny", message: "Canopy turn ended" });
      }
    }
  });

  try {
    const final = await runStream(
      prompt,
      { parentId, mode, turnId, port: PORT, cwd: WORKSPACE, signal: ac.signal },
      (evt) => {
        const token = extractToken(evt);
        if (token) send("token", { text: token });
      }
    );

    const node = addNode({
      sessionId: final.session_id,
      parentId,
      prompt,
      result: final.result ?? "",
    });
    send("node", node);
  } catch (e) {
    send("error", { message: e.message });
  } finally {
    activeTurns.delete(turnId);
    res.end();
  }
}

// POST /api/permission/ask — the MCP gate calls this for each tool decision. We
// raise it to the human over the turn's SSE stream and hold the HTTP response
// open until they answer (or the turn ends).
async function handlePermissionAsk(req, res) {
  const { turnId, requestId, tool_name, input } = await readBody(req);
  const send = activeTurns.get(turnId);
  if (!send) return sendJson(res, 200, { behavior: "deny", message: "no active turn" });

  send("permission", { requestId, tool_name, input });

  const decision = await new Promise((resolve) => {
    pendingPerms.set(requestId, { resolve, input, turnId });
  });
  sendJson(res, 200, decision);
}

// POST /api/permission/answer — the UI's Allow/Deny click lands here.
async function handlePermissionAnswer(req, res) {
  const { requestId, behavior } = await readBody(req);
  const pend = pendingPerms.get(requestId);
  if (pend) {
    pendingPerms.delete(requestId);
    pend.resolve(
      behavior === "allow"
        ? { behavior: "allow", updatedInput: pend.input ?? {} }
        : { behavior: "deny", message: "Denied in Canopy" }
    );
  }
  sendJson(res, 200, { ok: true });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, { workspace: WORKSPACE });
  }
  if (req.method === "GET" && url.pathname === "/api/graph") {
    // Disk (the CLI's own transcripts) is the source of truth, so restarts lose
    // nothing. The in-memory graph only backfills a just-finished turn whose
    // .jsonl hasn't flushed to disk yet.
    const disk = loadWorkspaceGraph(WORKSPACE, MAX_TREES);
    const have = new Set(disk.nodes.map((n) => n.id));
    const extra = snapshot().nodes.filter((n) => !have.has(n.id));
    const nodes = [...disk.nodes, ...extra];
    const edges = nodes
      .filter((n) => n.parentId)
      .map((n) => ({ id: `${n.parentId}->${n.id}`, source: n.parentId, target: n.id }));
    return sendJson(res, 200, { nodes, edges });
  }
  if (req.method === "GET" && url.pathname === "/api/stream") {
    return handleStream(req, res, url);
  }
  if (req.method === "POST" && url.pathname === "/api/reset") {
    reset();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/permission/ask") {
    return handlePermissionAsk(req, res);
  }
  if (req.method === "POST" && url.pathname === "/api/permission/answer") {
    return handlePermissionAnswer(req, res);
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`🌳 Canopy server on http://localhost:${PORT}`);
  console.log(`   workspace: ${WORKSPACE}`);
});
