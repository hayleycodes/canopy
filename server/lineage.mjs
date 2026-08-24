// Canopy's own record of what forked from what.
//
// store.mjs infers fork lineage by matching duplicated message UUIDs: a fork
// copies its parent's messages verbatim, so a session is a child when the
// parent's UUID list is a prefix of the child's. That holds until a turn gets
// auto-compacted — compaction rewrites the child's history, erasing the shared
// prefix, and the fork detaches into a stray root. Large repos (where turns
// carry enough context to trip compaction) hit this constantly; small ones never
// do, which is why a busy workspace's tree seems to randomly fall apart.
//
// Canopy already knows the true parent at fork time (it ran --resume <parent>),
// so we persist that link and use it to repair the reconstructed tree. Kept per
// workspace, on disk, so it survives a server restart.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".canopy", "lineage");
// Same path-encoding store.mjs uses for the CLI's project dirs.
const fileFor = (workspace) =>
  join(DIR, `${workspace.replace(/[^a-zA-Z0-9]/g, "-")}.json`);

// child session id -> parent session id, as Canopy recorded it at fork time.
// A missing/corrupt file just means "no links known" — never a hard failure.
export function loadLinks(workspace) {
  try {
    const raw = JSON.parse(readFileSync(fileFor(workspace), "utf8"));
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

// Remember that `childId` forked from `parentId`. A no-op for seeded roots (no
// parent) and for links we already have.
export function recordLink(workspace, childId, parentId) {
  if (!childId || !parentId) return;
  const links = loadLinks(workspace);
  if (links.get(childId) === parentId) return;
  links.set(childId, parentId);
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(fileFor(workspace), JSON.stringify(Object.fromEntries(links)));
  } catch {}
}
