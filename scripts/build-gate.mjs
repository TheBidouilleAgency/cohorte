#!/usr/bin/env node
// Builds core/hooks/gate.py — the single, stdlib-only file the installers ship and `cohorte
// sync` copies into each project — from its source modules in core/hooks/gate/.
//
// gate.py stays committed: lib/install.js and the npm package read it directly, and nothing is
// built at install time. validate-core rebuilds it in memory and fails when the committed file
// differs, so nobody edits the generated file or forgets to rebuild.
//
// The build is a deterministic concatenation, in the fixed order of MODULES:
//   - __init__.py carries gate.py's docstring (and comments that stay in the source tree);
//   - each module starts with its own docstring, dropped from the output, then its import
//     block: `import <stdlib>` lines are hoisted to the top of gate.py (deduplicated, sorted),
//     `from .<module> import …` lines are stripped — they may only name a module built earlier;
//   - the rest of each module is copied verbatim, under a banner naming its source file.
// No timestamps, no absolute paths, LF line endings: the same modules give the same bytes.
//
//   node scripts/build-gate.mjs           write core/hooks/gate.py
//   node scripts/build-gate.mjs --check   exit 1 if core/hooks/gate.py is stale (writes nothing)
import { readFileSync, writeFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export const SRC_DIR = "core/hooks/gate";
export const OUT = "core/hooks/gate.py";
// Build order. A module may use, at import time, only names from modules before it — and its
// `from .x import` lines may only name those.
export const MODULES = ["runtime", "shell", "git", "config", "ownership", "patterns", "context",
  "findings", "rules", "protect", "indirect", "analyze", "preflight", "evaluate", "main"];

const IMPORT_RE = /^import ([A-Za-z_][A-Za-z0-9_]*)$/;
const FROM_RE = /^from \.([A-Za-z_][A-Za-z0-9_]*) import (.+)$/;
const DEF_RE = /^(?:def|class) ([A-Za-z_][A-Za-z0-9_]*)\b|^([A-Za-z_][A-Za-z0-9_]*) *=[^=]/;

function banner(rel) {
  const head = `# ══ ${rel} `;
  return head + "═".repeat(Math.max(3, 79 - head.length));
}

// "# "-prefixed comment lines of at most 95 columns.
function wrap(text) {
  const out = [];
  let cur = "#";
  for (const w of text.split(" ")) {
    if (cur.length + 1 + w.length > 95) { out.push(cur); cur = "#"; }
    cur += " " + w;
  }
  return [...out, cur];
}

// { doc, stdlib: [names], from: [modules], body } for one module's source text.
function splitModule(rel, src) {
  const text = src.replace(/\r\n?/g, "\n");
  const bad = (msg) => { throw new Error(`${rel}: ${msg}`); };
  if (!text.startsWith('"""')) bad("must start with a docstring");
  const end = text.indexOf('"""', 3);
  if (end < 0) bad("unterminated docstring");
  const doc = text.slice(0, end + 3);
  const lines = text.slice(end + 3).split("\n");
  if (lines[0].trim()) bad("code on the docstring's closing line");
  const stdlib = [];
  const from = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    let m;
    if ((m = l.match(IMPORT_RE))) { stdlib.push(m[1]); continue; }
    if ((m = l.match(FROM_RE))) {
      from.push(m[1]);
      if (m[2].trim() === "(") {
        while (++i < lines.length && lines[i].trim() !== ")") {
          if (!/^\s+[A-Za-z_][A-Za-z0-9_, ]*$/.test(lines[i])) bad(`unexpected line in \`from .${m[1]} import (\`: ${lines[i]}`);
        }
        if (i >= lines.length) bad(`unterminated \`from .${m[1]} import (\``);
      } else if (!/^[A-Za-z_][A-Za-z0-9_, ]*$/.test(m[2])) {
        bad(`unsupported import form: ${l}`);
      }
      continue;
    }
    if (/^(import|from)\s/.test(l)) bad(`unsupported import form (only \`import <stdlib>\` and \`from .<module> import …\`): ${l}`);
    break;
  }
  const body = lines.slice(i);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  body.forEach((l, k) => {
    if (/^(import|from)\s/.test(l)) bad(`import outside the leading import block (body line ${k + 1}): ${l}`);
  });
  return { doc, stdlib, from, body };
}

// The full text of gate.py, built from the modules under `root`. Throws on a malformed tree.
export function buildGate(root = repoRoot) {
  const dir = join(root, SRC_DIR);
  const present = readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
  const expected = ["__init__.py", ...MODULES.map((m) => `${m}.py`)];
  const extra = present.filter((f) => !expected.includes(f));
  const missing = expected.filter((f) => !present.includes(f));
  if (extra.length) throw new Error(`${SRC_DIR}: ${extra.join(", ")} not in MODULES of scripts/build-gate.mjs`);
  if (missing.length) throw new Error(`${SRC_DIR}: missing ${missing.join(", ")}`);

  const read = (f) => readFileSync(join(dir, f), "utf8");
  const init = splitModule(`${SRC_DIR}/__init__.py`, read("__init__.py"));
  if (init.stdlib.length || init.from.length || init.body.some((l) => l.trim() && !l.startsWith("#")))
    throw new Error(`${SRC_DIR}/__init__.py: may hold only the docstring and comments`);

  const imports = new Set();
  const owner = new Map();
  const parts = [];
  MODULES.forEach((m, idx) => {
    const rel = `${SRC_DIR}/${m}.py`;
    const mod = splitModule(rel, read(`${m}.py`));
    for (const f of mod.from) {
      const at = MODULES.indexOf(f);
      if (at < 0) throw new Error(`${rel}: \`from .${f}\` names no module in MODULES`);
      if (at >= idx) throw new Error(`${rel}: \`from .${f}\` — ${f} is built after ${m}; a module may only import from earlier ones`);
    }
    mod.stdlib.forEach((s) => imports.add(s));
    // One namespace: a second top-level definition of a name would silently replace the first.
    for (const l of mod.body) {
      const d = l.match(DEF_RE);
      const name = d && (d[1] || d[2]);
      if (!name) continue;
      if (owner.has(name) && owner.get(name) !== m)
        throw new Error(`${rel}: \`${name}\` is already defined in ${SRC_DIR}/${owner.get(name)}.py — top-level names share one namespace`);
      owner.set(name, m);
    }
    if (!mod.body.length) throw new Error(`${rel}: empty`);
    parts.push(["", "", banner(rel), ...mod.body].join("\n"));
  });

  const header = [
    "#!/usr/bin/env python3",
    "# GENERATED from core/hooks/gate/*.py by scripts/build-gate.mjs — edit the modules, then run",
    "# `node scripts/build-gate.mjs`. validate-core fails when this file and the modules disagree.",
    ...wrap(`Build order: ${MODULES.join(", ")}.`),
  ];
  const importLines = [...imports].sort().map((s) => `import ${s}`);
  return [...header, init.doc, "", ...importLines, ...parts].join("\n") + "\n";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const check = process.argv.includes("--check");
  const out = join(repoRoot, OUT);
  let built;
  try { built = buildGate(); }
  catch (e) { console.error(`build-gate: ${e.message}`); process.exit(2); }
  const current = existsSync(out) ? readFileSync(out, "utf8").replace(/\r\n?/g, "\n") : null;
  if (current === built) {
    console.log(`build-gate: ${OUT} is up to date`);
  } else if (check) {
    console.error(`build-gate: ${OUT} is stale — run \`node scripts/build-gate.mjs\``);
    process.exit(1);
  } else {
    writeFileSync(out, built);
    if (current === null) chmodSync(out, 0o755);
    console.log(`build-gate: wrote ${OUT} (${built.split("\n").length - 1} lines)`);
  }
}
