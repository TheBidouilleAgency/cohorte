#!/usr/bin/env node
// Behavioural tests for the runtime adapter — core/adapter/render.js + core/runtimes/*.json.
//
// The adapter is where a single set of source prompts becomes N runtime-specific ones. Its
// failure mode is silent and expensive: a dropped conditional ships a Claude-only instruction
// to a runtime that cannot follow it, a leaked marker turns doctrine into visible noise, and a
// wrong frontmatter key is read by the model as prose. None of that raises an error anywhere —
// it just makes the pipeline quietly wrong on four runtimes out of five.
//
//   node scripts/test-adapter.mjs

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const adapter = require(join(root, "core", "adapter", "render.js"));

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const group = (name) => console.log(name);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const RUNTIMES = adapter.listRuntimes();
const tmps = [];

// ---------------------------------------------------------------- registry ---
group("registry — every runtime declares what the renderer reads");

check("at least the five supported runtimes ship", RUNTIMES.length >= 5, RUNTIMES.join(","));
for (const id of RUNTIMES) {
  const rt = adapter.loadRuntime(id);
  const ok = rt.id === id
    && typeof rt.label === "string"
    && rt.scopes && rt.scopes.global && rt.scopes.project
    && rt.command && ["md", "toml", "skill"].includes(rt.command.format)
    && Array.isArray(rt.command.frontmatter)
    && rt.capabilities && typeof rt.capabilities.subagents === "boolean"
                       && typeof rt.capabilities.hooks === "boolean"
                       && typeof rt.capabilities.workflows === "boolean"
                       && typeof rt.capabilities.tool_restriction === "boolean";
  check(`${id}: complete and well-typed`, ok);
}
check("unknown runtime is an error, not a silent default",
  throws(() => adapter.loadRuntime("nope")));

// A runtime that claims a capability it cannot back is the one mistake the whole design rests
// on: every `cohorte:if` branch trusts these booleans literally, and an over-claim ships the
// strict doctrine to a runtime that cannot enforce it. Pinned against the vendor docs — see
// each runtime's `docs` field; revisit these three lines whenever one of them is re-read.
const withCap = (c) => RUNTIMES.filter((id) => adapter.loadRuntime(id).capabilities[c]).sort().join();
check("hooks claimed everywhere but OpenCode (plugins are not a blocking hook)",
  withCap("hooks") === "claude,codex,cursor,gemini", withCap("hooks"));
check("only Claude Code claims workflows", withCap("workflows") === "claude");
// Not a capability to branch on: a HARD requirement. The pipeline's isolation guarantee is the
// subagent boundary, so a runtime without them cannot be supported — and must be refused loudly
// rather than rendered into a pipeline whose central promise is silently absent.
check("every target runtime has real subagents",
  withCap("subagents") === RUNTIMES.slice().sort().join(), withCap("subagents"));
check("a runtime declaring no subagents is refused, not degraded",
  throws(() => adapter.assertSupported({ id: "x", capabilities: { subagents: false } })));
check("…and one that has them passes the same guard",
  !throws(() => adapter.assertSupported({ id: "x", capabilities: { subagents: true } })));

// A hook runtime must declare how to talk to it, and a no-ask runtime must be flagged: gate.py
// escalates ask→deny there, and getting this backwards silently lets a gated command run.
for (const id of RUNTIMES) {
  const rt = adapter.loadRuntime(id);
  if (!rt.capabilities.hooks) { check(`${id}: declares no hook contract`, !rt.hook); continue; }
  check(`${id}: hook contract is complete`, !!rt.hook && !!rt.hook.event
    && ["claude", "cursor", "gemini"].includes(rt.hook.format)
    && typeof rt.hook.supports_ask === "boolean"
    && !!rt.scopes.project.hooks_config);
}
check("the ask tier is claimed only where the runtime honours it",
  RUNTIMES.filter((id) => (adapter.loadRuntime(id).hook || {}).supports_ask).sort().join()
    === "claude,cursor");

// ------------------------------------------------------------ conditionals ---
group("conditionals — the branch that survives is the branch that is true");

// Synthetic capability sets, not real runtimes: the branch logic must stay correct however the
// vendors' feature matrix moves, and a unit test of the parser should not depend on which
// runtimes happen to ship today.
const rich = { id: "rich", capabilities: { subagents: true, hooks: true, workflows: true, tool_restriction: true } };
const bare = { id: "bare", capabilities: { subagents: false, hooks: false, workflows: false, tool_restriction: false } };

const basic = ["<!-- cohorte:if hooks -->", "H", "<!-- cohorte:else -->", "NOH", "<!-- cohorte:endif -->"].join("\n");
check("if/else keeps the taken branch", adapter.applyConditionals(basic, rich).trim() === "H");
check("if/else keeps the else branch", adapter.applyConditionals(basic, bare).trim() === "NOH");

const neg = ["<!-- cohorte:if !hooks -->", "ADVISORY", "<!-- cohorte:endif -->"].join("\n");
check("negation works", adapter.applyConditionals(neg, bare).trim() === "ADVISORY"
  && adapter.applyConditionals(neg, rich).trim() === "");

const byId = ["<!-- cohorte:if runtime:claude -->", "CC", "<!-- cohorte:endif -->"].join("\n");
check("runtime:<id> targets one runtime",
  adapter.applyConditionals(byId, adapter.loadRuntime("claude")).trim() === "CC"
  && adapter.applyConditionals(byId, adapter.loadRuntime("cursor")).trim() === "");

const or = ["<!-- cohorte:if hooks workflows -->", "X", "<!-- cohorte:endif -->"].join("\n");
check("a multi-term condition is an OR", adapter.applyConditionals(or, rich).trim() === "X");

const nested = [
  "<!-- cohorte:if subagents -->", "A",
  "<!-- cohorte:if hooks -->", "B", "<!-- cohorte:else -->", "C", "<!-- cohorte:endif -->",
  "<!-- cohorte:endif -->",
].join("\n");
check("nesting resolves inner branches inside a taken outer one",
  adapter.applyConditionals(nested, rich).trim().split("\n").join() === "A,B");
check("a dropped outer branch drops its inner branches whole",
  adapter.applyConditionals(nested, bare).trim() === "");

check("an unknown capability is an error, not a silently-false branch",
  throws(() => adapter.applyConditionals("<!-- cohorte:if telepathy -->\nx\n<!-- cohorte:endif -->", rich)));
check("an unclosed if is an error", throws(() => adapter.applyConditionals("<!-- cohorte:if hooks -->\nx", rich)));
check("a stray endif is an error", throws(() => adapter.applyConditionals("<!-- cohorte:endif -->", rich)));
check("two elses in one if is an error", throws(() => adapter.applyConditionals(
  ["<!-- cohorte:if hooks -->", "<!-- cohorte:else -->", "<!-- cohorte:else -->", "<!-- cohorte:endif -->"].join("\n"), rich)));

// Every marker in the real source must be resolvable for EVERY runtime — an unknown term in
// a command nobody rendered yet would surface as an install-time crash for one runtime only.
group("source prompts — every marker resolves for every runtime");
const sources = [
  ...readdirSync(join(root, "core", "commands")).map((f) => ["commands", f]),
  ...readdirSync(join(root, "core", "agents")).map((f) => ["agents", f]),
].filter(([, f]) => f.endsWith(".md"));
for (const id of RUNTIMES) {
  const rt = adapter.loadRuntime(id);
  let bad = null;
  for (const [dir, f] of sources) {
    const src = readFileSync(join(root, "core", dir, f), "utf8");
    try { adapter.applyConditionals(adapter.parseFrontmatter(src).body, rt); }
    catch (e) { bad = `${dir}/${f}: ${e.message}`; break; }
  }
  check(`${id}: all ${sources.length} source files render`, !bad, bad || "");
}

// ------------------------------------------------------------ full install ---
group("install — what each runtime actually gets on disk");

const home = mkdtempSync(join(tmpdir(), "cohorte-home-"));
const proj = mkdtempSync(join(tmpdir(), "cohorte-proj-"));
tmps.push(home, proj);
spawnSync("git", ["init", "-q", "."], { cwd: proj });
const run = spawnSync(process.execPath, [join(root, "bin", "cli.js"), "install",
  `--runtime=${RUNTIMES.join(",")}`], {
  cwd: proj, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "" }, encoding: "utf8",
});
check("the installer exits clean for every runtime at once", run.status === 0,
  (run.stderr || "").slice(0, 400));

for (const id of RUNTIMES) {
  const rt = adapter.loadRuntime(id);
  // resolvePaths reads ~ from the real homedir, so re-point it at the sandbox.
  const p = adapter.resolvePaths(rt, "project", proj);
  const fix = (s) => s && s.replace(process.env.HOME, home);
  const cmdDir = fix(p.commands);
  const buildFile = join(cmdDir, `cohorte-build${rt.command.ext}`);
  check(`${id}: commands landed in ${rt.scopes.project.commands}`, existsSync(buildFile));
  if (!existsSync(buildFile)) continue;
  const build = readFileSync(buildFile, "utf8");

  check(`${id}: no unresolved marker leaked into the output`, !/cohorte:(if|else|endif)/.test(build));
  check(`${id}: the runtime preamble is present`, build.includes(`**Runtime: ${rt.label}.**`));

  // Parallel dispatch is the doctrine on every runtime now; the sequential-persona fallback was
  // removed in 2.2.0 along with any suggestion that a lead can simulate the boundary by hand.
  check(`${id}: dispatches surfaces in parallel`, build.includes("IN PARALLEL"));
  check(`${id}: no trace of the removed persona fallback`,
    !build.includes("ONE PERSONA AT A TIME") && !build.includes("adopt it verbatim"));

  // A path the runtime does not have is a path the model will fail to read, silently.
  if (id !== "claude") {
    check(`${id}: no hardcoded .claude path left in the prose`,
      !/(?<![\w/.-])~?\/?\.claude\//.test(build), (build.match(/.{0,60}\.claude\/.{0,40}/) || [""])[0]);
  }

  // The preamble must describe the gate the way it actually works here — a blocking hook that
  // fires regardless, or an advisory check the agent has to call. Getting this backwards is the
  // worst single error the adapter can make: it tells the model a safety property holds when it
  // does not.
  if (rt.capabilities.hooks) {
    check(`${id}: the gate is described as a blocking ${rt.hook.event} hook`,
      build.includes("is registered as a blocking") && build.includes(rt.hook.event));
    check(`${id}: the missing confirmation tier is stated`,
      build.includes("no confirmation tier") === !rt.hook.supports_ask);
  } else {
    check(`${id}: the gate is described as an explicit check`, build.includes("gate.py --check"));
  }

  // Frontmatter the runtime does not understand is prose the model reads as instruction.
  if (rt.command.format === "md" || rt.command.format === "skill") {
    const fm = adapter.parseFrontmatter(build).keys.map(([k]) => k);
    check(`${id}: only supported frontmatter keys survive`,
      fm.every((k) => rt.command.frontmatter.includes(k)), fm.join(","));
    if (rt.command.format === "skill") {
      // A skill is matched on its frontmatter `name`, both for explicit invocation and for
      // implicit selection. Without it the file installs and is simply never reachable.
      check(`${id}: the skill carries the name it is invoked by`,
        fm.includes("name") && /^name: cohorte-build$/m.test(build));
      check(`${id}: skills are repo-scoped, so a clone gets the commands`,
        rt.scopes.project.commands.startsWith(".agents/"));
    }
  } else {
    check(`${id}: emitted as ${rt.command.format}, not markdown frontmatter`,
      !build.startsWith("---\n") && /^description = "/m.test(build) && /^prompt = '''/m.test(build));
  }

  // Placeholder substitution: a token the runtime never expands must be explained, not left
  // to look like it works.
  if (rt.command.args && rt.command.args !== "$ARGUMENTS") {
    check(`${id}: $ARGUMENTS rewritten to ${rt.command.args}`,
      build.includes(rt.command.args) && !build.includes("$ARGUMENTS"));
  } else if (!rt.command.args) {
    check(`${id}: the unsubstituted placeholder is explained in the preamble`,
      build.includes("does not substitute placeholders"));
  }

  for (const excluded of rt.exclude_commands || []) {
    check(`${id}: ${excluded} is not installed (it cannot run here)`,
      !existsSync(join(cmdDir, `${excluded}${rt.command.ext}`)));
  }

  const agentsDir = fix(p.agents) || join(fix(p.core), "agents");
  const reviewFile = join(agentsDir, `review${rt.agent.ext || ".md"}`);
  check(`${id}: the review agent exists as ${rt.agent.format}`, existsSync(reviewFile));
  if (existsSync(reviewFile)) {
    const review = readFileSync(reviewFile, "utf8");
    // The reviewer must never be able to fix what it reports. Where the runtime can enforce
    // that, the rendered file must carry the restriction; where it cannot, the body must say
    // so — a reviewer that silently gains write access destroys the fix loop's evidence.
    if (rt.agent.readonly_key) {
      check(`${id}: the reviewer is pinned read-only (${rt.agent.readonly_key})`,
        review.includes(rt.agent.readonly_key) && review.includes(rt.agent.readonly_value));
    } else if (rt.capabilities.tool_restriction) {
      // Claude expresses it as the absence of write tools in the `tools:` list.
      check(`${id}: the reviewer's tool list carries no write tool`,
        /^tools:.*$/m.test(review) && !/^tools:.*(Write|Edit|Bash)/m.test(review));
    } else {
      check(`${id}: the reviewer is told read-only is on it`,
        review.includes("read-only **by discipline**") || review.includes("read-only by discipline"));
    }
    // An Anthropic model alias in another vendor's agent file either errors or is ignored.
    check(`${id}: no Anthropic model alias leaked into the agent file`,
      id === "claude" || !/^\s*model\s*[:=]/m.test(review), (review.match(/^.*model.*$/m) || [""])[0]);
  }
  // Every non-Claude runtime shares one `.cohorte` core, so this registry must ACCUMULATE.
  // A single-record file let each install erase the previous runtime's entry.
  const rtJson = join(fix(p.core), "pipeline", "runtimes.json");
  check(`${id}: survives in runtimes.json after the other installs`, existsSync(rtJson)
    && !!JSON.parse(readFileSync(rtJson, "utf8"))[id]);
  check(`${id}: the gate script ships with the core`, existsSync(join(fix(p.core), "hooks", "gate.py")));
  check(`${id}: workflows ship only where a workflow engine exists`,
    existsSync(join(fix(p.core), "workflows")) === rt.capabilities.workflows);

  // Templates are resolved in place at install time, so a shared core would let the LAST
  // runtime installed decide what every other one reads. Each core is its own directory
  // precisely to prevent that; assert the resolution actually matches this runtime.
  const step = join(fix(p.core), "templates", "steps", "init-pipeline", "04-write-render.md");
  if (existsSync(step)) {
    const text = readFileSync(step, "utf8");
    check(`${id}: templates carry no unresolved marker`, !/cohorte:(if|else|endif)/.test(text));
    check(`${id}: the settings/hook step matches this runtime`,
      text.includes("Write `.claude/settings.json`") === (rt.capabilities.hooks && id !== "codex"));
    if (id === "codex") {
      check("codex: init generates native project agents and MCP config",
        text.includes('.codex/agents/<agent>.toml') && text.includes('.codex/config.toml')
        && !text.includes('render `<agents>/<agent>.md`') && !text.includes('`review.md`'));
      const schema = readFileSync(join(p.core, 'pipeline', 'SCHEMA.md'), 'utf8');
      check("codex: reconciliation preserves TOML destinations and Codex MCP context",
        schema.includes('`<agents>/<agent>.toml`') && schema.includes('--context codex')
        && !schema.includes('claude mcp add'));
      const doctor = readFileSync(join(cmdDir, 'cohorte-doctor', 'SKILL.md'), 'utf8');
      check("codex: doctor understands inherited models and TOML",
        doctor.includes('Missing `model` means inheritance, not an error')
        && !doctor.includes('sonnet/haiku/haiku'));
      const update = readFileSync(join(cmdDir, 'cohorte-update-pipeline', 'SKILL.md'), 'utf8');
      check("codex: update selects its runtime and does not demand Claude workflows",
        update.includes('update --runtime=codex') && !update.includes('claude mcp add')
        && !update.includes('`<core>/workflows/` + `agents/profile-reader.md`'));
      const template = readFileSync(join(p.core, 'pipeline', 'PIPELINE.template.md'), 'utf8');
      check("codex: new profiles default to inheritance",
        /model: inherit/.test(template) && !/model: sonnet/.test(template));
      const implementer = readFileSync(join(p.core, 'pipeline', 'implementer.template.md'), 'utf8');
      check('codex: implementers are not accidentally pinned to a read-only sandbox',
        !/^sandbox_mode = "read-only"/m.test(implementer));
    }
  }
}

group("codex — global core, project-local surfaces, native TOML");
{
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' };
  const r = spawnSync(process.execPath,
    [join(root, 'bin/cli.js'), 'install', '--global', '--runtime=codex'],
    { cwd: proj, env, encoding: 'utf8' });
  check('global Codex install succeeds', r.status === 0, r.stderr);
  const init = readFileSync(join(home, '.agents/skills/cohorte-init-pipeline/SKILL.md'), 'utf8');
  check('global skill resolves surfaces relative to whichever project invokes it',
    init.includes('`<agents>` = `.codex/agents`') && !init.includes(proj));
  check('generic agents retain their global destination',
    existsSync(join(home, '.codex/agents/review.toml'))
    && init.includes('`<fixed-agents>` = `~/.codex/agents`'));
  const registry = JSON.parse(readFileSync(join(home, '.cohorte/codex/pipeline/runtimes.json'), 'utf8'));
  check('global registry does not pin surface agents to the installer cwd',
    registry.codex.paths.surface_agents === '.codex/agents'
    && registry.codex.paths.agent_ext === '.toml');
  const hook = JSON.parse(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0];
  check('installed Codex hook matches real shell and subagent calls',
    ['Bash', 'spawn_agent', 'Agent'].every(n => new RegExp(hook.matcher).test(n)));
  const rt = adapter.loadRuntime('codex');
  const paths = adapter.resolvePaths(rt, 'global', proj);
  const render = model => adapter.renderAgent({
    source: `---\nname: example\ndescription: Test agent\nmodel: ${model}\nmodel_reasoning_effort: high\n---\nHandle literal ''' in instructions.`,
    name: 'example', runtime: rt, paths, projectRoot: proj,
  }).content;
  const explicit = render('gpt-5.6-terra');
  check('explicit Codex model and reasoning choices survive rendering',
    explicit.includes('model = "gpt-5.6-terra"') && explicit.includes('model_reasoning_effort = "high"'));
  check('inherit and legacy Anthropic aliases never become executable pins',
    ['inherit', 'sonnet', 'haiku', 'opus'].every(m => !/^model =/m.test(render(m))));
  const python = [process.env.COHORTE_TEST_PYTHON, 'python3', 'python'].filter(Boolean)
    .find(p => spawnSync(p, ['-c', 'import tomllib']).status === 0);
  if (!python) { check('Python 3.11+ available to validate emitted TOML', false); }
  else {
    const parsed = spawnSync(python, ['-c', 'import sys,tomllib; print(tomllib.loads(sys.stdin.read())["developer_instructions"])'],
      { input: explicit, encoding: 'utf8' });
    check('instructions containing triple apostrophes remain valid TOML',
      parsed.status === 0 && parsed.stdout.includes("literal '''"), parsed.stderr);
    const native = spawnSync(python, ['-c',
      'import pathlib,sys,tomllib; [tomllib.loads(p.read_text()) for p in pathlib.Path(sys.argv[1]).glob("*.toml")]',
      join(home, '.codex/agents')], { encoding: 'utf8' });
    check('all installed generic agents parse as TOML', native.status === 0, native.stderr);
  }
}

// The project state — gate config, preflight stamp, metrics — describes the repo, not the
// agent driving it, and must NOT fork per runtime.
group("state — one project, one gate config");
const stateDirs = new Set(RUNTIMES.map((id) => adapter.stateDir(adapter.loadRuntime(id))));
check("every non-Claude runtime shares one state dir", stateDirs.size === 2
  && stateDirs.has(".claude") && stateDirs.has(".cohorte"));
check("but each keeps its own rendered core",
  new Set(RUNTIMES.map((id) => adapter.loadRuntime(id).scopes.project.core)).size === RUNTIMES.length);

// A config dir with a space in it is not exotic: a desktop host puts CLAUDE_CONFIG_DIR under
// `~/Library/Application Support/…`. An unquoted path there splits in the shell, python reports
// `can't open file '/Users/x/Library/Application'`, and EVERY tool call in the session fails —
// including the ones the human would need to undo it. Assert the registration is quoted, per
// runtime, and that the installer still recognises its own entry (or a re-install duplicates it).
group("hook registration — paths with spaces");
{
  const spacedHome = mkdtempSync(join(tmpdir(), "cohorte home-"));
  const spacedProj = mkdtempSync(join(tmpdir(), "cohorte proj-"));
  tmps.push(spacedHome, spacedProj);
  spawnSync("git", ["init", "-q", "."], { cwd: spacedProj });
  const env = { ...process.env, HOME: spacedHome, CLAUDE_CONFIG_DIR: join(spacedHome, ".claude") };
  const args = [join(root, "bin", "cli.js"), "install", `--runtime=${RUNTIMES.join(",")}`];
  const first = spawnSync(process.execPath, args, { cwd: spacedProj, env, encoding: "utf8" });
  check("installs into a path containing a space", first.status === 0,
    (first.stderr || "").slice(0, 300));
  // Claude registers its hook only on a GLOBAL install — project-scope settings.json is
  // /cohorte-init-pipeline's job — so exercise that scope too.
  const gargs = [join(root, "bin", "cli.js"), "install", "--global", "--runtime=claude"];
  spawnSync(process.execPath, gargs, { cwd: spacedProj, env, encoding: "utf8" });
  // Re-install BOTH: the reconcile must match its own quoted entry, or every run stacks another.
  spawnSync(process.execPath, args, { cwd: spacedProj, env, encoding: "utf8" });
  spawnSync(process.execPath, gargs, { cwd: spacedProj, env, encoding: "utf8" });

  for (const id of RUNTIMES) {
    const rt = adapter.loadRuntime(id);
    if (!rt.capabilities.hooks) continue;
    const cfgSpec = (id === "claude" ? rt.scopes.global : rt.scopes.project).hooks_config;
    const cfgPath = cfgSpec.startsWith("~/")
      ? join(spacedHome, cfgSpec.slice(2)) : join(spacedProj, cfgSpec);
    if (!existsSync(cfgPath)) { check(`${id}: hook config written`, false, cfgPath); continue; }
    const hooks = JSON.parse(readFileSync(cfgPath, "utf8")).hooks || {};
    const entries = hooks[rt.hook.event] || [];
    const cmds = entries.flatMap(e => e.command ? [e.command] : (e.hooks || []).map(h => h.command));
    const ours = cmds.filter(c => /gate\.py/.test(c));
    check(`${id}: the gate path is quoted`, ours.length > 0 && ours.every(c => /"[^"]*gate\.py"/.test(c)),
      ours.join(" | "));
    check(`${id}: re-installing does not stack a second registration`, ours.length === 1,
      `${ours.length} entries`);
  }
}

// CLAUDE_CONFIG_DIR moves Claude Code's whole tree — a desktop host points it at
// `~/Library/Application Support/…`. The registry declares those paths as `~/.claude`, and
// resolving them from the homedir instead of the override split the install in half: the core
// went to the REAL `~/.claude` while the hook was registered in the override. A scratch install
// therefore wrote into the user's actual global core, silently.
group("CLAUDE_CONFIG_DIR is honoured, not half-honoured");
{
  const home = mkdtempSync(join(tmpdir(), "cohorte-home-"));
  const cfg = mkdtempSync(join(tmpdir(), "cohorte-cfg-"));   // deliberately NOT under home
  const proj = mkdtempSync(join(tmpdir(), "cohorte-proj-"));
  tmps.push(home, cfg, proj);
  spawnSync("git", ["init", "-q", "."], { cwd: proj });
  const r = spawnSync(process.execPath,
    [join(root, "bin", "cli.js"), "install", "--global", "--runtime=claude"],
    { cwd: proj, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg }, encoding: "utf8" });

  check("the global install succeeds under an overridden config dir", r.status === 0,
    (r.stderr || "").slice(0, 300));
  check("the core lands in the override", existsSync(join(cfg, "pipeline", "VERSION")));
  check("the commands land in the override", existsSync(join(cfg, "commands", "cohorte-build.md")));
  check("the hook is registered in the override", existsSync(join(cfg, "settings.json")));
  check("nothing is written to the home default",
    !existsSync(join(home, ".claude", "pipeline", "VERSION")));
}

// Claude Code must not regress: it is the runtime everyone is already on.
group("no regression — the Claude install keeps its shape");
check("commands still in .claude/commands", existsSync(join(proj, ".claude", "commands", "cohorte-build.md")));
check("agents still in .claude/agents", existsSync(join(proj, ".claude", "agents", "review.md")));
check("the model pin survives the render",
  /^model: sonnet$/m.test(readFileSync(join(proj, ".claude", "commands", "cohorte-build.md"), "utf8")));
check("the subagent name survives the render",
  /^name: review$/m.test(readFileSync(join(proj, ".claude", "agents", "review.md"), "utf8")));
// 2.2.0 retired /cohorte-loop. Copy-over never deletes, so the scrub is the only thing standing
// between an upgrade and a decoy command the model can still fire — assert it on the layout that
// actually had one installed.
check("the retired /cohorte-loop is not installed",
  !existsSync(join(proj, ".claude", "commands", "cohorte-loop.md")));

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(failures ? `\ntest-adapter: ${failures} FAILED` : "\ntest-adapter: OK");
process.exit(failures ? 1 : 0);
