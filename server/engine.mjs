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
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

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
  const path = join(tmpdir(), `canopy-mcp-${turnId}.json`);
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

// Build the argv for a single `claude` turn.
//   parentId present => fork from that session (a branch)
//   parentId absent  => a fresh root
// mode is one of Claude Code's own permission modes (the VS Code picker names in
// parens), governing what's auto-approved before anything reaches our gate:
//   "default"          — Manual: prompt for every action (the gate handles all)
//   "acceptEdits"      — Edit automatically: edits land silently; other tools hit the gate
//   "plan"             — Plan: explore and present a plan before editing
//   "dontAsk"          — Auto: approve safe actions, pause (via the gate) for risky ones
//   "bypassPermissions"— allow everything, no prompts
function buildArgs(prompt, { parentId = null, mcpConfigPath = null, mode = "default", stream = false } = {}) {
  const args = ["-p", prompt];

  if (stream) {
    args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
  } else {
    args.push("--output-format", "json");
  }

  if (parentId) args.push("--resume", parentId, "--fork-session");

  // "default" is the CLI's own default, so we only pass the flag for the others.
  const VALID = new Set(["acceptEdits", "plan", "dontAsk", "bypassPermissions"]);
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

// Run one turn headless. Resolves with the parsed final-result JSON:
//   { session_id, result, ... } — see `claude -p --output-format json`.
export function run(prompt, opts = {}) {
  const args = buildArgs(prompt, { ...opts, stream: false });
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${err.trim() || out.trim()}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`could not parse claude JSON: ${e.message}\n---\n${out}`));
      }
    });
  });
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
