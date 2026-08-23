import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Render assistant replies as markdown (bold, lists, code, links, tables). Links
// open in a new tab; everything else is styled via `.md` in styles.css.
export default function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}
