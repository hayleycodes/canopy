# 🌳 Canopy

A visual, branching interface for Claude conversations.

Normal chat is linear — one scroll, top to bottom. But thinking is *branchy*:
you go down a path, hit a dead end, want to back up and try something else.
Canopy shows every conversation as a **tree** you can pan and zoom. Fork from
any node and a new branch appears. And because it drives the **Claude Code**
engine, any branch can edit the code in your open workspace — you drive from the
tree instead of the editor.

> Status: **working prototype.** The local server + tree canvas run; you can
> seed conversations, fork branches, stream replies, and approve edits with a
> diff preview. See the roadmap for what's still open.

## Why it can exist

A Claude conversation is *already a tree* internally — every edit-and-resend or
retry forks history; the linear UI just hides every branch but one. Canopy
exposes structure that already exists. The fork is a real, documented Claude
Code flag (`--fork-session`), not something we invent.

## How it's wired

Everything runs on **your own machine**, against **your own Anthropic account** —
nothing hosted. That's what keeps it inside Anthropic's terms (third-party apps
may not offer account login as a hosted service; a local tool you run yourself
is fine).

```
Browser (localhost:5173)   the tree canvas — pan, zoom, fork, chat, approve
        │  /api (SSE)
Local Node server (:8787)  reconstructs the tree from disk, shells out to the CLI
        │
Claude Code CLI            carries your ACCOUNT auth (no API key). --fork-session = branch
        │
~/.claude/projects/…       the CLI's own session transcripts = the source of truth
```

We build on the **CLI**, not the Agent SDK: the SDK requires an API key, the CLI
runs on your Claude account. That single fact decides the architecture.

## What it does

- **Trees you can fork.** Every turn is a node; fork any node to split a branch.
  Run several branches at once — they stream concurrently, so thinking on one
  never blocks another.
- **Reads from Claude Code's own store.** Canopy doesn't keep its own copy of
  your chats — it reconstructs the fork tree straight from
  `~/.claude/projects/<workspace>/*.jsonl` (matching branches by their shared
  message ids). So a restart loses nothing, and conversations you started
  outside Canopy show up too. It draws the 5 most recently active trees
  (`CANOPY_MAX_TREES` to change).
- **A chat panel per branch.** Click a node to read the full thread from its
  root, reply to continue it, and watch the reply stream in. Drag the panel edge
  to resize it.
- **Permissions, with a diff.** Each conversation has its own permission mode
  (Manual / Edit automatically / Plan / Auto). When a turn wants to edit a file
  or run a command, you see the **diff** and Allow / Deny it — right in the tree.
- **Edits your open workspace.** Turns run in a target repo and write to disk, so
  changes show up in the VS Code window you have open on that folder.

## Requirements

- **Node** (developed on v24)
- **Claude Code CLI** installed and logged in (`claude` on your PATH)
- **VS Code** open on the target repo, for the editor-hands features

## Running

```bash
npm install

# Start server + web. Canopy opens on a default repo (the one you launched from,
# or CANOPY_WORKSPACE if set) — you switch repos in-app from there.
CANOPY_WORKSPACE=/path/to/your/project npm run dev
```

Open **http://localhost:5173**. (With no `CANOPY_WORKSPACE`, the default is the
directory you launched from.) The web app is on `:5173` and proxies `/api` to
the server on `:8787`.

Seed a conversation in the composer, click a node to open its chat, and use the
`⑂` button (or reply in the chat) to branch.

### Multiple repos

You launch Canopy **once** and pick the repo from inside it — no running a server
per project, no juggling which port maps to which repo. Switch the current tab's
repo from the **📁 switcher** in the top bar (a recently-opened list, or paste a
path).

Each tab pins its repo in the URL as `?ws=/path/to/repo`, so **two repos on
screen at once is just two tabs**: open a second tab and switch it to another
repo — both talk to the same server on `:8787`, and the URL tells you which tab
is which.

## Running the spikes

The spikes proved the core seams before the app existed. Run them from a folder
VS Code currently has open:

```bash
node spike.mjs      # forking produces a real tree (root → two parallel branches)
node spike-ide.mjs  # a forked branch edits the workspace VS Code has open
```

See [DESIGN.md](./DESIGN.md) for what each proved — and the one thing that
didn't (live IDE diagnostics in headless mode).

## Known limits

- **Headless sessions aren't listed in VS Code's history panel.** They're saved
  to the same store (resume one with `claude --resume <id>`), but the extension
  filters out `-p`/SDK sessions by design.
- **Write previews show the new content, not a diff against the existing file**
  (edits show a true diff).
- **Canopy metadata isn't persisted** — permission modes and layout live in
  memory; only the conversations (on disk) survive a restart.

## Name

*Canopy* — the whole spreading tree seen from above, which is exactly the
zoomed-out view. Evokes the tree without borrowing the Claude trademark.
