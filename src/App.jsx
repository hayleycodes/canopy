import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";

import NodeCard from "./NodeCard.jsx";
import ModeSelect from "./ModeSelect.jsx";
import PermPrompt from "./PermPrompt.jsx";
import { layoutTree } from "./layout.js";
import { answerPermission, fetchConfig, fetchGraph, resetGraph, runTurn } from "./api.js";

const nodeTypes = { canopy: NodeCard };

export default function App() {
  const [nodes, setNodes] = useState([]); // server nodes
  // Every in-flight turn, keyed by a temp id. Many can stream at once — one per
  // branch — so thinking on the right never blocks talking on the left.
  const [pendings, setPendings] = useState([]); // [{ tempId, parentId, label, result, perms }]
  const [selectedId, setSelectedId] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState(""); // inspector's resume field
  // Permission mode is per conversation, keyed by root id — each tree remembers
  // its own. `newRootMode` is the choice for the next fresh conversation.
  // Claude Code's own permission modes: default | acceptEdits | plan | dontAsk.
  const [modes, setModes] = useState({}); // rootId -> mode
  const [newRootMode, setNewRootMode] = useState("default");
  const [error, setError] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const inputRef = useRef(null);
  const nextTemp = useRef(0);

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

  // Clear the inspector reply when switching to a different node.
  useEffect(() => setReply(""), [selectedId]);

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
        streaming: true,
        order: Infinity,
      });
    }
    return list;
  }, [nodes, pendings]);

  const { rfNodes, rfEdges } = useMemo(() => {
    const pos = layoutTree(allNodes);
    // Which nodes already have a child — the ⑂ button only makes sense there,
    // where it splits off a sibling branch. A leaf is continued via the composer.
    const hasChild = new Set(allNodes.map((n) => n.parentId).filter(Boolean));
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
  }, [allNodes, selectedId, onAnswer, forkFrom]);

  // Selection can point at a real node or a live pending turn, so the chat can
  // follow a branch the moment it's created.
  const selected = allNodes.find((n) => n.id === selectedId) || null;

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
    (parentId, rawText) => {
      const text = (rawText || "").trim();
      if (!text) return;

      // The turn runs under its conversation's mode: an existing tree's stored
      // mode, or the chosen mode for a brand-new root.
      const root = parentId ? rootOf(parentId) : null;
      const turnMode = root ? modes[root] ?? "default" : newRootMode;

      const tempId = `pending-${nextTemp.current++}`;
      setError(null);
      setPendings((ps) => [...ps, { tempId, parentId, label: text, result: "", perms: [] }]);
      // Follow the new branch in the chat as it streams.
      setSelectedId(tempId);

      runTurn(
        { prompt: text, parentId, mode: turnMode },
        {
          onToken: (t) => patchPending(tempId, (p) => ({ ...p, result: p.result + t })),
          onPermission: (req) =>
            patchPending(tempId, (p) => ({ ...p, perms: [...p.perms, req] })),
          onNode: async (node) => {
            setPendings((ps) => ps.filter((p) => p.tempId !== tempId));
            // A new root carries the mode chosen for it into the modes map.
            if (!parentId) setModes((m) => ({ ...m, [node.id]: newRootMode }));
            await refresh();
            // Hand selection from the temp id to the real node; don't steal it if
            // you've since moved to a different branch while this one was thinking.
            setSelectedId((cur) =>
              cur === null || cur === parentId || cur === tempId ? node.id : cur
            );
          },
          onError: (msg) => {
            setError(msg);
            setPendings((ps) => ps.filter((p) => p.tempId !== tempId));
          },
        }
      );
    },
    [modes, newRootMode, rootOf, patchPending, refresh]
  );

  // Bottom composer: seed a root (nothing selected) or continue the selected node.
  const submit = useCallback(
    (parentId) => {
      startTurn(parentId, prompt);
      setPrompt("");
    },
    [startTurn, prompt]
  );

  // Inspector reply: continue the selected conversation from that node.
  const sendReply = useCallback(() => {
    if (!selectedId) return;
    startTurn(selectedId, reply);
    setReply("");
  }, [startTurn, selectedId, reply]);

  const onReset = useCallback(async () => {
    await resetGraph();
    setSelectedId(null);
    setPendings([]);
    setModes({});
    await refresh();
  }, [refresh]);

  // Start a fresh conversation: deselect so the composer seeds a NEW root tree
  // (multiple roots live side by side on the canvas), and focus the input.
  const newConversation = useCallback(() => {
    setSelectedId(null);
    setPrompt("");
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
        <div className="composer-row">
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
            placeholder={selected ? "Ask this branch something new…" : "Start a conversation…"}
            autoFocus
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
        <aside className="inspector" style={{ width: inspectorWidth }}>
          <div className="inspector-resizer" onMouseDown={startResize} />
          <div className="inspector-head">
            <span className="mono">{selected.streaming ? "streaming…" : selected.id.slice(0, 8)}</span>
            <button className="ghost" onClick={() => setSelectedId(null)}>
              ✕
            </button>
          </div>
          <div className="thread">
            {thread.map((n) => (
              <div
                key={n.id}
                className={`exchange${n.id === selected.id ? " current" : ""}`}
              >
                <div className="msg user">{n.prompt || <span className="muted">—</span>}</div>
                <div className="msg assistant">
                  {n.result || (n.streaming ? "" : <span className="muted">—</span>)}
                  {n.streaming && <span className="cursor">▋</span>}
                </div>
                {(n.perms || []).map((p) => (
                  <PermPrompt key={p.requestId} perm={p} onAnswer={onAnswer} />
                ))}
              </div>
            ))}
          </div>
          <div className="resume">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
              placeholder={
                selected.streaming ? "Streaming… reply once it finishes" : "Reply to continue this conversation…"
              }
              rows={3}
              disabled={selected.streaming}
            />
            <div className="resume-controls">
              <ModeSelect
                value={currentMode}
                onChange={setCurrentMode}
                title="Permission mode for this conversation"
              />
              <button onClick={sendReply} disabled={!reply.trim() || selected.streaming}>
                Send
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
