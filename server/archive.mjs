// Canopy's record of which conversations the user has archived.
//
// Archiving is the mirror image of pinning (see pins.mjs): where a pin forces a
// tree to stay on the canvas past the recency limit, an archive forces one off
// the canvas regardless of how recent it is — without deleting its transcript.
// Archived trees are listed in a drawer so they can be brought back. Archives
// are per workspace, kept on disk so they survive a server restart, and stored
// by the tree's root session id.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".canopy", "archived");
// Same path-encoding store.mjs uses for the CLI's project dirs.
const fileFor = (workspace) =>
  join(DIR, `${workspace.replace(/[^a-zA-Z0-9]/g, "-")}.json`);

// The set of archived root session ids. A missing/corrupt file just means
// "nothing archived" — never a hard failure.
export function loadArchived(workspace) {
  try {
    const raw = JSON.parse(readFileSync(fileFor(workspace), "utf8"));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

// Archive or unarchive a conversation by its root id. Returns the updated set.
export function setArchived(workspace, rootId, archived) {
  const set = loadArchived(workspace);
  if (!rootId) return set;
  if (archived) set.add(rootId);
  else set.delete(rootId);
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(fileFor(workspace), JSON.stringify([...set]));
  } catch {}
  return set;
}
