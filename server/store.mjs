// Read-through view over Claude Code's own session store.
//
// Canopy doesn't persist conversations — the CLI already does, as JSONL
// transcripts under ~/.claude/projects/<encoded-workspace>/<session-id>.jsonl.
// This module reconstructs the fork tree straight from those files so a restart
// loses nothing (and conversations started outside Canopy show up too).
//
// Fork lineage isn't stored explicitly, but a fork DUPLICATES its ancestor's
// messages with identical uuids — so a session is a child of whichever other
// session's message-uuid list is the longest strict prefix of its own.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS = join(homedir(), ".claude", "projects");

// Locate the project dir for a workspace. The CLI encodes the path by replacing
// non-alphanumerics with "-"; if that guess misses, fall back to matching the
// `cwd` recorded inside the transcripts.
function projectDir(workspace) {
  const guess = join(PROJECTS, workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  if (existsSync(guess)) return guess;
  if (!existsSync(PROJECTS)) return null;
  for (const name of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, name);
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const cwd = firstCwd(join(dir, f));
      if (cwd === workspace) return dir;
    }
  }
  return null;
}

// Does a session (by id) exist on disk for this workspace? Used to validate a
// fork parent that may live only on disk (e.g. started in VS Code, or from
// before this server started) and was never in the in-memory graph.
export function sessionExists(workspace, id) {
  const dir = projectDir(workspace);
  return !!dir && existsSync(join(dir, `${id}.jsonl`));
}

function firstCwd(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const cwd = JSON.parse(line).cwd;
      if (cwd) return cwd;
    }
  } catch {}
  return null;
}

// Text out of a message.content that may be a string or an array of blocks.
function textOf(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  return "";
}

// Parse one transcript into the bits we need to place it in the tree.
function parseSession(path, id) {
  const msgs = []; // ordered main-chain messages: { uuid, role, text }
  let title = null;
  let firstTs = null;
  let lastTs = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.timestamp) {
      if (!firstTs) firstTs = d.timestamp;
      if (!lastTs || d.timestamp > lastTs) lastTs = d.timestamp;
    }
    if (d.type === "ai-title" && d.aiTitle) title = d.aiTitle;
    if ((d.type === "user" || d.type === "assistant") && d.uuid && !d.isSidechain) {
      msgs.push({ uuid: d.uuid, role: d.type, text: textOf(d.message) });
    }
  }
  return { id, msgs, uuids: msgs.map((m) => m.uuid), title, firstTs, lastTs };
}

// Reconstruct the workspace's forest as { nodes, edges }, matching the shape the
// in-memory graph produces so the client is unchanged. `limit` keeps only the N
// most recently active trees (a busy day can create dozens; older ones are still
// on disk and resumable, just not drawn).
export function loadWorkspaceGraph(workspace, limit = 5) {
  const dir = projectDir(workspace);
  if (!dir) return { nodes: [], edges: [] };

  let sessions = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const s = parseSession(join(dir, f), f.slice(0, -6));
      if (s.msgs.length) sessions.push(s);
    } catch {}
  }

  // Parent = the other session whose full uuid list is the longest strict
  // prefix of this one's.
  const isPrefix = (a, b) => a.length < b.length && a.every((u, i) => u === b[i]);
  for (const s of sessions) {
    let parent = null;
    for (const other of sessions) {
      if (other === s) continue;
      if (isPrefix(other.uuids, s.uuids)) {
        if (!parent || other.uuids.length > parent.uuids.length) parent = other;
      }
    }
    s.parentId = parent ? parent.id : null;
    s.parentLen = parent ? parent.uuids.length : 0;
  }

  // Keep only the `limit` most recently active trees. A tree's activity is the
  // latest timestamp anywhere in it; children are collected from its root.
  const children = new Map(sessions.map((s) => [s.id, []]));
  for (const s of sessions) if (s.parentId) children.get(s.parentId)?.push(s.id);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const subtreeMax = (id) => {
    let m = byId.get(id).lastTs || "";
    for (const c of children.get(id) || []) {
      const cm = subtreeMax(c);
      if (cm > m) m = cm;
    }
    return m;
  };
  if (limit > 0) {
    const roots = sessions.filter((s) => !s.parentId);
    const keepRoots = roots
      .map((r) => ({ id: r.id, act: subtreeMax(r.id) }))
      .sort((a, b) => b.act.localeCompare(a.act))
      .slice(0, limit)
      .map((r) => r.id);
    const keep = new Set();
    const collect = (id) => {
      keep.add(id);
      for (const c of children.get(id) || []) collect(c);
    };
    keepRoots.forEach(collect);
    sessions = sessions.filter((s) => keep.has(s.id));
  }

  const byTime = (a, b) => (a.firstTs || "").localeCompare(b.firstTs || "");
  sessions.sort(byTime);

  const nodes = sessions.map((s, i) => {
    // This node's own turn is the tail after the shared ancestor prefix.
    const tail = s.msgs.slice(s.parentLen);
    const prompt = tail.find((m) => m.role === "user")?.text || "";
    const lastAssistant = [...tail].reverse().find((m) => m.role === "assistant");
    // Prefer this node's own new prompt (distinctive per fork); aiTitle is
    // conversation-level and repeats across a tree's branches.
    const clean = prompt.replace(/\s+/g, " ").trim();
    const label = clean.slice(0, 60) || s.title || "(untitled)";
    return {
      id: s.id,
      parentId: s.parentId,
      order: i,
      prompt,
      label,
      result: lastAssistant?.text || "",
    };
  });

  // A synthetic summary node above each tree's root: a one-line sense of what the
  // tree is about, drawn from Claude's own conversation title — the most recently
  // active branch's title wins, so it evolves as the tree grows. Falls back to
  // the root's opening prompt.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const treeTitle = (rootId) => {
    const subs = [];
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      if (byId.get(id)) subs.push(byId.get(id));
      for (const c of children.get(id) || []) stack.push(c);
    }
    const titled = subs
      .filter((s) => s.title)
      .sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""));
    return (
      titled[0]?.title ||
      byId.get(rootId)?.title ||
      nodeById.get(rootId)?.label ||
      "Conversation"
    );
  };

  const summaries = [];
  for (const n of nodes) {
    if (n.parentId) continue; // real roots only
    const sumId = `summary-${n.id}`;
    summaries.push({
      id: sumId,
      parentId: null,
      kind: "summary",
      order: n.order - 0.5,
      prompt: "",
      result: "",
      label: treeTitle(n.id),
    });
    n.parentId = sumId; // the root now hangs beneath its summary
  }

  const outNodes = [...summaries, ...nodes];
  const edges = outNodes
    .filter((n) => n.parentId)
    .map((n) => ({ id: `${n.parentId}->${n.id}`, source: n.parentId, target: n.id }));

  return { nodes: outNodes, edges };
}
