// Recognize when a prompt is really a *pasted error* — a stack trace or log
// blob someone dropped in to start a conversation — and pull out a concise
// headline for it. A raw paste truncated to 60 chars ("[duke-hq-svc-api]: @duke…")
// is a useless node title; the error's class + message is what you actually want
// to see on the canvas. Detection is a pure function of the prompt text, so it
// works the same for a live pending node and one reconstructed from disk.

// An error/exception class token, e.g. DriverAdapterError, TypeError,
// NullPointerException, TRPCError.
const ERROR_CLASS = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception|Fault|Panic|Warning))\b/;

// A stack-frame-ish line: a JS "at …" frame, a Python `File "…", line N`, or any
// `path:line[:col]` location — the tell-tale texture of a trace, not a sentence.
function isFrame(line) {
  return (
    /^\s*at\s+/.test(line) ||
    /^\s*File\s+".*",\s*line\s+\d+/.test(line) ||
    /(?:file:\/\/|node:internal|\/|\\)[^\s]*:\d+(?::\d+)?/.test(line)
  );
}

// Returns null for an ordinary prompt, or { errorType, message, frameCount }
// when the text reads as a pasted error.
export function parseErrorPaste(text) {
  const raw = (text || "").trim();
  if (raw.length < 60) return null; // a passing mention of "TypeError" isn't a paste

  const lines = raw.split(/\r?\n/);
  const frameCount = lines.filter(isFrame).length;
  const classMatch = raw.match(ERROR_CLASS);
  // The "SomeError: message" form — a thrown error printed with its message,
  // which prose almost never writes but a paste almost always contains.
  const colon = raw.match(/\b[A-Z][A-Za-z0-9_]*(?:Error|Exception|Fault|Panic|Warning):\s*([^\n]+)/);

  // Treat it as an error paste only with real evidence: an actual stack (≥2
  // frames), a named error class alongside at least one frame, or a printed
  // "SomeError: …" line in a multi-line blob. This keeps normal prose out.
  const looksError =
    frameCount >= 2 || (classMatch && frameCount >= 1) || (colon && lines.length >= 3);
  if (!looksError) return null;

  const errorType = classMatch ? classMatch[1] : "Error";

  // The message: whatever follows the first "SomeError: …" on its line. Fall back
  // to the first substantive (non-frame) line if there's no colon form.
  let message = "";
  if (colon) {
    message = colon[1];
  } else {
    message = lines.find((l) => l.trim() && !isFrame(l)) || "";
  }
  message = message.replace(/\s+/g, " ").trim();
  if (message.length > 160) message = message.slice(0, 159) + "…";

  return { errorType, message, frameCount };
}
