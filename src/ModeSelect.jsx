import { useEffect, useRef, useState } from "react";

// Claude Code's permission modes, mirrored from the VS Code picker.
export const MODES = [
  { value: "default", label: "Manual", desc: "Ask before each action", icon: "✋" },
  { value: "acceptEdits", label: "Edit automatically", desc: "Edits apply without asking", icon: "⌁" },
  { value: "plan", label: "Plan", desc: "Explore and plan before editing", icon: "◇" },
  { value: "dontAsk", label: "Auto", desc: "Approve safe actions, pause for risky", icon: "⚡" },
];

// A themed replacement for a native <select> — the OS-drawn option list can't be
// styled, so we render our own menu (opens upward; it lives in the bottom bar).
export default function ModeSelect({ value, onChange, title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = MODES.find((m) => m.value === value) || MODES[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="modeSelect" ref={ref}>
      <button
        type="button"
        className="modeTrigger"
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="modeIco">{current.icon}</span>
        <span className="modeName">{current.label}</span>
        <span className="modeCaret">▾</span>
      </button>

      {open && (
        <div className="modeMenu" role="listbox">
          {MODES.map((m) => (
            <button
              type="button"
              key={m.value}
              role="option"
              aria-selected={m.value === value}
              className={`modeItem${m.value === value ? " selected" : ""}`}
              onClick={() => {
                onChange(m.value);
                setOpen(false);
              }}
            >
              <span className="modeIco">{m.icon}</span>
              <span className="modeItemText">
                <span className="modeItemLabel">{m.label}</span>
                <span className="modeItemDesc">{m.desc}</span>
              </span>
              {m.value === value && <span className="modeCheck">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
