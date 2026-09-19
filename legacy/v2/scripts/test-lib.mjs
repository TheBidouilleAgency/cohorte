#!/usr/bin/env node
// Tests for the shared readers in lib/.
//
// These are shipped runtime code behind `cohorte doctor` and `cohorte specs`
// (and the Francois panels that call them): a hand-rolled YAML parser every
// check derives from, the JS port of /cohorte-doctor, and the runtime-layout
// resolver that decides where a given coding agent keeps its core.
//
//   node scripts/test-lib.mjs

import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const { parse, parseProfileBlock } = require(join(root, "lib/yaml.js"));
const { state, scanSpecs } = require(join(root, "lib/doctor.js"));
const adapter = require(join(root, 'core/adapter/render.js'));

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
// Runtime discovery must not pick up Cohorte installations from the developer's real home.
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

  // The real thing: the shipped template must round-trip.
  const tpl = readFileSync(join(root, "profile/PIPELINE.template.md"), "utf8");
  const p = parseProfileBlock(adapter.adaptInstructions(tpl, adapter.loadRuntime('claude')));
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
  // be computed from disk.
  const g = scratch();                       // stands in for ~/.claude
  const d = scratch();
  const gate = {
    deny: ["x"], ask: ["y"], ask_on_default_branch: ["git push"], default_branch: "main",
    preflight: { enabled: true, agents: ["review"], max_age_minutes: 30 },
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
    "    agents: [review]",
    "    max_age_minutes: 30",
    "```",
  ].join("\n"));
  mkdirSync(join(d, ".claude", "agents"), { recursive: true });
  mkdirSync(join(d, ".claude", "pipeline"), { recursive: true });
  writeFileSync(join(d, ".claude", "pipeline", "VERSION"), "9.9.9\n");
  writeFileSync(join(d, ".claude", "agents", "backend.md"), "x");
  writeFileSync(join(d, ".claude", "gate-config.json"), JSON.stringify(gate));
  writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { serena: {} } }));
  mkdirSync(join(d, ".claude", "workflows"), { recursive: true });
  for (const w of ["review.js", "audit.js", "refactor.js", "loop.js"]) {
    writeFileSync(join(d, ".claude", "workflows", w), "x");
  }
  writeFileSync(join(d, ".claude", "agents", "profile-reader.md"), "x");
  writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: 'py "C:\\x\\gate.py"' }] }] },
  }));

  const by = (checks, id) => checks.find(c => c.id === id);
  let s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9" });
  eq("profile parses ⇒ ok", by(s.checks, "profile").status, "ok");
  eq("surface agent present ⇒ ok", by(s.checks, "agents").status, "ok");
  eq("gate mirrors the profile ⇒ ok", by(s.checks, "gate").status, "ok");
  eq("Windows-quoted hook command is recognised", by(s.checks, "hooks").status, "ok");
  eq("retrieval wired in .mcp.json ⇒ ok", by(s.checks, "retrieval").status, "ok");
  eq("workflows + profile-reader ⇒ ok", by(s.checks, "workflows").status, "ok");

  // Local artifacts: a versioned preflight stamp is what made the phase gate ask on
  // every review dispatch forever, so its absence from .gitignore is a hard failure.
  check("no .gitignore ⇒ local artifacts flagged bad (the stamp is the breaking one)",
    by(s.checks, "artifacts").status === "bad"
      && /preflight\.ok/.test(by(s.checks, "artifacts").detail),
    by(s.checks, "artifacts").detail);
  writeFileSync(join(d, ".gitignore"),
    "node_modules/\n.claude/preflight.ok\n.claude/pipeline-metrics.jsonl\nspecs/reports/\n");
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9" });
  eq("all local artifacts gitignored ⇒ ok", by(s.checks, "artifacts").status, "ok");
  writeFileSync(join(d, ".gitignore"), "node_modules/\n.claude/\nspecs/reports/\n");
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9" });
  eq("a `.claude/` directory rule covers the files inside it",
    by(s.checks, "artifacts").status, "ok");

  // …and each check must actually FAIL when its precondition breaks.
  writeFileSync(join(d, ".claude", "gate-config.json"),
    JSON.stringify({ ...gate, preflight: { enabled: false } }));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9" });
  check("gate-config preflight drift is detected",
    by(s.checks, "gate").status === "warn" && /preflight/.test(by(s.checks, "gate").detail),
    by(s.checks, "gate").detail);
  writeFileSync(join(d, ".claude", "gate-config.json"), JSON.stringify(gate));

  writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 /x/gate.py" }] }] },
  }));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9" });
  check("a Bash-only matcher is flagged (the 1.3.0 dead phase gate)",
    by(s.checks, "hooks").status === "warn" && /Task/.test(by(s.checks, "hooks").detail),
    by(s.checks, "hooks").detail);

  writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [
      { matcher: "Bash|Task", hooks: [{ type: "command", command: "python3 /x/gate.py" }] },
      { matcher: "Bash|Task", hooks: [{ type: "command", command: 'py "/x/gate.py"' }] },
    ] },
  }));
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9" });
  check("a duplicate registration is flagged (it double-prompts)",
    by(s.checks, "hooks").status === "warn" && /2×/.test(by(s.checks, "hooks").detail),
    by(s.checks, "hooks").detail);

  rmSync(join(d, ".mcp.json"));
  writeFileSync(join(d, ".claude", "agents", "orphan.md"), "x");
  s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9" });
  check("provider declared but never wired ⇒ warn",
    by(s.checks, "retrieval").status === "warn", by(s.checks, "retrieval").detail);
  check("an agent file with no surface ⇒ orphan warn",
    by(s.checks, "agents").status === "warn" && /orphan/.test(by(s.checks, "agents").detail),
    by(s.checks, "agents").detail);

  const bare = scratch();
  s = await state({ projectRoot: bare, globalDir: g, cliVersion: "9.9.9" });
  eq("no PIPELINE.md ⇒ profile bad", by(s.checks, "profile").status, "bad");
  eq("no core ⇒ core bad", by(s.checks, "core").status, "bad");
}

// ── runtime.js + a non-Claude layout ────────────────────────────────────────
// Every path-dependent check used to assume `.claude/`. On a repo driven from Cursor that
// reported a healthy install as three ❌ and a ⚠️ — no core, no rendered agent, artifacts not
// ignored, hook not registered — and every one was wrong. A false red is worse than no check:
// it sends a human fixing something that is not broken.
console.log("doctor.js — a non-Claude runtime layout");
{
  const d = scratch();
  const g = join(d, "global-claude");
  mkdirSync(g, { recursive: true });

  const core = join(d, ".cohorte", "cursor");
  mkdirSync(join(core, "pipeline"), { recursive: true });
  writeFileSync(join(core, "pipeline", "VERSION"), "9.9.9\n");
  writeFileSync(join(core, "pipeline", "runtimes.json"), JSON.stringify({
    cursor: {
      label: "Cursor", scope: "project", core_version: "9.9.9",
      capabilities: { subagents: true, hooks: true, workflows: false, tool_restriction: true },
      paths: {
        core, commands: join(d, ".cursor", "commands"), agents: join(d, ".cursor", "agents"),
        hooks_config: join(d, ".cursor", "hooks.json"), state: ".cohorte",
      },
    },
  }));
  mkdirSync(join(d, ".cursor", "agents"), { recursive: true });
  writeFileSync(join(d, ".cursor", "agents", "api.md"), "---\nname: api\n---\n");
  writeFileSync(join(d, ".cursor", "hooks.json"), JSON.stringify({
    version: 1,
    hooks: { beforeShellExecution: [{ command: `python3 ${core}/hooks/gate.py --runtime cursor` }] },
  }));
  mkdirSync(join(d, ".cohorte"), { recursive: true });
  const gate = { deny: ["rm -rf /"], ask: [], ask_on_default_branch: [], default_branch: "main" };
  writeFileSync(join(d, ".cohorte", "gate-config.json"),
    JSON.stringify({ ...gate, preflight: { enabled: false } }));
  writeFileSync(join(d, ".gitignore"),
    ".cohorte/preflight.ok\n.cohorte/pipeline-metrics.jsonl\nspecs/reports/\n");
  writeFileSync(join(d, "PIPELINE.md"), [
    "```yaml pipeline-profile", "name: demo",
    "surfaces:", "  - key: api", "    path: src/api", "    agent: api",
    "gate:", "  deny:", "    - rm -rf /", "  default_branch: main",
    "  preflight:", "    enabled: false", "```",
  ].join("\n"));

  const s = await state({ projectRoot: d, globalDir: g, cliVersion: "9.9.9" });
  const pick = id => s.checks.find(c => c.id === id) || {};
  const st = id => pick(id).status;
  const dt = id => pick(id).detail;

  eq("the runtime is discovered from runtimes.json", s.runtimes.map(r => r.id), ["cursor"]);
  check("the core in .cohorte/<id>/ counts as installed", st("core") === "ok", dt("core"));
  check("agents are looked for in .cursor/agents", st("agents") === "ok", dt("agents"));
  check("gate-config is read from .cohorte, not .claude", st("gate") === "ok", dt("gate"));
  check("artifact paths are named against the right state dir",
    st("artifacts") === "ok" && !/\.claude/.test(dt("artifacts")), dt("artifacts"));
  // Cursor's registration is a flat {command} under beforeShellExecution — read with Claude's
  // matcher-group shape it looks absent, which is exactly the false red this guards.
  check("the Cursor hook envelope is recognised", st("hooks") === "ok", dt("hooks"));
  check("workflows are skipped, not reported missing",
    st("workflows") === "skip" && /Cursor/.test(dt("workflows")), dt("workflows"));
  check("nothing is reported broken on a healthy non-Claude install",
    s.summary.bad === 0 && s.summary.warn === 0, JSON.stringify(s.summary));
}

// Codex's global core supplies fixed agents; each consuming repo owns its surfaces.
{
  const d = scratch();
  const g = join(d, 'global');
  write(join(g, 'pipeline/VERSION'), '9.9.9\n');
  write(join(g, 'pipeline/runtimes.json'), JSON.stringify({ codex: {
    label: 'Codex', scope: 'global', capabilities: { subagents: true, hooks: true, workflows: false },
    paths: { core: g, agents: join(g, 'agents'), hooks_config: join(g, 'hooks.json'), state: '.cohorte' },
  } }));
  // Legacy registry intentionally has no surface_agents or agent_ext fields.
  write(join(g, 'agents/unrelated.toml'), 'name = "unrelated"\n');
  const hook = matcher => write(join(g, 'hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher, hooks: [{ command: `python3 ${g}/hooks/gate.py --runtime codex` }] }],
  } }));
  hook('Bash|shell');
  const a = join(d, 'project-a'), b = join(d, 'project-b');
  for (const repo of [a, b]) {
    write(join(repo, 'PIPELINE.md'), '```yaml pipeline-profile\nname: example\nsurfaces:\n  - key: api\n    agent: api\nretrieval:\n  provider: serena\n```\n');
    write(join(repo, '.codex/agents/api.toml'), 'name = "api"\ndescription = "API"\ndeveloper_instructions = "Implement"\n');
    write(join(repo, '.codex/config.toml'), '[mcp_servers.serena]\ncommand = "serena"\n');
  }
  const inspect = repo => state({ projectRoot: repo, globalDir: g, cliVersion: '9.9.9' });
  const status = (s, id) => s.checks.find(c => c.id === id)?.status;
  let s = await inspect(a);
  check('Codex doctor accepts project TOML agents with a legacy global registry', status(s, 'agents') === 'ok');
  check('Codex doctor rejects a shell-only preflight hook', status(s, 'hooks') === 'warn');
  check('Codex doctor finds native project MCP configuration', status(s, 'retrieval') === 'ok');
  hook('Bash|spawn_agent');
  s = await inspect(b);
  check('a second project resolves its own agents without a launcher', status(s, 'agents') === 'ok');
  check('Codex doctor accepts the native dispatch matcher', status(s, 'hooks') === 'ok');
  write(join(b, '.codex/agents/stale.toml'), 'name = "stale"\n');
  s = await inspect(b);
  check('Codex doctor detects local orphans even with a global core', status(s, 'agents') === 'warn');
  write(join(a, '.codex/config.toml'), '# [mcp_servers.serena]\n');
  write(join(a, '.mcp.json'), JSON.stringify({ mcpServers: { serena: { command: 'serena' } } }));
  s = await inspect(a);
  check('a comment or Claude MCP config does not count as Codex registration', status(s, 'retrieval') === 'warn');
}

// ── runtime.js — stale absolute registry paths (a cloned/moved bundled core) ─
// runtimes.json records install-time ABSOLUTE paths. A committed core cloned to
// another machine (or a checkout simply moved) still carries the original paths;
// taken verbatim, every check went red on a healthy install.
console.log("runtime.js — registry paths survive a clone/move");
{
  const { layouts } = require(join(root, "lib/runtime.js"));
  const d = scratch();
  const core = join(d, ".claude");
  mkdirSync(join(core, "pipeline"), { recursive: true });
  const theirRoot = join("/Users", "somebody-else", "their-checkout");
  writeFileSync(join(core, "pipeline", "runtimes.json"), JSON.stringify({
    claude: {
      label: "Claude Code", scope: "project", core_version: "9.9.9",
      paths: {
        core: join(theirRoot, ".claude"),
        commands: join(theirRoot, ".claude", "commands"),
        agents: join(theirRoot, ".claude", "agents"),
        hooks_config: join(theirRoot, ".claude", "settings.json"),
        state: ".claude",
      },
    },
  }));
  const [l] = layouts({ projectRoot: d, globalDir: join(d, "no-global") });
  check("agents re-rooted onto the probed checkout",
    l.agents === join(d, ".claude", "agents"), l.agents);
  check("hooks config re-rooted too",
    l.hooksConfig === join(d, ".claude", "settings.json"), l.hooksConfig);
  // A path OUTSIDE the recorded project root (a genuine machine-local absolute,
  // e.g. a global agents dir) must pass through untouched.
  writeFileSync(join(core, "pipeline", "runtimes.json"), JSON.stringify({
    claude: {
      label: "Claude Code", scope: "project", core_version: "9.9.9",
      paths: { core: join(theirRoot, ".claude"), agents: "/opt/shared-agents", state: ".claude" },
    },
  }));
  const [l2] = layouts({ projectRoot: d, globalDir: join(d, "no-global") });
  check("an absolute path outside the recorded root is untouched",
    l2.agents === "/opt/shared-agents", l2.agents);
}

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log("");
if (failures) { console.error(`test-lib: ${failures} failure(s)`); process.exit(1); }
console.log("test-lib: OK");
