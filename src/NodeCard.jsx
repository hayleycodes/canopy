import { useState } from "react";
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
  const { id, label, result, streaming, perms = [], canFork, onFork, onAnswer, kind, highlighted, ready, errorPaste, tokens, finding, canSplit, split, onSplit, canSpinUp, spinCount, onSpinUp, canMerge, mergeCount, onMerge, isMerge, rootId, pinned, pending, onTogglePin, onToggleArchive } = data;

  // The file chip on a finding card copies its path on click (see below). A brief
  // "copied" flip gives feedback without stealing the click from the card.
  const [copied, setCopied] = useState(false);
  const copyFile = (e, path) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(path).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  // A tree's summary header — what the whole conversation is about. The 📌 toggle
  // pins the tree so it stays on the canvas even once newer conversations would
  // otherwise push it off; the 🗄 toggle archives it (off the canvas, into the
  // drawer) without deleting its transcript.
  if (kind === "summary") {
    return (
      <div className={`summaryCard${pinned ? " pinned" : ""}`}>
        {!pending && (
          <div className="summaryActions nodrag">
            <button
              className={`pinBtn${pinned ? " on" : ""}`}
              title={pinned ? "Unpin — let this conversation scroll off when it gets old" : "Pin — keep this conversation on the canvas"}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin?.(rootId, !pinned);
              }}
            >
              📌
            </button>
            <button
              className="archiveBtn"
              title="Archive — take this conversation off the canvas without deleting it"
              onClick={(e) => {
                e.stopPropagation();
                onToggleArchive?.(rootId, true);
              }}
            >
              🗄
            </button>
          </div>
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
        {finding.file && (
          <span className="findingFileRow">
            <span className="findingFile" title={finding.file}>
              <bdi>{finding.file}</bdi>
            </span>
            <button
              type="button"
              className={`findingFileCopy${copied ? " copied" : ""}`}
              title={copied ? "Copied!" : "Copy path"}
              onClick={(e) => copyFile(e, finding.file)}
            >
              {copied ? (
                "✓"
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </span>
        )}
        {finding.body && <div className="findingBody">{finding.body}</div>}
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  return (
    <div className={`nodeCard${selected ? " selected" : ""}${highlighted ? " inView" : ""}${streaming ? " streaming" : ""}${errorPaste ? " errored" : ""}${ready ? " ready" : ""}${isMerge ? " merged" : ""}`}>
      <Handle type="target" position={Position.Top} />
      {ready && <span className="readyDot" title="New reply ready — click to open" />}
      {isMerge && (
        <span className="mergeBadge" title="Merged — this node combines a fan of parallel branches">
          ⤚ merged
        </span>
      )}

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
      </div>

      {(canSplit || canSpinUp || canMerge || canFork) && (
        <div className="nodeTools nodrag">
          {canSpinUp && (
            <button
              className="spinBtn"
              title={`Run these ${spinCount} as parallel branches — each forks from here carrying the full thread as context`}
              onClick={(e) => {
                e.stopPropagation();
                onSpinUp(id);
              }}
            >
              ⑂ spin up {spinCount}
            </button>
          )}
          {canMerge && (
            <button
              className="mergeBtn"
              title={`Bring these ${mergeCount} branches back together — a new turn that combines what each produced`}
              onClick={(e) => {
                e.stopPropagation();
                onMerge(id);
              }}
            >
              ⤚ merge {mergeCount}
            </button>
          )}
          {canSplit && (
            <button
              className="splitBtn"
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
              className="forkBtn"
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
      )}

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
