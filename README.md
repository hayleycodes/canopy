# 🌳 Canopy

A visual, branching interface for Claude conversations.

Normal chat is linear — one scroll, top to bottom. But thinking is *branchy*:
you go down a path, hit a dead end, want to back up and try something else.
Canopy shows every conversation as a **tree** you can pan and zoom. Fork from
any point and watch a new branch appear. Each node is a one-sentence summary.
And because it drives the **Claude Code** engine, any branch can edit the code
in your open VS Code window — you drive from the tree instead of the editor.

> Status: **early spike.** The two make-or-break capabilities are verified
> (see [DESIGN.md](./DESIGN.md)); the real app isn't built yet.

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
Browser (localhost)      the tree canvas — pan, zoom, fork, switch
        │
Local Node server        shells out to the Claude Code CLI, streams results back
        │
Claude Code CLI          carries your ACCOUNT auth (no API key). --fork-session = branch
        │
VS Code                  spawned with --ide; edits land in your open workspace
```

We build on the **CLI**, not the Agent SDK: the SDK requires an API key, the CLI
runs on your Claude account. That single fact decides the architecture.

## Requirements

- **Node** (developed on v24)
- **Claude Code CLI** installed and logged in (`claude` on your PATH)
- **VS Code** with the Claude Code extension, for the editor-hands features

## Running the spikes

The spikes prove the core seams before any UI exists.

```bash
# 1. Forking produces a real tree (root → two divergent branches, in parallel)
node spike.mjs

# 2. A forked branch edits the workspace VS Code has open.
#    Run this from a folder VS Code currently has open.
node spike-ide.mjs
```

See [DESIGN.md](./DESIGN.md) for what each spike proved — and the one thing that
didn't work (live IDE diagnostics in headless mode).

## Roadmap (rough)

- [x] Prove forking → a real session tree
- [x] Prove a branch can edit the open VS Code workspace
- [ ] Solve live IDE awareness (diagnostics / selection) — currently unproven
- [ ] Generalize: fork from any node, arbitrary depth, streaming node output
- [ ] Local server holding the session graph + a React tree canvas
- [ ] Per-branch git worktrees for isolated parallel building
- [ ] Merge branches back together

## Name

*Canopy* — the whole spreading tree seen from above, which is exactly the
zoomed-out view. Evokes the tree without borrowing the Claude trademark.
