// Canopy engine — the one seam that touches Claude Code.
//
// Generalizes spike.mjs into a reusable module: run a turn from scratch (seed a
// root) or forked from any existing session (--resume <id> --fork-session). The
// original session is never mutated; a fork always yields a NEW session_id, so
// the graph is built purely from what the CLI hands back.
//
// Permissions: a headless `claude -p` turn can't pop an approval prompt to a
// human. Instead we point it at our own MCP tool with --permission-prompt-tool;
// the CLI calls that tool for every permission decision, and the tool bridges
// back to the Canopy server (which asks the human in the UI). See
// server/permission-mcp.mjs for the other end of that bridge.

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Self-awareness: a bare `claude -p` has no idea it's rendered as a node in
// Canopy's tree, so domain words collide — "split these into nodes" gets read as
// "make Linear sub-issues", not "lay them out as branches". We append this to
// every turn's system prompt so the model knows where it lives, what the shared
// vocabulary means, and how the way it shapes a reply drives Canopy's structural
// features. Kept short and behavioral — enough to disambiguate, not a manual.
const CANOPY_PREAMBLE = `You are running inside **Canopy**, which renders this very conversation as a branching tree on a canvas. Each exchange — a prompt and your reply — is a **node** in that tree, and the human drives the work by forking, branching, and merging nodes visually rather than in a single linear chat.

This changes what some words mean. When the human says **node, branch, split into nodes, spin up, fan out, or merge**, they mean Canopy's tree — NOT objects in whatever system you happen to be working in (Linear issues, GitHub PRs, files, tests). "Split these into individual nodes" means "shape your reply so each becomes its own branch here," not "create tickets."

How you format a reply drives Canopy's features:
- **Fan-out → parallel branches.** When work divides into independent pieces the human could run at once, present them as a numbered list of parallel tracks with explicit framing (e.g. "I'll tackle these in parallel: 1. … 2. … 3. …"). Canopy surfaces a "spin up N branches" button that forks each item into its own concurrent turn.
- **Findings → cards.** When you review something, format problems as an explicit list ("### Finding 1: …", or "I found 3 issues: 1. … 2. …"). Canopy breaks each finding into its own card.
- **Merge.** Parallel branches can later be converged into one synthesis node, so proposing a split is often better than doing everything inline in one reply.

Prefer proposing structure over collapsing it: if the human asks for N things as nodes or branches, give N cleanly-numbered items, not one merged answer.`;

// Per-turn MCP config filename. Scoped by port so a startup sweep only ever
// touches this server instance's leftovers, never a sibling instance's.
const cfgPathFor = (port, turnId) => join(tmpdir(), `canopy-mcp-${port}-${turnId}.json`);

// Write a per-turn MCP config pointing at our stdio permission server. turnId +
// port are handed to that subprocess via env so it can call back to the right
// turn's SSE stream.
function writePermConfig({ turnId, port }) {
  const cfg = {
    mcpServers: {
      canopy: {
        command: process.execPath, // this same node binary
        args: [join(HERE, "permission-mcp.mjs")],
        env: { CANOPY_PORT: String(port), CANOPY_TURN_ID: turnId },
      },
    },
  };
  const path = cfgPathFor(port, turnId);
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

// Remove any per-turn configs this port leaked in a previous run (e.g. a crash
// that skipped the normal cleanup). Scoped to `port` so concurrent Canopy
// instances on other ports are left alone.
export function sweepStaleConfigs(port) {
  const prefix = `canopy-mcp-${port}-`;
  try {
    for (const f of readdirSync(tmpdir())) {
      if (f.startsWith(prefix) && f.endsWith(".json")) rmSync(join(tmpdir(), f), { force: true });
    }
  } catch {}
}

// Build the argv for a single `claude` turn.
//   parentId present => fork from that session (a branch)
//   parentId absent  => a fresh root
// mode is one of Claude Code's own permission modes (the VS Code picker names in
// parens), governing what's auto-approved before anything reaches our gate:
//   "default"          — Manual: prompt for every action (the gate handles all)
//   "acceptEdits"      — Edit automatically: edits land silently; other tools hit the gate
//   "plan"             — Plan: explore and present a plan before editing
//   "auto"             — Auto: a classifier approves safe actions, pausing (via the gate) for risky ones
// "bypassPermissions" is deliberately NOT accepted: it would let a turn run every
// tool with no gate at all, so it's never a mode Canopy will hand the CLI.
function buildArgs(prompt, { parentId = null, mcpConfigPath = null, mode = "default", stream = false } = {}) {
  const args = ["-p", prompt];

  // Tell every turn it's living in Canopy (see CANOPY_PREAMBLE) so the tree's
  // vocabulary — "node", "branch", "spin up", "merge" — isn't misread as objects
  // in whatever domain the turn is working in.
  args.push("--append-system-prompt", CANOPY_PREAMBLE);

  if (stream) {
    args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
  } else {
    args.push("--output-format", "json");
  }

  if (parentId) args.push("--resume", parentId, "--fork-session");

  // "default" is the CLI's own default, so we only pass the flag for the others.
  const VALID = new Set(["acceptEdits", "plan", "auto"]);
  if (VALID.has(mode)) args.push("--permission-mode", mode);

  if (mcpConfigPath) {
    // Route remaining permission decisions through our tool, and point the turn
    // at the workspace VS Code has open (edits land on disk either way — §3).
    // Under acceptEdits/bypass, anything already auto-approved never reaches it.
    args.push(
      "--mcp-config", mcpConfigPath,
      "--permission-prompt-tool", "mcp__canopy__approve",
      "--ide"
    );
  }
  return args;
}

// Run one turn streaming. `onEvent(evt)` fires for every stream-json event as it
// arrives; resolves with the final result object once the turn completes.
//
// When opts.turnId + opts.port are set, the turn runs with interactive
// permissions bridged to the Canopy server (the default for canvas turns).
export function runStream(prompt, opts = {}, onEvent = () => {}) {
  const cfgPath = opts.turnId ? writePermConfig({ turnId: opts.turnId, port: opts.port }) : null;
  const args = buildArgs(prompt, { ...opts, mcpConfigPath: cfgPath, mode: opts.mode, stream: true });

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
    let buf = "";
    let err = "";
    let final = null;

    // If the caller aborts (e.g. the browser disconnected), stop the turn so we
    // don't leave an orphaned `claude` process writing a half-finished session.
    const signal = opts.signal;
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (cfgPath) rmSync(cfgPath, { force: true });
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      // Emit each complete line; keep the trailing partial in `buf`.
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // ignore non-JSON noise
        }
        if (evt.type === "result") final = evt;
        onEvent(evt);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim()}`));
      if (!final) return reject(new Error("stream ended without a result event"));
      resolve(final);
    });
  });
}
