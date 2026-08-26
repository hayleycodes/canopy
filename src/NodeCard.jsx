import { Handle, Position } from "reactflow";
import PermPrompt from "./PermPrompt.jsx";

// Compact token count: 950 → "950", 1200 → "1.2k", 47000 → "47k".
function fmtTokens(n) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
}

// One node on the canvas: a card with the prompt as its title and a preview of
// the reply. `streaming` nodes show a live cursor; any pending permission
// requests surface here as Allow/Deny. The ⑂ button branches a new child off
// this node — do it on a node that already has children to split the tree.
export default function NodeCard({ data, selected }) {
  const { id, label, result, streaming, perms = [], canFork, onFork, onAnswer, kind, highlighted, ready, errorPaste, tokens, finding, canSplit, split, onSplit, rootId, pinned, pending, onTogglePin } = data;

  // A tree's summary header — what the whole conversation is about. The 📌 toggle
  // pins the tree so it stays on the canvas even once newer conversations would
  // otherwise push it off.
  if (kind === "summary") {
    return (
      <div className={`summaryCard${pinned ? " pinned" : ""}`}>
        {!pending && (
          <button
            className={`pinBtn nodrag${pinned ? " on" : ""}`}
            title={pinned ? "Unpin — let this conversation scroll off when it gets old" : "Pin — keep this conversation on the canvas"}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin?.(rootId, !pinned);
            }}
          >
            📌
          </button>
        )}
        <div className="summaryEyebrow">{pinned ? "PINNED" : "TREE"}</div>
        <div className="summaryText">{label}</div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  // A finding pulled out of a review reply into its own node: it holds the
  // finding's explanation, and selecting it opens the finding in the inspector,
  // where a reply forks the review into a real conversation to work on it.
  if (kind === "finding") {
    return (
      <div className={`findingCard${selected ? " selected" : ""}${highlighted ? " inView" : ""}`}>
        <Handle type="target" position={Position.Top} />
        <div className="findingHead">
          <span className="findingNum">{finding.n}</span>
          <span className="findingTitle">{finding.headline || "finding"}</span>
        </div>
        {finding.body && <div className="findingBody">{finding.body}</div>}
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  return (
    <div className={`nodeCard${selected ? " selected" : ""}${highlighted ? " inView" : ""}${streaming ? " streaming" : ""}${errorPaste ? " errored" : ""}${ready ? " ready" : ""}`}>
      <Handle type="target" position={Position.Top} />
      {ready && <span className="readyDot" title="New reply ready — click to open" />}

      <div className="nodeHead">
        {errorPaste ? (
          <div className="nodeErr">
            <div className="nodeErrTop">
              <span className="nodeErrBadge">⚠ ERROR</span>
              <span className="nodeErrType">{errorPaste.errorType}</span>
            </div>
            {errorPaste.message && <div className="nodeErrMsg">{errorPaste.message}</div>}
            {errorPaste.frameCount > 0 && (
              <div className="nodeErrFrames">
                ⤷ {errorPaste.frameCount} stack {errorPaste.frameCount === 1 ? "frame" : "frames"}
              </div>
            )}
          </div>
        ) : (
          <div className="nodeLabel">{label || "…"}</div>
        )}
        {canSplit && (
          <button
            className="splitBtn nodrag"
            title={split ? "Merge findings back into this reply" : "Split this review's findings into cards"}
            onClick={(e) => {
              e.stopPropagation();
              onSplit(id);
            }}
          >
            {split ? "⤺ merge" : "⑃ split"}
          </button>
        )}
        {canFork && (
          <button
            className="forkBtn nodrag"
            title="Fork a new branch from here"
            onClick={(e) => {
              e.stopPropagation();
              onFork(id);
            }}
          >
            <span className="forkIco">⑂</span>
          </button>
        )}
      </div>

      <div className="nodeResult">
        {result || (streaming ? "" : <span className="muted">no reply yet</span>)}
        {streaming && <span className="cursor">▋</span>}
      </div>

      {perms.map((p) => (
        <PermPrompt key={p.requestId} perm={p} onAnswer={onAnswer} />
      ))}

      {tokens && (
        <div
          className="nodeTokens"
          title={`Context sent this turn: ${tokens.context.toLocaleString()} tokens\nGenerated this turn: ${tokens.output.toLocaleString()} tokens`}
        >
          <span className="tok">◐ {fmtTokens(tokens.context)} ctx</span>
          <span className="tok">↓ {fmtTokens(tokens.output)}</span>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
