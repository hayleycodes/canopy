import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// A copy button that flashes a checkmark for a moment after copying. Shared by
// the whole-block button and the per-line buttons.
function CopyButton({ text, className }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button className={className} onClick={copy} title="Copy">
      {copied ? "✓ copied" : "copy"}
    </button>
  );
}

// A fenced code block. A multi-line block often bundles several independent
// commands (e.g. `cd …` then `yarn test`), and one copy button that grabs all of
// them is useless when you need to run them one at a time — so each line gets its
// own hover copy button, plus a whole-block button for when you do want it all.
function CodeBlock({ children, ...props }) {
  const text = codeText(children).replace(/\n$/, "");
  const lines = text.split("\n");
  const multi = lines.length > 1;
  return (
    <pre {...props} className={multi ? "multiline" : undefined}>
      <CopyButton className="copyBtn nodrag" text={text} />
      {multi ? (
        <code>
          {lines.map((line, i) => (
            <span className="codeLine" key={i}>
              {line || " "}
              {line.trim() && (
                <CopyButton className="lineCopyBtn nodrag" text={line} />
              )}
              {"\n"}
            </span>
          ))}
        </code>
      ) : (
        children
      )}
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

// External link renderer — hoisted (not an inline arrow) so `components` can be a
// stable module constant. A fresh `components` object each render would defeat
// react-markdown's memoization and re-parse on every token.
const ExternalLink = (props) => <a {...props} target="_blank" rel="noreferrer" />;
const REMARK_PLUGINS = [remarkGfm];
const COMPONENTS = { a: ExternalLink, pre: CodeBlock };

// Render assistant replies as markdown (bold, lists, code, links, tables). Links
// open in a new tab; everything else is styled via `.md` in styles.css.
//
// Memoized on `children`: the inspector re-renders on every streamed token, but
// only the one growing segment's text actually changes — every other exchange in
// the thread has identical text, so it skips the (expensive) remark re-parse.
function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
