#!/usr/bin/env node
// Layering rules of DESIGN 1.2, net 3: an import scanner over the source tree, driven by layers.json.
//
//   a  an import that is not an edge of layers.json (workspace package, third-party module, or a
//      relative path that leaves the package). Area subpaths (@cohorte/<pkg>/<area>) are the edge <pkg>.
//   b  `@earendil-works/` outside packages/runtime-pi/src/child/** and packages/runtime-pi/test/**
//   c  a `node:` module in core other than path, crypto, events, timers
//   d  from src/**: an import of a package the importer declares only as a dev edge (testkit first of
//      all), a VALUE import across a typeOnly edge, or a typeOnly import outside its allowed subpaths
//   e  credential-reading identifiers, on the raw text
//   f  the cast `as Sealed…` outside the redactor and testkit
//   g  `import(`, or `createRequire` (the same lazy load under its CommonJS name), in shipped code outside
//      the two files allowed to load lazily
//   h  the token `entryOverride` under apps/cli/src (DESIGN 1.3)
//
// layers.json itself is held to DESIGN 1.2 when it is loaded (validateLayers): an edge goes DOWN the layers
// L0..L5, sideways only inside L2, and into the dev layer only as a dev edge.
//
// TypeScript 7 exposes no compiler API, so this file carries a small tokenizer instead of a parser.
// It understands comments, strings, templates and regular expressions, which is what keeps a string
// that merely CONTAINS an import statement from being read as one. What counts as an import: `import` and
// `export … from` in every form, `import('x')` and import(`x`), `require('x')`, and `createRequire(…)('x')`
// directly or through the name the file binds it to. A specifier that is COMPUTED stays invisible to rules
// a-d; in shipped code rule g refuses the construct itself.
//
// Shipped scope is exactly what `tsc -b` compiles: <package>/src/** minus *.test.ts and *.itest.ts, the
// two suffixes the package tsconfigs exclude (src/x.live.ts IS compiled, so it is shipped code here).
// Everything else inside a package is test scope: dev edges are legal there, third-party imports are
// pnpm's business, and rules c, d and g do not apply. Rules b, e, f and h are not tied to a package:
// with the path allowances layers.json gives each of them, they also apply to tests/**, scripts/** and
// fixtures/**, which belong to no package and therefore have no edges to check.
//
// For an undeclared or dev-only `@cohorte/*` import from src/**, this scanner is the ONLY net: the root
// declares every workspace package (PLAN PC-9), so the name resolves from anywhere, and `tsc -b`
// compiles the foreign sources into the importer's program without a word
// (scripts/test/reference-net.test.ts pins that). scripts/unit-check.ts therefore runs checkLayers too.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

// ── layers.json ────────────────────────────────────────────────────────────────────────────────

export interface LayerPackage {
  dir: string;
  layer: string;
  entryPoints: Record<string, string>;
  normal: string[];
  typeOnly: Record<string, string[]>;
  dev: string[];
  thirdParty: string[];
  declaredOnly: string[];
}

export interface LayersFile {
  version: number;
  scope: string;
  packages: Record<string, LayerPackage>;
  root: { dev: string[]; devTools: string[] };
  thirdPartyUniverse: string[];
  rules: {
    a: { devToolImports: Array<{ paths: string[]; modules: string[] }> };
    b: { prefix: string; allowedIn: string[] };
    c: { package: string; allowedNodeModules: string[] };
    e: { everywhere: string[]; scoped: Array<{ token: string; in: string[] }>; exempt: string[] };
    f: { pattern: string; allowedIn: string[]; exempt: string[] };
    g: { allowedIn: string[]; exempt: string[] };
    h: { token: string; forbiddenIn: string[] };
  };
}

export type RuleId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';

export interface Violation {
  rule: RuleId;
  file: string;
  line: number;
  message: string;
  specifier?: string;
}

/** The layers of DESIGN 1.2, bottom up. `dev` (testkit) is outside the order: only dev edges reach it. */
const LAYER_ORDER: readonly string[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
const DEV_LAYER = 'dev';
/** The one layer whose packages may import each other (DESIGN 1.2: L1 packages never do, rule C4). */
const LAYER_WITH_INNER_EDGES = 'L2';

/** Everything that makes a layers file self-contradictory; empty when it is sound. */
export function validateLayers(layers: LayersFile): string[] {
  const names = new Set(Object.keys(layers.packages));
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(layers.packages)) {
    const typeOnly = Object.keys(entry.typeOnly);
    if (entry.layer !== DEV_LAYER && !LAYER_ORDER.includes(entry.layer))
      problems.push(`${name}: unknown layer ${entry.layer} (expected ${LAYER_ORDER.join(', ')} or ${DEV_LAYER})`);
    for (const target of [...entry.normal, ...typeOnly, ...entry.dev]) {
      if (!names.has(target)) problems.push(`${name}: edge to unknown package ${target}`);
      if (target === name) problems.push(`${name}: edge to itself`);
    }
    // Nothing imports upward, and sideways only inside L2. A new edge that merely avoids a cycle is still refused.
    for (const target of [...entry.normal, ...typeOnly]) {
      const to = layers.packages[target]?.layer;
      if (to === undefined || target === name) continue;
      if (to === DEV_LAYER) {
        problems.push(`${name}: ${target} is in the dev layer, which only a dev edge may reach`);
      } else if (entry.layer !== DEV_LAYER) {
        const down = LAYER_ORDER.indexOf(to) < LAYER_ORDER.indexOf(entry.layer);
        const inner = to === entry.layer && to === LAYER_WITH_INNER_EDGES;
        if (!down && !inner)
          problems.push(
            `${name} (${entry.layer}) -> ${target} (${to}): an edge goes DOWN the layers of DESIGN 1.2; same-layer edges exist only inside ${LAYER_WITH_INNER_EDGES}`,
          );
      }
    }
    for (const target of typeOnly) {
      if (entry.normal.includes(target)) problems.push(`${name}: ${target} is both a normal and a typeOnly edge`);
    }
    for (const module of [...entry.thirdParty, ...entry.declaredOnly]) {
      if (!layers.thirdPartyUniverse.includes(module)) problems.push(`${name}: ${module} is not in thirdPartyUniverse`);
    }
  }
  for (const target of layers.root.dev) {
    if (!names.has(target)) problems.push(`root: dev edge to unknown package ${target}`);
  }
  return problems;
}

export function loadLayers(path: string): LayersFile {
  const layers = JSON.parse(readFileSync(path, 'utf8')) as LayersFile;
  const problems = validateLayers(layers);
  if (problems.length > 0) throw new Error(`${path} is inconsistent:\n  ${problems.join('\n  ')}`);
  return layers;
}

// ── tokenizer ──────────────────────────────────────────────────────────────────────────────────

export type TokenKind = 'word' | 'string' | 'template' | 'regex' | 'number' | 'punct';

export interface Token {
  kind: TokenKind;
  /**
   * The identifier, the punctuation, or the VALUE of a string literal. A template without `${}` IS a string
   * literal (kind `string`); a template with substitutions and a regex are opaque.
   */
  text: string;
  line: number;
  /** True when no other token precedes this one on its line. */
  lineStart: boolean;
}

const WORD_START = /[A-Za-z_$]/;
const WORD_PART = /[A-Za-z0-9_$]/;
const PUNCTUATION = ['=>', '...', '?.', '&&', '||', '??', '==', '!=', '<=', '>=', '++', '--'];
/** After these words a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Code tokens only: comments are dropped, literal contents never become tokens. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lastTokenLine = 0;
  // One entry per open `{`: true when it is the `${` of a template, so that its `}` resumes the template.
  const braces: boolean[] = [];

  const push = (kind: TokenKind, text: string, atLine: number) => {
    tokens.push({ kind, text, line: atLine, lineStart: lastTokenLine !== atLine });
    lastTokenLine = atLine;
  };

  /** Consumes template characters from `i` up to the closing backtick or the next `${`, and says which it was. */
  const readTemplateChunk = (): { text: string; closed: boolean } => {
    let text = '';
    while (i < source.length) {
      const c = source[i] as string;
      if (c === '\\') {
        text += source[i + 1] ?? '';
        i += 2;
      } else if (c === '`') {
        i += 1;
        return { text, closed: true };
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        braces.push(true);
        return { text, closed: false };
      } else {
        if (c === '\n') line += 1;
        text += c;
        i += 1;
      }
    }
    return { text, closed: true };
  };

  const regexAllowed = () => {
    const previous = tokens.at(-1);
    if (!previous) return true;
    if (previous.kind === 'word') return REGEX_AFTER_WORD.has(previous.text);
    if (previous.kind === 'punct') return ![')', ']', '}'].includes(previous.text);
    return false;
  };

  while (i < source.length) {
    const c = source[i] as string;
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k += 1) if (source[k] === '\n') line += 1;
      i = stop;
    } else if (c === "'" || c === '"') {
      const startLine = line;
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') {
          value += source[i + 1] ?? '';
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      push('string', value, startLine);
    } else if (c === '`') {
      const startLine = line;
      i += 1;
      const head = readTemplateChunk();
      // Without `${}` a template is a string literal under another quote: import(`x`) names the module x.
      if (head.closed) push('string', head.text, startLine);
      else push('template', '', startLine);
    } else if (c === '}' && braces.at(-1) === true) {
      braces.pop();
      i += 1;
      readTemplateChunk();
    } else if (c === '/' && regexAllowed()) {
      const startLine = line;
      let inClass = false;
      i += 1;
      while (i < source.length && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') i += 1;
        else if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      while (i < source.length && WORD_PART.test(source[i] as string)) i += 1;
      push('regex', '', startLine);
    } else if (WORD_START.test(c)) {
      let end = i + 1;
      while (end < source.length && WORD_PART.test(source[end] as string)) end += 1;
      push('word', source.slice(i, end), line);
      i = end;
    } else if (/[0-9]/.test(c)) {
      let end = i + 1;
      while (end < source.length && /[0-9a-zA-Z_.]/.test(source[end] as string)) end += 1;
      push('number', source.slice(i, end), line);
      i = end;
    } else {
      const multi = PUNCTUATION.find((p) => source.startsWith(p, i));
      const text = multi ?? c;
      if (text === '{') braces.push(false);
      if (text === '}') braces.pop();
      push('punct', text, line);
      i += text.length;
    }
  }
  return tokens;
}

// ── imports ────────────────────────────────────────────────────────────────────────────────────

export interface ImportRecord {
  /** `null` for a dynamic import whose argument is not a string literal. */
  specifier: string | null;
  /** `type` only for `import type …` / `export type … from`: under verbatimModuleSyntax an inline `{ type X }` still loads the module. */
  kind: 'value' | 'type' | 'dynamic';
  line: number;
}

export function scanImports(source: string): ImportRecord[] {
  return scanImportTokens(tokenize(source));
}

function scanImportTokens(tokens: readonly Token[]): ImportRecord[] {
  const records: ImportRecord[] = [];
  const is = (index: number, kind: TokenKind, text?: string) => {
    const token = tokens[index];
    return token !== undefined && token.kind === kind && (text === undefined || token.text === text);
  };
  /** From `start`, the string after the next `from`, giving up at the end of the statement. */
  const specifierAfterFrom = (start: number): string | null => {
    for (let k = start; k < tokens.length && k < start + 400; k += 1) {
      if (is(k, 'punct', ';') || is(k, 'punct', '=')) return null;
      if (k > start && tokens[k]?.lineStart && (is(k, 'word', 'import') || is(k, 'word', 'export'))) return null;
      if (is(k, 'word', 'from') && is(k + 1, 'string')) return tokens[k + 1]?.text ?? null;
    }
    return null;
  };

  /** Index of the `)` that closes the `(` at `open`, or -1. */
  const closingParen = (open: number): number => {
    let depth = 0;
    for (let k = open; k < tokens.length; k += 1) {
      if (is(k, 'punct', '(')) depth += 1;
      if (is(k, 'punct', ')')) depth -= 1;
      if (depth === 0) return k;
    }
    return -1;
  };

  // createRequire(…) returns `require` under whatever name the file gives it:
  //   const load = createRequire(import.meta.url)   ·   const load: NodeJS.Require = module.createRequire(…)
  const requireNames = new Set(['require']);
  for (let k = 0; k < tokens.length; k += 1) {
    if (!is(k, 'word', 'createRequire') || !is(k + 1, 'punct', '(')) continue;
    let at = k - 1;
    while (is(at, 'punct', '.') && is(at - 1, 'word')) at -= 2;
    if (!is(at, 'punct', '=')) continue;
    at -= 1;
    // Step back over a type annotation (`name: A.B = …`) to the name it annotates.
    let annotation = at;
    while (is(annotation, 'word') && is(annotation - 1, 'punct', '.')) annotation -= 2;
    if (is(annotation, 'word') && is(annotation - 1, 'punct', ':') && is(annotation - 2, 'word')) at = annotation - 2;
    if (is(at, 'word')) requireNames.add(tokens[at]?.text ?? '');
  }

  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k] as Token;
    if (token.kind !== 'word') continue;

    // The direct call, `createRequire(import.meta.url)('x')`, also as a member of the node:module namespace.
    if (token.text === 'createRequire' && is(k + 1, 'punct', '(')) {
      const close = closingParen(k + 1);
      if (close !== -1 && is(close + 1, 'punct', '(') && is(close + 2, 'string') && is(close + 3, 'punct', ')'))
        records.push({ specifier: tokens[close + 2]?.text ?? null, kind: 'value', line: token.line });
      continue;
    }
    if (is(k - 1, 'punct', '.') || is(k - 1, 'punct', '?.')) continue;

    if (token.text === 'import') {
      if (is(k + 1, 'punct', '.')) continue;
      if (is(k + 1, 'punct', '(')) {
        const literal = is(k + 2, 'string') && (is(k + 3, 'punct', ')') || is(k + 3, 'punct', ','));
        records.push({ specifier: literal ? (tokens[k + 2]?.text ?? null) : null, kind: 'dynamic', line: token.line });
      } else if (is(k + 1, 'string')) {
        records.push({ specifier: tokens[k + 1]?.text ?? null, kind: 'value', line: token.line });
      } else {
        const typeOnly = is(k + 1, 'word', 'type') && !is(k + 2, 'word', 'from') && !is(k + 2, 'punct', ',');
        const specifier = specifierAfterFrom(k + 1);
        if (specifier !== null) records.push({ specifier, kind: typeOnly ? 'type' : 'value', line: token.line });
      }
    } else if (token.text === 'export') {
      const typeOnly = is(k + 1, 'word', 'type') && (is(k + 2, 'punct', '{') || is(k + 2, 'punct', '*'));
      const clause = typeOnly ? k + 2 : k + 1;
      if (!is(clause, 'punct', '{') && !is(clause, 'punct', '*')) continue;
      const specifier = specifierAfterFrom(clause);
      if (specifier !== null) records.push({ specifier, kind: typeOnly ? 'type' : 'value', line: token.line });
    } else if (
      requireNames.has(token.text) &&
      is(k + 1, 'punct', '(') &&
      is(k + 2, 'string') &&
      is(k + 3, 'punct', ')')
    ) {
      records.push({ specifier: tokens[k + 2]?.text ?? null, kind: 'value', line: token.line });
    }
  }
  return records;
}

// ── paths ──────────────────────────────────────────────────────────────────────────────────────

/** `*` stays inside one path segment, `**` crosses segments; a pattern without wildcards also matches everything below it. */
export function globToRegExp(pattern: string): RegExp {
  let body = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        body += '(?:.*/)?';
        i += 2;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const literal = !/[*?]/.test(pattern);
  return new RegExp(`^${body}${literal ? '(?:/.*)?' : ''}$`);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

// docs/ and assets/ are never entered because only the five roots below are walked.
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-types', '.git', '.build', '.cohorte']);
const SOURCE_FILE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;
// The two suffixes every package tsconfig.json excludes from `tsc -b`, and no other.
const COLOCATED_TEST_FILE = /\.(?:test|itest)\.ts$/;

/** A parallel unit may delete or rename a file between the directory listing and the read. */
function ifPresent<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function walk(root: string, relativeDir: string, out: string[]): void {
  const absolute = join(root, relativeDir);
  if (!existsSync(absolute)) return;
  for (const name of (ifPresent(() => readdirSync(absolute)) ?? []).sort()) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const child = relativeDir === '' ? name : posix.join(relativeDir, name);
    const stats = statSync(join(root, child), { throwIfNoEntry: false });
    if (stats?.isDirectory()) walk(root, child, out);
    else if (stats?.isFile() && SOURCE_FILE.test(name) && !name.endsWith('.d.ts')) out.push(child);
  }
}

/** Everything the rules look at: both package roots, plus tests/, fixtures/ and scripts/ for the text rules. */
function collectFiles(root: string): string[] {
  const files: string[] = [];
  for (const top of ['apps', 'packages', 'tests', 'fixtures', 'scripts']) walk(root, top, files);
  return files;
}

// ── the rules ──────────────────────────────────────────────────────────────────────────────────

const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')));
const asNodeModule = (specifier: string): string | null => {
  if (specifier.startsWith('node:')) return specifier;
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0] ?? '') ? `node:${specifier}` : null;
};

/** `@scope/name/sub/path` -> ['@scope/name', './sub/path']; `name` -> ['name', '.'] */
function splitSpecifier(specifier: string): [string, string] {
  const parts = specifier.split('/');
  const size = specifier.startsWith('@') ? 2 : 1;
  const rest = parts.slice(size).join('/');
  return [parts.slice(0, size).join('/'), rest === '' ? '.' : `./${rest}`];
}

/**
 * Indexes of the tokens inside the braces of an import / export specifier list, where `as` renames a
 * binding (`import type { Sealed as SealedBrand }`) and casts nothing.
 */
function specifierListTokens(tokens: readonly Token[]): Set<number> {
  const inside = new Set<number>();
  const is = (index: number, kind: TokenKind, text?: string) =>
    tokens[index]?.kind === kind && (text === undefined || tokens[index]?.text === text);
  for (let k = 0; k < tokens.length; k += 1) {
    if (!is(k, 'word', 'import') && !is(k, 'word', 'export')) continue;
    if (is(k - 1, 'punct', '.') || is(k - 1, 'punct', '?.')) continue;
    // import [type] [Default,] {   ·   export [type] {
    let open = k + 1;
    if (is(open, 'word', 'type')) open += 1;
    if (is(k, 'word', 'import') && is(open, 'word') && is(open + 1, 'punct', ',')) open += 2;
    if (!is(open, 'punct', '{')) continue;
    for (let m = open + 1; m < tokens.length && !is(m, 'punct', '}'); m += 1) inside.add(m);
  }
  return inside;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

export interface CheckLayersResult {
  violations: Violation[];
  filesScanned: number;
}

export function checkLayers(options: { root: string; layers: LayersFile }): CheckLayersResult {
  const { root, layers } = options;
  const violations: Violation[] = [];
  const byDir = Object.entries(layers.packages).map(([name, entry]) => ({ name, entry }));
  const ownerOf = (file: string) => byDir.find(({ entry }) => file.startsWith(`${entry.dir}/`));
  const files = collectFiles(root);

  for (const file of files) {
    const text = ifPresent(() => readFileSync(join(root, file), 'utf8'));
    if (text === null) continue;
    const owner = ownerOf(file);
    // Shipped scope is what `tsc -b` compiles. Everything else in a package (test/**, a colocated
    // test, a tsdown or vitest config beside package.json) is test scope: never bundled, dev edges legal.
    const shipped =
      owner !== undefined && file.startsWith(`${owner.entry.dir}/src/`) && !COLOCATED_TEST_FILE.test(file);
    const testScope = !shipped;
    const report = (rule: RuleId, line: number, message: string, specifier?: string) =>
      violations.push({ rule, file, line, message, ...(specifier === undefined ? {} : { specifier }) });

    // e: raw text, comments and strings included.
    if (!matchesAny(file, layers.rules.e.exempt)) {
      const tokens = [
        ...layers.rules.e.everywhere,
        ...layers.rules.e.scoped.filter((scoped) => matchesAny(file, scoped.in)).map((scoped) => scoped.token),
      ];
      for (const token of tokens) {
        const at = text.indexOf(token);
        if (at !== -1)
          report(
            'e',
            lineOf(text, at),
            `credential-reading identifier \`${token}\` (spec 10.1: the token is never read nor exported)`,
          );
      }
    }

    const tokens = tokenize(text);

    // f: the cast, on code tokens (a comment may talk about it).
    if (!matchesAny(file, layers.rules.f.allowedIn) && !matchesAny(file, layers.rules.f.exempt)) {
      const renames = specifierListTokens(tokens);
      for (let k = 0; k + 1 < tokens.length; k += 1) {
        const next = tokens[k + 1] as Token;
        const namespaceRename = tokens[k - 1]?.kind === 'punct' && tokens[k - 1]?.text === '*';
        if (
          tokens[k]?.kind === 'word' &&
          tokens[k]?.text === 'as' &&
          next.kind === 'word' &&
          next.text.startsWith('Sealed') &&
          !renames.has(k) &&
          !namespaceRename
        ) {
          report(
            'f',
            next.line,
            `\`as Sealed…\` cast: only the redactor (${layers.rules.f.allowedIn[0]}) mints Sealed<T>`,
          );
        }
      }
    }

    // h
    if (matchesAny(file, layers.rules.h.forbiddenIn)) {
      const hit = tokens.find((t) => t.kind === 'word' && t.text === layers.rules.h.token);
      if (hit)
        report(
          'h',
          hit.line,
          `the token \`${layers.rules.h.token}\` must not appear here: the CLI never passes a test entry to the runtime`,
        );
    }

    // g: shipped code loads its modules statically, where the bundler and the rules above can see them.
    const lazyLoadForbidden =
      shipped && !matchesAny(file, layers.rules.g.allowedIn) && !matchesAny(file, layers.rules.g.exempt);
    const lazyLoadMessage = (what: string) =>
      `\`${what}\` in shipped code: only ${layers.rules.g.allowedIn.join(' and ')} may load lazily`;
    if (lazyLoadForbidden) {
      // The same escape hatch under its CommonJS name. One report per file: the import of the name is the first hit.
      const hit = tokens.find((t) => t.kind === 'word' && t.text === 'createRequire');
      if (hit) report('g', hit.line, lazyLoadMessage('createRequire'));
    }

    for (const record of scanImportTokens(tokens)) {
      if (record.kind === 'dynamic' && lazyLoadForbidden) report('g', record.line, lazyLoadMessage('import('));
      const specifier = record.specifier;
      if (specifier === null) continue;

      // b
      if (specifier.startsWith(layers.rules.b.prefix) && !matchesAny(file, layers.rules.b.allowedIn)) {
        report(
          'b',
          record.line,
          `\`${layers.rules.b.prefix}\` is imported outside ${layers.rules.b.allowedIn.join(', ')}`,
          specifier,
        );
        continue;
      }

      // Every rule below is about the edges of a package: tests/**, scripts/** and fixtures/** have none.
      if (owner === undefined) continue;
      const { name: importer, entry } = owner;

      if (specifier.startsWith('.')) {
        const target = relative(root, resolve(root, dirname(file), specifier))
          .split(sep)
          .join('/');
        if (!target.startsWith(`${entry.dir}/`))
          report(
            'a',
            record.line,
            `relative import \`${specifier}\` leaves ${entry.dir}: import the package by name`,
            specifier,
          );
        continue;
      }

      const nodeModule = asNodeModule(specifier);
      if (nodeModule !== null) {
        // c
        if (shipped && importer === layers.rules.c.package && !layers.rules.c.allowedNodeModules.includes(nodeModule)) {
          report(
            'c',
            record.line,
            `\`${specifier}\` in core: only ${layers.rules.c.allowedNodeModules.join(', ')} are allowed, every byte of I/O goes through a port`,
            specifier,
          );
        }
        continue;
      }

      const [target, subpath] = splitSpecifier(specifier);
      if (target === importer) continue;

      if (target in layers.packages) {
        const normal = entry.normal.includes(target);
        const typeOnlySubpaths = entry.typeOnly[target];
        const dev = entry.dev.includes(target);
        if (testScope) {
          if (!normal && typeOnlySubpaths === undefined && !dev)
            report(
              'a',
              record.line,
              `${importer} -> ${target} is not an edge of layers.json (not even a dev edge)`,
              target,
            );
        } else if (normal) {
          // a declared edge
        } else if (typeOnlySubpaths !== undefined) {
          // d
          if (record.kind !== 'type')
            report(
              'd',
              record.line,
              `${importer} -> ${target} is a typeOnly edge: use \`import type\` (an inline \`{ type X }\` still loads the module)`,
              target,
            );
          else if (!typeOnlySubpaths.includes(subpath))
            report(
              'd',
              record.line,
              `${importer} -> ${target} is a typeOnly edge restricted to ${typeOnlySubpaths.join(', ')}; got ${subpath}`,
              target,
            );
        } else if (dev) {
          report(
            'd',
            record.line,
            `${target} is a dev edge of ${importer}: legal from test/** only, never from src/**`,
            target,
          );
        } else {
          report('a', record.line, `${importer} -> ${target} is not an edge of layers.json`, target);
        }
        continue;
      }

      if (testScope) continue;
      const allowedTool = layers.rules.a.devToolImports.some(
        (allowance) => allowance.modules.includes(target) && matchesAny(file, allowance.paths),
      );
      if (!entry.thirdParty.includes(target) && !allowedTool) {
        report(
          'a',
          record.line,
          `third-party module \`${target}\` is not declared for ${importer} in layers.json`,
          target,
        );
      }
    }
  }

  violations.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1));
  return { violations, filesScanned: files.length };
}

// ── command line ───────────────────────────────────────────────────────────────────────────────

function main(): number {
  const { values } = parseArgs({
    options: { root: { type: 'string' }, layers: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  const root = resolve(values.root ?? join(import.meta.dirname, '..'));
  const layers = loadLayers(resolve(values.layers ?? join(root, 'layers.json')));
  const result = checkLayers({ root, layers });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.violations.length === 0) {
    process.stdout.write(`check-layers: OK (${result.filesScanned} files)\n`);
  } else {
    for (const v of result.violations) process.stderr.write(`${v.file}:${v.line} [${v.rule}] ${v.message}\n`);
    process.stderr.write(`check-layers: ${result.violations.length} violation(s) in ${result.filesScanned} files\n`);
  }
  return result.violations.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
