import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";

import NodeCard from "./NodeCard.jsx";
import ModeSelect, { MODES } from "./ModeSelect.jsx";
import PermPrompt, { ResolvedQuestions } from "./PermPrompt.jsx";
import Markdown from "./Markdown.jsx";
import { AttachButton, Thumbnails, filesToImages, MAX_IMAGES } from "./Attach.jsx";
import { layoutTree } from "./layout.js";
import { parseErrorPaste } from "./errorPaste.js";
import { findingItems, looksLikeReview, fanoutItems } from "./findings.js";
import { answerPermission, fetchConfig, fetchGraph, getWorkspace, openWorkspace, resetGraph, runTurn, setArchive, setPin, setTurnAuto } from "./api.js";

const nodeTypes = { canopy: NodeCard };

// Stable empty-images identity so a draft with no attachments doesn't hand a
// fresh [] to consumers on every render.
const EMPTY_IMAGES = [];

// Replying to a finding card tags the prompt with this suffix (see sendReply),
// naming the finding it forked off. It's the durable record of that link — the
// server only knows the branch forked the review session, not which finding — so
// we read it back to re-hang the branch under its finding card. Anchored to the
// end so it survives whatever the user typed before it.
const FINDING_REPLY_RE = /\(Re: your review finding — (.+)\)\s*$/;

// A converge turn Canopy seeds to bring fanned-out branches back together carries
// this tag on its prompt. Like the finding tag it's the durable record — the
// server only knows this branch forked one sibling, not that it's a merge — so we
// read it back to (a) draw the gather edges from the other branches into it and
// (b) hide the parent's "merge" button once one exists. Holds across reloads with
// no separate bookkeeping. Anchored to the end so it survives the digest before it.
const MERGE_TAG_RE = /\(Canopy: merge\)\s*$/;
// A merge node's real prompt is a giant digest of every branch's output (fed to
// the model so it can combine them). We never want to *show* that wall of text —
// on the card and in the thread it reads as a short "Merging N branches…" line.
function mergePromptLabel(prompt) {
  const n = (prompt.match(/^—\s*Branch \d+ \(/gm) || []).length;
  return n > 0 ? `Merging ${n} branches…` : "Merging branches…";
}

// The repo switcher dropdown. A browser tab can't open a native folder dialog
// (that path needs a Tauri/Electron wrapper), so opening a repo is: pick a
// recently-opened one, or paste a path. Both route through onPick, which
// validates server-side and reloads the tab into the chosen repo.
function WorkspacePicker({ current, recent, onPick, onClose }) {
  const [path, setPath] = useState("");
  const others = (recent || []).filter((p) => p !== current);
  return (
    <div className="ws-picker" onClick={(e) => e.stopPropagation()}>
      <form
        className="ws-open"
        onSubmit={(e) => {
          e.preventDefault();
          onPick(path);
        }}
      >
        <input
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Open a repo by path…"
          onKeyDown={(e) => e.key === "Escape" && onClose()}
        />
        <button type="submit" disabled={!path.trim()}>Open</button>
      </form>
      {others.length > 0 && (
        <ul className="ws-recent">
          {others.map((p) => (
            <li key={p}>
              <button title={p} onClick={() => onPick(p)}>
                📁 {p.split("/").pop()}
                <span className="ws-path">{p}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  const [nodes, setNodes] = useState([]); // server nodes
  const [archivedList, setArchivedList] = useState([]); // [{ rootId, label }] off-canvas
  const [drawerOpen, setDrawerOpen] = useState(false);
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
  // Composer drafts, keyed by the conversation they target, so switching threads
  // — by hand, or when a background turn finishes in another tree — never loses
  // or misattributes a half-written message. Each entry is { text, images }; the
  // images are the screenshots attached to that draft's next turn, sent with the
  // prompt then cleared (the server writes them to a temp file it reads from).
  // The inspector reply is keyed by the selected node ("__new__" while composing
  // a fresh conversation); the bottom composer by the node it forks from
  // ("__root__" when seeding a new root).
  const [replyDrafts, setReplyDrafts] = useState(() => new Map());
  const [promptDrafts, setPromptDrafts] = useState(() => new Map());
  // Nodes whose turn finished while you were looking/typing elsewhere: surfaced
  // passively (a badge on the card + a toast) instead of yanking selection over.
  const [readyIds, setReadyIds] = useState(() => new Set());
  const [toasts, setToasts] = useState([]); // [{ id, nodeId, label }]
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
  // The repo this tab is for, from its ?ws= URL. Null until the boot sequence
  // resolves the server default for a tab that opened without one.
  const [workspace, setWorkspace] = useState(() => getWorkspace());
  const [recent, setRecent] = useState([]); // recently-opened repos, for the switcher
  const [switching, setSwitching] = useState(false); // repo switcher panel open
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
  // Review nodes whose fan-out proposal has already been spun up into branches, so
  // the "spin up N" button drops off and can't spawn duplicate branches. Session
  // state (like splitOverride) — the branches themselves persist server-side, so a
  // reload naturally leaves them in place with the button gone (its items are now
  // real children).
  const [spunUp, setSpunUp] = useState(() => new Set());
  const inputRef = useRef(null);
  const replyRef = useRef(null); // inspector's composer, focused for a new conversation
  const inspectorRef = useRef(null);
  const currentRef = useRef(null); // the selected exchange in the thread
  const rfRef = useRef(null); // ReactFlow instance, for imperative fitView
  const nextTemp = useRef(0);
  const toastSeq = useRef(0);
  // Live mirrors of selection + "am I mid-compose", read inside a turn's async
  // onNode (whose closure would otherwise see stale values) to decide whether
  // following a finished turn would steal selection from an active composer.
  const selectedIdRef = useRef(null);
  const composingRef = useRef(false);
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

  // Tokens can arrive faster than the screen refreshes; committing each to state
  // on its own re-renders the whole app per token, which compounds badly in a long
  // conversation. Buffer incoming text per turn and flush at most once per frame,
  // coalescing a burst into a single render. (During streaming a turn only ever
  // grows one trailing text segment — no Q&A is inserted client-side — so merging
  // a run of tokens is identical to applying them one by one.)
  const tokenBuf = useRef(new Map()); // tempId -> unflushed text
  const flushRaf = useRef(0);
  const flushTokens = useCallback(() => {
    flushRaf.current = 0;
    const buf = tokenBuf.current;
    if (buf.size === 0) return;
    const batch = new Map(buf);
    buf.clear();
    setPendings((ps) =>
      ps.map((p) => {
        const t = batch.get(p.tempId);
        if (!t) return p;
        const segments = [...(p.segments || [])];
        const last = segments[segments.length - 1];
        if (last && last.type === "text") {
          segments[segments.length - 1] = { type: "text", text: last.text + t };
        } else {
          const trimmed = t.replace(/^\n+/, "");
          if (trimmed) segments.push({ type: "text", text: trimmed });
        }
        return { ...p, result: p.result + t, segments };
      })
    );
  }, []);
  const pushToken = useCallback(
    (tempId, t) => {
      const buf = tokenBuf.current;
      buf.set(tempId, (buf.get(tempId) || "") + t);
      if (!flushRaf.current) flushRaf.current = requestAnimationFrame(flushTokens);
    },
    [flushTokens]
  );

  // Paste a screenshot straight into a composer (Cmd/Ctrl+V). Returns a paste
  // handler bound to a draft's add-images fn; a paste that carries no image
  // falls through untouched so text paste still works.
  const pasteImages = useCallback(
    (addImages) => async (e) => {
      const imgs = await filesToImages(e.clipboardData?.files || []);
      if (!imgs.length) return;
      e.preventDefault();
      addImages(imgs);
    },
    []
  );

  // Drag a screenshot straight onto a composer. `dragZone` names the container
  // currently under a file drag so it can highlight; the drop handler is bound
  // to a draft's add-images fn, mirroring pasteImages.
  const [dragZone, setDragZone] = useState(null);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const dragOver = useCallback(
    (zone) => (e) => {
      if (!hasFiles(e)) return; // let non-file drags (text selection) through
      e.preventDefault();
      setDragZone(zone);
    },
    []
  );
  const dragLeave = useCallback((e) => {
    // ignore moves between children of the same container
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragZone(null);
  }, []);
  const dropImages = useCallback(
    (addImages) => async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragZone(null);
      const imgs = await filesToImages(e.dataTransfer?.files || []);
      if (imgs.length) addImages(imgs);
    },
    []
  );

  // Where each composer's draft lives. The inspector reply follows the selected
  // node (or "__new__" while seeding a fresh conversation); the bottom composer
  // follows the node it would fork from (or "__root__" when nothing's selected).
  const replyKey = selectedId ?? (composingNew ? "__new__" : null);
  const promptKey = selectedId ?? "__root__";
  const reply = (replyKey && replyDrafts.get(replyKey)?.text) || "";
  const replyImages = (replyKey && replyDrafts.get(replyKey)?.images) || EMPTY_IMAGES;
  const prompt = promptDrafts.get(promptKey)?.text || "";
  const composerImages = promptDrafts.get(promptKey)?.images || EMPTY_IMAGES;

  // Merge a patch into one draft entry (or drop it entirely). `patch` is either
  // a partial { text?, images? } or a fn of the current entry.
  const patchDraft = useCallback((setMap, key, patch) => {
    if (!key) return;
    setMap((m) => {
      const cur = m.get(key) || { text: "", images: EMPTY_IMAGES };
      const nextEntry = typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
      const next = new Map(m);
      next.set(key, nextEntry);
      return next;
    });
  }, []);
  const clearDraft = useCallback((setMap, key) => {
    if (!key) return;
    setMap((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  const addImagesTo = (cur, imgs) => ({ ...cur, images: [...cur.images, ...imgs].slice(0, MAX_IMAGES) });
  const setReplyText = (text) => patchDraft(setReplyDrafts, replyKey, { text });
  const addReplyImages = (imgs) => patchDraft(setReplyDrafts, replyKey, (d) => addImagesTo(d, imgs));
  const removeReplyImage = (imgId) =>
    patchDraft(setReplyDrafts, replyKey, (d) => ({ ...d, images: d.images.filter((im) => im.id !== imgId) }));
  const setPromptText = (text) => patchDraft(setPromptDrafts, promptKey, { text });
  const addComposerImages = (imgs) => patchDraft(setPromptDrafts, promptKey, (d) => addImagesTo(d, imgs));
  const removeComposerImage = (imgId) =>
    patchDraft(setPromptDrafts, promptKey, (d) => ({ ...d, images: d.images.filter((im) => im.id !== imgId) }));

  // Aim the composer at a node so the next prompt branches off it. Forking a
  // node that already has children splits the tree — the new branch is a sibling
  // of the existing one(s).
  const forkFrom = useCallback((id) => {
    setSelectedId(id);
    clearDraft(setPromptDrafts, id);
    inputRef.current?.focus();
  }, [clearDraft]);

  // The node's "spin up" button lives in the rfNodes memo, which renders before
  // spinUp is declared (it needs startTurn, defined further down). Reach it through
  // a ref so the memo depends on this stable wrapper, not the not-yet-initialized
  // spinUp itself. spinUpRef is pointed at the latest spinUp by an effect below.
  const spinUpRef = useRef(null);
  const handleSpinUp = useCallback((id) => spinUpRef.current?.(id), []);
  // Same ref indirection for merge (mergeBranches is defined below startTurn, past
  // the rfNodes memo that wires this button).
  const mergeRef = useRef(null);
  const handleMerge = useCallback((id) => mergeRef.current?.(id), []);

  // Replies that *propose* fanning work out into parallel branches ("I'll have
  // subagents dig into (1)… (2)… (3)…"). For each such node, the parsed items — one
  // per proposed track. The node offers a "spin up N branches" button that forks
  // each item into a real concurrent turn (see spinUp). Same final-block source as
  // findings; streaming turns are excluded (a half-streamed plan would flicker).
  const fanoutInfo = useMemo(() => {
    const m = new Map();
    for (const n of nodes) {
      if (n.kind === "summary" || n.streaming) continue;
      const items = fanoutItems(n.finalResult ?? n.result);
      if (items.length >= 2) m.set(n.id, { items });
    }
    return m;
  }, [nodes]);

  // Review replies broken out into findings: for each real node whose reply is a
  // findings list, the parsed items and whether it's currently shown as cards
  // (auto-detected, unless the user's split button overrode it). Pending/streaming
  // turns are excluded — a half-streamed list would flicker synthetic children.
  const findingInfo = useMemo(() => {
    const m = new Map();
    for (const n of nodes) {
      if (n.kind === "summary") continue;
      // A fan-out proposal wins the node — it gets the spin-up button, not passive
      // finding cards. Both detectors can see the same numbered+cited reply, so
      // without this a proposal would also sprout inert cards.
      if (fanoutInfo.has(n.id)) continue;
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
  }, [nodes, splitOverride, fanoutInfo]);

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
    if (!workspace) return; // graph is per-repo; wait until this tab has one
    const g = await fetchGraph(workspace);
    setNodes(g.nodes);
    setArchivedList(g.archived || []);
  }, [workspace]);

  // Pin/unpin a conversation from its summary header. A pinned tree survives the
  // recency limit, so it stays on the canvas however old it gets. Persisted
  // server-side, so we refresh to pick up which trees are now drawn.
  const togglePin = useCallback(
    async (rootId, pinned) => {
      await setPin(rootId, pinned, workspace);
      await refresh();
    },
    [refresh, workspace]
  );

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

  // Archive/unarchive a conversation from its summary header (archive) or the
  // drawer (unarchive). Persisted server-side; refresh to pick up which trees are
  // now drawn and what's in the drawer. Archiving the selected tree deselects it
  // so the inspector doesn't dangle on a node that just left the canvas.
  const toggleArchive = useCallback(
    async (rootId, archived) => {
      await setArchive(rootId, archived, workspace);
      if (archived && rootOf(selectedId) === rootId) setSelectedId(null);
      await refresh();
    },
    [refresh, rootOf, selectedId, workspace]
  );

  // Boot: learn the server default + recent repos, and — for a tab that opened
  // with no ?ws= — pin it to the default and write that into the URL so the tab
  // is self-describing (and a reload keeps the same repo).
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setRecent(c.recent || []);
        if (!getWorkspace() && c.defaultWorkspace) {
          const u = new URL(window.location.href);
          u.searchParams.set("ws", c.defaultWorkspace);
          window.history.replaceState({}, "", u);
          setWorkspace(c.defaultWorkspace);
        }
      })
      .catch(() => {});
  }, []);

  // Load the graph once this tab knows its repo (and whenever that changes).
  useEffect(() => {
    if (workspace) refresh().catch((e) => setError(e.message));
  }, [workspace, refresh]);

  // Switch this tab to another repo. A repo change is a clean slate — the whole
  // canvas, selection, and any in-flight turns belong to the old repo — so we
  // navigate (full reload) rather than hand-tearing-down state. Two repos at once
  // is just two tabs. Validates + records the repo before navigating.
  const switchWorkspace = useCallback(async (path) => {
    const trimmed = (path || "").trim();
    if (!trimmed) return;
    try {
      const { workspace: ws } = await openWorkspace(trimmed);
      const u = new URL(window.location.href);
      u.searchParams.set("ws", ws);
      window.location.assign(u); // reload into the new repo
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // Name the browser tab after the workspace so multiple instances are
  // distinguishable at a glance.
  useEffect(() => {
    document.title = workspace ? `🌳 ${workspace.split("/").pop()}` : "🌳 Canopy";
  }, [workspace]);

  // Picking a real node drops the "new conversation" state — that node's thread
  // takes over the inspector (including the node a seeded turn just created).
  // Drafts are keyed per target, so switching nodes preserves each one rather
  // than clearing it. A newly selected node has been seen, so it's no longer
  // "ready".
  useEffect(() => {
    if (selectedId) setComposingNew(false);
  }, [selectedId]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (!selectedId) return;
    setReadyIds((s) => {
      if (!s.has(selectedId)) return s;
      const n = new Set(s);
      n.delete(selectedId);
      return n;
    });
  }, [selectedId]);

  // Keep the "mid-compose" mirror current so a finishing turn can tell whether
  // following it would blow away a message you're actively writing.
  useEffect(() => {
    composingRef.current = composingNew || reply.trim() !== "" || prompt.trim() !== "";
  }, [composingNew, reply, prompt]);

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

  // A turn finished in a tree you weren't watching: drop a dismissible toast that
  // jumps you there on click, and auto-clears after a while.
  const pushToast = useCallback((nodeId, label) => {
    const id = `toast-${toastSeq.current++}`;
    setToasts((t) => [...t, { id, nodeId, label }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);
  const openToast = useCallback((t) => {
    setSelectedId(t.nodeId);
    setToasts((ts) => ts.filter((x) => x.id !== t.id));
  }, []);
  const dismissToast = useCallback((tid) => {
    setToasts((ts) => ts.filter((x) => x.id !== tid));
  }, []);

  // Answer a permission prompt (requestId is globally unique) and drop it from
  // whichever pending node raised it. An answered AskUserQuestion isn't a gate
  // that just disappears — record its picks as a segment at this point in the
  // turn so the resolved Q&A stays inline in the flow (the server persists the
  // same thing once the turn lands).
  const onAnswer = useCallback((requestId, behavior, updatedInput) => {
    answerPermission(requestId, behavior, updatedInput);
    setPendings((ps) =>
      ps.map((p) => {
        const answered = p.perms.find((q) => q.requestId === requestId);
        const perms = p.perms.filter((q) => q.requestId !== requestId);
        if (answered?.tool_name === "AskUserQuestion" && behavior === "allow") {
          const answers = updatedInput?.answers || {};
          const items = (answered.input?.questions || []).map((q) => ({
            header: q.header || "",
            question: q.question,
            answer: answers[q.question] || "",
          }));
          return { ...p, perms, segments: [...(p.segments || []), { type: "questions", items }] };
        }
        return { ...p, perms };
      })
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
    // Re-hang finding replies under their finding card. Such a branch's real
    // (server) parent is the review node, but its prompt carries the finding it
    // forked off (FINDING_REPLY_RE); match that tag to the review's finding cards
    // and re-parent onto the right one, so the reply reads as that finding's
    // conversation instead of a sibling of the findings. Derived from persisted
    // data, so it holds across reloads with no separate bookkeeping.
    //
    // The tag stored whatever the finding's headline was AT REPLY TIME, and that
    // computation has since changed — a leading `file.ts:42` ref is now peeled
    // off into its own chip, so today's headline is the description while an older
    // reply's tag is the bare file ref. Key each card on BOTH its headline and its
    // file ref so either form resolves; without this those older replies match
    // nothing and scatter back onto the top-level review node. Set the file ref
    // first so a genuine headline always wins a collision.
    const cardByKey = new Map(); // reviewId -> (headline|fileRef -> finding card id)
    for (const [reviewId, info] of findingInfo) {
      if (!info.shown) continue;
      const m = new Map();
      info.items.forEach((it, i) => {
        const cardId = `finding-${reviewId}-${i}`;
        if (it.file) m.set(it.file, cardId);
        m.set(it.headline, cardId);
      });
      cardByKey.set(reviewId, m);
    }
    const list = nodes.map((n) => {
      const m = n.parentId && cardByKey.get(n.parentId);
      if (!m) return n;
      const tag = n.prompt?.match(FINDING_REPLY_RE)?.[1]?.trim();
      const cardId = tag && m.get(tag);
      return cardId ? { ...n, parentId: cardId } : n;
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
        segments: p.segments,
        turnId: p.turnId,
        auto: p.auto,
        images: p.images,
        mode: p.mode,
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

  // The per-node actions — split / spin-up / merge — computed once and consumed by
  // BOTH the canvas card and the inspector's conversation flow, so the same reply
  // offers the same affordances in both places (the flow is where you read the
  // reply; the card is the at-a-glance handle). Keyed by node id; also exposes the
  // merge helpers the gather edges need.
  const nodeActions = useMemo(() => {
    const isMerge = (n) => MERGE_TAG_RE.test(n.prompt || "");
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const hasChild = new Set(allNodes.map((n) => n.parentId).filter(Boolean));
    const realKids = new Map();
    for (const n of allNodes) {
      if (!n.parentId || n.kind === "summary" || n.kind === "finding") continue;
      if (!realKids.has(n.parentId)) realKids.set(n.parentId, []);
      realKids.get(n.parentId).push(n);
    }
    const branchesOf = (id) => (realKids.get(id) || []).filter((k) => !isMerge(k));
    // Follow a branch's single non-merge-child chain down to its current tip, so a
    // merge combines each branch's LATEST work rather than the branch node itself.
    // A branch that sub-forked (≥2 kids) or has no child yet is its own leaf.
    const leafOf = (node) => {
      let cur = node;
      for (;;) {
        const kids = branchesOf(cur.id);
        if (kids.length !== 1) return cur;
        cur = kids[0];
      }
    };
    // Recover the fan a merge gathered: from its anchor leaf, walk up to the
    // nearest ancestor with ≥2 branches, then take each branch's leaf.
    const mergeFan = (mergeNode) => {
      const anchorLeaf = byId.get(mergeNode.parentId);
      if (!anchorLeaf) return null;
      let cur = anchorLeaf;
      let fanRoot = null;
      while (cur?.parentId) {
        const parent = byId.get(cur.parentId);
        if (!parent) break;
        if (branchesOf(parent.id).length >= 2) {
          fanRoot = parent;
          break;
        }
        cur = parent;
      }
      if (!fanRoot) return null;
      return { fanRoot, anchorLeaf, leaves: branchesOf(fanRoot.id).map(leafOf) };
    };
    const map = new Map();
    for (const n of allNodes) {
      if (n.kind === "summary" || n.kind === "finding") continue;
      const branches = branchesOf(n.id);
      // The merge combines each branch's leaf (its latest work), so "already
      // merged" = one of those leaves has a merge child, and streaming is checked
      // on the leaves too.
      const leaves = branches.map(leafOf);
      map.set(n.id, {
        canSplit: findingInfo.has(n.id),
        split: findingInfo.get(n.id)?.shown ?? false,
        // A fan-out proposal — hidden once spun up this session, or once the node
        // already has children (so a reload doesn't re-offer and double-spawn).
        canSpinUp: fanoutInfo.has(n.id) && !spunUp.has(n.id) && !hasChild.has(n.id),
        spinCount: fanoutInfo.get(n.id)?.items.length ?? 0,
        // ≥2 real branches, every leaf finished, and not already merged. All
        // derived, so the button hides across reloads, and the instant the merge
        // turn starts streaming.
        canMerge:
          !n.streaming &&
          branches.length >= 2 &&
          leaves.every((b) => !b.streaming) &&
          !leaves.some((leaf) => (realKids.get(leaf.id) || []).some(isMerge)),
        mergeCount: branches.length,
      });
    }
    return { map, isMerge, branchesOf, byId, leafOf, mergeFan };
  }, [allNodes, findingInfo, fanoutInfo, spunUp]);

  // Persistent per-tree horizontal slots, so a tree keeps its x position across
  // renders and forking one tree never shifts another.
  const treeSlots = useRef(new Map());
  // Bumped by "tidy" to force a fresh re-pack of the slots (see onTidy).
  const [tidyNonce, setTidyNonce] = useState(0);

  // Positions only depend on the tree shape, so keep the (relatively expensive)
  // layout out of the render path that reacts to selection/highlight changes.
  const layout = useMemo(() => {
    const pos = layoutTree(allNodes, treeSlots.current, dims);
    // A merge forks from the middle branch (see mergeBranches), so the tree layout
    // drops it inline with the OTHER branches' children — same row as its cousins.
    // Push it (and any subtree it grew) a row below the whole fan it gathers from,
    // so it visibly sits under the convergence rather than beside it.
    const { isMerge, mergeFan } = nodeActions;
    const kids = new Map();
    for (const n of allNodes) {
      if (!n.parentId) continue;
      if (!kids.has(n.parentId)) kids.set(n.parentId, []);
      kids.get(n.parentId).push(n.id);
    }
    const heightOf = (id) => dims.get(id)?.height || 100;
    for (const n of allNodes) {
      if (!isMerge(n) || !n.parentId) continue;
      const fan = mergeFan(n);
      if (!fan) continue;
      // Lowest bottom across the fan's leaves — the deepest row it gathers from.
      let maxBottom = -Infinity;
      for (const leaf of fan.leaves) {
        if (leaf.id === n.id) continue;
        const p = pos.get(leaf.id);
        if (p) maxBottom = Math.max(maxBottom, p.y + heightOf(leaf.id));
      }
      const cur = pos.get(n.id);
      if (!cur || maxBottom === -Infinity) continue;
      const delta = maxBottom + 50 - cur.y; // 50 = V_GAP
      if (delta <= 0) continue;
      // Shift the merge and its whole subtree down by the same delta.
      const stack = [n.id];
      while (stack.length) {
        const id = stack.pop();
        const p = pos.get(id);
        if (p) pos.set(id, { ...p, y: p.y + delta });
        for (const c of kids.get(id) || []) stack.push(c);
      }
    }
    // Which nodes already have a child — the ⑂ button only makes sense there,
    // where it splits off a sibling branch. A leaf is continued via the composer.
    const hasChild = new Set(allNodes.map((n) => n.parentId).filter(Boolean));
    return { pos, hasChild };
  }, [allNodes, dims, tidyNonce, nodeActions]);

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
    const { map: actions, isMerge, mergeFan } = nodeActions;
    const rfNodes = allNodes.map((n) => {
      const acts = actions.get(n.id);
      return {
      id: n.id,
      type: "canopy",
      position: pos.get(n.id) || { x: 0, y: 0 },
      // Carry the last measured size so React Flow keeps this node "initialized"
      // (and visible) even though we hand it a brand-new object every render.
      ...(dims.get(n.id) || {}),
      data: {
        id: n.id,
        label: isMerge(n) ? mergePromptLabel(n.prompt || "") : n.label,
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
        onToggleArchive: toggleArchive,
        // A finding card carries the finding it holds; selecting it opens the
        // finding in the inspector, where a reply forks the review to work on it.
        finding: n.finding,
        // The split / spin-up / merge affordances (shared with the inspector flow).
        canSplit: acts?.canSplit ?? false,
        split: acts?.split ?? false,
        onSplit: toggleSplit,
        canSpinUp: acts?.canSpinUp ?? false,
        spinCount: acts?.spinCount ?? 0,
        onSpinUp: handleSpinUp,
        canMerge: acts?.canMerge ?? false,
        mergeCount: acts?.mergeCount ?? 0,
        onMerge: handleMerge,
        // This node is itself a merge — the convergence of a fan of branches.
        isMerge: isMerge(n),
        // Detect a pasted stack trace so the card can headline the error instead
        // of showing a meaningless truncation of the raw blob.
        errorPaste: n.kind !== "summary" && n.kind !== "finding" ? parseErrorPaste(n.prompt) : null,
        tokens: n.tokens,
        perms: n.perms || [],
        // Real node (a pending turn has no session yet) that already branched.
        canFork: !n.streaming && n.kind !== "summary" && n.kind !== "finding" && hasChild.has(n.id),
        // Highlighted as the thread scrolls past its exchange (but not summaries).
        highlighted: n.id === inViewId && n.kind !== "summary",
        // Finished while you were elsewhere — badge it so you can go when ready.
        ready: readyIds.has(n.id),
        onAnswer,
        onFork: forkFrom,
      },
      selected: n.id === selectedId,
    };
    });
    const rfEdges = allNodes
      .filter((n) => n.parentId)
      .map((n) => ({
        id: `${n.parentId}->${n.id}`,
        source: n.parentId,
        target: n.id,
        animated: n.streaming,
        // A merge sits a row below the fan, so its tree edge (and the gather edges
        // below) span the intervening reply row. Draw it straight so it reads as a
        // branch converging into the merge, not a stepped line hugging a column
        // behind those nodes.
        ...(isMerge(n) ? { type: "straight" } : {}),
      }));
    // A merge forks from one branch's leaf (its normal tree edge); draw the extra
    // "gather" edges from the OTHER branches' leaves into it, so the fan visibly
    // converges. The merge sits below the branch leaf it forked from (see
    // mergeBranches — the middle one, for a centered gather).
    for (const n of allNodes) {
      if (!isMerge(n) || !n.parentId) continue;
      const fan = mergeFan(n);
      if (!fan) continue;
      for (const leaf of fan.leaves) {
        if (leaf.id === fan.anchorLeaf.id) continue; // that pairing is the tree edge
        rfEdges.push({
          id: `gather-${leaf.id}->${n.id}`,
          source: leaf.id,
          target: n.id,
          type: "straight",
          className: "gatherEdge",
          animated: n.streaming,
        });
      }
    }
    return { rfNodes, rfEdges };
  }, [allNodes, layout, nodeActions, selectedId, inViewId, onAnswer, forkFrom, toggleSplit, togglePin, toggleArchive, handleSpinUp, handleMerge, dims, readyIds]);

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
        { tempId, parentId: displayParentId, label: text, result: "", perms: [], segments: [], turnId: null, auto: false, images, mode: turnMode },
      ]);
      // Follow the new branch in the chat as it streams — unless the caller opts
      // out (a fan-out spawns several at once and only selects the first, letting
      // the rest surface via the ready-badge/toast path as they land).
      if (opts.select !== false) setSelectedId(tempId);

      const abort = runTurn(
        { prompt: text, parentId, mode: turnMode, images, workspace },
        {
          onStart: (turnId) => patchPending(tempId, (p) => ({ ...p, turnId })),
          // Buffered and flushed once per frame (see pushToken/flushTokens).
          onToken: (t) => pushToken(tempId, t),
          onPermission: (req) =>
            patchPending(tempId, (p) => ({ ...p, perms: [...p.perms, req] })),
          onNode: async (node) => {
            aborters.current.delete(tempId);
            tokenBuf.current.delete(tempId); // real node carries the full text
            // A finding reply re-hangs under its finding card via its prompt tag
            // (see allNodes), so nothing to record here.
            // A new root carries the mode chosen for it into the modes map.
            if (!parentId) setModes((m) => ({ ...m, [node.id]: newRootMode }));
            // Fetch the real graph WITHOUT committing yet, then swap the pending
            // for it in a single synchronous batch below. If we committed the
            // real node first (via refresh) and dropped the pending afterwards,
            // the two land in separate renders — and the frame between them holds
            // both the real tree and the still-present pending, drawing the tree
            // twice. A failed fetch must still drop the pending, or it lingers as
            // a second tree beside whatever the next refresh brings in.
            let g = null;
            try {
              g = await fetchGraph(workspace);
            } catch {}
            // Decide whether to follow this finished turn into the inspector. We
            // follow our own branch (the temp id we're still viewing) and an idle
            // inspector sitting on null or the fork parent — but NEVER yank
            // selection out from under an active composer, even if it's parked on
            // null while you seed a new conversation. Read the live refs, not the
            // closure, which captured stale values when this turn started.
            const cur = selectedIdRef.current;
            const followed =
              cur === tempId ||
              (!composingRef.current && (cur === null || cur === parentId));
            // Bring in the real node, hand selection from the temp id to it, and
            // drop the pending — all synchronous, so React batches them into one
            // render. The real tree replaces the pending in place; there's never
            // a frame with both, and the selected id is always valid. The temp id
            // is going away regardless, so always advance off it.
            if (g) {
              setNodes(g.nodes);
              setArchivedList(g.archived || []);
            }
            setSelectedId((c) => {
              if (c === tempId) return node.id;
              return followed ? node.id : c;
            });
            setPendings((ps) => ps.filter((p) => p.tempId !== tempId));
            // Didn't follow it → surface it passively so a reply landing in one
            // tree can't blow away a message you're writing in another.
            if (!followed) {
              setReadyIds((s) => new Set(s).add(node.id));
              pushToast(node.id, node.label || text);
            }
          },
          onError: (msg) => {
            aborters.current.delete(tempId);
            tokenBuf.current.delete(tempId);
            setError(msg);
            setPendings((ps) => ps.filter((p) => p.tempId !== tempId));
          },
        }
      );
      aborters.current.set(tempId, abort);
    },
    [modes, newRootMode, rootOf, patchPending, pushToken, pushToast, workspace]
  );

  // Spin a fan-out proposal into parallel branches: fork one real turn off the
  // proposing node per proposed track. Each fork inherits the whole thread (the
  // plan included) via --fork-session, so we just tell it to carry out its slice.
  // They stream concurrently as sibling trunks — DESIGN.md's "run parallel work".
  // Select the first so the inspector follows one; the rest land as ready badges.
  const spinUp = useCallback(
    (id) => {
      const info = fanoutInfo.get(id);
      if (!info) return;
      info.items.forEach((it, i) => {
        const slice = (it.body || "").trim() || it.headline;
        const branchPrompt = `Focus on just this part of your plan and carry it out now, then report back:\n\n${slice}`;
        startTurn(id, branchPrompt, [], { select: i === 0 });
      });
      setSpunUp((prev) => new Set(prev).add(id));
    },
    [fanoutInfo, startTurn]
  );
  // Keep the ref the rfNodes memo reaches through pointed at the current spinUp.
  useEffect(() => {
    spinUpRef.current = spinUp;
  }, [spinUp]);

  // Converge a node's fanned-out branches back into one. There's no primitive to
  // union several forked sessions, so the merge is a fresh synthesis turn: gather
  // each branch's final output as text and fork one turn that combines them. Fork
  // from the MIDDLE branch — that branch's own work is then in-session for free,
  // and the merge sits centered under the fan so the gather edges converge evenly.
  const mergeBranches = useCallback(
    (id) => {
      const { branchesOf, leafOf } = nodeActions;
      const branches = branchesOf(id);
      if (branches.length < 2) return;
      // Merge each branch's LEAF — the latest work down that branch — not the
      // branch node itself. The merge forks from the middle leaf so that thread is
      // in-session for free, and the merge sits centered under the fan.
      const leaves = branches.map(leafOf);
      if (leaves.some((l) => l.streaming)) return;
      const anchor = leaves[Math.floor(leaves.length / 2)];
      const digest = branches
        .map((b, i) => `— Branch ${i + 1} (${b.label}):\n${(leaves[i].finalResult ?? leaves[i].result ?? "").trim()}`)
        .join("\n\n");
      const prompt =
        `These parallel branches each carried out one part of the plan. ` +
        `Here's what each produced:\n\n${digest}\n\n` +
        `Combine them into a single coherent result.\n\n(Canopy: merge)`;
      startTurn(anchor.id, prompt);
    },
    [nodeActions, startTurn]
  );
  useEffect(() => {
    mergeRef.current = mergeBranches;
  }, [mergeBranches]);

  // Bottom composer: seed a root (nothing selected) or continue the selected node.
  const submit = useCallback(
    (parentId) => {
      startTurn(parentId, prompt, composerImages);
      clearDraft(setPromptDrafts, promptKey);
    },
    [startTurn, prompt, composerImages, promptKey, clearDraft]
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
  // the escape hatch when you started a turn in manual mode by accident.
  // Enabling clears any prompts already showing (the server has just allowed
  // them); disabling — changed your mind — goes back to asking for what's left.
  const setAuto = useCallback(
    (tempId, turnId, enabled) => {
      if (!turnId) return;
      setTurnAuto(turnId, enabled);
      patchPending(tempId, (p) => (enabled ? { ...p, auto: true, perms: [] } : { ...p, auto: false }));
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
    clearDraft(setReplyDrafts, replyKey);
  }, [startTurn, selected, selectedId, composingNew, reply, replyImages, replyKey, clearDraft]);

  const onReset = useCallback(async () => {
    // Stop every in-flight turn (closes its stream, kills the CLI child) before
    // clearing state, so nothing keeps running server-side after a reset.
    for (const abort of aborters.current.values()) abort();
    aborters.current.clear();
    await resetGraph(workspace);
    setSelectedId(null);
    setPendings([]);
    setModes({});
    setReplyDrafts(new Map());
    setPromptDrafts(new Map());
    setReadyIds(new Set());
    setToasts([]);
    await refresh();
  }, [refresh, workspace]);

  // Start a fresh conversation: open the inspector on the right in its empty
  // "new conversation" state (deselect any node so its composer seeds a NEW root
  // tree — multiple roots live side by side on the canvas). The focus effect
  // above puts the cursor in the inspector's composer.
  const newConversation = useCallback(() => {
    setSelectedId(null);
    setComposingNew(true);
    clearDraft(setPromptDrafts, "__root__");
    clearDraft(setReplyDrafts, "__new__");
  }, [clearDraft]);


  const empty = nodes.length === 0 && pendings.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🌳 Canopy</div>
        <div className="hint">
          {empty ? "Seed a root to grow the tree" : "Select a node, then fork from it"}
        </div>
        {workspace && (
          <div className="workspace-switch">
            <button
              className="workspace"
              title={`This tab runs in ${workspace} — click to switch repo`}
              onClick={() => setSwitching((s) => !s)}
            >
              📁 {workspace.split("/").pop()} ▾
            </button>
            {switching && (
              <WorkspacePicker
                current={workspace}
                recent={recent}
                onPick={switchWorkspace}
                onClose={() => setSwitching(false)}
              />
            )}
          </div>
        )}
        <button onClick={newConversation}>＋ new conversation</button>
        <button className="ghost" onClick={onTidy} disabled={empty} title="Re-pack the trees so they stop overlapping">
          🧹 tidy
        </button>
        {archivedList.length > 0 && (
          <button
            className={`ghost${drawerOpen ? " on" : ""}`}
            onClick={() => setDrawerOpen((o) => !o)}
            title="Conversations you've taken off the canvas"
          >
            🗄 archived ({archivedList.length})
          </button>
        )}
        <button className="ghost" onClick={onReset} disabled={empty}>
          reset
        </button>
      </header>

      {drawerOpen && archivedList.length > 0 && (
        <div className="drawer">
          <div className="drawerHead">
            <span>Archived</span>
            <button className="drawerClose nodrag" title="Close" onClick={() => setDrawerOpen(false)}>
              ✕
            </button>
          </div>
          <div className="drawerList">
            {archivedList.map((a) => (
              <div key={a.rootId} className="drawerItem">
                <span className="drawerItemLabel" title={a.label}>
                  {a.label}
                </span>
                <button
                  className="drawerRestore"
                  title="Bring this conversation back onto the canvas"
                  onClick={() => toggleArchive(a.rootId, false)}
                >
                  restore
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
          defaultEdgeOptions={{ type: "smoothstep" }}
          minZoom={0.15}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="#CDC1FF" />
          <MiniMap pannable zoomable nodeColor="#6E9E5B" maskColor="rgba(221,230,207,0.6)" />
          <Controls />
        </ReactFlow>
      </div>

      {/* Composer: seeds the root when empty / nothing selected, else forks. */}
      <div
        className={`composer${dragZone === "composer" ? " dragging" : ""}`}
        onDragOver={dragOver("composer")}
        onDragLeave={dragLeave}
        onDrop={dropImages(addComposerImages)}
      >
        {error && <div className="error">⚠ {error}</div>}
        <Thumbnails images={composerImages} onRemove={removeComposerImage} />
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
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit(selected ? selected.id : null)}
            onPaste={pasteImages(addComposerImages)}
            placeholder={selected ? "Ask this branch something new…" : "Start a conversation…"}
            autoFocus
          />
          <AttachButton onAdd={addComposerImages} />
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
                <div className="msg user">
                  {MERGE_TAG_RE.test(n.prompt || "")
                    ? mergePromptLabel(n.prompt)
                    : n.prompt || <span className="muted">—</span>}
                </div>
                {n.images?.length > 0 && (
                  <div className="thumbs threadThumbs">
                    {n.images.map((img) => (
                      <div className="thumb" key={img.id} title={img.name}>
                        <img src={img.dataUrl} alt={img.name} />
                      </div>
                    ))}
                  </div>
                )}
                {(() => {
                  // Once a turn is flipped to "approve the rest", it's running in
                  // auto — reflect that on the badge instead of its starting mode.
                  const m = n.streaming ? MODES.find((mo) => mo.value === (n.auto ? "auto" : n.mode)) : null;
                  return (
                    <div className={`assistantBlock${m ? " tagged" : ""}`}>
                      {m && (
                        <div className="modeTag" title={`Thinking in ${m.label} mode — ${m.desc}`}>
                          <span className="modeTagIco">{m.icon}</span>
                          <span className="modeTagName">{m.label}</span>
                        </div>
                      )}
                      {n.segments?.length ? (
                        <>
                          {n.segments.map((seg, i) =>
                            seg.type === "questions" ? (
                              <ResolvedQuestions key={i} questions={seg.items} />
                            ) : (
                              <div className="msg assistant" key={i}>
                                <Markdown>{seg.text}</Markdown>
                                {n.streaming && i === n.segments.length - 1 && <span className="cursor">▋</span>}
                              </div>
                            )
                          )}
                          {/* Answered a question and Claude hasn't resumed yet — show the
                              cursor below the Q&A so the turn still reads as in-progress. */}
                          {n.streaming && n.segments[n.segments.length - 1]?.type === "questions" && (
                            <div className="msg assistant">
                              <span className="cursor">▋</span>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="msg assistant">
                          {n.result ? (
                            <Markdown>{n.result}</Markdown>
                          ) : (
                            !n.streaming && <span className="muted">—</span>
                          )}
                          {n.streaming && <span className="cursor">▋</span>}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {(n.perms || []).map((p) => (
                  <PermPrompt key={p.requestId} perm={p} onAnswer={onAnswer} />
                ))}
                {(() => {
                  // The same split / spin-up / merge actions the card offers, inline
                  // in the flow where you're actually reading the reply. Skipped
                  // while streaming — the reply, and what it affords, isn't settled.
                  const a = !n.streaming && nodeActions.map.get(n.id);
                  if (!a || (!a.canSplit && !a.canSpinUp && !a.canMerge)) return null;
                  return (
                    <div className="flowActions">
                      {a.canSpinUp && (
                        <button className="spinBtn" onClick={() => spinUp(n.id)}>
                          ⑂ spin up {a.spinCount} branches
                        </button>
                      )}
                      {a.canMerge && (
                        <button className="mergeBtn" onClick={() => mergeBranches(n.id)}>
                          ⤚ merge {a.mergeCount} branches
                        </button>
                      )}
                      {a.canSplit && (
                        <button className="splitBtn" onClick={() => toggleSplit(n.id)}>
                          {a.split ? "⤺ merge findings" : "⑃ split into findings"}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
              )
            )}
          </div>
          <div
            className={`resume${dragZone === "reply" ? " dragging" : ""}`}
            onDragOver={dragOver("reply")}
            onDragLeave={dragLeave}
            onDrop={dropImages(addReplyImages)}
          >
            <Thumbnails images={replyImages} onRemove={removeReplyImage} />
            <textarea
              ref={replyRef}
              value={reply}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
              onPaste={pasteImages(addReplyImages)}
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
                    <button
                      className="ghost autoOn"
                      onClick={() => setAuto(selected.id, selected.turnId, false)}
                      disabled={!selected.turnId}
                      title="Changed your mind — go back to asking before the rest of this turn's permission requests"
                    >
                      ⚡ approving the rest — cancel
                    </button>
                  ) : (
                    <button
                      className="ghost"
                      onClick={() => setAuto(selected.id, selected.turnId, true)}
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
                    <AttachButton onAdd={addReplyImages} />
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

      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <button key={t.id} className="toast" onClick={() => openToast(t)}>
              <span className="toastIco">🌿</span>
              <span className="toastText">
                Reply ready — <span className="toastLabel">{t.label}</span>
              </span>
              <span
                className="toastClose"
                role="button"
                title="Dismiss"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissToast(t.id);
                }}
              >
                ✕
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
