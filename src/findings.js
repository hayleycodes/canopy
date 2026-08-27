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
// Tools like the code-review skill also prefix a severity emoji — and it may sit
// either before the heading ("🔴 **1.** …") or *after* the hashes ("## 🚩 1. …"),
// so allow an optional pictographic marker (with its variation-selector / ZWJ
// bytes) in both positions.
const ITEM_START = /^\s*(?:[\p{Extended_Pictographic}️‍]+\s*)?(?:#{1,6}\s*)?(?:[\p{Extended_Pictographic}️‍]+\s*)?(?:\*\*\s*)?(\d{1,3})[.)]\s+/u;

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

// The lead-in of a review's closing wrap-up — the paragraph after the last
// finding where the reviewer steps back ("My take: …", "Overall …", "Bottom
// line: …"). Distinctly a summary word, not a within-finding subsection like
// "Fix:" or "Impact:", so trimming on it won't eat a finding's own detail.
const CLOSING_LEAD =
  /^\s*(?:#{1,6}\s*)?\*{0,2}\s*(?:my take|my recommendation|overall|in summary|to summari[sz]e|bottom line|net[- ]net|tl;?dr|verdict|conclusion|closing thoughts?|final thoughts?)\b/i;

// A horizontal rule (`---`, `***`, `___`) on its own line.
const HR = /^\s*([-*_])\1{2,}\s*$/;

// The last finding has no next-marker boundary, so its block runs to the end of
// the reply and swallows any trailing wrap-up. Cut the block at the first
// fresh-paragraph boundary — either a closing lead-in ("Overall …") or a new
// section heading that isn't itself a finding ("### Checked and clean") — and drop
// the blank/rule separating it, so a finding card shows only the finding. The
// trailing content already lives on the review node.
function trimClosingSummary(block) {
  for (let i = 1; i < block.length; i++) {
    if (block[i - 1].trim() !== "") continue; // must begin a new paragraph
    const isSection = /^\s*#{1,6}\s+\S/.test(block[i]) && !ITEM_START.test(block[i]);
    if (!CLOSING_LEAD.test(block[i]) && !isSection) continue;
    let cut = i;
    while (cut > 1 && (block[cut - 1].trim() === "" || HR.test(block[cut - 1]))) cut--;
    return block.slice(0, cut);
  }
  return block;
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
    const isLast = s + 1 >= starts.length;
    const to = isLast ? lines.length : starts[s + 1];
    let block = lines.slice(from, to);
    if (isLast) block = trimClosingSummary(block);
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

// A markdown section heading (## …) sitting *after* the numbered list starts means
// the numbers are steps inside a larger document — a scenario trace, a walkthrough —
// not a bare findings list. A real un-framed review is just its list; it doesn't
// resume into fresh titled sections. This matters because the last numbered item
// has no lower boundary and swallows all the trailing prose, so a discussion that
// happens to cite a file:line down there wrongly trips the citation heuristic.
// (Our explicit `### Finding N:` / `### N.` shapes are handled above, and a
// heading-prefixed item like `### 2.` is an ITEM_START, so it's excluded here.)
function hasSectionAfterList(text, firstMarker) {
  const after = firstMarker > 0 ? (text || "").slice(firstMarker) : text || "";
  return after
    .split(/\r?\n/)
    .some((l) => /^\s*#{1,6}\s+\S/.test(l) && !ITEM_START.test(l));
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
  const firstMarker = (text || "").search(/^\s*(?:[\p{Extended_Pictographic}️‍]+\s*)?(?:#{1,6}\s*)?(?:[\p{Extended_Pictographic}️‍]+\s*)?(?:\*\*\s*)?\d{1,3}[.)]\s+/mu);
  const leadIn = firstMarker > 0 ? text.slice(0, firstMarker) : "";
  if (FINDINGS_FRAMING.test(leadIn)) return true;

  // Numbers embedded in a larger document (a trace, a walkthrough) rather than a
  // bare findings list — bail before the citation heuristic below mistakes the
  // trailing discussion's file refs for finding citations. Skipped when the items
  // are themselves markdown headings ("## 🚩 1. …"): a prose scenario trace
  // doesn't promote each step to a heading, so a following section (e.g. a review's
  // "### Checked and clean" list) is expected structure, not a document body.
  const markerLine = (text || "").split(/\r?\n/).find((l) => ITEM_START.test(l)) || "";
  const headingStyle = /^\s*#{1,6}\s/.test(markerLine);
  if (!headingStyle && hasSectionAfterList(text, firstMarker)) return false;

  const cited = items.filter((it) => FILE_LINE.test(it.body)).length;
  return cited >= Math.ceil(items.length / 2);
}

// Strict, auto-fire parse: the items only when the reply looks like a review.
// Returns null otherwise, so a plain "here are 3 steps" reply is left intact.
export function parseFindings(text) {
  const items = findingItems(text);
  return looksLikeReview(text, items) ? items : null;
}
