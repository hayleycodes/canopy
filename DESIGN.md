# Canopy — Design & Decisions

The distilled record of the founding brainstorm. Captures *what* was decided,
*why*, and what's been verified vs. still open. Read this before building.

---

## 1. The idea

A browser canvas showing Claude conversations as a **branching tree**. Fork from
any message and a new branch appears. Each node is a **one-sentence summary** of
that exchange (zoom in for the full text). Any branch can edit code through the
same Claude Code engine the VS Code extension uses — **you drive from the tree,
VS Code is where the hands are.**

The tree serves three jobs with the same structure, just shaped differently:

| Job | Gesture on the tree | Shape |
| --- | --- | --- |
| Explore alternatives | Fork many children from one node | A fan |
| Run parallel work | Several tall branches advancing at once | Multiple trunks |
| Think & synthesize | Fork wide, then merge back | Branch-then-converge |

They're not three apps — they're three gestures on one canvas.

## 2. Why it's possible

A Claude conversation is *already a tree* internally: every edit-and-resend or
retry forks history rather than mutating it; the linear UI just hides all
branches but one. Canopy visualizes structure that already exists.

## 3. Architecture (settled)

```
Browser (localhost)  →  Local Node server  →  Claude Code CLI  →  VS Code
   tree canvas           shells out, streams     account auth        --ide
```

- **Build on the Claude Code CLI, not the Agent SDK.** The SDK requires an API
  key; the CLI carries the user's **Anthropic account** auth. The user has
  accounts, not API access — so the CLI is the only permitted path. This single
  fact decides the whole stack.
- **Distribution: an open-source local app devs run themselves** (`npm start`,
  open localhost). NOT a hosted service — Anthropic disallows third-party apps
  offering account/claude.ai login. Each dev runs their own copy against their
  own account. This is the *only* permitted shape of "put it out to the world,"
  and it happens to be the same architecture we'd build anyway.
- **No Electron.** Audience is devs; a browser tab + local server is fine. A
  **Tauri** wrap is the named later upgrade, and it buys exactly one thing: a
  native "Open Folder…" dialog yielding a real filesystem path (a browser tab
  can't — its file APIs are sandboxed). It replaces the paste-a-path field and
  nothing else changes. Not a requirement; the CLI must be installed anyway, so
  Electron's bundle-a-runtime advantage is moot and Tauri's thin shell wins.
- **Stack:** Vite + React + a canvas lib (e.g. React Flow) front-end; a small
  local Node server that shells out to the CLI.

### The workspace model — one server, many repos (implemented)

You launch Canopy **once** and pick the repo from inside it, instead of running a
server-per-repo and juggling which port maps to which repo. The refactor that
made this true:

- **The server is stateless about workspace.** It no longer resolves one
  `WORKSPACE` at boot; every request names its repo (query param on GETs, body
  field on POSTs), validated to an existing directory. `--workspace` /
  `CANOPY_WORKSPACE` survive only as the *default* a fresh tab opens with.
- **Each browser tab pins itself to a repo via a `?ws=<path>` URL param.** The
  URL is per-tab, so **two repos on screen at once is just two tabs** — and the
  URL says which is which, which is the whole point (no more "which port?").
- **Switching a tab's repo is a navigation** to a new `?ws=`, i.e. a full reload.
  That tears down the old repo's canvas and in-flight turns for free, so there's
  no hand-written teardown to get wrong.
- **Everything that persists was already keyed by workspace path on disk** — the
  CLI's own transcripts under `~/.claude/projects/<encoded>/`, plus Canopy's
  pins/lineage/archives under `~/.canopy/`. So switching is just pointing the
  reads at another path; nothing had to migrate. The only in-memory state that
  needed keying was the node backfill cache (now one tree per workspace).
- **A recent-repos list** (`~/.canopy/recent.json`) feeds the in-app switcher.
  Opening a repo is: pick a recent one, or paste a path (the seam a Tauri folder
  dialog replaces later).

### The fork primitive (verified native)

```bash
claude -p "<prompt>" --output-format json                    # seed, capture session_id
claude -p "<prompt>" --resume <id> --fork-session            # BRANCH (original untouched)
claude -p "<prompt>" --output-format stream-json --include-partial-messages   # live tokens
```

### The VS Code seam

`claude --ide` connects to VS Code via a lock file at
`~/.claude/ide/<port>.lock` (contains port + auth token + workspace folders).
The connection is **loopback-only, same-user** — inherently local.
The native in-editor **diff panel is extension-only**; an external driver
renders its own diffs (edits still land on disk, so VS Code shows them as git
changes regardless).

## 4. The worktree model (user's decision)

A worktree is a property of the **branch**, not a mode of the app.

- **Most branches share the main worktree** — "several chats, one repo," mostly
  thinking. Collision risk (two branches editing the same files at once) is the
  user's judgment call; the app may *warn* but not forbid.
- **A branch can be promoted to its own git worktree** — an isolated checkout —
  to build without stepping on anything else.
- Both coexist in one tree. The tree then visualizes not just conversation shape
  but **workspace** shape: which worktree am I looking at, which branches share
  it.

Consequences to design for:
1. **Where VS Code points.** "Make this branch active" sometimes means "point
   VS Code at this branch's worktree." Shared-main branches don't move VS Code;
   worktree branches do.
2. **The lifecycle:** branch starts in main → promote to worktree → build in
   isolation → `git merge` back. This is the "git-for-chat" idea, grounded in
   real worktrees instead of metaphor.

## 5. Verified on the user's machine (2026-08-23)

Claude Code CLI **v2.1.241**, Node **v24**, VS Code running with the extension.

### `spike.mjs` — ✅ PASSED
Seeded a root session, forked it **twice in parallel** into divergent follow-ups.
Result: three distinct session IDs, root ID preserved on both forks, branches
genuinely diverged. **The forkable-tree spine is real, and parallel forks work.**

### `spike-ide.mjs` — ✅ PARTIAL (one finding)
A forked branch run with `claude -p --ide --permission-mode acceptEdits`
**created a file in the live VS Code workspace** — the core "hands in the editor"
capability. ✅

BUT: `mcp__ide__getDiagnostics` reported **"no active IDE/MCP connection"**.
So headless `-p --ide` **writes to disk but does not hold the live extension
link open** — the deeper awareness (diagnostics, selection) didn't connect.

**Takeaway — VS Code hands come in two tiers:**

| Capability | Status | Needs |
| --- | --- | --- |
| Edit files in the open workspace | ✅ Works | Just a working dir VS Code has open |
| Live IDE link (diagnostics, selection) | ⚠️ Unproven | Something headless `--ide` isn't doing |

The everyday value — a branch changes your code, you see it in VS Code — is the
first tier, and it's proven. The second tier is an isolated known-unknown.

## 6. Open questions

- **IDE awareness:** does an *interactive* (non-`-p`) session, or a persistent
  held-open connection, unlock diagnostics/selection? Investigate before
  relying on those features.
- **Merging conversations:** `git merge` handles the files; combining the
  *context* of two threads is the genuinely novel design question.
- **Node granularity:** is a node one exchange (user+assistant) or a single
  message? Ripples through the whole visual.
- **Context cost made visible:** a deep branch drags its whole ancestor path as
  context — the tree can make token cost legible (prune, summarize a subtree
  into one node, "reset context here").

## 7. What proves the idea, in order

1. ✅ Forking → real tree
2. ✅ Editing the open workspace
3. ◻︎ Generalize fork (any node, any depth) + streaming
4. ◻︎ Local server (session graph) + React tree stub — *becomes the app*
5. ◻︎ IDE-awareness investigation
6. ◻︎ Worktree promotion + merge-back
