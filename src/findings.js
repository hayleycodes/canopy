// Recognize when an assistant reply is a *review* — the numbered list of
// findings you get back from a "review this PR / diff" turn — and split it into
// its individual findings. A review answered as one node hides its structure:
// you read finding #3, then fork the node by hand to go fix it. Pulling each
// finding out into its own card (see App's synthetic "finding" nodes) turns that
// manual fork into a click. Detection is a pure function of the reply text, so it
// works the same for a live node and one reconstructed from disk.

// Explicit "here are the findings" framing in a reply's lead-in — the thing that
// actually marks a review, as opposed to a passing mention of a word like
// "finding". Either a counted list of problems ("found 3 issues", "two bugs"), or
// a bare "Findings:" / "## Issues" heading on its own line. Deliberately narrow:
// a reply that merely *talks about* a finding (e.g. "here's the expanded
// finding") must NOT match, or every explanation with a numbered list gets split.
const FINDINGS_FRAMING =
  /\b(?:\d+|a|one|two|three|four|five|six|several|multiple|some|few|these|the following)\s+(?:issues?|bugs?|findings?|problems?|defects?|concerns?|vulnerabilit\w+|nits?)\b|(?:^|\n)\s*(?:#{1,6}\s*|\*\*\s*)?(?:findings?|issues?|problems?)\s*:?\*{0,2}\s*(?:\n|$)/i;

// A real code location a finding cites: `path/to/file.ext:42`. This — not an
// inline backtick, which ordinary prose is full of — is the finding texture we
// key on.
const FILE_LINE = /\b[\w./-]+\.[a-z]{1,5}:\d+/i;

// The explicit per-finding heading Canopy asks the reviewer to emit (see
// withReviewFormat): "### Finding 1: …". When present we split on this and skip
// the guesswork entirely — Claude writes the review, so we get to dictate shape.
const FINDING_HEADING = /^\s*#{1,6}\s*Finding\s+\d+\s*[:.\-–—)]?\s+/i;

// The leading marker of a numbered item: "1.", "2)". A review not written to our
// format often numbers each finding as a *heading* ("### 1. …") or bolds the
// number ("**1.** …"), so tolerate a leading `#` heading prefix and/or `**`.
const ITEM_START = /^\s*(?:#{1,6}\s*)?(?:\*\*\s*)?(\d{1,3})[.)]\s+/;

// One finding's headline — the short thing shown on its card. Prefer a bold
// **lead**, else the text up to the first dash/colon separator, else a trimmed
// prefix of the line.
function headlineFor(firstLine) {
  const bold = firstLine.match(/\*\*(.+?)\*\*/);
  let h = bold ? bold[1] : firstLine.split(/\s+[—–-]\s+|:\s+/)[0];
  h = h.replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  if (h.length > 80) h = h.slice(0, 79) + "…";
  return h;
}

// Group a reply into items, one per line matching `startRe`. Each item runs from
// its marker line up to the next, so a finding's continuation lines (details,
// code refs) come with it.
function collectItems(lines, startRe) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) starts.push(i);
  }
  const items = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const block = lines.slice(from, to);
    const firstLine = block[0].replace(startRe, "");
    const body = [firstLine, ...block.slice(1)].join("\n").replace(/\s+$/, "");
    items.push({ n: items.length + 1, headline: headlineFor(firstLine), body });
  }
  return items;
}

// Break a review reply into its findings. Prefer the explicit "### Finding N:"
// convention Canopy asks for (reliable, split even one finding); otherwise fall
// back to a plain/heading numbered list for reviews written outside Canopy — and
// there a lone item isn't a list, so require two.
export function findingItems(text) {
  const lines = (text || "").split(/\r?\n/);
  const explicit = collectItems(lines, FINDING_HEADING);
  if (explicit.length) return explicit;
  const numbered = collectItems(lines, ITEM_START);
  return numbered.length >= 2 ? numbered : [];
}

// True when the reply uses our explicit finding headings — unambiguous, so it
// always splits (no heuristic gate).
function hasExplicitFindings(text) {
  return /^\s*#{1,6}\s*Finding\s+\d+\b/im.test(text || "");
}

// Does this reply read as a *review* worth auto-splitting, versus an ordinary
// numbered list we should leave alone? Deliberately conservative — a false split
// is a confusing surprise, while a missed one is one click of the manual "split"
// button away. So it fires only on strong evidence: explicit findings framing in
// the lead-in, OR most items citing a real file:line location.
export function looksLikeReview(text, items = findingItems(text)) {
  if (!items.length) return false;
  // Our own format is unambiguous — always split, even a single finding.
  if (hasExplicitFindings(text)) return true;
  if (items.length < 2) return false;

  // The text before the first numbered item — where "I found 3 issues:" lives.
  const firstMarker = (text || "").search(/^\s*(?:#{1,6}\s*)?(?:\*\*\s*)?\d{1,3}[.)]\s+/m);
  const leadIn = firstMarker > 0 ? text.slice(0, firstMarker) : "";
  if (FINDINGS_FRAMING.test(leadIn)) return true;

  const cited = items.filter((it) => FILE_LINE.test(it.body)).length;
  return cited >= Math.ceil(items.length / 2);
}

// Strict, auto-fire parse: the items only when the reply looks like a review.
// Returns null otherwise, so a plain "here are 3 steps" reply is left intact.
export function parseFindings(text) {
  const items = findingItems(text);
  return looksLikeReview(text, items) ? items : null;
}
