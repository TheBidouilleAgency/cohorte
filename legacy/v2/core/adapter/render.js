#!/usr/bin/env node
// cohorte — runtime adapter.
//
// The core prompts (core/commands/*.md, core/agents/*.md) are the SINGLE source of
// truth and are written runtime-neutral. This module transpiles them into whatever
// the target coding agent actually reads:
//
//                 commands                        agents                  gate hook
//   claude    .claude/commands/<n>.md         md, $ARGUMENTS      md      PreToolUse (deny+ask)
//   codex     .agents/skills/<n>/SKILL.md     md, no substitution toml    PreToolUse (deny only)
//   cursor    .cursor/commands/<n>.md         md, no substitution md      beforeShellExecution
//   gemini    .gemini/commands/<n>.toml       toml, {{args}}      md      BeforeTool (deny only)
//   opencode  .opencode/commands/<n>.md       md, $ARGUMENTS      md      none — advisory --check
//
// Three transforms, in order:
//
//   1. capability conditionals — `<!-- cohorte:if hooks -->…<!-- cohorte:else -->…
//      <!-- cohorte:endif -->` keeps exactly one branch, so one file can state both "the gate
//      fires whether or not you cooperate" and "you must call the gate yourself".
//   2. runtime preamble — one block resolving `<core>`, `<agents>`, the dispatch verb and
//      the gate mechanism, so the prose below never hardcodes a runtime's layout.
//   3. surface encoding — frontmatter filtered to the keys that runtime understands (an
//      unknown key is prose the model reads as an instruction, so dropping is not cosmetic),
//      arg placeholder swapped, and the whole thing re-emitted as md, toml or a skill dir.
//
// Subagents are NOT one of the conditionals: they are a precondition (see assertSupported).
//
// Claude output is byte-identical to the pre-adapter core when a file has no conditionals:
// that is the regression test (scripts/test-adapter.mjs).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtimes');

// --- registry ----------------------------------------------------------------

function listRuntimes() {
  return fs.readdirSync(RUNTIME_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

function loadRuntime(id) {
  const file = path.join(RUNTIME_DIR, `${id}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`unknown runtime "${id}" (known: ${listRuntimes().join(', ')})`);
  }
  const rt = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertSupported(rt);
  return rt;
}

// Subagents are a HARD requirement, not a capability to branch on. The pipeline's premise is
// that each surface is built by someone who can only see the frozen contract; without real
// subagents the lead does every surface in one context and that isolation is simply gone.
// A sequential-persona fallback existed briefly and was removed: it asked the lead to simulate
// the boundary by discipline, which is not the same guarantee, and no supported runtime ever
// took that branch. Refuse loudly rather than render a pipeline whose central promise is absent.
function assertSupported(rt) {
  if (rt.capabilities && rt.capabilities.subagents === false) {
    throw new Error(`runtime "${rt.id}" declares no subagents — cohorte requires them `
      + '(see docs/reference/runtimes.md §Requirements)');
  }
  return rt;
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// Which runtimes are actually installed on this machine. Detection is by config
// directory, not by binary on PATH: Cursor ships no CLI, and a runtime the human
// has configured but not opened this shell for is still a legitimate target.
function detectRuntimes() {
  return listRuntimes().filter((id) => {
    const rt = loadRuntime(id);
    return (rt.detect || []).some((d) => fs.existsSync(expandHome(d)));
  });
}

// Absolute destinations for one (runtime, scope) pair. `projectRoot` anchors every
// relative path; `~`-rooted ones ignore it. A scope entry may pin an individual
// surface to another scope (Codex reads prompts ONLY from ~/.codex, even when the
// neutral core is bundled in the repo) via `<key>_scope`.
function resolvePaths(runtime, scope, projectRoot, { overrides } = {}) {
  const spec = runtime.scopes[scope];
  if (!spec) throw new Error(`runtime ${runtime.id} has no "${scope}" scope`);
  // `overrides` re-roots a declared prefix — the one caller is CLAUDE_CONFIG_DIR, which moves
  // Claude Code's whole `~/.claude` tree elsewhere (a desktop host points it at
  // `~/Library/Application Support/…`). Ignoring it split the install in half: the core was
  // written to `~/.claude` while the hook was registered in the overridden dir, so a scratch
  // install silently wrote into the user's real global core.
  const reroot = (p) => {
    for (const [from, to] of Object.entries(overrides || {})) {
      if (p === from) return to;
      if (p.startsWith(from + '/')) return to + p.slice(from.length);
    }
    return p;
  };
  const abs = (p) => {
    if (!p) return null;
    const e = expandHome(reroot(p));
    return path.isAbsolute(e) ? e : path.join(projectRoot, e);
  };
  const out = { scope, effective: {} };
  for (const key of ['root', 'core', 'commands', 'agents', 'hooks', 'hooks_config',
                     'workflows', 'settings']) {
    out[key] = abs(spec[key]);
    out.effective[key] = spec[`${key}_scope`] || scope;
  }
  return out;
}

// --- 1. capability conditionals ----------------------------------------------

const IF = /^\s*<!--\s*cohorte:if\s+([^>]+?)\s*-->\s*$/;
const ELSE = /^\s*<!--\s*cohorte:else\s*-->\s*$/;
const ENDIF = /^\s*<!--\s*cohorte:endif\s*-->\s*$/;

// A condition is a space-separated OR of terms; a term is `cap`, `!cap`, `runtime:<id>`
// or `!runtime:<id>`. OR (not AND) because every real use is "this family of runtimes".
function testCondition(expr, runtime) {
  return expr.split(/\s+/).filter(Boolean).some((term) => {
    const neg = term.startsWith('!');
    const name = neg ? term.slice(1) : term;
    let value;
    if (name.startsWith('runtime:')) value = runtime.id === name.slice(8);
    else if (name in (runtime.capabilities || {})) value = !!runtime.capabilities[name];
    else throw new Error(`unknown cohorte:if term "${name}"`);
    return neg ? !value : value;
  });
}

function applyConditionals(text, runtime) {
  const lines = text.split('\n');
  const out = [];
  // Each frame: {keep} — whether the branch currently being read survives. Nesting is
  // supported so a hooks-branch can carry a subagents-branch inside it.
  const stack = [];
  const emitting = () => stack.every((f) => f.keep);
  for (const line of lines) {
    let m;
    if ((m = line.match(IF))) {
      const taken = testCondition(m[1], runtime);
      stack.push({ taken, keep: taken, seenElse: false });
      continue;
    }
    if (ELSE.test(line)) {
      const frame = stack[stack.length - 1];
      if (!frame) throw new Error('cohorte:else without a matching cohorte:if');
      if (frame.seenElse) throw new Error('two cohorte:else in one cohorte:if');
      frame.seenElse = true;
      frame.keep = !frame.taken;
      continue;
    }
    if (ENDIF.test(line)) {
      if (!stack.pop()) throw new Error('cohorte:endif without a matching cohorte:if');
      continue;
    }
    if (emitting()) out.push(line);
  }
  if (stack.length) throw new Error('unclosed cohorte:if');
  return out.join('\n');
}

// --- 2. runtime preamble ------------------------------------------------------

// Path as the human/model should see it: `~/…` reads better than an expanded homedir,
// and a project-relative path must stay relative (the agent's cwd is the repo).
function displayPath(p, projectRoot) {
  if (!p) return null;
  const home = os.homedir();
  if (p.startsWith(home + path.sep)) return '~/' + path.relative(home, p).split(path.sep).join('/');
  if (p.startsWith(projectRoot + path.sep)) return path.relative(projectRoot, p).split(path.sep).join('/');
  return p;
}

// The per-project directory holding everything the pipeline GENERATES for this repo
// (gate-config.json, preflight.ok, pipeline-metrics.jsonl, pipeline.json). Distinct from
// `<core>`: the core can be global while this is always in the repo, next to the code it
// describes. `.claude` on a Claude install — unchanged, so existing repos keep working.
//
// Deliberately SHARED across non-Claude runtimes (`.cohorte`), while each of their cores is
// its own subdirectory (`.cohorte/<id>`). The state describes the PROJECT — one gate config,
// one preflight stamp, one metrics log — and duplicating it per runtime would let a repo
// driven from two agents disagree with itself about what is gated and what is verified.
// The core, by contrast, is rendered per runtime and cannot be shared: the same template
// resolves differently depending on whether that agent has subagents or hooks.
function stateDir(runtime) {
  return runtime.id === 'claude' ? '.claude' : '.cohorte';
}

// The user-level config (kanban boards, shared vault). One file per
// human, not per project or per runtime; the shipped scripts probe the same two paths.
function configPath(runtime) {
  return runtime.id === 'claude' ? '~/.claude/cohorte.config.yaml' : '~/.cohorte/cohorte.config.yaml';
}

function preamble(runtime, paths, projectRoot, { kind = 'command' } = {}) {
  const caps = runtime.capabilities || {};
  const core = displayPath(paths.core, projectRoot);
  const fixedAgentsDir = paths.agents ? displayPath(paths.agents, projectRoot) : `${core}/agents`;
  const agentsDir = runtime.id === 'codex' ? '.codex/agents' : fixedAgentsDir;
  const L = [];
  L.push(`> **Runtime: ${runtime.label}.** Generated by the cohorte adapter — do not edit this file;`);
  L.push(`> edit \`core/${kind === 'agent' ? 'agents' : 'commands'}/\` in the cohorte source and re-install.`);
  L.push('>');
  L.push(`> - \`<core>\` = \`${core}\` — the pipeline's shared assets (\`pipeline/scripts/\`, \`pipeline/SCHEMA.md\`, \`templates/\`). Every \`<core>/…\` path below resolves there, and nowhere else.`);
  L.push(`> - \`<state>\` = \`${stateDir(runtime)}/\` in **this repo** — what the pipeline generates for this project (\`gate-config.json\`, \`preflight.ok\`, \`pipeline-metrics.jsonl\`, \`pipeline.json\`). Always project-relative, even when \`<core>\` is global.`);
  L.push(`> - \`<memory>\` = \`${runtime.memory}\` — this runtime's project-instructions file at the repo root, loaded into every session here. Where the doctrine says to reference or extend it, that is the file.`);
  L.push(`> - \`<config>\` = \`${configPath(runtime)}\` — your user-level config (kanban boards, shared vault). One per human, never committed.`);

  L.push(`> - \`<agents>\` = \`${agentsDir}\` — real subagents. Dispatch: ${runtime.agent.dispatch}.`);
  L.push(`> - \`<fixed-agents>\` = \`${fixedAgentsDir}\` — shipped review, release and profile-reader agents. Agent extension: \`${runtime.agent.ext}\`.`);
  if (runtime.id === 'codex') {
    L.push('> - Surface agents are always project-local `.codex/agents/*.toml`, even with a global core. Keep the normal user `CODEX_HOME`; no project launcher or authentication symlink is needed. Never overwrite another project\'s global agents.');
    L.push('> - Agent files use TOML `name`, `description`, `developer_instructions`; optional `model` and `model_reasoning_effort` must be Codex-compatible. Omitted model settings inherit; never write Anthropic aliases. MCP registration lives in `.codex/config.toml`, not a standalone `.mcp.json`.');
  }

  if (caps.hooks) {
    const cfg = displayPath(paths.hooks_config, projectRoot);
    const ask = runtime.hook.supports_ask
      ? 'It can deny outright or ask you to confirm.'
      : 'This runtime has **no confirmation tier**, so a command that would merely be queried elsewhere is **denied** here — re-run it yourself if you meant it.';
    L.push(`> - **Gate** — \`<core>/hooks/gate.py\` is registered as a blocking \`${runtime.hook.event}\` hook in \`${cfg}\`, reading \`<state>/gate-config.json\`. It fires whether or not you cooperate. ${ask}`);
  }

  if (!caps.hooks) {
    L.push('> - **Gate** — this runtime has no blocking hook, so the gate is not automatic. Before any command listed in the profile\'s `gate` block, and before every phase dispatch, run `<core>/hooks/gate.py --check <command>` yourself and obey its verdict (`deny` ⇒ stop, `ask` ⇒ get the human\'s explicit go-ahead). Skipping this is the one deviation that silently removes a safety property.');
  }

  if (!caps.workflows) {
    L.push('> - **Workflows** — unavailable on this runtime. The conversational path below is the only path; ignore any mention of a workflow variant.');
  }

  if (!runtime.command.args) {
    L.push(`> - \`$ARGUMENTS\` — this runtime does not substitute placeholders. It means ${runtime.command.args_note || 'the text typed after the command name'}; expand it yourself everywhere it appears below.`);
  }

  return L.join('\n') + '\n';
}

// Apply to commands AND the instruction templates they consume. Filenames here refer to
// rendered agents, not to the Markdown source templates shipped inside the core.
function adaptInstructions(text, runtime) {
  const resolved = applyConditionals(text, runtime);
  if (runtime.id !== 'codex') return resolved;
  return resolved.replace(/(<(?:agents|fixed-agents)>\/[^\s`]+)\.md\b/g, '$1.toml');
}

// --- 3. surface encoding ------------------------------------------------------

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { keys: [], body: text };
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return { keys: [], body: text };
  const block = text.slice(4, end + 1);
  const body = text.slice(end + 5);
  const keys = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z][\w-]*):\s?(.*)$/);
    // Continuation lines (a wrapped value) belong to the previous key.
    if (!m) {
      if (line.trim() && keys.length) keys[keys.length - 1][1] += '\n' + line;
      continue;
    }
    keys.push([m[1], m[2]]);
  }
  return { keys, body };
}

function emitFrontmatter(keys) {
  if (!keys.length) return '';
  return '---\n' + keys.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n';
}

function substituteArgs(text, runtime) {
  const token = runtime.command.args;
  if (!token || token === '$ARGUMENTS') return text;
  return text.split('$ARGUMENTS').join(token);
}

// Prefer readable multi-line literal TOML; fall back to basic strings for delimiter collisions.
function tomlMultiline(s) {
  // Literal TOML strings cannot escape their delimiter. Use a basic string when the
  // prompt itself contains triple apostrophes, preserving the content exactly.
  return s.includes("'''") ? JSON.stringify(s) : "'''\n" + s + "\n'''";
}
function tomlBasic(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
}

/**
 * Render one core command for one runtime.
 * @returns {{filename: string, content: string, dir: 'commands'}}
 */
function renderCommand({ source, name, runtime, paths, projectRoot }) {
  const { keys, body } = parseFrontmatter(source);
  let out = adaptInstructions(body, runtime);
  out = preamble(runtime, paths, projectRoot) + '\n' + out.replace(/^\n+/, '');
  out = substituteArgs(out, runtime);

  const kept = keys.filter(([k]) => runtime.command.frontmatter.includes(k));
  const dropped = keys.filter(([k]) => !runtime.command.frontmatter.includes(k)).map(([k]) => k);

  // A skill is a DIRECTORY — `<name>/SKILL.md` — whose frontmatter must carry `name`, since
  // that is what the runtime matches on (both for `$<name>` and for implicit selection from
  // `description`). Command sources have no `name` key, so synthesise it from the filename.
  if (runtime.command.format === 'skill') {
    if (!kept.some(([k]) => k === 'name')) kept.unshift(['name', name]);
    return { filename: `${name}${runtime.command.ext}`, content: emitFrontmatter(kept) + out, dropped };
  }

  if (runtime.command.format === 'toml') {
    const desc = (keys.find(([k]) => k === 'description') || [null, ''])[1];
    const lines = [`# cohorte — generated for ${runtime.label}. Do not edit; edit core/commands/${name}.md.`];
    if (dropped.length) lines.push(`# frontmatter not supported here, dropped: ${dropped.join(', ')}`);
    if (desc) lines.push(`description = ${tomlBasic(desc)}`);
    lines.push(`prompt = ${tomlMultiline(substituteArgs(out, runtime))}`);
    return { filename: `${name}${runtime.command.ext}`, content: lines.join('\n') + '\n', dropped };
  }

  const header = emitFrontmatter(kept);
  return { filename: `${name}${runtime.command.ext}`, content: header + out, dropped };
}

// Is this agent read-only? Derived from the source's Claude-style `tools:` list rather than
// declared twice: an agent that was never given Write, Edit or Bash is read-only by intent,
// and each runtime spells that its own way (`readonly: true`, `sandbox_mode = "read-only"`).
// Losing it silently would hand the reviewer the ability to fix what it is meant to report.
function isReadOnly(keys) {
  const tools = (keys.find(([k]) => k === 'tools') || [])[1];
  if (!tools) return false;
  // The implementer template is rendered before its surface tool list is known.
  // A placeholder is not evidence that the eventual worker must be read-only.
  if (tools.includes('<SURFACE_TOOLS>')) return false;
  return !/\b(Write|Edit|MultiEdit|Bash|NotebookEdit)\b/.test(tools);
}

/**
 * Render one core agent for one runtime.
 *
 * Every runtime cohorte targets has real subagents, but they disagree on the file: markdown +
 * frontmatter for Claude Code, Cursor, Gemini CLI and OpenCode; TOML with the body under
 * `developer_instructions` for Codex. `format: "persona"` remains for a runtime with no
 * subagents at all — the file is then read and adopted by the lead in sequence.
 */
function renderAgent({ source, name, runtime, paths, projectRoot }) {
  const { keys, body } = parseFrontmatter(source);
  const out = preamble(runtime, paths, projectRoot, { kind: 'agent' }) + '\n'
    + adaptInstructions(body, runtime).replace(/^\n+/, '');
  const spec = runtime.agent;
  const readonly = isReadOnly(keys);

  if (spec.format === 'toml') {
    const get = (k) => (keys.find(([kk]) => kk === k) || [null, ''])[1];
    const lines = [`# cohorte — generated for ${runtime.label}. Do not edit; edit core/agents/${name}.md.`];
    lines.push(`name = ${tomlBasic(get('name') || name)}`);
    if (get('description')) lines.push(`description = ${tomlBasic(get('description'))}`);
    const model = get('model');
    if (spec.frontmatter.includes('model') && model
        && !['inherit', 'sonnet', 'haiku', 'opus'].includes(model) && !model.startsWith('<')) {
      lines.push(`model = ${tomlBasic(model)}`);
    }
    if (spec.frontmatter.includes('model_reasoning_effort') && get('model_reasoning_effort')) {
      lines.push(`model_reasoning_effort = ${tomlBasic(get('model_reasoning_effort'))}`);
    }
    if (readonly && spec.readonly_key) {
      lines.push(`${spec.readonly_key} = ${tomlBasic(spec.readonly_value)}`);
    }
    lines.push(`${spec.body_key} = ${tomlMultiline(out)}`);
    return { filename: `${name}${spec.ext}`, content: lines.join('\n') + '\n', native: true, readonly };
  }

  if (spec.format !== 'md') {
    return { filename: `${name}.md`, content: out, native: false, dropped: keys.map(([k]) => k) };
  }

  const allowed = spec.frontmatter;
  const kept = keys.filter(([k]) => allowed.includes(k));
  for (const [k, v] of Object.entries(spec.defaults || {})) {
    if (!kept.some(([kk]) => kk === k)) kept.push([k, v]);
  }
  if (readonly && spec.readonly_key && !kept.some(([k]) => k === spec.readonly_key)) {
    kept.push([spec.readonly_key, spec.readonly_value]);
  }
  const dropped = keys.filter(([k]) => !allowed.includes(k)).map(([k]) => k);
  return { filename: `${name}${spec.ext || '.md'}`, content: emitFrontmatter(kept) + out, native: true, dropped, readonly };
}

module.exports = {
  assertSupported,
  stateDir,
  configPath,
  listRuntimes,
  loadRuntime,
  detectRuntimes,
  resolvePaths,
  expandHome,
  displayPath,
  applyConditionals,
  adaptInstructions,
  testCondition,
  parseFrontmatter,
  emitFrontmatter,
  preamble,
  renderCommand,
  renderAgent,
};
