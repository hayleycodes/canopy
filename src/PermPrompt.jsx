// A permission request with a preview of exactly what will change — the diff for
// edits, the content for writes, the command for Bash — so you can see it before
// approving, like the VS Code diff panel. The request input carries all of this.

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

export default function PermPrompt({ perm, onAnswer }) {
  const { requestId, tool_name, input } = perm;
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
