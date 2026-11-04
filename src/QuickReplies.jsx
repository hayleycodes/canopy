import { useRef, useState } from "react";
import { useDismiss } from "./ModeSelect.jsx";

// Canned replies — picking one fills the reply box, it doesn't send.
export const QUICK_REPLIES = [
  "verify each of these and write the valid ones in the form of a draft pr comments with steps to replicate",
];

export default function QuickReplies({ onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useDismiss(ref, open, () => setOpen(false));

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
        <div className="modeMenu quickMenu" role="listbox">
          {QUICK_REPLIES.map((text) => (
            <button
              type="button"
              key={text}
              role="option"
              className="modeItem"
              onClick={() => {
                onPick(text);
                setOpen(false);
              }}
            >
              <span className="modeItemLabel">{text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
