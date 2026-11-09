#!/usr/bin/env node
// Behavioural tests for scripts/kanban-move.sh — the board mirror's only writer.
//
// The mirror's failure mode is not a crash, it is silence: every call site chains
// `|| true`, so a card that stops moving looks exactly like a project with no
// board. That is how a shipped feature sat in "Ready to build" for a day — the
// ship session decided, without opening the config, that no board was configured.
// `auto` moved that decision out of the agent and into here, so here is where it
// has to be pinned: what resolves, what refuses to resolve, and the fact that a
// refusal SAYS WHY on stdout instead of exiting quietly.
//
//   node scripts/test-kanban.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts", "kanban-move.sh");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "kanban-"));
  tmps.push(d);
  return d;
}

const COLUMNS = ["Ideas", "Brainstorm", "Spec", "Ready to build", "Building",
                 "Review", "Fix", "Ship", "Shipped"];

function board(dir, cards = {}, name = "Tasks.md") {
  const body = [
    "---", "", "kanban-plugin: board", "", "---", "",
    ...COLUMNS.flatMap((c) => ["## " + c, "", ...(cards[c] || []), ""]),
    "%% kanban:settings", "```",
    JSON.stringify({ "kanban-plugin": "board", "list-collapse": COLUMNS.map(() => false) }),
    "```", "%%", "",
  ].join("\n");
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

function config(dir, { project = "demo", vault, boardRel = "Demo/Tasks.md",
                       enabled = true, kanbanEnabled = true, columns, boardColumns } = {}) {
  const lines = [
    `enabled: ${enabled}                 # cfg:enabled`,
    "",
    "obsidian:",
    `  vault_path: "${vault}"  # cfg:vault_path`,
    "",
    "kanban:",
    `  enabled: ${kanbanEnabled}               # cfg:kanban_enabled`,
    "  columns:",
    ...Object.entries(columns || {
      ideas: "Ideas", brainstorm: "Brainstorm", spec: "Spec", ready: "Ready to build",
      building: "Building", review: "Review", fix: "Fix", ship: "Ship", shipped: "Shipped",
    }).map(([k, v]) => `    ${k}: "${v}"`),
    "  boards:",
    `    ${project}:`,
    `      board: "${boardRel}"`,
    ...(boardColumns ? [`      columns: { ${boardColumns} }`] : []),
  ];
  const p = join(dir, "cohorte.config.yaml");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function profile(dir, name) {
  writeFileSync(join(dir, "PIPELINE.md"), [
    "# PIPELINE.md", "",
    "```yaml pipeline-profile",
    "# ── identity ──",
    `name: ${name}`,
    "ui_language: French",
    "surfaces:",
    "  - key: backend",
    "    name: not-the-project-name",
    "```", "",
  ].join("\n"));
}

function run(args, { cwd, config: cfg } = {}) {
  const r = spawnSync("sh", [SCRIPT, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, ...(cfg ? { COHORTE_CONFIG: cfg } : {}) },
  });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const columnOf = (path, id) => {
  let col = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("## ")) col = line.slice(3).trim();
    else if (line.includes("#" + id)) return col;
  }
  return null;
};

// ── explicit board path (the pre-existing contract) ─────────────────────────
console.log("explicit board");
{
  const d = scratch();
  const b = board(d, { "Ready to build": ["- [ ] Some feature  #feat-a"] });
  const r = run([b, "feat-a", "Shipped", "--pr", "42"]);
  check("moves a card to a literal heading", r.status === 0 && columnOf(b, "feat-a") === "Shipped", r.err);
  check("appends the PR number", readFileSync(b, "utf8").includes("#feat-a — PR #42"));
}
{
  const d = scratch();
  const b = board(d);
  const r = run([b, "feat-new", "Spec", "--title", "Brand new"]);
  check("creates a missing card", r.status === 0 && columnOf(b, "feat-new") === "Spec", r.err);
  check("uses --title for the new card", readFileSync(b, "utf8").includes("- [ ] Brand new  #feat-new"));
}
{
  const d = scratch();
  const b = board(d, { Ideas: ["- [ ] Dup  #dup", "- [ ] Dup again  #dup"] });
  run([b, "dup", "Building"]);
  const hits = readFileSync(b, "utf8").split("\n").filter((l) => l.includes("#dup")).length;
  check("collapses duplicates to one card", hits === 1, `found ${hits}`);
}
{
  const d = scratch();
  const b = board(d, { Ideas: ["- [ ] Parent  #par", "  - a sub-note", "  - another"] });
  run([b, "par", "Brainstorm"]);
  const txt = readFileSync(b, "utf8");
  check("carries sub-notes along", columnOf(b, "par") === "Brainstorm" && txt.includes("  - a sub-note"));
  check("leaves the settings block intact", txt.includes("%% kanban:settings"));
}
{
  const d = scratch();
  const b = board(d, { Ideas: ["- [ ] X  #x"] });
  const r = run([b, "x", "Nonexistent column"]);
  check("unknown literal column is a loud failure (exit 3)", r.status === 3, `exit ${r.status}`);
  const r2 = run(["/nope/board.md", "x", "Ideas"]);
  check("missing explicit board is a loud failure (exit 3)", r2.status === 3, `exit ${r2.status}`);
}
{
  const d = scratch();
  const b = board(d, { Ideas: ["- [ ] X  #x"] });
  for (let i = 0; i < 6; i++) run([b, "x", i % 2 ? "Ideas" : "Building"]);
  const blanks = (readFileSync(b, "utf8").match(/\n\n\n/g) || []).length;
  check("repeated moves do not pad the board with blank lines", blanks === 0,
        `${blanks} runs of blank lines after 6 moves`);
}

// ── auto resolution (the fix) ───────────────────────────────────────────────
console.log("auto resolution");
{
  const d = scratch();
  const vault = join(d, "vault");
  mkdirSync(join(vault, "Demo"), { recursive: true });
  const b = board(join(vault, "Demo"), { "Ready to build": ["- [ ] Feature  #feat-b"] });
  const cfg = config(d, { project: "demo", vault });
  const repo = scratch();
  profile(repo, "demo");
  const r = run(["auto", "feat-b", "shipped", "--pr", "7"], { cwd: repo, config: cfg });
  check("resolves vault + board + stage from the config",
        r.status === 0 && columnOf(b, "feat-b") === "Shipped", `${r.err} ${r.out}`);
  check("reports the move", r.out.startsWith("moved #feat-b"), r.out);
}
{
  const d = scratch();
  const vault = join(d, "vault");
  mkdirSync(join(vault, "Demo"), { recursive: true });
  const b = board(join(vault, "Demo"));
  const cfg = config(d, { project: "demo", vault });
  const repo = scratch();
  profile(repo, "demo");
  const stages = { ideas: "Ideas", brainstorm: "Brainstorm", spec: "Spec", ready: "Ready to build",
                   building: "Building", review: "Review", fix: "Fix", ship: "Ship", shipped: "Shipped" };
  let ok = true, bad = "";
  for (const [stage, heading] of Object.entries(stages)) {
    run(["auto", "st", stage], { cwd: repo, config: cfg });
    if (columnOf(b, "st") !== heading) { ok = false; bad = `${stage} → ${columnOf(b, "st")}`; }
  }
  check("every one of the nine stage keys maps to its heading", ok, bad);
}
{
  const d = scratch();
  const vault = join(d, "vault");
  mkdirSync(join(vault, "Demo"), { recursive: true });
  const b = board(join(vault, "Demo"), { Ideas: [], Prêt: [] }, "Tasks.md");
  // a board whose headings are localised, declared per-board in the config
  writeFileSync(b, readFileSync(b, "utf8").replace("## Ready to build", "## Prêt"));
  const cfg = config(d, { project: "demo", vault, boardColumns: 'ready: "Prêt"' });
  const repo = scratch();
  profile(repo, "demo");
  const r = run(["auto", "loc", "ready", "--title", "Localisé"], { cwd: repo, config: cfg });
  check("per-board column override beats the global mapping",
        r.status === 0 && columnOf(b, "loc") === "Prêt", `${r.err} ${r.out}`);
}
{
  const repo = scratch();
  profile(repo, "demo");
  const r = run(["auto", "x", "shipped"], { cwd: repo, config: join(repo, "nope.yaml") });
  check("no config ⇒ exit 0", r.status === 0, `exit ${r.status}`);
  check("no config ⇒ says why on stdout", /^kanban: no config at /.test(r.out), r.out);
}
{
  const d = scratch();
  const cfg = config(d, { project: "other", vault: d });
  const repo = scratch();
  profile(repo, "demo");
  const r = run(["auto", "x", "shipped"], { cwd: repo, config: cfg });
  check("project not in boards ⇒ exit 0", r.status === 0, `exit ${r.status}`);
  check("project not in boards ⇒ names the project it looked for",
        r.out.includes('no board configured for project "demo"'), r.out);
}
{
  const d = scratch();
  const cfg = config(d, { project: "demo", vault: d, kanbanEnabled: false });
  const repo = scratch();
  profile(repo, "demo");
  const r = run(["auto", "x", "shipped"], { cwd: repo, config: cfg });
  check("kanban.enabled: false ⇒ exit 0 with a reason",
        r.status === 0 && r.out.includes("kanban.enabled: false"), `${r.status} ${r.out}`);
}
{
  const d = scratch();
  const cfg = config(d, { project: "demo", vault: d, enabled: false });
  const repo = scratch();
  profile(repo, "demo");
  const r = run(["auto", "x", "shipped"], { cwd: repo, config: cfg });
  check("master enabled: false ⇒ exit 0 with a reason",
        r.status === 0 && r.out.includes("enabled: false"), `${r.status} ${r.out}`);
}
{
  const d = scratch();
  const cfg = config(d, { project: "demo", vault: join(d, "vault"), boardRel: "Demo/Gone.md" });
  const repo = scratch();
  profile(repo, "demo");
  const r = run(["auto", "x", "shipped"], { cwd: repo, config: cfg });
  check("configured board file missing ⇒ exit 0, names the path",
        r.status === 0 && r.out.includes("board file not found"), `${r.status} ${r.out}`);
}
{
  const repo = scratch(); // no PIPELINE.md at all
  const d = scratch();
  const cfg = config(d, { project: "demo", vault: d });
  const r = run(["auto", "x", "shipped"], { cwd: repo, config: cfg });
  check("no profile ⇒ exit 0 with a reason",
        r.status === 0 && r.out.includes("no project name"), `${r.status} ${r.out}`);
}
{
  // The profile's `name:` is the one in the pipeline-profile block — not a
  // `name:` nested under a surface, which is what a naive grep would find.
  const d = scratch();
  const vault = join(d, "vault");
  mkdirSync(join(vault, "Demo"), { recursive: true });
  const b = board(join(vault, "Demo"));
  const cfg = config(d, { project: "demo", vault });
  const repo = scratch();
  profile(repo, "demo");
  const r = run(["auto", "nested", "spec"], { cwd: repo, config: cfg });
  check("reads the profile name from the pipeline-profile block only",
        r.status === 0 && columnOf(b, "nested") === "Spec", `${r.err} ${r.out}`);
}
{
  const d = scratch();
  const vault = join(d, "vault");
  mkdirSync(join(vault, "Demo"), { recursive: true });
  const b = board(join(vault, "Demo"));
  const cfg = config(d, { project: "demo", vault });
  const r = run(["auto", "ov", "ship", "--project", "demo"], { cwd: scratch(), config: cfg });
  check("--project overrides profile lookup",
        r.status === 0 && columnOf(b, "ov") === "Ship", `${r.err} ${r.out}`);
}
{
  const d = scratch();
  const vault = join(d, "vault");
  mkdirSync(join(vault, "Demo"), { recursive: true });
  const b = board(join(vault, "Demo"));
  const cfg = config(d, { project: "demo", vault });
  const repo = scratch();
  profile(repo, "demo");
  const before = readFileSync(b, "utf8");
  const r = run(["--check"], { cwd: repo, config: cfg });
  check("--check names the resolved board",
        r.status === 0 && r.out === `kanban: project "demo" -> ${b}`, r.out);
  check("--check does not touch the board", readFileSync(b, "utf8") === before);
  const r2 = run(["--check"], { cwd: scratch(), config: cfg });
  check("--check reports the reason when nothing resolves",
        r2.status === 0 && r2.out.startsWith("kanban: no project name"), r2.out);
}
{
  const r = run(["auto", "x"]);
  check("too few arguments is a usage error (exit 2)", r.status === 2, `exit ${r.status}`);
  const r2 = run(["auto", "x", "shipped", "--bogus", "1"]);
  check("unknown flag is a usage error (exit 2)", r2.status === 2, `exit ${r2.status}`);
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} failing check(s)`); process.exit(1); }
console.log("\nall kanban checks passed");
