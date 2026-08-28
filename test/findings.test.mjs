import { test } from "node:test";
import assert from "node:assert/strict";
import { findingItems, looksLikeReview, parseFindings, looksLikeFanout, fanoutItems } from "../src/findings.js";

test("explicit `### Finding N:` headings split deterministically, even one", () => {
  const review = `## Summary

Looks fine overall.

## Findings

### Finding 1: Dark-mode tokens are dead

\`provider/StudentUiProvider.tsx:12\` — the .dark class is never emitted.`;
  const items = findingItems(review);
  assert.equal(items.length, 1); // explicit format splits even a lone finding
  assert.equal(items[0].headline, "Dark-mode tokens are dead");
  assert.ok(looksLikeReview(review));
});

const REVIEW = `I reviewed the diff and found 3 issues:

1. **Race condition in the cache** — two requests can populate \`src/cache.ts:42\`
   at once, so the second write is lost.
2. **Missing null check** in \`handler.ts:88\` — \`user\` may be undefined.
3. **N+1 query** in the render loop, one round-trip per row.`;

test("splits a review reply into one item per finding", () => {
  const items = findingItems(REVIEW);
  assert.equal(items.length, 3);
  assert.equal(items[0].n, 1);
  assert.equal(items[0].headline, "Race condition in the cache");
  assert.equal(items[1].headline, "Missing null check");
  // The body keeps the finding's continuation lines (the code ref, the detail).
  assert.match(items[0].body, /src\/cache\.ts:42/);
});

test("a review reply auto-detects", () => {
  assert.ok(looksLikeReview(REVIEW));
  assert.equal(parseFindings(REVIEW).length, 3);
});

test("splits a review whose findings are prefixed with a severity emoji", () => {
  // The shape the code-review skill emits: a severity emoji before the bold
  // number ("🔴 **1. …**"). The emoji must not defeat the item-start match.
  const review = `Here's my review of **PR 5553**.

Five findings, ranked by severity.

---

🔴 **1. Migration mislabels every existing contacted nomination**

\`services/api/db/migrations/x.sql:5\` — no backfill, so historical rows stay wrong.

🟠 **2. Lost-update race in \`advanceNominationOnSuccessfulLog\`**

\`services/api/service/src/lib/workPlacement/contactStatusTransitions.ts:79\` — read-then-write with no lock.`;
  const items = findingItems(review);
  assert.equal(items.length, 2);
  assert.equal(items[0].headline, "Migration mislabels every existing contacted nomination");
  assert.equal(items[1].headline, "Lost-update race in advanceNominationOnSuccessfulLog");
  assert.ok(looksLikeReview(review));
  assert.equal(parseFindings(review).length, 2);
});

test("the last finding does not swallow the review's closing wrap-up", () => {
  // The last item has no next-marker boundary, so a trailing "My take: …"
  // paragraph was landing inside finding #3's card. It belongs on the review, not
  // the finding.
  const review = `I found 3 issues:

1. **Race condition** — \`src/cache.ts:42\` drops a write.

2. **Missing null check** — \`handler.ts:88\` may be undefined.

3. **Inconsistent casing** — \`meta.tsx:7\` mixes Title and sentence case.

---

**My take:** #1 is the definite fix. Want me to apply it?`;
  const items = findingItems(review);
  assert.equal(items.length, 3);
  const last = items[2];
  assert.equal(last.headline, "Inconsistent casing");
  assert.doesNotMatch(last.body, /My take/);
  assert.doesNotMatch(last.body, /---/); // the separating rule is dropped too
  assert.match(last.body, /Title and sentence case/); // the finding itself is kept
});

test("an ordinary numbered list does not auto-detect", () => {
  const steps = `To set it up:\n\n1. Install the deps\n2. Start the server\n3. Open the page`;
  assert.equal(looksLikeReview(steps), false);
  assert.equal(parseFindings(steps), null);
  // ...but it's still a splittable list for the manual button.
  assert.equal(findingItems(steps).length, 3);
});

test("a single numbered item is not a list", () => {
  assert.equal(findingItems("1. just the one thing").length, 0);
});

test("splits a review whose findings are numbered headings", () => {
  // The real shape that slipped through: findings as "### N." headings under a
  // bold "Findings" heading, each with its code ref on its own line.
  const review = `Here's my review of **PR 5547**.

**Summary**

Clean, well-scoped change.

**Findings**

### 1. **Dark-mode semantic tokens are permanently unreachable** 🚩 *(most substantive)*

\`apps/student/ui/src/provider/StudentUiProvider.tsx:12\`

The scope div always carries light, so the _dark token set is dead.

### 2. **Duplicated name-derivation logic**

\`apps/student/ui/src/home/Home.tsx:40\`

The same derivation runs twice.`;
  const items = findingItems(review);
  assert.equal(items.length, 2);
  assert.equal(items[0].headline, "Dark-mode semantic tokens are permanently unreachable");
  assert.equal(items[1].headline, "Duplicated name-derivation logic");
  assert.ok(looksLikeReview(review));
  assert.match(items[0].body, /StudentUiProvider\.tsx:12/);
});

test("splits a review whose findings are emoji-tagged headings with a trailing clean section", () => {
  // The real shape that slipped through: the code-review skill emits findings as
  // `## 🚩 N.` headings — the severity emoji sits AFTER the hashes, not before —
  // and closes with a `### Checked and clean` section. The emoji-after-hash
  // defeated the item-start match, and once fixed the trailing section tripped the
  // scenario-trace gate. Heading-style findings should split regardless.
  const review = `Here's the review of **PR 5567** — a backend-only port. Two genuine correctness findings surfaced.

---

## 🚩 1. Two consecutive \`choice\` turns produce a broken React Flow graph

**\`transformConversationsToReactFlow.ts:970\`**

Only *dialogue* turns consume \`pendingConverge\`, so back-to-back choices dangle.

## 🚩 2. Unit introduction blocks silently dropped when there are zero sections

**\`3-content.ts:261\`**

If \`finalised.sections\` is empty, the intro blocks never reach the guide.

---

### Checked and clean (not findings)
- \`unitService.ts:26\` — nullable field is safe.
- \`pipelineInput.ts\` — defaults fixed.

Both findings are edge cases, so this is a low-risk port.`;
  const items = findingItems(review);
  assert.equal(items.length, 2);
  assert.equal(items[0].headline, "Two consecutive choice turns produce a broken React Flow graph");
  assert.equal(items[1].headline, "Unit introduction blocks silently dropped when there are zero sections");
  assert.ok(looksLikeReview(review));
  assert.equal(parseFindings(review).length, 2);
  // The last finding must not swallow the trailing clean section or wrap-up.
  assert.doesNotMatch(items[1].body, /Checked and clean/);
  assert.doesNotMatch(items[1].body, /low-risk port/);
  assert.match(items[1].body, /intro blocks never reach the guide/);
});

test("an explanation that merely mentions a finding does not auto-detect", () => {
  // Regression: a reply expanding on ONE finding, whose body is a numbered list
  // of the functions involved, was wrongly split into finding cards — the word
  // "finding" in the lead-in and backticked names looked review-ish.
  const expand = `Good — the code confirms it. Here's the expanded finding.

## Expanding #2

1. \`resolveUserSiteAccess\` (lines 7-27) resolves the site.
2. \`scopeEnrolmentsToUserAccess\` (lines 29-56) scopes the enrolments.`;
  assert.equal(looksLikeReview(expand), false);
  assert.equal(parseFindings(expand), null);
  // Still splittable by hand if you want it.
  assert.equal(findingItems(expand).length, 2);
});

test("a numbered scenario trace with trailing sections does not auto-detect", () => {
  // Regression: a walkthrough numbered as steps (Sally → … → Sam), then continuing
  // into `## ` discussion sections, was split into finding cards. No "found N
  // issues" framing, so it hit the citation heuristic — and the LAST step swallows
  // the trailing "**The critical finding:**" prose, whose `…ts:19` ref plus the
  // first step's ref cleared the "half the items cite a file:line" bar.
  const trace = `That settles it. Here's the answer to your scenario.

## Tracing your scenario

**Sally → Mitre 10 Bridgetown:**
1. Sally types "Mitre 10 Bridgetown" as free text. Her nomination is created with \`employerId = null\` (createNomination.ts:76 — no employer lookup at all).
2. Admin logs a contact → \`ensureNominationEmployer\` creates a brand-new employer record for Mitre 10.
3. Admin saves to directory → that same employer record flips to \`isInDirectory: true\`.

**Now Sam → also "Mitre 10 Bridgetown":**
4. Sam types "Mitre 10 Bridgetown" as free text. His nomination is created with \`employerId = null\`.

**The critical finding:** There is no matching logic anywhere — not on log (ensureNominationEmployer.ts:19 just blindly creates a new employer).

## So, directly answering your question

No. Sam's nomination won't auto-link to Sally's employer record.`;
  assert.equal(looksLikeReview(trace), false);
  assert.equal(parseFindings(trace), null);
  // Still splittable by hand if you want it.
  assert.equal(findingItems(trace).length, 4);
});

test("a finding opening with a file ref splits the path off the headline", () => {
  // When the finding leads with its code location ("**`file.ts:116`** — desc"),
  // the long unbreakable path used to land in the headline and overflow the card.
  // Peel it into `file` so the card headlines the description and renders the path
  // as its own truncatable chip.
  const review = `I found 2 issues:

1. **\`saveAndContinueFromAllocation.ts:116\`** — recurring cast validation gap, \`guide\` is nullable.

2. \`src/api/handler.ts:88\` — headers are never set on the retry path.`;
  const items = findingItems(review);
  assert.equal(items.length, 2);
  assert.equal(items[0].file, "saveAndContinueFromAllocation.ts:116");
  assert.equal(items[0].headline, "recurring cast validation gap, guide is nullable.");
  assert.equal(items[1].file, "src/api/handler.ts:88");
  assert.equal(items[1].headline, "headers are never set on the retry path.");
  // The full text still lives in the body for the inspector.
  assert.match(items[0].body, /saveAndContinueFromAllocation\.ts:116/);
});

test("a finding that doesn't open with a file ref has a null file", () => {
  // "app.js is broken" must not be mistaken for a file chip: a bare filename with
  // no backticks and no :line is prose, not a citation.
  const items = findingItems(REVIEW);
  assert.equal(items[0].file, null);
  assert.equal(items[0].headline, "Race condition in the cache");
});

test("prose with no list yields nothing", () => {
  assert.equal(findingItems("Looks good to me, ship it.").length, 0);
  assert.equal(parseFindings("Looks good to me, ship it."), null);
});

// ── Fan-out proposals: the "spin up N branches" trigger ──

// The real shape from the screenshot: a plan to hand three pieces to parallel
// subagents, each written up as a numbered heading with its own file refs.
const FANOUT = `This is three distinct pieces of work. Let me parallelize the investigation — I'll have subagents dig into (1) the Realtime setup, (2) the CSS/layout, and (3) the resize bug.

## 1. Live updates — Supabase Realtime

\`sighting-candidates.service.ts:42\` — add \`subscribeToPendingCandidates()\`.

## 2. Gliding carousel

Replace the single remounted card with a track: all cards in a flex row.

## 3. The residual resize-on-select

The old \`min-height: 40px\` reserve could still drift on narrow widths.`;

test("a fan-out proposal detects and yields one item per track", () => {
  const items = fanoutItems(FANOUT);
  assert.equal(items.length, 3);
  assert.equal(items[0].headline, "Live updates"); // headlineFor trims at the em-dash
  assert.equal(items[1].headline, "Gliding carousel");
  assert.equal(items[2].headline, "The residual resize-on-select");
  assert.ok(looksLikeFanout(FANOUT));
  // The body carries the track's detail, so the forked branch inherits the plan.
  assert.match(items[0].body, /subscribeToPendingCandidates/);
});

test("a fan-out proposal is not treated as a review", () => {
  // It cites file:lines and has ≥2 heading items, so the citation heuristic could
  // fire — but the app gives fan-out precedence, and here we just confirm both
  // detectors can see it so the App layer can prefer fan-out.
  assert.ok(looksLikeFanout(FANOUT));
});

test("a past-tense review is not a fan-out", () => {
  // The demo review shape ("I found 3 issues") must stay passive finding cards,
  // not sprout a spin-up button.
  assert.equal(looksLikeFanout(REVIEW), false);
  assert.equal(fanoutItems(REVIEW).length, 0);
});

test("an ordinary numbered plan without parallel framing is not a fan-out", () => {
  const plan = `Here's the plan:

1. Add the migration
2. Wire up the service
3. Update the UI`;
  assert.equal(looksLikeFanout(plan), false);
  assert.equal(fanoutItems(plan).length, 0);
});

test("a single-item proposal is not a fan-out", () => {
  const one = `Let me parallelize this.

1. Just the one thing.`;
  assert.equal(looksLikeFanout(one), false);
  assert.equal(fanoutItems(one).length, 0);
});
