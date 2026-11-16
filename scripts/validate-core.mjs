#!/usr/bin/env node
// Validates the structural invariants of the cohorte core — the things a
// prose refactor can silently break. Run by CI on every push/PR; run it
// locally with `node scripts/validate-core.mjs`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname — on Windows the latter yields "/C:/…", which
// join() then resolves against the cwd drive ("C:\C:\…") and every read ENOENTs.
const root = fileURLToPath(new URL("..", import.meta.url));
const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

const read = (p) => readFileSync(join(root, p), "utf8");
const frontmatter = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : null;
};

// ── commands ────────────────────────────────────────────────────────────────
// Mechanical commands must pin model: sonnet (otherwise the lead's
// orchestration turn silently bills at the session model — Opus/Fable).
// Interactive commands must stay unpinned (they inherit on purpose).
const PINNED = ["cohorte-build", "cohorte-review", "cohorte-fix", "cohorte-ship",
  "cohorte-audit", "cohorte-refactor", "cohorte-doctor", "cohorte-align-ds",
  "cohorte-update-pipeline", "cohorte-fleet"];
const UNPINNED = ["cohorte-brainstorm", "cohorte-spec", "cohorte-init-pipeline", "cohorte-patch",
  "cohorte-intake", "cohorte-retro"];

// Every command must carry the `cohorte-` prefix. This replaces the old RESERVED
// blocklist, which chased collisions one name at a time and always lagged: a command
// that collides with a Claude Code built-in is not overridden, it is SHADOWED — the
// built-in answers the slash, our file is never read, and the session confidently
// reports on a run that never happened. `/loop` did exactly that (Claude Code's own
// `/loop` runs a prompt on an interval) and went unnoticed until a user found the
// driver had never started; `/doctor` sat on a watchlist waiting to do the same.
// A blocklist can only forbid the collisions we already know about. The prefix makes
// the whole class unreachable, so this check is structural, not a list to maintain.
const PREFIX = "cohorte-";

for (const f of readdirSync(join(root, "core/commands"))) {
  const path = `core/commands/${f}`;
  if (!f.startsWith(PREFIX))
    fail(path, `command name lacks the \`${PREFIX}\` prefix — an unprefixed command can be ` +
      `SHADOWED by a Claude Code built-in of the same name (the built-in answers the slash ` +
      `and this file is never read); rename it to ${PREFIX}${f}`);
  const fm = frontmatter(read(path));
  if (!fm) { fail(path, "missing or malformed YAML frontmatter"); continue; }
  if (!/^description:\s*\S/m.test(fm)) fail(path, "frontmatter lacks a description");
  const name = f.replace(/\.md$/, "");
  const pinned = /^model:\s*sonnet\s*$/m.test(fm);
  if (PINNED.includes(name) && !pinned)
    fail(path, "mechanical command must carry `model: sonnet` in frontmatter");
  if (UNPINNED.includes(name) && /^model:/m.test(fm))
    fail(path, "interactive command must NOT pin a model (inherits the session)");
}

// ── fixed agents ────────────────────────────────────────────────────────────
// Every non-template agent needs name/tools/model and the `cohorte-` prefix: they are
// installed into the user's shared ~/.claude/agents, where a bare `review.md` would
// collide with (and, in 2.x, overwrite) the user's own agent of that name.
// scripts/test-install.mjs asserts each one actually reaches an install.
const AGENT_MODEL = { "cohorte-review": "sonnet", "cohorte-release": "haiku",
  "cohorte-profile-reader": "haiku" };

for (const f of readdirSync(join(root, "core/agents"))) {
  const path = `core/agents/${f}`;
  const text = read(path);
  const fm = frontmatter(text);
  if (!fm) { fail(path, "missing or malformed YAML frontmatter"); continue; }
  if (f === "implementer.template.md") {
    for (const ph of ["<SURFACE_AGENT>", "<SURFACE_LABEL>", "<SURFACE_PATH>",
      "<SURFACE_TOOLS>", "<SURFACE_MODEL>", "<PROJECT_NAME>", "<SURFACE_CONVENTIONS>",
      "<SURFACE_EXTRA_NEVER>", "<SURFACE_DESIGN_INPUT>", "<SURFACE_TDD_STEP1>"])
      if (!text.includes(ph)) fail(path, `render placeholder ${ph} disappeared`);
    continue;
  }
  const name = f.replace(/\.md$/, "");
  if (!name.startsWith(PREFIX)) fail(path, `fixed agent lacks the \`${PREFIX}\` prefix — it would collide with a user agent in ~/.claude/agents`);
  if (!new RegExp(`^name:\\s*${name}\\s*$`, "m").test(fm)) fail(path, `frontmatter name must equal the file name (${name})`);
  if (!/^tools:\s*\S/m.test(fm)) fail(path, "frontmatter lacks tools");
  const want = AGENT_MODEL[name];
  if (want && !new RegExp(`^model:\\s*${want}\\s*$`, "m").test(fm))
    fail(path, `frontmatter must pin \`model: ${want}\``);
  if (text.includes("<SURFACE_"))
    fail(path, "unrendered <SURFACE_*> placeholder in a non-template agent");
}

// ── cross-references ────────────────────────────────────────────────────────
// Any `<core>/templates/<x>.md` referenced by a command or agent must exist in
// core/templates (it resolves to the installed copy of exactly that file).
// Recursive: the step files under core/templates/steps/** are prompts too (loaded by a
// router command), and a reference inside one rots exactly like one in a command.
const mdUnder = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? mdUnder(`${dir}/${e.name}`) : e.name.endsWith(".md") ? [`${dir}/${e.name}`] : []);
const allDocs = ["core/commands", "core/agents", "core/templates"].flatMap(mdUnder);
// A dispatch names either a shipped agent or the one placeholder the lead resolves from the
// profile (`<surface.agent>`). Anything else — a typo, a pre-3.0 name like `review` — reaches
// the Agent tool as an unknown type and the dispatch fails (or worse, falls back to a default).
const SUBAGENT_PLACEHOLDERS = ["<surface.agent>"];
const shippedScripts = new Set(readdirSync(join(root, "scripts"))
  .filter((f) => /\.sh(\.template)?$/.test(f)).map((f) => f.replace(/\.template$/, "")));

for (const path of allDocs) {
  const text = read(path);
  for (const m of text.matchAll(/<core>\/templates\/([a-z0-9./-]+\.md)/g)) {
    if (!existsSync(join(root, "core/templates", m[1])))
      fail(path, `references <core>/templates/${m[1]} which is not in core/templates/`);
  }
  for (const m of text.matchAll(/subagent_type:\s*`?(<[^>`\s]+>|[A-Za-z][\w.-]*)/g)) {
    const t = m[1];
    if (t.startsWith("<")) {
      if (!SUBAGENT_PLACEHOLDERS.includes(t))
        fail(path, `dispatches subagent_type ${t} — the only placeholder the lead resolves is ${SUBAGENT_PLACEHOLDERS.join(", ")}`);
      continue;
    }
    if (!existsSync(join(root, "core/agents", `${t}.md`)))
      fail(path, `dispatches subagent_type ${t} with no core/agents/${t}.md`);
  }
  // `<core>/pipeline/scripts/<x>.sh` resolves to the installed copy of scripts/<x>.sh — it
  // must ship (lib/install.js copies every scripts/*.sh and *.sh.template).
  for (const m of text.matchAll(/<core>\/pipeline\/scripts\/([a-z0-9-]+\.sh)\b/g)) {
    if (!shippedScripts.has(m[1]))
      fail(path, `references <core>/pipeline/scripts/${m[1]} which is not in scripts/`);
  }
}

// Workflow scripts dispatch by `agentType: '<literal>'` (or a surface's `.agent` from the
// profile, which is not a literal). Every literal must be a shipped agent.
for (const f of readdirSync(join(root, "core/workflows")).filter((f) => f.endsWith(".js"))) {
  const text = read(`core/workflows/${f}`);
  for (const m of text.matchAll(/agentType:\s*'([^']+)'/g))
    if (!existsSync(join(root, "core/agents", `${m[1]}.md`)))
      fail(`core/workflows/${f}`, `agentType '${m[1]}' has no core/agents/${m[1]}.md`);
  for (const m of text.matchAll(/<core>\/pipeline\/scripts\/([a-z0-9-]+\.sh)\b/g))
    if (!shippedScripts.has(m[1]))
      fail(`core/workflows/${f}`, `references <core>/pipeline/scripts/${m[1]} which is not in scripts/`);
}

// ── the review report shape, three copies ────────────────────────────────────
// The authoritative REVIEW REPORT shape is the fenced template in the review agent; the
// human reference copy (templates/review-feedback.md) and the workflow's merged report
// (review.js) must carry the same sections in the same order — `## Deferred` once went
// missing from the reference copy while the agent and the workflow both emitted it.
{
  const agentText = read("core/agents/cohorte-review.md");
  const fence = (agentText.split("## Your return")[1] || "").match(/```\n([\s\S]*?)```/);
  const heads = (t) => [...t.matchAll(/^## ([A-Z][\w ]*)$/gm)].map((m) => m[1].trim());
  if (!fence) fail("core/agents/cohorte-review.md", "no fenced REVIEW REPORT template under §Your return");
  else {
    const want = heads(fence[1]);
    const ref = heads(read("core/templates/review-feedback.md"));
    if (want.join("|") !== ref.join("|"))
      fail("core/templates/review-feedback.md", `sections [${ref.join(", ")}] differ from the review agent's template [${want.join(", ")}]`);
    for (const marker of ["| Severity | Count |", "Verdict: <SHIP | REVISE | BLOCK>", "feature_id: <feature_id> · scope: <surface.key>"])
      if (fence[1].includes(marker) && !read("core/templates/review-feedback.md").includes(marker))
        fail("core/templates/review-feedback.md", `missing the agent template's \`${marker}\` line`);
    const wf = read("core/workflows/review.js");
    for (const h of want.filter((h) => h !== "Notes"))   // Notes is optional by the agent's own rule
      if (!wf.includes(`'## ${h}'`))
        fail("core/workflows/review.js", `the merged report lacks the agent template's \`## ${h}\` section`);
  }
}

// ── every pipeline diff goes through feature-diff.sh ─────────────────────────
// A bare `git diff <default_branch>` (or `${base}` / `$BASE`) misses every untracked file —
// and feature work is uncommitted until ship — and diffs against the branch TIP rather than
// the merge-base. That reviewed adds-only features as an empty diff and scored them SHIP.
// The one legitimate bare diff is PR mode's three-dot diff of committed PR history.
for (const path of [...allDocs, ...readdirSync(join(root, "core/workflows")).map((f) => `core/workflows/${f}`)]) {
  const flat = read(path).replace(/\s+/g, " ");
  const m = flat.match(/git diff (?:--stat )?(?:<default_branch>|\$\{base\}|\$BASE\b|<reviewed_base>)/);
  if (m) fail(path, `\`${m[0]}\` — pipeline diffs must use <core>/pipeline/scripts/feature-diff.sh (untracked files, merge-base)`);
}

// ── /cohorte-ship gates on the machine verdict, not on prose ─────────────────
// ship used to read "the latest review returned SHIP" from the conversation and treat a
// missing freshness stamp as "legacy spec ⇒ skip" — which shipped known HIGH/MEDIUMs (the
// review withholds the stamp exactly then) and an empty-diff "SHIP".
{
  const ship = read("core/commands/cohorte-ship.md").replace(/\s+/g, " ");
  for (const [needle, why] of [
    ["verdict.json", "must read specs/reports/<id>.verdict.json"],
    ["`unreviewed` is `[]`", "must require unreviewed == []"],
    ["severity.MEDIUM", "must refuse surviving HIGH/MEDIUM"],
    ["feature-diff.sh --base <reviewed_base> --digest", "must recompute the digest with feature-diff.sh"],
    ["verdict.json` is absent", "may treat a missing stamp as legacy ONLY when verdict.json is absent"],
  ]) if (!ship.includes(needle)) fail("core/commands/cohorte-ship.md", why);
}

// ── profile ─────────────────────────────────────────────────────────────────
for (const p of ["profile/PIPELINE.template.md", "profile/SCHEMA.md",
  "profile/cohorte.config.template.yaml"])
  if (!existsSync(join(root, p))) fail(p, "missing");

const tpl = read("profile/PIPELINE.template.md");
if (/^\s*model:\s*inherit\b/m.test(tpl))
  fail("profile/PIPELINE.template.md",
    "a surfaces[] example pins `model: inherit` — examples must default to sonnet " +
    "(inherit bills at the lead session's model)");

// ── Claude Code only (3.0.0) ────────────────────────────────────────────────
// The multi-runtime adapter and its `<!-- cohorte:if … -->` conditionals were removed
// (archived on the archive/multi-runtime branch). A conditional left in a prompt reaches
// the model as noise, and a runtime-specific path tells it to write where nothing reads.
const walkAll = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkAll(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const shipped = [...walkAll("core"), ...walkAll("profile"), ...walkAll("lib"),
  ...readdirSync(join(root, "scripts")).filter((f) => /\.(sh|template)$/.test(f)).map((f) => `scripts/${f}`)]
  .filter((p) => /\.(md|js|py|sh|yaml|template)$/.test(p));
for (const rel of shipped) {
  const text = read(rel);
  if (text.includes("cohorte:if")) fail(rel, "carries a `cohorte:if` conditional — there is one runtime now; resolve it");
  if (/\b(codex|cursor|gemini|opencode)\b/i.test(text.replace(/\s+/g, " ")) || text.includes("~/.cohorte") || text.includes("'.cohorte'"))
    fail(rel, "mentions a dropped runtime (Codex/Cursor/Gemini/OpenCode/.cohorte) — 3.x is Claude Code only");
}

// ── init-pipeline router steps ──────────────────────────────────────────────
const steps = join(root, "core/templates/steps/init-pipeline");
if (!existsSync(steps) || readdirSync(steps).length === 0)
  fail("core/templates/steps/init-pipeline", "router step files missing/empty");

// ── no telemetry ────────────────────────────────────────────────────────────
// Telemetry was removed wholesale in 2.3.0: the shipped `telemetry-send.sh`, the
// per-phase pings, the consent question, the `telemetry:` config block, the collector
// endpoint. This check is the ratchet — it fails if any of it creeps back into the
// core, which is easy to do by copying an old command file that still chains a ping.
// Deliberately broad: the whole point is that there is nothing left to send with.
const NO_TELEMETRY = /telemetry|usage ping/i;
// One exemption, and it is the opposite of a regression: /cohorte-update-pipeline is what
// DELETES the leftover `telemetry:` block from configs seeded before 2.3.0, so it is the one
// file that must still name the thing. Narrow on purpose — a filename, not a pattern.
const TELEMETRY_SCRUBBER = "core/commands/cohorte-update-pipeline.md";
const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
for (const dir of ["core/commands", "core/agents", "core/templates", "core/workflows"])
  for (const rel of walk(dir)) {
    if (!/\.(md|js)$/.test(rel) || rel === TELEMETRY_SCRUBBER) continue;
    // Collapse whitespace first: prose wraps mid-phrase, and "usage\n  ping" sat in a
    // command file for two releases because this regex only saw one line at a time.
    if (NO_TELEMETRY.test(read(rel).replace(/\s+/g, " ")))
      fail(rel, "mentions telemetry — it was removed in 2.3.0; nothing may ping or ask for consent");
  }
// …and the exempt file may only REMOVE it: naming a send/ping/consent path there is still a bug.
if (/usage ping|telemetry-send|consent/i.test(read(TELEMETRY_SCRUBBER)))
  fail(TELEMETRY_SCRUBBER, "may reference the retired telemetry block only to delete it — no ping, sender or consent flow");

// ── kanban call sites ───────────────────────────────────────────────────────
// Every pipeline stage moves a card, and a stage that only *describes* the move
// ("move card #<id> → Building, no-op silently if no board") leaves the agent to
// decide whether a board exists — which it does by not looking. That is not
// hypothetical: a /cohorte-ship session declared "no kanban board configured",
// having opened neither the config nor PIPELINE.md, and a merged feature's card
// stayed in "Ready to build". `kanban-move.sh auto` moved resolution into the
// script; this keeps it there. Prose is not a call site — the literal invocation is.
const KANBAN_STAGES = ["brainstorm", "spec", "build", "review", "fix", "ship", "patch", "intake"];
for (const c of KANBAN_STAGES) {
  const path = `core/commands/${PREFIX}${c}.md`;
  const text = read(path);
  if (!/kanban-move\.sh\s+auto\s+\S/.test(text))
    fail(path, "moves a kanban card without a literal `kanban-move.sh auto …` call — the agent is left to infer whether a board exists");
  // The one sentence that turns an unread config into a reported no-op. Match on
  // unwrapped text: these live in `>` blockquotes and wrap mid-sentence.
  const flat = text.replace(/\n>?\s*/g, " ");
  if (!/without\s+running\s+it/i.test(flat))
    fail(path, "no instruction to run the resolver before concluding there is no board");
}

// ── thin installers ─────────────────────────────────────────────────────────
// The shell installers are THIN DELEGATORS to bin/cli.js — their legacy copy-verbatim
// path was unreachable dead code from 2.2.0 (removed in 2.7.0), and its text was what
// this file's copy checks used to vacuously match. Pin the shape: both must hand off
// to the CLI and neither may grow its own copy logic back.
for (const [name, marker] of [["install.sh", "cp -R \"$src/core"], ["install.ps1", "Copy-Tree"]]) {
  const text = read(name);
  if (!text.includes("bin/cli.js") && !text.includes("bin\\cli.js"))
    fail(name, "no longer delegates to bin/cli.js — the only renderer of runtime-neutral sources");
  if (text.includes(marker))
    fail(name, "carries its own core-copy logic again — installs must go through bin/cli.js (no shell renderer exists)");
}

// install.ps1 must stay pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code
// page, and one em dash inside a string literal breaks the parser (CI caught it on 3.0).
if (/[^\x00-\x7F]/.test(read("install.ps1")))
  fail("install.ps1", "contains non-ASCII characters — Windows PowerShell 5.1 mis-parses BOM-less scripts");

// ── workflow scripts ────────────────────────────────────────────────────────
// core/workflows/*.js run inside the Claude Code Workflow runtime: an async
// function body with agent()/pipeline()/… injected, plus one `export const
// meta` line. Validate the syntax the same way the runtime parses it (plain
// `node --check` would reject the top-level return/await), and the invariants:
// a meta literal, phase 0 through profile-reader, and no Date.now()-family
// calls (they would break workflow resume).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const workflowsDir = join(root, "core/workflows");
if (!existsSync(workflowsDir) || readdirSync(workflowsDir).length === 0)
  fail("core/workflows", "workflow scripts missing/empty");
else for (const f of readdirSync(workflowsDir)) {
  if (!f.endsWith(".js")) continue;
  const path = `core/workflows/${f}`;
  const text = read(path);
  if (!/^export const meta = \{/m.test(text))
    fail(path, "missing the `export const meta = {…}` literal");
  if (!text.includes("agentType: 'cohorte-profile-reader'"))
    fail(path, "phase 0 must read the profile via the profile-reader agent");
  if (/\bDate\.now\(\)|\bMath\.random\(\)|new Date\(\)/.test(text))
    fail(path, "Date.now()/Math.random()/new Date() are unavailable in workflow scripts");
  // Prompts hand agents literal `<core>/…` paths; an agent can only resolve that
  // token if the same script also spells out what <core> means. A bare token +
  // `|| true` = the command fails silently and the ping/metrics never happen.
  if (text.includes("<core>/") && !/<core> = /.test(text))
    fail(path, "uses <core>/ paths in prompts without defining `<core> = …` anywhere");
  try {
    new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args",
      "budget", "workflow", text.replace(/^export const meta/m, "const meta"));
  } catch (e) {
    fail(path, `does not parse as a workflow body: ${e.message}`);
  }
}
// Workflow meta.names and command names share one mental namespace — both are the
// "/cohorte-…" way a human asks for a phase. A meta.name that MATCHES a
// core/commands/<name>.md is a declared variant pair (same phase, two execution paths —
// review/audit/refactor, on purpose). A meta.name matching neither a command nor the
// deliberate command-less list below is a typo'd variant: the human asks for "the
// review workflow", the lead resolves the name, and a mismatched name runs nothing.
// cohorte-loop is command-less BY DECISION (SCHEMA.md §Workflows): when the Workflow
// runtime is unavailable it must refuse explicitly, never degrade to a conversational
// loop — so a core/commands/cohorte-loop.md appearing later is a regression, not an
// addition, and the check below this one pins that too.
const COMMANDLESS = ["cohorte-loop"];
if (existsSync(workflowsDir)) for (const f of readdirSync(workflowsDir)) {
  if (!f.endsWith(".js")) continue;
  const path = `core/workflows/${f}`;
  const m = read(path).match(/name:\s*'([^']+)'/);
  if (!m) { fail(path, "meta has no parseable `name: '…'`"); continue; }
  const name = m[1];
  if (!name.startsWith(PREFIX))
    fail(path, `meta.name '${name}' lacks the \`${PREFIX}\` prefix`);
  else if (!existsSync(join(root, "core/commands", `${name}.md`)) && !COMMANDLESS.includes(name))
    fail(path, `meta.name '${name}' matches no core/commands/${name}.md and is not in the ` +
      `deliberate command-less list — a variant pair must share the name exactly, or the ` +
      `workflow-only decision must be recorded in COMMANDLESS`);
}
if (existsSync(join(root, "core/commands/cohorte-loop.md")))
  fail("core/commands/cohorte-loop.md", "must not exist — /cohorte-loop is workflow-only " +
    "(no conversational fallback, by decision; see core/workflows/loop.js header)");


// A new workflow script must also be KNOWN to the things that check for it, or it
// ships and nothing notices when an installer stops copying it. This check exists
// because a workflow once shipped while three call sites still named only the
// three that preceded it.
const workflowNames = existsSync(workflowsDir)
  ? readdirSync(workflowsDir).filter((f) => f.endsWith(".js"))
  : [];
const ci = existsSync(join(root, ".github/workflows/ci.yml")) ? read(".github/workflows/ci.yml") : "";
const libDoctor = read("lib/doctor.js");
for (const f of workflowNames) {
  if (!libDoctor.includes(`'cohorte-${f}'`))
    fail("lib/doctor.js", `checkWorkflows() does not list cohorte-${f}`);
}

// ── every test suite must run in BOTH workflows ──────────────────────────────
// publish.yml re-runs the test suites under the comment "same gate as CI", because
// it has no dependency on the CI workflow's conclusion — a merge whose CI failed
// would otherwise still ship to npm. That only holds if the two lists agree, and
// they drift the moment a suite is added to one: test-loop.mjs landed in ci.yml and
// publish.yml kept publishing without it. Neither list is the source of truth —
// the directory is.
const ciYml = existsSync(join(root, ".github/workflows/ci.yml")) ? read(".github/workflows/ci.yml") : "";
const publishYml = existsSync(join(root, ".github/workflows/publish.yml"))
  ? read(".github/workflows/publish.yml") : "";
for (const f of readdirSync(join(root, "scripts")).filter((f) => /^test-.*\.mjs$/.test(f))) {
  if (ciYml && !ciYml.includes(`scripts/${f}`))
    fail(".github/workflows/ci.yml", `never runs scripts/${f} — a suite CI does not run is a suite that does not exist`);
  if (publishYml && !publishYml.includes(`scripts/${f}`))
    fail(".github/workflows/publish.yml", `never runs scripts/${f} — publish would ship past a failure that gate is meant to catch`);
}

// ── packaging: no build artifacts in the published tarball ──────────────────
// `.npmignore` is INERT under an explicit package.json `files` allowlist, so its
// `__pycache__/` rule never fired — a maintainer who had compiled gate.py shipped
// their machine's bytecode cache. The negations in `files` are what actually work.
const pkg = JSON.parse(read("package.json"));
for (const negation of ["!core/hooks/__pycache__", "!**/*.pyc"])
  if (!(pkg.files || []).includes(negation))
    fail("package.json", `\`files\` must carry the ${negation} negation (.npmignore cannot do this)`);
if (!read("lib/install.js").includes("__pycache__"))
  fail("lib/install.js", "the core copy never excludes __pycache__");

// ── report ──────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`validate-core: ${errors.length} error(s)\n`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log("validate-core: OK");
