import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";

import NodeCard from "./NodeCard.jsx";
import ModeSelect from "./ModeSelect.jsx";
import PermPrompt from "./PermPrompt.jsx";
import Markdown from "./Markdown.jsx";
import { AttachButton, Thumbnails, filesToImages, MAX_IMAGES } from "./Attach.jsx";
import { layoutTree } from "./layout.js";
import { parseErrorPaste } from "./errorPaste.js";
import { findingItems, looksLikeReview } from "./findings.js";
import { answerPermission, fetchConfig, fetchGraph, resetGraph, runTurn, setPin, setTurnAuto } from "./api.js";

const nodeTypes = { canopy: NodeCard };

export default function App() {
  const [nodes, setNodes] = useState([]); // server nodes
  // Every in-flight turn, keyed by a temp id. Many can stream at once — one per
  // branch — so thinking on the right never blocks talking on the left.
  const [pendings, setPendings] = useState([]); // [{ tempId, parentId, label, result, perms }]
  const [selectedId, setSelectedId] = useState(null);
  // Opens the inspector on the right in an empty "new conversation" state — no
  // node selected yet, its composer seeds a fresh root. Cleared as soon as a real
  // node is selected (including the one the seeded turn creates).
  const [composingNew, setComposingNew] = useState(false);
  // The node whose exchange is currently scrolled into view in the inspector —
  // highlighted on the canvas so scrolling the thread tracks the tree. Kept
  // separate from selectedId so it never rebuilds the thread.
  const [inViewId, setInViewId] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState(""); // inspector's resume field
  // Screenshots attached to the next turn, one set per composer. Sent with the
  // prompt, then cleared — the server writes them to a temp file it reads from.
  const [composerImages, setComposerImages] = useState([]);
  const [replyImages, setReplyImages] = useState([]);
  // Permission mode is per conversation, keyed by root id — each tree remembers
  // its own. `newRootMode` is the choice for the next fresh conversation.
  // Claude Code's own permission modes: default | acceptEdits | plan | auto.
  const [modes, setModes] = useState({}); // rootId -> mode
  // A fresh conversation defaults to whatever the last one used, remembered
  // across reloads.
  const [newRootMode, setNewRootMode] = useState(() => {
    try {
      return localStorage.getItem("canopy.newRootMode") || "default";
    } catch {
      return "default";
    }
  });
  const [error, setError] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  // React Flow measures each node's size with a ResizeObserver and keeps it in
  // its OWN store — but it drops those dimensions every time the `nodes` prop is
  // rebuilt (see createNodeInternals). Since we rebuild `rfNodes` on every token,
  // an un-measured node renders `visibility:hidden` and vanishes. We cache the
  // measured size here (fed by onNodesChange) and merge it back onto each node so
  // rebuilt nodes stay "initialized" and visible. Keyed by node id.
  const [dims, setDims] = useState(() => new Map());
  // Which review nodes are broken out into per-finding cards. A node isn't in the
  // map → follow auto-detection (looksLikeReview); mapped to true/false → the user
  // forced it split or merged via the node's split button. Keyed by node id.
  const [splitOverride, setSplitOverride] = useState(() => new Map());
  const inputRef = useRef(null);
  const replyRef = useRef(null); // inspector's composer, focused for a new conversation
  const inspectorRef = useRef(null);
  const currentRef = useRef(null); // the selected exchange in the thread
  const rfRef = useRef(null); // ReactFlow instance, for imperative fitView
  const nextTemp = useRef(0);
  // Abort fns for in-flight turns, keyed by tempId, so we can stop them (kill the
  // server-side stream + CLI child) on reset instead of leaving them running.
  const aborters = useRef(new Map());
  // Real branches born by replying to a finding card: realSessionId -> finding
  // node id. Lineage-wise these fork the review session, but we hang them under
  // their finding card on the canvas so "the conversation about finding 2" reads
  // as a child of finding 2, not a sibling of it.
  const findingBranch = useRef(new Map());

  // Draggable inspector width, remembered across reloads.
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem("canopy.inspectorWidth"));
      if (v >= 300 && v <= 900) return v;
    } catch {}
    return 360;
  });
  const startResize = useCallback((e) => {
    e.preventDefault();
    let latest = inspectorWidth;
    const onMove = (ev) => {
      latest = Math.min(900, Math.max(300, window.innerWidth - ev.clientX));
      setInspectorWidth(latest);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("canopy.inspectorWidth", String(latest));
      } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [inspectorWidth]);

  const patchPending = useCallback((tempId, fn) => {
    setPendings((ps) => ps.map((p) => (p.tempId === tempId ? fn(p) : p)));
  }, []);

  // Paste a screenshot straight into a composer (Cmd/Ctrl+V). Returns a paste
  // handler bound to one of the attachment setters; a paste that carries no
  // image falls through untouched so text paste still works.
  const pasteImages = useCallback(
    (setImages) => async (e) => {
      const imgs = await filesToImages(e.clipboardData?.files || []);
      if (!imgs.length) return;
      e.preventDefault();
      setImages((prev) => [...prev, ...imgs].slice(0, MAX_IMAGES));
    },
    []
  );

  // Aim the composer at a node so the next prompt branches off it. Forking a
  // node that already has children splits the tree — the new branch is a sibling
  // of the existing one(s).
  const forkFrom = useCallback((id) => {
    setSelectedId(id);
    setPrompt("");
    inputRef.current?.focus();
  }, []);

  // Review replies broken out into findings: for each real node whose reply is a
  // findings list, the parsed items and whether it's currently shown as cards
  // (auto-detected, unless the user's split button overrode it). Pending/streaming
  // turns are excluded — a half-streamed list would flicker synthetic children.
  const findingInfo = useMemo(() => {
    const m = new Map();
    for (const n of nodes) {
      if (n.kind === "summary") continue;
      // Split on the turn's final answer block only — a review's findings live
      // there, not in the earlier narration/scratchpad that `result` also joins in.
      const src = n.finalResult ?? n.result;
      const items = findingItems(src);
      if (items.length < 2) continue;
      const auto = looksLikeReview(src, items);
      const shown = splitOverride.has(n.id) ? splitOverride.get(n.id) : auto;
      m.set(n.id, { items, shown });
    }
    return m;
  }, [nodes, splitOverride]);

  // Split/merge a review node's findings by hand — the fallback when auto-detect
  // misses a review (or fires on a list you'd rather keep whole).
  const toggleSplit = useCallback(
    (id) => {
      const cur = findingInfo.get(id)?.shown ?? false;
      setSplitOverride((prev) => {
        const next = new Map(prev);
        next.set(id, !cur);
        return next;
      });
    },
    [findingInfo]
  );

  const refresh = useCallback(async () => {
    const g = await fetchGraph();
    setNodes(g.nodes);
  }, []);

  // Pin/unpin a conversation from its summary header. A pinned tree survives the
  // recency limit, so it stays on the canvas however old it gets. Persisted
  // server-side, so we refresh to pick up which trees are now drawn.
  const togglePin = useCallback(
    async (rootId, pinned) => {
      await setPin(rootId, pinned);
      await refresh();
    },
    [refresh]
  );

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    fetchConfig().then((c) => setWorkspace(c.workspace)).catch(() => {});
  }, [refresh]);

  // Name the browser tab after the workspace so multiple instances are
  // distinguishable at a glance.
  useEffect(() => {
    document.title = workspace ? `🌳 ${workspace.split("/").pop()}` : "🌳 Canopy";
  }, [workspace]);

  // Clear the inspector reply (and its attachments) when switching nodes. Picking
  // a real node also drops the "new conversation" state — that node's thread takes
  // over the inspector (including the node a seeded turn just created).
  useEffect(() => {
    setReply("");
    setReplyImages([]);
    if (selectedId) setComposingNew(false);
  }, [selectedId]);

  // Focus the inspector's composer when a new conversation opens, so you can type
  // straight into the chat window on the right.
  useEffect(() => {
    if (composingNew) replyRef.current?.focus();
  }, [composingNew]);

  // When you pick a node (e.g. click it on the canvas), scroll the inspector to
  // that node's exchange so the thread jumps to the item you selected instead of
  // leaving you wherever you'd scrolled to.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "start" });
    setInViewId(selectedId);
  }, [selectedId]);

  // As the thread scrolls, highlight the tree node whose exchange sits at the top
  // of the inspector — the inverse of click-to-scroll above. offsetTop is
  // relative to the positioned .inspector, so it lines up with its scrollTop.
  const onInspectorScroll = useCallback(() => {
    const el = inspectorRef.current;
    if (!el) return;
    const marker = el.scrollTop + 100; // a little below the top edge
    let active = null;
    for (const ex of el.querySelectorAll(".exchange")) {
      if (ex.offsetTop <= marker) active = ex.dataset.nodeId;
      else break;
    }
    setInViewId(active);
  }, []);

  // Answer a permission prompt (requestId is globally unique) and drop it from
  // whichever pending node raised it.
  const onAnswer = useCallback((requestId, behavior, updatedInput) => {
    answerPermission(requestId, behavior, updatedInput);
    setPendings((ps) =>
      ps.map((p) => ({ ...p, perms: p.perms.filter((q) => q.requestId !== requestId) }))
    );
  }, []);

  // Persist React Flow's own dimension measurements. We only apply "dimensions"
  // changes (position/selection stay driven by our layout + `selected` field);
  // this is what keeps a rebuilt node carrying its width/height so it doesn't
  // flip to visibility:hidden mid-stream. Only re-render when a size truly
  // changed, so this never loops against the re-measure.
  const onNodesChange = useCallback((changes) => {
    setDims((prev) => {
      let next = null;
      for (const c of changes) {
        if (c.type !== "dimensions" || !c.dimensions) continue;
        const { width, height } = c.dimensions;
        const cur = prev.get(c.id);
        if (cur && cur.width === width && cur.height === height) continue;
        if (!next) next = new Map(prev);
        next.set(c.id, { width, height });
      }
      return next || prev;
    });
  }, []);

  // Merge every live pending turn into the set we lay out, so each streaming
  // branch appears immediately, in place, before its real session_id exists.
  const allNodes = useMemo(() => {
    // A branch spawned from a finding forks the review session, so its real
    // lineage parent is the review node — but on the canvas we re-parent it onto
    // its finding card so it reads as that finding's conversation.
    const list = nodes.map((n) => {
      const fp = findingBranch.current.get(n.id);
      return fp ? { ...n, parentId: fp } : n;
    });
    for (const p of pendings) {
      // A fresh root (no parent) has no persisted session yet, so the server
      // hasn't built its summary header. Synthesize one now from the opening
      // prompt so the green root shows immediately; the server's real summary
      // replaces it once the session persists.
      let parentId = p.parentId;
      if (!parentId) {
        parentId = `summary-${p.tempId}`;
        list.push({
          id: parentId,
          parentId: null,
          kind: "summary",
          label: p.label,
          rootId: p.tempId,
          pinned: false,
          pending: true, // not persisted yet — no pinning
          prompt: "",
          result: "",
          order: Infinity,
        });
      }
      list.push({
        id: p.tempId,
        parentId,
        label: p.label,
        prompt: p.label,
        result: p.result,
        perms: p.perms,
        turnId: p.turnId,
        auto: p.auto,
        images: p.images,
        streaming: true,
        order: Infinity,
      });
    }
    // Hang one child node under each shown review node, one per finding, holding
    // that finding's explanation. Like the summary headers these aren't Claude
    // sessions of their own — until you reply to one, which forks the review into
    // a real conversation scoped to that finding (see sendReply).
    for (const [reviewId, info] of findingInfo) {
      if (!info.shown) continue;
      const parent = nodes.find((n) => n.id === reviewId);
      info.items.forEach((it, i) => {
        list.push({
          id: `finding-${reviewId}-${i}`,
          parentId: reviewId,
          kind: "finding",
          finding: it,
          reviewId,
          label: it.headline,
          prompt: "",
          result: it.body, // the explanation is this node's content
          order: (parent?.order ?? 0) + (i + 1) / 1000,
        });
      });
    }
    return list;
  }, [nodes, pendings, findingInfo]);

  // Persistent per-tree horizontal slots, so a tree keeps its x position across
  // renders and forking one tree never shifts another.
  const treeSlots = useRef(new Map());
  // Bumped by "tidy" to force a fresh re-pack of the slots (see onTidy).
  const [tidyNonce, setTidyNonce] = useState(0);

  // Positions only depend on the tree shape, so keep the (relatively expensive)
  // layout out of the render path that reacts to selection/highlight changes.
  const layout = useMemo(() => {
    const pos = layoutTree(allNodes, treeSlots.current, dims);
    // Which nodes already have a child — the ⑂ button only makes sense there,
    // where it splits off a sibling branch. A leaf is continued via the composer.
    const hasChild = new Set(allNodes.map((n) => n.parentId).filter(Boolean));
    return { pos, hasChild };
  }, [allNodes, dims, tidyNonce]);

  // Tidy the forest: trees keep a slot assigned once and never re-packed, so a
  // tree that grows wider than its original slot ends up overlapping its
  // neighbour. Clearing the slot cache re-packs every tree left-to-right by its
  // current width on the next layout — no page refresh, so no conversations are
  // lost. Re-fit the camera afterwards since positions shift.
  const onTidy = useCallback(() => {
    treeSlots.current.clear();
    setTidyNonce((n) => n + 1);
    requestAnimationFrame(() => rfRef.current?.fitView({ duration: 300 }));
  }, []);

  const { rfNodes, rfEdges } = useMemo(() => {
    const { pos, hasChild } = layout;
    const rfNodes = allNodes.map((n) => ({
      id: n.id,
      type: "canopy",
      position: pos.get(n.id) || { x: 0, y: 0 },
      // Carry the last measured size so React Flow keeps this node "initialized"
      // (and visible) even though we hand it a brand-new object every render.
      ...(dims.get(n.id) || {}),
      data: {
        id: n.id,
        label: n.label,
        result: n.result,
        streaming: !!n.streaming,
        kind: n.kind,
        // Summary headers carry their tree's root id + pin state, so the header
        // can toggle whether this conversation stays on the canvas.
        rootId: n.rootId,
        pinned: n.pinned,
        // A synthetic header for a still-streaming root can't be pinned yet.
        pending: n.pending,
        onTogglePin: togglePin,
        // A finding card carries the finding it holds; selecting it opens the
        // finding in the inspector, where a reply forks the review to work on it.
        finding: n.finding,
        // Real review node whose reply is a findings list — offer split/merge, and
        // show whether it's currently broken out.
        canSplit: findingInfo.has(n.id),
        split: findingInfo.get(n.id)?.shown ?? false,
        onSplit: toggleSplit,
        // Detect a pasted stack trace so the card can headline the error instead
        // of showing a meaningless truncation of the raw blob.
        errorPaste: n.kind !== "summary" && n.kind !== "finding" ? parseErrorPaste(n.prompt) : null,
        tokens: n.tokens,
        perms: n.perms || [],
        // Real node (a pending turn has no session yet) that already branched.
        canFork: !n.streaming && n.kind !== "summary" && n.kind !== "finding" && hasChild.has(n.id),
        // Highlighted as the thread scrolls past its exchange (but not summaries).
        highlighted: n.id === inViewId && n.kind !== "summary",
        onAnswer,
        onFork: forkFrom,
      },
      selected: n.id === selectedId,
    }));
    const rfEdges = allNodes
      .filter((n) => n.parentId)
      .map((n) => ({
        id: `${n.parentId}->${n.id}`,
        source: n.parentId,
        target: n.id,
        animated: n.streaming,
      }));
    return { rfNodes, rfEdges };
  }, [allNodes, layout, selectedId, inViewId, onAnswer, forkFrom, toggleSplit, togglePin, findingInfo, dims]);

  // Camera: frame the canvas once, on the initial load, via ReactFlow's own
  // `fitView` prop — and then never move it automatically again. Every automatic
  // re-fit we tried caused a worse problem: fitting the whole forest on each turn
  // mis-framed it into a "collapsed to one node" view (fitView bails until every
  // node is measured), fitting just the current tree hid all the other trees, and
  // pinning a node let the layout slide out from under it. Leaving the viewport
  // alone is safe now that the layout is stable (see layout.js): each tree keeps a
  // fixed horizontal slot, so forking one never moves another. Pan and zoom with
  // the mouse or the Controls' fit button whenever you want to reframe.

  // Selection can point at a real node or a live pending turn, so the chat can
  // follow a branch the moment it's created.
  const selected = allNodes.find((n) => n.id === selectedId) || null;

  // Follow the stream: as tokens land on the selected node, keep the inspector
  // pinned to the bottom — but only if you're already near it, so scrolling up
  // to re-read something mid-stream doesn't get yanked back down.
  useEffect(() => {
    const el = inspectorRef.current;
    if (!el || !selected?.streaming) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [selected?.result, selected?.streaming]);

  // The full conversation leading to the selected node: root → … → selected,
  // one exchange (prompt + reply) per ancestor. This is what the inspector shows
  // so a branch reads as the whole thread, not just its last turn.
  const thread = useMemo(() => {
    if (!selected) return [];
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const chain = [];
    let cur = selected;
    while (cur && cur.kind !== "summary") {
      chain.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return chain;
  }, [selected, allNodes]);

  // Walk parent links to the root of whatever conversation a node belongs to.
  const rootOf = useCallback(
    (nodeId) => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      let cur = byId.get(nodeId);
      // Climb to the real root — stop before the synthetic summary header so
      // per-conversation modes stay keyed by the actual root session id.
      while (cur && cur.parentId && byId.has(cur.parentId)) {
        if (byId.get(cur.parentId).kind === "summary") break;
        cur = byId.get(cur.parentId);
      }
      return cur ? cur.id : null;
    },
    [nodes]
  );

  // The conversation the composer currently targets, and its mode. With a node
  // selected we edit that tree's mode; otherwise we're setting up a new root. A
  // pending node has no session id yet, so we key off its parent.
  const targetRoot = selected
    ? rootOf(
        selected.kind === "finding"
          ? selected.reviewId
          : selected.streaming
            ? selected.parentId
            : selected.id
      )
    : null;
  const currentMode = targetRoot ? modes[targetRoot] ?? "default" : newRootMode;

  const setCurrentMode = useCallback(
    (value) => {
      if (targetRoot) setModes((m) => ({ ...m, [targetRoot]: value }));
      else setNewRootMode(value);
    },
    [targetRoot]
  );

  // Run a turn: seed (parentId null) or continue/fork from a node (parentId set).
  // Streamed, and many can run concurrently — each tracked by its own tempId.
  const startTurn = useCallback(
    (parentId, rawText, images = [], opts = {}) => {
      const text = (rawText || "").trim();
      if (!text) return;

      // Where this branch appears on the canvas — its fork parent by default, but
      // a finding reply pins it under the finding card while forking the review.
      const displayParentId = opts.displayParentId ?? parentId;

      // The turn runs under its conversation's mode: an existing tree's stored
      // mode, or the chosen mode for a brand-new root.
      const root = parentId ? rootOf(parentId) : null;
      const turnMode = root ? modes[root] ?? "default" : newRootMode;

      // Remember this turn's mode as the default for the next fresh conversation.
      setNewRootMode(turnMode);
      try {
        localStorage.setItem("canopy.newRootMode", turnMode);
      } catch {}

      const tempId = `pending-${nextTemp.current++}`;
      setError(null);
      setPendings((ps) => [
        ...ps,
        { tempId, parentId: displayParentId, label: text, result: "", perms: [], turnId: null, auto: false, images },
      ]);
      // Follow the new branch in the chat as it streams.
      setSelectedId(tempId);

      const abort = runTurn(
        { prompt: text, parentId, mode: turnMode, images },
        {
          onStart: (turnId) => patchPending(tempId, (p) => ({ ...p, turnId })),
          onToken: (t) => patchPending(tempId, (p) => ({ ...p, result: p.result + t })),
          onPermission: (req) =>
            patchPending(tempId, (p) => ({ ...p, perms: [...p.perms, req] })),
          onNode: async (node) => {
            aborters.current.delete(tempId);
            // A finding reply keeps its display parent: remember the real session
            // -> finding card link so the reconstructed node re-parents onto it.
            if (opts.displayParentId && opts.displayParentId !== parentId) {
              findingBranch.current.set(node.id, opts.displayParentId);
            }
            // A new root carries the mode chosen for it into the modes map.
            if (!parentId) setModes((m) => ({ ...m, [node.id]: newRootMode }));
            // Bring in the real node BEFORE dropping the pending, so the selected
            // id never briefly points at a node that no longer exists. That gap
            // makes `selected` null for a frame, which unmounts the inspector and
            // throws the chat scroll back to the top.
            await refresh();
            // Hand selection from the temp id to the real node, then drop the
            // pending — batched into one render so selection is always valid.
            // Don't steal selection if you've since moved to a different branch
            // while this one was thinking.
            setSelectedId((cur) =>
              cur === null || cur === parentId || cur === tempId ? node.id : cur
            );
            setPendings((ps) => ps.filter((p) => p.tempId !== tempId));
          },
          onError: (msg) => {
            aborters.current.delete(tempId);
            setError(msg);
            setPendings((ps) => ps.filter((p) => p.tempId !== tempId));
          },
        }
      );
      aborters.current.set(tempId, abort);
    },
    [modes, newRootMode, rootOf, patchPending, refresh]
  );

  // Bottom composer: seed a root (nothing selected) or continue the selected node.
  const submit = useCallback(
    (parentId) => {
      startTurn(parentId, prompt, composerImages);
      setPrompt("");
      setComposerImages([]);
    },
    [startTurn, prompt, composerImages]
  );

  // Stop an in-flight turn: abort it (closes the stream, SIGTERMs the CLI child
  // server-side), drop the pending node, and fall selection back to the branch
  // it forked from — or deselect if it was a seeded root with no parent.
  const stopTurn = useCallback((tempId, parentId) => {
    aborters.current.get(tempId)?.();
    aborters.current.delete(tempId);
    setSelectedId((cur) => (cur === tempId ? parentId : cur));
    setPendings((ps) => ps.filter((p) => p.tempId !== tempId));
  }, []);

  // Switch a live turn to auto-approve so it stops prompting for permissions —
  // the escape hatch when you started a turn in manual mode by accident. Clears
  // any prompts already showing, since the server has just allowed them.
  const enableAuto = useCallback(
    (tempId, turnId) => {
      if (!turnId) return;
      setTurnAuto(turnId, true);
      patchPending(tempId, (p) => ({ ...p, auto: true, perms: [] }));
    },
    [patchPending]
  );

  // Inspector composer: continue the selected conversation from that node, or —
  // when the inspector is open for a new conversation — seed a fresh root.
  const sendReply = useCallback(() => {
    if (selected?.kind === "finding") {
      // The review session already holds the whole review (this finding included),
      // so forking it and naming the finding scopes the new branch to it. Put the
      // reference last so the node's label reads as what you actually typed.
      const scoped = `${reply}\n\n(Re: your review finding — ${selected.finding.headline})`;
      startTurn(selected.reviewId, scoped, replyImages, { displayParentId: selected.id });
    } else if (selectedId) startTurn(selectedId, reply, replyImages);
    else if (composingNew) startTurn(null, reply, replyImages);
    else return;
    setReply("");
    setReplyImages([]);
  }, [startTurn, selected, selectedId, composingNew, reply, replyImages]);

  const onReset = useCallback(async () => {
    // Stop every in-flight turn (closes its stream, kills the CLI child) before
    // clearing state, so nothing keeps running server-side after a reset.
    for (const abort of aborters.current.values()) abort();
    aborters.current.clear();
    findingBranch.current.clear();
    await resetGraph();
    setSelectedId(null);
    setPendings([]);
    setModes({});
    setComposerImages([]);
    setReplyImages([]);
    await refresh();
  }, [refresh]);

  // Start a fresh conversation: open the inspector on the right in its empty
  // "new conversation" state (deselect any node so its composer seeds a NEW root
  // tree — multiple roots live side by side on the canvas). The focus effect
  // above puts the cursor in the inspector's composer.
  const newConversation = useCallback(() => {
    setSelectedId(null);
    setComposingNew(true);
    setPrompt("");
    setComposerImages([]);
  }, []);


  const empty = nodes.length === 0 && pendings.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🌳 Canopy</div>
        <div className="hint">
          {empty ? "Seed a root to grow the tree" : "Select a node, then fork from it"}
        </div>
        {workspace && (
          <div className="workspace" title={`Every turn runs in ${workspace}`}>
            📁 {workspace.split("/").pop()}
          </div>
        )}
        <button onClick={newConversation}>＋ new conversation</button>
        <button className="ghost" onClick={onTidy} disabled={empty} title="Re-pack the trees so they stop overlapping">
          🧹 tidy
        </button>
        <button className="ghost" onClick={onReset} disabled={empty}>
          reset
        </button>
      </header>

      <div className="canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onInit={(inst) => (rfRef.current = inst)}
          onNodeClick={(_, n) => !n.id.startsWith("summary-") && setSelectedId(n.id)}
          onPaneClick={() => {
            setSelectedId(null);
            setComposingNew(false);
          }}
          fitView
          minZoom={0.15}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="#CDC1FF" />
          <MiniMap pannable zoomable nodeColor="#6E9E5B" maskColor="rgba(221,230,207,0.6)" />
          <Controls />
        </ReactFlow>
      </div>

      {/* Composer: seeds the root when empty / nothing selected, else forks. */}
      <div className="composer">
        {error && <div className="error">⚠ {error}</div>}
        <Thumbnails
          images={composerImages}
          onRemove={(id) => setComposerImages((p) => p.filter((img) => img.id !== id))}
        />
        <div className="composerRow">
          <span className="target">
            {empty
              ? "seed root"
              : selected
                ? `fork › ${selected.label}`
                : "seed a new root"}
          </span>
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit(selected ? selected.id : null)}
            onPaste={pasteImages(setComposerImages)}
            placeholder={selected ? "Ask this branch something new…" : "Start a conversation…"}
            autoFocus
          />
          <AttachButton
            onAdd={(imgs) => setComposerImages((p) => [...p, ...imgs].slice(0, MAX_IMAGES))}
          />
          <ModeSelect
            value={currentMode}
            onChange={setCurrentMode}
            title={
              targetRoot
                ? "Permission mode for this conversation"
                : "Permission mode for the new conversation"
            }
          />
          <button onClick={() => submit(selected ? selected.id : null)} disabled={!prompt.trim()}>
            {selected ? "fork" : "seed"}
          </button>
        </div>
      </div>

      {(selected || composingNew) && (
        <>
          {/* Full-height drag handle on the inspector's left edge. Lives outside
              the scrolling <aside> so it never scrolls out of reach. */}
          <div
            className="inspectorResizer"
            style={{ right: inspectorWidth }}
            onMouseDown={startResize}
            title="Drag to resize"
          >
            <div className="inspectorGrip" />
          </div>
          <aside
            ref={inspectorRef}
            className="inspector"
            style={{ width: inspectorWidth }}
            onScroll={onInspectorScroll}
          >
          <div className="inspectorHead">
            <span className="mono">
              {selected ? (selected.streaming ? "streaming…" : selected.kind === "finding" ? `finding ${selected.finding.n}` : selected.id.slice(0, 8)) : "new conversation"}
            </span>
            <button
              className="ghost"
              onClick={() => {
                setSelectedId(null);
                setComposingNew(false);
              }}
            >
              ✕
            </button>
          </div>
          <div className="thread">
            {thread.length === 0 && (
              <div className="muted" style={{ padding: "8px 4px" }}>
                Ask anything to start a new conversation.
              </div>
            )}
            {thread.map((n) =>
              n.kind === "finding" ? (
                // A finding pulled out of the review — its explanation, not a
                // prompt/reply pair. Reply below to fork the review and work on it.
                <div
                  key={n.id}
                  ref={n.id === selected.id ? currentRef : null}
                  data-node-id={n.id}
                  className={`exchange finding${n.id === selected.id ? " current" : ""}`}
                >
                  <div className="findingTag">◆ FINDING {n.finding.n}</div>
                  <div className="msg assistant">
                    <Markdown>{n.finding.body}</Markdown>
                  </div>
                </div>
              ) : (
              <div
                key={n.id}
                ref={n.id === selected.id ? currentRef : null}
                data-node-id={n.id}
                className={`exchange${n.id === selected.id ? " current" : ""}`}
              >
                <div className="msg user">{n.prompt || <span className="muted">—</span>}</div>
                {n.images?.length > 0 && (
                  <div className="thumbs threadThumbs">
                    {n.images.map((img) => (
                      <div className="thumb" key={img.id} title={img.name}>
                        <img src={img.dataUrl} alt={img.name} />
                      </div>
                    ))}
                  </div>
                )}
                <div className="msg assistant">
                  {n.result ? (
                    <Markdown>{n.result}</Markdown>
                  ) : (
                    !n.streaming && <span className="muted">—</span>
                  )}
                  {n.streaming && <span className="cursor">▋</span>}
                </div>
                {(n.perms || []).map((p) => (
                  <PermPrompt key={p.requestId} perm={p} onAnswer={onAnswer} />
                ))}
              </div>
              )
            )}
          </div>
          <div className="resume">
            <Thumbnails
              images={replyImages}
              onRemove={(id) => setReplyImages((p) => p.filter((img) => img.id !== id))}
            />
            <textarea
              ref={replyRef}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
              onPaste={pasteImages(setReplyImages)}
              placeholder={
                !selected
                  ? "Ask anything to start a new conversation…"
                  : selected.streaming
                    ? "Streaming… reply once it finishes"
                    : selected.kind === "finding"
                      ? "Reply to fork the review and work on this finding…"
                      : "Reply to continue this conversation…"
              }
              rows={3}
              disabled={!!selected?.streaming}
            />
            <div className="resumeControls">
              {selected?.streaming ? (
                <>
                  {selected.auto ? (
                    <span className="autoOn" title="Approving the rest of this turn's requests without asking">
                      ⚡ approving the rest
                    </span>
                  ) : (
                    <button
                      className="ghost"
                      onClick={() => enableAuto(selected.id, selected.turnId)}
                      disabled={!selected.turnId}
                      title="Stop prompting — approve the rest of this turn's permission requests without asking"
                    >
                      ⚡ stop asking, approve the rest
                    </button>
                  )}
                  <button
                    className="stopBtn"
                    onClick={() => stopTurn(selected.id, selected.parentId)}
                  >
                    ■ stop
                  </button>
                </>
              ) : (
                <>
                  <ModeSelect
                    value={currentMode}
                    onChange={setCurrentMode}
                    title="Permission mode for this conversation"
                  />
                  <div className="resumeActions">
                    <AttachButton
                      onAdd={(imgs) => setReplyImages((p) => [...p, ...imgs].slice(0, MAX_IMAGES))}
                    />
                    <button onClick={sendReply} disabled={!reply.trim()}>
                      Send
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          </aside>
        </>
      )}
    </div>
  );
}
