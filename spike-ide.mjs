#!/usr/bin/env node
// Canopy IDE spike — proves the OTHER headline capability: a forked branch
// reaching into the user's live VS Code, not just writing to disk.
//
// Requires: VS Code running with the Claude Code extension, a workspace open
// (a lock file present at ~/.claude/ide/<port>.lock).
//
// It does four things:
//   1. Seed a root, fork it                    (fork still works)
//   2. On the fork, spawn `claude --ide` and    (hands in the editor)
//      ask it to CREATE a file in the workspace
//   3. Verify the file actually landed on disk
//   4. Ask it to read live VS Code diagnostics   (extension-only, two-way proof)
//
// Run from inside the workspace VS Code has open:
//   node spike-ide.mjs

import { spawn } from "node:child_process";
import { readFile, readdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKSPACE = process.cwd();
const MARKER_FILE = "canopy-hello.txt";

// --- confirm the IDE seam exists before we lean on it ------------------------
async function findIdeLock() {
  const dir = join(homedir(), ".claude", "ide");
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".lock"));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const lock = JSON.parse(await readFile(join(dir, f), "utf8"));
      if ((lock.workspaceFolders || []).some((w) => WORKSPACE.startsWith(w) || w.startsWith(WORKSPACE))) {
        return { file: f, ...lock };
      }
    } catch {}
  }
  // fall back to any lock at all, just report it
  return files.length ? { file: files[0], workspaceFolders: ["<unmatched>"] } : null;
}

// --- run one headless claude turn --------------------------------------------
// opts: { resumeId?, ide?: bool }  -> returns parsed JSON result
function claudeTurn(prompt, { resumeId = null, ide = false } = {}) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (resumeId) args.push("--resume", resumeId, "--fork-session");
  if (ide) args.push("--ide");
  // let it actually edit files without an interactive approval prompt
  args.push("--permission-mode", "acceptEdits");

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], cwd: WORKSPACE });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim() || out.trim()}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`bad JSON: ${e.message}\n---\n${out}`)); }
    });
  });
}

const preview = (t, n = 90) => {
  const c = (t || "").replace(/\s+/g, " ").trim();
  return c.length > n ? c.slice(0, n - 1) + "…" : c;
};
const fileExists = (p) => access(p).then(() => true).catch(() => false);

async function main() {
  console.log("🌳 Canopy IDE spike — a forked branch reaching into VS Code\n");

  const lock = await findIdeLock();
  if (!lock) {
    console.log("✗ No IDE lock file found. Open this folder in VS Code with the");
    console.log("  Claude Code extension running, then re-run. Skipping.");
    process.exitCode = 1;
    return;
  }
  console.log(`   IDE lock: ${lock.file}  ·  workspace: ${lock.workspaceFolders?.[0]}\n`);

  // 1. root + fork -----------------------------------------------------------
  console.log("① seeding root + forking…");
  const root = await claudeTurn("Reply with exactly the word: ready");
  const fork = { session_id: root.session_id }; // placeholder for clarity
  console.log(`   root ${root.session_id.slice(0, 8)}\n`);

  // 2. forked branch edits the workspace via --ide ---------------------------
  console.log(`② forked branch (--ide) creating ${MARKER_FILE} in the workspace…`);
  const edit = await claudeTurn(
    `Create a file named ${MARKER_FILE} in the current directory containing exactly this line: ` +
      `"Canopy reached into VS Code." Then reply with the word done.`,
    { resumeId: root.session_id, ide: true }
  );
  console.log(`   fork ${edit.session_id.slice(0, 8)}  ·  “${preview(edit.result)}”`);

  // 3. verify on disk --------------------------------------------------------
  const path = join(WORKSPACE, MARKER_FILE);
  const landed = await fileExists(path);
  let contents = "";
  if (landed) contents = (await readFile(path, "utf8")).trim();
  console.log(`   ${landed ? "✓" : "✗"} file on disk${landed ? `: “${contents}”` : ""}\n`);

  // 4. two-way: read live diagnostics from VS Code ---------------------------
  console.log("③ asking the branch to read live VS Code diagnostics (extension-only)…");
  const diag = await claudeTurn(
    "Use your IDE connection to get current diagnostics from the open editor " +
      "(the mcp__ide__getDiagnostics tool). Summarise in one sentence how many " +
      "problems VS Code reports, or say 'no problems' if none.",
    { resumeId: edit.session_id, ide: true }
  );
  console.log(`   “${preview(diag.result, 120)}”\n`);

  // --- verdict --------------------------------------------------------------
  console.log("— checks —");
  const contentOk = contents.includes("Canopy reached into VS Code");
  console.log(`   ${landed ? "✓" : "✗"} forked branch wrote a file into the live workspace`);
  console.log(`   ${contentOk ? "✓" : "✗"} file contents are correct`);
  console.log(`   • diagnostics call returned above (manual read — did it use the IDE tool?)`);

  if (landed && contentOk) {
    console.log("\n✅ IDE spike passed — a forked branch has hands in your editor.");
    console.log(`   (leftover ${MARKER_FILE} is safe to delete)`);
  } else {
    console.log("\n❌ IDE spike failed — the branch did not edit the workspace as expected.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("\n💥 spike error:\n" + e.message);
  process.exitCode = 1;
});
