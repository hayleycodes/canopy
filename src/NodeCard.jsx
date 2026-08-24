import { Handle, Position } from "reactflow";
import PermPrompt from "./PermPrompt.jsx";

// One node on the canvas: a card with the prompt as its title and a preview of
// the reply. `streaming` nodes show a live cursor; any pending permission
// requests surface here as Allow/Deny. The ⑂ button branches a new child off
// this node — do it on a node that already has children to split the tree.
export default function NodeCard({ data, selected }) {
  const { id, label, result, streaming, perms = [], canFork, onFork, onAnswer, kind, highlighted, errorPaste } = data;

  // A tree's summary header — what the whole conversation is about.
  if (kind === "summary") {
    return (
      <div className="summaryCard">
        <div className="summaryEyebrow">TREE</div>
        <div className="summaryText">{label}</div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  return (
    <div className={`nodeCard${selected ? " selected" : ""}${highlighted ? " inView" : ""}${streaming ? " streaming" : ""}${errorPaste ? " errored" : ""}`}>
      <Handle type="target" position={Position.Top} />

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

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
