// A permission request with a preview of exactly what will change — the diff for
// edits, the content for writes, the command for Bash — so you can see it before
// approving, like the VS Code diff panel. The request input carries all of this.

import { useState } from "react";

function shortPath(p) {
  if (!p) return "";
  const parts = p.split("/");
  return parts.slice(-2).join("/"); // last dir + filename, enough to identify
}

function Diff({ oldText, newText }) {
  const del = oldText != null ? oldText.split("\n") : [];
  const add = newText != null ? newText.split("\n") : [];
  return (
    <pre className="diff">
      {del.map((l, i) => (
        <div key={`d${i}`} className="diffDel">
          - {l}
        </div>
      ))}
      {add.map((l, i) => (
        <div key={`a${i}`} className="diffAdd">
          + {l}
        </div>
      ))}
    </pre>
  );
}

function Preview({ toolName, input = {} }) {
  if (toolName === "Edit") {
    return (
      <>
        {input.file_path && <div className="diffFile">{shortPath(input.file_path)}</div>}
        <Diff oldText={input.old_string} newText={input.new_string} />
      </>
    );
  }
  if (toolName === "MultiEdit") {
    return (
      <>
        {input.file_path && <div className="diffFile">{shortPath(input.file_path)}</div>}
        {(input.edits || []).map((e, i) => (
          <Diff key={i} oldText={e.old_string} newText={e.new_string} />
        ))}
      </>
    );
  }
  if (toolName === "Write") {
    return (
      <>
        {input.file_path && <div className="diffFile">{shortPath(input.file_path)} (new content)</div>}
        <Diff newText={input.content} />
      </>
    );
  }
  if (toolName === "Bash") {
    return <pre className="diff diffCmd">{input.command || "(command)"}</pre>;
  }
  const s = JSON.stringify(input, null, 2);
  return <pre className="diff">{s.length > 600 ? s.slice(0, 599) + "…" : s}</pre>;
}

// AskUserQuestion isn't an allow/deny gate — it's the agent asking the human to
// pick from options. We render each question with its choices and feed the picks
// back as the tool's `answers` (keyed by question text), which is what the CLI
// reads from updatedInput to produce the tool result.
// Sentinel label for the always-available "Other" choice, whose real answer is
// whatever the human types into the free-text box.
const OTHER = "__other__";

function QuestionPrompt({ requestId, input, onAnswer }) {
  const questions = input?.questions || [];
  // selections[i] is a Set of chosen labels for question i.
  const [selections, setSelections] = useState(() => questions.map(() => new Set()));
  // customTexts[i] is the free text typed when "Other" is chosen for question i.
  const [customTexts, setCustomTexts] = useState(() => questions.map(() => ""));

  const toggle = (qi, label, multi) => {
    setSelections((prev) =>
      prev.map((set, i) => {
        if (i !== qi) return set;
        const next = new Set(multi ? set : []);
        if (set.has(label)) next.delete(label);
        else next.add(label);
        return next;
      })
    );
  };

  const setCustom = (qi, text) => {
    setCustomTexts((prev) => prev.map((t, i) => (i === qi ? text : t)));
  };

  // A question is answered once it has a real pick — or, when "Other" is chosen,
  // once its text box is non-empty (a bare "Other" says nothing to feed back).
  const ready = questions.every((_, i) => {
    const set = selections[i];
    if (set.size === 0) return false;
    if (set.has(OTHER) && !customTexts[i].trim()) return false;
    return true;
  });

  const submit = () => {
    const answers = {};
    questions.forEach((q, i) => {
      answers[q.question] = [...selections[i]]
        .map((label) => (label === OTHER ? customTexts[i].trim() : label))
        .join(", ");
    });
    onAnswer(requestId, "allow", { ...input, answers });
  };

  return (
    <div className="perm nodrag">
      {questions.map((q, qi) => (
        <div key={qi} className="question">
          {q.header && <div className="questionHeader">{q.header}</div>}
          <div className="questionText">{q.question}</div>
          <div className="questionOpts">
            {(q.options || []).map((opt, oi) => {
              const selected = selections[qi].has(opt.label);
              return (
                <button
                  key={oi}
                  className={`questionOpt${selected ? " selected" : ""}`}
                  onClick={() => toggle(qi, opt.label, q.multiSelect)}
                >
                  <div className="questionOptLabel">{opt.label}</div>
                  {opt.description && (
                    <div className="questionOptDesc">{opt.description}</div>
                  )}
                </button>
              );
            })}
            <button
              className={`questionOpt${selections[qi].has(OTHER) ? " selected" : ""}`}
              onClick={() => toggle(qi, OTHER, q.multiSelect)}
            >
              <div className="questionOptLabel">Other</div>
              <div className="questionOptDesc">Type your own response</div>
            </button>
          </div>
          {selections[qi].has(OTHER) && (
            <textarea
              className="questionOther"
              autoFocus
              rows={2}
              placeholder="Your response…"
              value={customTexts[qi]}
              onChange={(e) => setCustom(qi, e.target.value)}
            />
          )}
        </div>
      ))}
      <div className="permActions">
        <button className="allow" disabled={!ready} onClick={submit}>
          Submit
        </button>
        <button className="ghost" onClick={() => onAnswer(requestId, "deny")}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// An AskUserQuestion after it's been answered: the question and the human's pick,
// shown in the conversation flow so the exchange doesn't lose that it happened.
// Fed the persisted shape [{ header, question, answer }] — from the live pending
// node once answered, or reconstructed from the transcript on reload.
export function ResolvedQuestions({ questions = [] }) {
  if (!questions.length) return null;
  return (
    <div className="askResolved">
      {questions.map((q, i) => (
        <div key={i} className="askItem">
          {q.header && <div className="askHeader">{q.header}</div>}
          <div className="askQuestion">{q.question}</div>
          <div className="askAnswer">{q.answer || <span className="muted">—</span>}</div>
        </div>
      ))}
    </div>
  );
}

export default function PermPrompt({ perm, onAnswer }) {
  const { requestId, tool_name, input } = perm;
  if (tool_name === "AskUserQuestion") {
    return <QuestionPrompt requestId={requestId} input={input} onAnswer={onAnswer} />;
  }
  return (
    <div className="perm nodrag">
      <div className="permTool">
        wants to use <b>{tool_name}</b>
      </div>
      <Preview toolName={tool_name} input={input} />
      <div className="permActions">
        <button className="allow" onClick={() => onAnswer(requestId, "allow")}>
          Allow
        </button>
        <button className="ghost" onClick={() => onAnswer(requestId, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
