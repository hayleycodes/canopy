import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// A fenced code block with a hover "copy" button. Pulls the raw text out of the
// rendered children so the button copies exactly what's shown.
function CodeBlock({ children, ...props }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = codeText(children);
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <pre {...props}>
      <button className="copyBtn nodrag" onClick={copy} title="Copy">
        {copied ? "✓ copied" : "copy"}
      </button>
      {children}
    </pre>
  );
}

// Flatten a React node tree (the <code> the markdown renderer nests in <pre>)
// down to its text so we copy the source, not markup.
function codeText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeText).join("");
  if (node.props) return codeText(node.props.children);
  return "";
}

// Render assistant replies as markdown (bold, lists, code, links, tables). Links
// open in a new tab; everything else is styled via `.md` in styles.css.
export default function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: CodeBlock,
        }}
      >
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}
