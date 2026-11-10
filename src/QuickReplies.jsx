import { useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "./ModeSelect.jsx";

// Canned replies — picking one fills the reply box; its ➤ sends it as is.
export const QUICK_REPLIES = [
  "verify each of these and write the valid ones in the form of a draft pr comments with steps to replicate",
  "commit and push",
  "commit, push, create a draft pr",
  "write me a test plan",
  "explain this like I am a junior engineer",
  "Look at my PRs and linear cards. what is the state of things?",
];

export default function QuickReplies({ onPick, onSend }) {
  const [open, setOpen] = useState(false);
  const [below, setBelow] = useState(false);
  const ref = useRef(null);
  const menuRef = useRef(null);

  useDismiss(ref, open, () => setOpen(false));

  // The menu opens upward, but the inspector scrolls and clips anything past its
  // top — e.g. a new conversation, where the composer sits near the top. Flip
  // it below the trigger when there isn't room above.
  useLayoutEffect(() => {
    if (!open) return setBelow(false);
    const clip = ref.current.closest(".inspector");
    if (clip && menuRef.current.getBoundingClientRect().top < clip.getBoundingClientRect().top) setBelow(true);
  }, [open]);

  return (
    <div className="modeSelect" ref={ref}>
      <button
        type="button"
        className="modeTrigger"
        title="Fill the reply box with a canned reply"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="modeName">Quick replies</span>
        <span className="modeCaret">▾</span>
      </button>

      {open && (
        <div ref={menuRef} className={`modeMenu quickMenu${below ? " below" : ""}`} role="listbox">
          {QUICK_REPLIES.map((text) => (
            <div className="quickRow" key={text}>
              <button
                type="button"
                role="option"
                className="modeItem"
                onClick={() => {
                  onPick(text);
                  setOpen(false);
                }}
              >
                <span className="modeItemLabel">{text}</span>
              </button>
              <button
                type="button"
                className="quickSend"
                title={onSend ? "Send as is" : "Wait for the turn to finish to send"}
                disabled={!onSend}
                onClick={() => {
                  onSend(text);
                  setOpen(false);
                }}
              >
                ➤
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
