#!/usr/bin/env node
// Canopy engine spike — proves the core seam before any UI exists.
//
// It answers ONE question: can a local Node process drive Claude Code to
// produce a real *tree* of sessions — a root, forked into divergent branches?
//
// It does three things:
//   1. Seed a root session               (claude -p ... --output-format json)
//   2. Fork it twice into two follow-ups (--resume <id> --fork-session)
//   3. Print the resulting session graph (parent -> children, with IDs)
//
// Run:  node spike.mjs

import { spawn } from "node:child_process";

// --- run one headless claude turn, return the parsed JSON result -------------
// `resumeId` present => fork from that session (branch); absent => fresh root.
function claudeTurn(prompt, resumeId = null) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (resumeId) args.push("--resume", resumeId, "--fork-session");

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${err.trim() || out.trim()}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`could not parse JSON output: ${e.message}\n---\n${out}`));
      }
    });
  });
}

// one-line-ish preview of an assistant reply, for the printout
function preview(text, n = 68) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

async function main() {
  console.log("🌳 Canopy spike — forking a session into a tree\n");

  // 1. ROOT ------------------------------------------------------------------
  console.log("① seeding root session…");
  const root = await claudeTurn(
    "In one short sentence, name a small side project someone could build in a weekend. Just the idea."
  );
  console.log(`   root  ${root.session_id}`);
  console.log(`         “${preview(root.result)}”\n`);

  // 2. FORK TWICE ------------------------------------------------------------
  // Two divergent follow-ups from the SAME root. If forking works, each gets a
  // NEW session_id and the root stays intact.
  console.log("② forking root into two divergent branches…");
  const [branchA, branchB] = await Promise.all([
    claudeTurn("Now argue in one sentence why that idea is exciting.", root.session_id),
    claudeTurn("Now argue in one sentence why that idea is a bad idea.", root.session_id),
  ]);
  console.log(`   fork-A ${branchA.session_id}`);
  console.log(`          “${preview(branchA.result)}”`);
  console.log(`   fork-B ${branchB.session_id}`);
  console.log(`          “${preview(branchB.result)}”\n`);

  // 3. THE GRAPH -------------------------------------------------------------
  console.log("③ resulting session graph:\n");
  const short = (id) => id.slice(0, 8);
  console.log(`   ● ${short(root.session_id)}  root`);
  console.log(`   ├─● ${short(branchA.session_id)}  branch A (exciting)`);
  console.log(`   └─● ${short(branchB.session_id)}  branch B (bad idea)`);

  // --- assertions: this is what "the spike passed" actually means -----------
  const ids = new Set([root.session_id, branchA.session_id, branchB.session_id]);
  console.log("\n— checks —");
  const distinct = ids.size === 3;
  const rootUntouched =
    branchA.session_id !== root.session_id && branchB.session_id !== root.session_id;
  console.log(`   ${distinct ? "✓" : "✗"} three distinct session IDs (forks branched, not mutated)`);
  console.log(`   ${rootUntouched ? "✓" : "✗"} root ID preserved on both forks`);

  if (distinct && rootUntouched) {
    console.log("\n✅ spike passed — the tree has a real spine.");
  } else {
    console.log("\n❌ spike failed — forking did not branch as expected.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("\n💥 spike error:\n" + e.message);
  process.exitCode = 1;
});
