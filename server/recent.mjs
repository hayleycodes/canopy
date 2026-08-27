// Canopy's list of recently-opened workspaces.
//
// The whole point of workspace-switching is that you launch Canopy ONCE and pick
// the repo from inside it, instead of running a server-per-repo and juggling
// ports. For that, the repo switcher needs something to show — this is the
// most-recently-opened-first list that populates it.
//
// Unlike pins/lineage/archives (which are per workspace), this is a single
// global file: it's the index OF workspaces, so it can't itself be keyed by one.

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const FILE = join(homedir(), ".canopy", "recent.json");
// Keep the list short — a switcher dropdown, not a history log.
const MAX_RECENT = 20;

// Absolute, symlink-free-ish canonical form so the same repo reached two ways
// (trailing slash, relative launch) collapses to one entry.
export function normalizeWorkspace(path) {
  return resolve(path);
}

// Is this an openable workspace — an existing directory?
export function isWorkspaceDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The recent list, most-recently-opened first. A missing/corrupt file just means
// "nothing yet" — never a hard failure. Stale entries (dir since deleted) are
// filtered so the switcher never offers a repo that's gone.
export function loadRecent() {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    const list = Array.isArray(raw) ? raw : [];
    return list.filter(isWorkspaceDir);
  } catch {
    return [];
  }
}

// Record that a workspace was opened: move it to the front (most recent), dedupe,
// and cap the list. Returns the updated list.
export function recordRecent(workspace) {
  const path = normalizeWorkspace(workspace);
  const list = [path, ...loadRecent().filter((p) => p !== path)].slice(0, MAX_RECENT);
  try {
    mkdirSync(join(homedir(), ".canopy"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(list, null, 2));
  } catch {}
  return list;
}
