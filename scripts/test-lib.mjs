#!/usr/bin/env node
// Tests for the shared readers in lib/.
//
// These are shipped runtime code behind `cohorte doctor` and `cohorte specs`
// (and the Francois panels that call them): a hand-rolled YAML parser every
// check derives from, and the JS port of /cohorte-doctor.
//
//   node scripts/test-lib.mjs

import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const { parse, parseProfileBlock, profileJsonText } = require(join(root, "lib/yaml.js"));
const { state, scanSpecs } = require(join(root, "lib/doctor.js"));

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

const tmps = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "cohorte-lib-")); tmps.push(d); return d; };
const write = (p, s) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
// Doctor must not pick up a Cohorte installation from the developer's real home.
const os = require('node:os');
const originalHomedir = os.homedir;
os.homedir = () => isolatedHome;
const isolatedHome = scratch();

// ── yaml.js ──────────────────────────────────────────────────────────────────
console.log("yaml.js — the profile parser");
{
  eq("scalars: bool / int / null / quoted",
    parse("a: true\nb: 12\nc: null\nd: \"x: y\"\ne: ~"),
    { a: true, b: 12, c: null, d: "x: y", e: null });
  eq("flow array", parse("t: [Read, Write, mcp__serena]").t, ["Read", "Write", "mcp__serena"]);
  eq("flow map", parse("p: { api: 3333, web: 5173 }").p, { api: 3333, web: 5173 });
  eq("nested map", parse("a:\n  b:\n    c: 1").a.b, { c: 1 });
  eq("block sequence of scalars", parse("d:\n  - one\n  - two").d, ["one", "two"]);
  eq("block sequence of maps",
    parse("s:\n  - key: a\n    path: x\n  - key: b\n    path: y").s,
    [{ key: "a", path: "x" }, { key: "b", path: "y" }]);
  eq("comment after a value is stripped", parse("a: 1   # note").a, 1);
  eq("a # inside quotes is NOT a comment", parse('a: "x # y"').a, "x # y");
  eq("a # not preceded by whitespace is literal", parse("a: c#d").a, "c#d");
  eq("empty value ⇒ null", parse("a:").a, null);
  eq("a colon in the value survives", parse('m: "cd x && node ace migration:run"').m,
    "cd x && node ace migration:run");
  eq("empty flow array", parse("a: []").a, []);
  check("no fenced block ⇒ null", parseProfileBlock("# just prose") === null);
  // Shapes that crashed `cohorte doctor` or silently changed meaning before 3.0.
  eq("indentless sequence (`key:` then `- a` at the same indent)",
    parse("deny:\n- git push -f\n- git reset\nask:\n- y"), { deny: ["git push -f", "git reset"], ask: ["y"] });
  eq("`- db:wipe` is a scalar, not a one-key map", parse("d:\n  - node ace db:wipe").d, ["node ace db:wipe"]);
  eq("a URL item stays a scalar", parse("u:\n  - http://x.y/z").u, ["http://x.y/z"]);
  eq("extra spaces after the dash keep every key of the item",
    parse("s:\n  -   key: a\n      path: x").s, [{ key: "a", path: "x" }]);
  eq("`|` block scalar keeps newlines (and a # inside it)", parse("n: |\n  one\n  two # x\nk: 1"), { n: "one\ntwo # x", k: 1 });
  eq("`>` block scalar folds", parse("n: >\n  one\n  two\n").n, "one two");
  eq("double-quoted escapes are decoded", parse('q: "a \\"b\\" \\\\ c"').q, 'a "b" \\ c');
  eq("floats are numbers", parse("f: 1.5").f, 1.5);
  eq("blank lines inside a map are fine", parse("a:\n  b: 1\n\n  c: 2").a, { b: 1, c: 2 });

  // The real thing: the shipped template must round-trip.
  const tpl = readFileSync(join(root, "profile/PIPELINE.template.md"), "utf8");
  const p = parseProfileBlock(tpl);
  check("the shipped PIPELINE.template.md parses", !!p);
  eq("…surfaces are a list of 2", (p.surfaces || []).length, 2);
  eq("…surface tools survive as an array", p.surfaces[0].tools.length, 7);
  eq("…uses_design is a real boolean", p.surfaces[1].uses_design, true);
  eq("…build_cmd stays an empty string, not null", p.surfaces[0].build_cmd, "");
  eq("…gate.deny is a list of 4", p.gate.deny.length, 4);
  eq("…gate.preflight.max_age_minutes is a number", p.gate.preflight.max_age_minutes, 30);
  eq("…port_base flow map", p.isolation.port_base, { api: 3333, web: 5173 });
  eq("…a chained migrate command survives", p.commands.migrate, "cd apps/api && node ace migration:run");
}

// ── doctor.js ────────────────────────────────────────────────────────────────
console.log("doctor.js — the /cohorte-doctor port");
{
  const spec = (fm) => `---\n${fm}\n---\n\n# x\n`;
  const d = scratch();
  mkdirSync(join(d, "specs"), { recursive: true });
  writeFileSync(join(d, "specs", "a.md"), spec("feature_id: a\ntitle: A\nstatus: frozen\nbranch: feature/a"));
  writeFileSync(join(d, "specs", "b.md"), spec("feature_id: b\nstatus: shipped   # done"));
  writeFileSync(join(d, "specs", "c.md"), "no front-matter at all");
  writeFileSync(join(d, "specs", "_template.md"), spec("status: draft"));
  // /cohorte-audit writes this file by design and it has no front-matter. Scanning it as a
  // spec made /cohorte-doctor warn about a file cohorte itself had just created — it fired in
  // every project that had ever run /cohorte-audit.
  writeFileSync(join(d, "specs", "refactor-backlog.md"), "# Refactor Backlog\n\n## backend\n- [ ] x\n");
  const specs = scanSpecs(d);
  eq("_template.md is excluded", specs.length, 3);
  eq("the /cohorte-audit backlog is not scanned as a spec",
    specs.some(s => s.file === "refactor-backlog.md"), false);
  eq("front-matter fields are read", specs.find(s => s.id === "a").title, "A");
  eq("a trailing comment is stripped from status", specs.find(s => s.id === "b").status, "shipped");
  eq("no front-matter ⇒ id falls back to the filename", specs.find(s => s.file === "c.md").id, "c");
}
{
  // A fully-wired synthetic project must come back green on the checks that can
  // be computed from disk. Layout (3.x): the core in <globalDir>/cohorte, the gate in
  // the project.
  const g = scratch();                       // stands in for ~/.claude
  const d = scratch();
  const gate = {
    deny: ["x"], ask: ["y"], ask_on_default_branch: ["git push"], default_branch: "main",
    preflight: { enabled: true, agents: ["cohorte-review"], max_age_minutes: 30 },
  };
  writeFileSync(join(d, "PIPELINE.md"), [
    "```yaml pipeline-profile",
    "name: Proj",
    "retrieval:",
    "  provider: serena",
    "surfaces:",
    "  - key: backend",
    "    path: apps/api",
    "    agent: backend",
    "gate:",
    "  default_branch: main",
    '  deny: ["x"]',
    '  ask: ["y"]',
    '  ask_on_default_branch: ["git push"]',
    "  preflight:",
    "    enabled: true",
    "    agents: [cohorte-review]",
    "    max_age_minutes: 30",
    "```",
  ].join("\n"));
  write(join(g, "cohorte", "pipeline", "VERSION"), "9.9.9\n");
  for (const w of ["cohorte-review.js", "cohorte-audit.js", "cohorte-refactor.js", "cohorte-loop.js"]) {
    write(join(g, "workflows", w), "x");
  }
  write(join(g, "agents", "cohorte-profile-reader.md"), "x");
  write(join(d, ".claude", "agents", "backend.md"), "x");
  writeFileSync(join(d, ".claude", "gate-config.json"), JSON.stringify(gate));
  writeFileSync(join(d, ".claude", "pipeline.json"), JSON.stringify({ pipeline: "cohorte", core_version: "9.9.9" }));
  write(join(d, ".claude", "hooks", "cohorte-gate.py"), "# gate");
  writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { serena: {} } }));
  const hook = { type: "command", command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py"' };
  const wired = { hooks: { PreToolUse: [
    { matcher: "Bash|Task|Agent", hooks: [hook] }, { matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [hook] },
  ] } };
  writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify(wired));

  const by = (checks, id) => checks.find(c => c.id === id);
  let s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  eq("core in <globalDir>/cohorte ⇒ ok", by(s.checks, "core").status, "ok");
  eq("profile parses ⇒ ok", by(s.checks, "profile").status, "ok");
  eq("surface agent present ⇒ ok", by(s.checks, "agents").status, "ok");
  eq("gate mirrors the profile ⇒ ok", by(s.checks, "gate").status, "ok");
  // Not a git repo here, so "committed" is unknown — never reported as a failure.
  eq("project gate registered for Bash|Task|Agent + Write|Edit ⇒ ok", by(s.checks, "hooks").status, "ok");
  eq("retrieval wired in .mcp.json ⇒ ok", by(s.checks, "retrieval").status, "ok");
  eq("workflows + cohorte-profile-reader ⇒ ok", by(s.checks, "workflows").status, "ok");
  eq("the --json shape keeps a runtimes[] for panels", s.runtimes.map(r => r.id), ["claude"]);

  check("no .gitignore ⇒ local artifacts flagged bad (the stamp is the breaking one)",
    by(s.checks, "artifacts").status === "bad"
      && /preflight\.ok/.test(by(s.checks, "artifacts").detail),
    by(s.checks, "artifacts").detail);
  writeFileSync(join(d, ".gitignore"),
    "node_modules/\n.claude/preflight.ok\n.claude/pipeline-metrics.jsonl\nspecs/reports/\n");
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  eq("all local artifacts gitignored ⇒ ok", by(s.checks, "artifacts").status, "ok");

  writeFileSync(join(d, ".claude", "gate-config.json"),
    JSON.stringify({ ...gate, preflight: { enabled: false } }));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("gate-config preflight drift is detected",
    by(s.checks, "gate").status === "warn" && /preflight/.test(by(s.checks, "gate").detail),
    by(s.checks, "gate").detail);
  writeFileSync(join(d, ".claude", "gate-config.json"), JSON.stringify(gate));

  // The hook check must FAIL each way it can actually break.
  const setHooks = (groups) => writeFileSync(join(d, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: groups } }));
  setHooks([{ matcher: "Bash|Task", hooks: [hook] }, { matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [hook] }]);
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("a matcher without Agent is bad (the phase gate never fires on Claude Code ≥ 2.1.63)",
    by(s.checks, "hooks").status === "bad" && /Agent/.test(by(s.checks, "hooks").detail), by(s.checks, "hooks").detail);
  setHooks([{ matcher: "Bash|Task|Agent", hooks: [hook] }, { matcher: "Bash", hooks: [hook] },
    { matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [hook] }]);
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("a duplicate Bash registration is flagged (it double-prompts)",
    by(s.checks, "hooks").status === "warn" && /2×/.test(by(s.checks, "hooks").detail), by(s.checks, "hooks").detail);
  writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify(wired));
  rmSync(join(d, ".claude", "hooks", "cohorte-gate.py"));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("registered but missing gate file is bad (fail-closed hook refuses every Bash call)",
    by(s.checks, "hooks").status === "bad" && /missing/.test(by(s.checks, "hooks").detail), by(s.checks, "hooks").detail);
  write(join(d, ".claude", "hooks", "cohorte-gate.py"), "# gate");
  writeFileSync(join(d, ".claude", "settings.json"), '{"hooks": {,}}');
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  eq("invalid settings.json is bad", by(s.checks, "hooks").status, "bad");
  writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify(wired));
  write(join(g, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: "Bash|Task", hooks: [{ type: "command", command: `python3 "${join(g, "hooks", "gate.py")}"` }] }] } }));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("a leftover 2.x machine-wide gate is flagged",
    by(s.checks, "hooks").status === "warn" && /2\.x/.test(by(s.checks, "hooks").detail), by(s.checks, "hooks").detail);
  rmSync(join(g, "settings.json"));

  // 2.x layouts are named, with the migration as the fix.
  writeFileSync(join(d, ".claude", "pipeline.json"), JSON.stringify({ pipeline: "cohorte", mode: "global", core_version: "2.10.2" }));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("a 2.x pointer (mode:) is a warn naming the migration",
    by(s.checks, "core").status === "warn" && /mode/.test(by(s.checks, "core").detail), by(s.checks, "core").detail);
  writeFileSync(join(d, ".claude", "pipeline.json"), JSON.stringify({ pipeline: "cohorte", core_version: "1.0.0" }));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("a lagging pointer is a warn fixed by cohorte sync",
    by(s.checks, "core").status === "warn" && /sync/.test(by(s.checks, "core").fix || ""), by(s.checks, "core").detail);
  writeFileSync(join(d, ".claude", "pipeline.json"), JSON.stringify({ pipeline: "cohorte", core_version: "9.9.9" }));

  rmSync(join(d, ".claude", "agents", "backend.md"));
  write(join(g, "agents", "backend.md"), "x");
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("a surface agent only in ~/.claude/agents (2.x global) is a warn, not ok",
    by(s.checks, "agents").status === "warn" && /2\.x/.test(by(s.checks, "agents").detail), by(s.checks, "agents").detail);
  rmSync(join(g, "agents", "backend.md"));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  eq("a surface agent missing everywhere is bad", by(s.checks, "agents").status, "bad");
  write(join(d, ".claude", "agents", "backend.md"), "x");

  rmSync(join(d, ".mcp.json"));
  writeFileSync(join(d, ".claude", "agents", "orphan.md"), "x");
  write(join(d, ".claude", "agents", "cohorte-review.md"), "x");
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
  check("provider declared but never wired ⇒ warn",
    by(s.checks, "retrieval").status === "warn", by(s.checks, "retrieval").detail);
  check("an agent file with no surface ⇒ orphan warn (a shipped agent name is not an orphan)",
    by(s.checks, "agents").status === "warn" && /orphan\b/.test(by(s.checks, "agents").detail)
      && !/cohorte-review/.test(by(s.checks, "agents").detail),
    by(s.checks, "agents").detail);

  // .claude/profile.json freshness: content decides, mtime only names the cause.
  const pjPath = join(d, ".claude", "profile.json");
  const mdPath = join(d, "PIPELINE.md");
  const pjStatus = async () => by((await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true })).checks, "profile-json");
  rmSync(pjPath, { force: true });
  let c = await pjStatus();
  check("profile.json missing ⇒ warn, fixed by cohorte sync", c.status === "warn" && /missing/.test(c.detail) && /sync/.test(c.fix), c.detail);
  writeFileSync(pjPath, profileJsonText(readFileSync(mdPath, "utf8")));
  c = await pjStatus();
  // Not a git repo here, so "committed" is unknown — never reported as a failure.
  eq("profile.json matching a fresh parse ⇒ ok", c.status, "ok");
  writeFileSync(pjPath, profileJsonText(readFileSync(mdPath, "utf8")).replace(/\n/g, "\r\n"));
  c = await pjStatus();
  eq("CRLF line endings (Windows autocrlf checkout) are not staleness ⇒ ok", c.status, "ok");
  const mdText = readFileSync(mdPath, "utf8");
  writeFileSync(mdPath, mdText + "\n## Conventions\n\nprose only\n");
  const past = new Date(Date.now() - 3600e3);
  utimesSync(pjPath, past, past);
  c = await pjStatus();
  eq("older than PIPELINE.md but identical content (prose edit, fresh clone) ⇒ still ok", c.status, "ok");
  writeFileSync(mdPath, mdText.replace("name: Proj", "name: Renamed"));
  utimesSync(pjPath, past, past);
  c = await pjStatus();
  check("machine block edited after the last sync ⇒ stale warn", c.status === "warn" && /stale/.test(c.detail), c.detail);
  writeFileSync(mdPath, mdText);
  writeFileSync(pjPath, JSON.stringify({ name: "hand-edited" }));
  c = await pjStatus();
  check("hand-edited profile.json (newer, different) ⇒ warn", c.status === "warn" && /differs/.test(c.detail), c.detail);
  writeFileSync(pjPath, profileJsonText(mdText));

  const bare = scratch();
  s = await state({ projectRoot: bare, globalDir: g, cliVersion: "9.9.9", offline: true });
  eq("no PIPELINE.md ⇒ profile bad", by(s.checks, "profile").status, "bad");
  eq("no PIPELINE.md ⇒ the profile.json check is skipped", by(s.checks, "profile-json").status, "skip");
  eq("not a cohorte project ⇒ the hook check is skipped, not failed", by(s.checks, "hooks").status, "skip");
  s = await state({ projectRoot: bare, globalDir: scratch(), cliVersion: "9.9.9", offline: true });
  eq("no core ⇒ core bad", by(s.checks, "core").status, "bad");
  const old = scratch();
  write(join(old, "pipeline", "VERSION"), "2.10.2\n");
  s = await state({ projectRoot: bare, globalDir: old, cliVersion: "9.9.9", offline: true });
  check("only a 2.x core in ~/.claude ⇒ bad, fixed by cohorte update",
    by(s.checks, "core").status === "bad" && /update/.test(by(s.checks, "core").fix || ""), by(s.checks, "core").detail);
}

{
  // The git identity row. Unset, git signs commits <os user>@<hostname> (enzo@Mac.lan): the code host cannot
  // link them and the fix is a history rewrite — a founded project's first three commits went out that way.
  const { spawnSync } = require("node:child_process");
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  const g = scratch(); const d = scratch();
  writeFileSync(join(g, "empty.gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(g, "empty.gitconfig"); process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const by = (s) => s.checks.find(c => c.id === "identity");
    let s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
    eq("not a git repo ⇒ the identity check is skipped", by(s).status, "skip");
    spawnSync("git", ["init", "-q", d]);
    s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
    check("no user.email ⇒ bad, with the exact repo-local fix",
      by(s).status === "bad" && /no user\.email/.test(by(s).detail)
        && /^git config user\.name ".+" && git config user\.email ".+"/.test(by(s).fix || ""), JSON.stringify(by(s)));
    spawnSync("git", ["-C", d, "config", "user.name", "Enzo"]);
    spawnSync("git", ["-C", d, "config", "user.email", "enzo@Enzos-MBP.lan"]);
    s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
    check("a hostname email (.lan) ⇒ warn", by(s).status === "warn" && /local network/.test(by(s).detail), JSON.stringify(by(s)));
    spawnSync("git", ["-C", d, "config", "user.email", "enzo@devbox"]);
    s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
    check("no dot in the domain ⇒ warn", by(s).status === "warn" && /no dot/.test(by(s).detail), JSON.stringify(by(s)));
    spawnSync("git", ["-C", d, "config", "user.email", "1+enzo@users.noreply.github.com"]);
    s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9", offline: true });
    check("a real address ⇒ ok, naming where it comes from",
      by(s).status === "ok" && /1\+enzo@users\.noreply\.github\.com/.test(by(s).detail) && /\.git\/config/.test(by(s).detail), JSON.stringify(by(s)));
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log("");
if (failures) { console.error(`test-lib: ${failures} failure(s)`); process.exit(1); }
console.log("test-lib: OK");
