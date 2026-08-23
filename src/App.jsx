import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";

import NodeCard from "./NodeCard.jsx";
import ModeSelect from "./ModeSelect.jsx";
import PermPrompt from "./PermPrompt.jsx";
import Markdown from "./Markdown.jsx";
import { AttachButton, Thumbnails, filesToImages, MAX_IMAGES } from "./Attach.jsx";
import { layoutTree } from "./layout.js";
import { answerPermission, fetchConfig, fetchGraph, resetGraph, runTurn, setTurnAuto } from "./api.js";

const nodeTypes = { canopy: NodeCard };

export default function App() {
  const [nodes, setNodes] = useState([]); // server nodes
  // Every in-flight turn, keyed by a temp id. Many can stream at once — one per
  // branch — so thinking on the right never blocks talking on the left.
  const [pendings, setPendings] = useState([]); // [{ tempId, parentId, label, result, perms }]
  const [selectedId, setSelectedId] = useState(null);
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
  const [newRootMode, setNewRootMode] = useState("default");
  const [error, setError] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const inputRef = useRef(null);
  const inspectorRef = useRef(null);
  const currentRef = useRef(null); // the selected exchange in the thread
  const rfRef = useRef(null); // ReactFlow instance, for imperative fitView
  const nextTemp = useRef(0);
  // Abort fns for in-flight turns, keyed by tempId, so we can stop them (kill the
  // server-side stream + CLI child) on reset instead of leaving them running.
  const aborters = useRef(new Map());

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

  const refresh = useCallback(async () => {
    const g = await fetchGraph();
    setNodes(g.nodes);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    fetchConfig().then((c) => setWorkspace(c.workspace)).catch(() => {});
  }, [refresh]);

  // Clear the inspector reply (and its attachments) when switching nodes.
  useEffect(() => {
    setReply("");
    setReplyImages([]);
  }, [selectedId]);

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
  const onAnswer = useCallback((requestId, behavior) => {
    answerPermission(requestId, behavior);
    setPendings((ps) =>
      ps.map((p) => ({ ...p, perms: p.perms.filter((q) => q.requestId !== requestId) }))
    );
  }, []);

  // Merge every live pending turn into the set we lay out, so each streaming
  // branch appears immediately, in place, before its real session_id exists.
  const allNodes = useMemo(() => {
    const list = [...nodes];
    for (const p of pendings) {
      list.push({
        id: p.tempId,
        parentId: p.parentId,
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
    return list;
  }, [nodes, pendings]);

  // Positions only depend on the tree shape, so keep the (relatively expensive)
  // layout out of the render path that reacts to selection/highlight changes.
  const layout = useMemo(() => {
    const pos = layoutTree(allNodes);
    // Which nodes already have a child — the ⑂ button only makes sense there,
    // where it splits off a sibling branch. A leaf is continued via the composer.
    const hasChild = new Set(allNodes.map((n) => n.parentId).filter(Boolean));
    return { pos, hasChild };
  }, [allNodes]);

  const { rfNodes, rfEdges } = useMemo(() => {
    const { pos, hasChild } = layout;
    const rfNodes = allNodes.map((n) => ({
      id: n.id,
      type: "canopy",
      position: pos.get(n.id) || { x: 0, y: 0 },
      data: {
        id: n.id,
        label: n.label,
        result: n.result,
        streaming: !!n.streaming,
        kind: n.kind,
        perms: n.perms || [],
        // Real node (a pending turn has no session yet) that already branched.
        canFork: !n.streaming && n.kind !== "summary" && hasChild.has(n.id),
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
  }, [allNodes, layout, selectedId, inViewId, onAnswer, forkFrom]);

  // The layout uses one global cursor, so starting, forking, or finishing a turn
  // — even in a different tree — reflows tree x-positions and can slide the one
  // you're looking at out of the viewport. `fitView` otherwise only runs on
  // mount, so re-fit whenever a node is added/removed OR moves. Keyed on ids +
  // positions (not result), so streamed tokens — which move nothing — don't
  // refit. Deferred a frame so ReactFlow has measured the changed nodes first;
  // fitting synchronously here reads a stale node set and mis-frames the canvas.
  const layoutSig = rfNodes
    .map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`)
    .join("|");
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (!rfRef.current || !layoutSig) return;
    // The fitView prop already handles the first paint; skip that one.
    if (!didInitialFit.current) {
      didInitialFit.current = true;
      return;
    }
    const raf = requestAnimationFrame(() =>
      rfRef.current?.fitView({ duration: 300, padding: 0.2 })
    );
    return () => cancelAnimationFrame(raf);
  }, [layoutSig]);

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
    ? rootOf(selected.streaming ? selected.parentId : selected.id)
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
    (parentId, rawText, images = []) => {
      const text = (rawText || "").trim();
      if (!text) return;

      // The turn runs under its conversation's mode: an existing tree's stored
      // mode, or the chosen mode for a brand-new root.
      const root = parentId ? rootOf(parentId) : null;
      const turnMode = root ? modes[root] ?? "default" : newRootMode;

      const tempId = `pending-${nextTemp.current++}`;
      setError(null);
      setPendings((ps) => [
        ...ps,
        { tempId, parentId, label: text, result: "", perms: [], turnId: null, auto: false, images },
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

  // Inspector reply: continue the selected conversation from that node.
  const sendReply = useCallback(() => {
    if (!selectedId) return;
    startTurn(selectedId, reply, replyImages);
    setReply("");
    setReplyImages([]);
  }, [startTurn, selectedId, reply, replyImages]);

  const onReset = useCallback(async () => {
    // Stop every in-flight turn (closes its stream, kills the CLI child) before
    // clearing state, so nothing keeps running server-side after a reset.
    for (const abort of aborters.current.values()) abort();
    aborters.current.clear();
    await resetGraph();
    setSelectedId(null);
    setPendings([]);
    setModes({});
    setComposerImages([]);
    setReplyImages([]);
    await refresh();
  }, [refresh]);

  // Start a fresh conversation: deselect so the composer seeds a NEW root tree
  // (multiple roots live side by side on the canvas), and focus the input.
  const newConversation = useCallback(() => {
    setSelectedId(null);
    setPrompt("");
    setComposerImages([]);
    inputRef.current?.focus();
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
        <button className="ghost" onClick={onReset} disabled={empty}>
          reset
        </button>
      </header>

      <div className="canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onInit={(inst) => (rfRef.current = inst)}
          onNodeClick={(_, n) => !n.id.startsWith("summary-") && setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          minZoom={0.15}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="#CDC1FF" />
          <MiniMap pannable zoomable nodeColor="#A594F9" maskColor="rgba(229,217,242,0.6)" />
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

      {selected && (
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
            <span className="mono">{selected.streaming ? "streaming…" : selected.id.slice(0, 8)}</span>
            <button className="ghost" onClick={() => setSelectedId(null)}>
              ✕
            </button>
          </div>
          <div className="thread">
            {thread.map((n) => (
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
            ))}
          </div>
          <div className="resume">
            <Thumbnails
              images={replyImages}
              onRemove={(id) => setReplyImages((p) => p.filter((img) => img.id !== id))}
            />
            <textarea
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
                selected.streaming ? "Streaming… reply once it finishes" : "Reply to continue this conversation…"
              }
              rows={3}
              disabled={selected.streaming}
            />
            <div className="resumeControls">
              {selected.streaming ? (
                <>
                  {selected.auto ? (
                    <span className="autoOn" title="This turn approves actions automatically">
                      ⚡ auto-approving
                    </span>
                  ) : (
                    <button
                      className="ghost"
                      onClick={() => enableAuto(selected.id, selected.turnId)}
                      disabled={!selected.turnId}
                      title="Stop prompting — approve the rest of this turn's actions automatically"
                    >
                      ⚡ auto-approve
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
