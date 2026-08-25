import { test } from "node:test";
import assert from "node:assert/strict";
import { findingItems, looksLikeReview, parseFindings } from "../src/findings.js";

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

test("prose with no list yields nothing", () => {
  assert.equal(findingItems("Looks good to me, ship it.").length, 0);
  assert.equal(parseFindings("Looks good to me, ship it."), null);
});
