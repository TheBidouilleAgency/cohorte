#!/usr/bin/env node
// Validates the structural invariants of the cohorte core — the things a
// prose refactor can silently break. Run by CI on every push/PR; run it
// locally with `node scripts/validate-core.mjs`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { applyConditionals, loadRuntime } = createRequire(import.meta.url)('../core/adapter/render.js');

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
// Every non-template agent needs name/tools/model, and every one must be
// ASSERTED by the ci.yml install dry-run (a new agent the CLI's copy rules miss
// would otherwise never reach an install and nothing would notice — the exact
// bug that motivated this check). The old form grepped install.sh/install.ps1
// for copy commands, but those scripts have been thin delegators to bin/cli.js
// since 2.2.0 — the text being matched was unreachable dead code, so the check
// passed vacuously. CI postconditions test the copy that actually runs.
const AGENT_MODEL = { review: "sonnet", release: "haiku",
  "profile-reader": "haiku" };
const ciYmlText = existsSync(join(root, ".github/workflows/ci.yml"))
  ? read(".github/workflows/ci.yml") : "";

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
  if (!/^name:\s*\S/m.test(fm)) fail(path, "frontmatter lacks name");
  if (!/^tools:\s*\S/m.test(fm)) fail(path, "frontmatter lacks tools");
  const want = AGENT_MODEL[name];
  if (want && !new RegExp(`^model:\\s*${want}\\s*$`, "m").test(fm))
    fail(path, `frontmatter must pin \`model: ${want}\``);
  if (text.includes("<SURFACE_"))
    fail(path, "unrendered <SURFACE_*> placeholder in a non-template agent");
  if (ciYmlText && !ciYmlText.includes(`agents/${f}`))
    fail(".github/workflows/ci.yml", `install dry-run never asserts .claude/agents/${f} — a fixed agent the CLI's copy rules miss would ship silently`);
}

// ── cross-references ────────────────────────────────────────────────────────
// Any `.claude/templates/<x>.md` referenced by a command or agent must exist
// in core/templates (they resolve to the installed copy of exactly that file).
const allDocs = [];
for (const dir of ["core/commands", "core/agents", "core/templates"])
  for (const f of readdirSync(join(root, dir)))
    if (f.endsWith(".md")) allDocs.push(`${dir}/${f}`);

for (const path of allDocs) {
  const text = read(path);
  for (const m of text.matchAll(/\.claude\/templates\/([a-z0-9.-]+\.md)/g)) {
    if (!existsSync(join(root, "core/templates", m[1])))
      fail(path, `references .claude/templates/${m[1]} which is not in core/templates/`);
  }
  for (const m of text.matchAll(/subagent_type:\s*(?:`|)([a-z-]+)(?:`|)/g)) {
    const t = m[1];
    if (["review", "release", "profile-reader"].includes(t)) continue;
    if (t.startsWith("<")) continue; // <surface.agent> placeholder
    if (!existsSync(join(root, "core/agents", `${t}.md`)))
      fail(path, `dispatches subagent_type ${t} with no core/agents/${t}.md`);
  }
}

// ── profile ─────────────────────────────────────────────────────────────────
for (const p of ["profile/PIPELINE.template.md", "profile/SCHEMA.md",
  "profile/cohorte.config.template.yaml"])
  if (!existsSync(join(root, p))) fail(p, "missing");

const tpl = applyConditionals(read("profile/PIPELINE.template.md"), loadRuntime('claude'));
if (/^\s*model:\s*inherit\b/m.test(tpl))
  fail("profile/PIPELINE.template.md",
    "a surfaces[] example pins `model: inherit` — examples must default to sonnet " +
    "(inherit bills at the lead session's model)");
const codexTpl = applyConditionals(read('profile/PIPELINE.template.md'), loadRuntime('codex'));
if (/^\s*model:\s*(sonnet|haiku|opus)\b/m.test(codexTpl))
  fail('profile/PIPELINE.template.md', 'Codex examples must not pin Anthropic model aliases');

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

// ── shipped scripts + thin installers ───────────────────────────────────────
// Every shipped scripts/*.sh must be asserted by the ci.yml install dry-run —
// bin/cli.js copies by rule rather than by name, so only a postcondition on the
// copy that actually runs can catch a rule that misses a new script. Callers
// chain these with `|| true`, so a missing one is a silent no-op forever.
// A `<name>.sh` with a `<name>.sh.template` sibling is a locally-rendered artifact
// (this repo dogfoods its own /cohorte-init-pipeline), not a core asset — skip those.
const shipped = readdirSync(join(root, "scripts"));
for (const f of shipped.filter((f) => f.endsWith(".sh") && !shipped.includes(`${f}.template`)))
  if (ciYmlText && !ciYmlText.includes(`pipeline/scripts/${f}`))
    fail(".github/workflows/ci.yml", `install dry-run never asserts pipeline/scripts/${f} (a copy rule that misses it is a silent no-op at runtime)`);
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
  if (!text.includes("agentType: 'profile-reader'"))
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

// The workflows dir reaching installs is covered per-file by the ci.yml dry-run
// assertions checked just below (the shell installers delegate to bin/cli.js).

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
  if (!ci.includes(`workflows/${f}`))
    fail(".github/workflows/ci.yml", `install dry-run never asserts .claude/workflows/${f}`);
  if (!libDoctor.includes(`'${f}'`))
    fail("lib/doctor.js", `checkWorkflows() does not list ${f}`);
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
if (!read("bin/cli.js").includes("__pycache__"))
  fail("bin/cli.js", "copyCore() never excludes __pycache__ from the hooks copy");
if (ciYmlText && !ciYmlText.includes("hooks/__pycache__"))
  fail(".github/workflows/ci.yml", "install dry-run never asserts hooks/__pycache__ is absent — a compiled cache would ride into the user's .claude unnoticed");

// ── report ──────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`validate-core: ${errors.length} error(s)\n`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log("validate-core: OK");
