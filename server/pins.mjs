// Canopy's record of which conversations the user has pinned.
//
// The canvas only draws the N most recently active trees (see store.mjs), so an
// older conversation scrolls off once five newer ones exist. Pinning a tree
// keeps it on the canvas regardless of how old it is. Pins are per workspace,
// kept on disk so they survive a server restart, and stored by the tree's root
// session id.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".canopy", "pins");
// Same path-encoding store.mjs uses for the CLI's project dirs.
const fileFor = (workspace) =>
  join(DIR, `${workspace.replace(/[^a-zA-Z0-9]/g, "-")}.json`);

// The set of pinned root session ids. A missing/corrupt file just means "no
// pins" — never a hard failure.
export function loadPins(workspace) {
  try {
    const raw = JSON.parse(readFileSync(fileFor(workspace), "utf8"));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

// Pin or unpin a conversation by its root id. Returns the updated set.
export function setPin(workspace, rootId, pinned) {
  const pins = loadPins(workspace);
  if (!rootId) return pins;
  if (pinned) pins.add(rootId);
  else pins.delete(rootId);
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(fileFor(workspace), JSON.stringify([...pins]));
  } catch {}
  return pins;
}
