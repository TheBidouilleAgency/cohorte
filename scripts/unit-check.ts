#!/usr/bin/env node
// PLAN §4: `pnpm unit:check <unitId>` — the one command a unit of a PARALLEL wave may run to
// prove itself. It sees only the unit's owned code and writes nothing shared:
//
//   1. tsc -p tsconfig.checks/<unit>.json --noEmit      a diagnostic in a file the unit does NOT own
//                                                       is printed as a warning (a sibling is mid-edit)
//   2. biome check <owned paths that exist>
//   3. check-layers, in process and read-only           a violation in a file the unit owns is a failure,
//                                                       anywhere else a warning. For an undeclared or
//                                                       dev-only `@cohorte/*` import from src/** this is
//                                                       the ONLY net (`tsc -b` lets it through:
//                                                       scripts/test/reference-net.test.ts), so a unit
//                                                       must see it before the gate does
//   4. vitest run --maxWorkers=2 <testPaths>            private cache dir .build/.vitest/<unit>;
//                                                       no matched test file is a FAILURE, and so is
//                                                       EACH test path that selects no file on its own
//                                                       (`vitest list`, once per path, runs nothing), and
//                                                       an owned file with a test suffix that no vitest
//                                                       project collects (a foreign one is a warning)
//
//   node scripts/unit-check.ts <unitId> [--root <dir>] [--plan <file>]
//   node scripts/unit-check.ts --self-test              proves the behaviours above on a temp tree
//
// Exit codes: 0 green, 1 red, 2 usage / unknown unit / missing generated tsconfig.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { checkLayers, globToRegExp, loadLayers, type Violation } from './check-layers.ts';
import {
  CHECKS_DIRECTORY,
  generateUnitChecks,
  loadPlan,
  PLAN_PATH,
  type Plan,
  PlanFileError,
  type PlanUnit,
  typeScriptIncludes,
  unitsOf,
} from './gen-unit-checks.ts';

/** The repository whose node_modules holds tsc, Biome and vitest: the one this script lives in. */
const TOOL_ROOT = resolve(import.meta.dirname, '..');
const TOOLS = {
  tsc: join(TOOL_ROOT, 'node_modules/typescript/bin/tsc'),
  biome: join(TOOL_ROOT, 'node_modules/@biomejs/biome/bin/biome'),
  vitest: join(TOOL_ROOT, 'node_modules/vitest/vitest.mjs'),
};

const LAYERS_FILE = 'layers.json';

export class UsageError extends Error {}

export interface Diagnostic {
  /** Repository-relative POSIX path, or `null` for a diagnostic that belongs to no file. */
  file: string | null;
  line: number;
  column: number;
  code: string;
  message: string;
}

const FILE_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const GLOBAL_DIAGNOSTIC = /^error (TS\d+): (.*)$/;

/** Parses `tsc --pretty false` output. Indented lines continue the previous diagnostic. */
export function parseTscOutput(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const inFile = FILE_DIAGNOSTIC.exec(line);
    const global = inFile ? null : GLOBAL_DIAGNOSTIC.exec(line);
    const last = diagnostics.at(-1);
    if (inFile) {
      diagnostics.push({
        file: inFile[1] ?? null,
        line: Number(inFile[2]),
        column: Number(inFile[3]),
        code: inFile[4] ?? '',
        message: inFile[5] ?? '',
      });
    } else if (global) {
      diagnostics.push({ file: null, line: 0, column: 0, code: global[1] ?? '', message: global[2] ?? '' });
    } else if (last && /^\s+\S/.test(line)) {
      last.message += `\n${line}`;
    }
  }
  return diagnostics;
}

/** True for a repository-relative POSIX path that lies inside one of the unit's owned paths. */
export function createOwnedMatcher(ownedPaths: readonly string[]): (path: string) => boolean {
  const patterns = ownedPaths.map(globToRegExp);
  return (path) => patterns.some((pattern) => pattern.test(path));
}

export interface UnitCheckResult {
  ok: boolean;
  tsc: { ran: boolean; errors: Diagnostic[]; warnings: Diagnostic[] };
  biome: { ran: boolean; ok: boolean; paths: string[] };
  layers: { ran: boolean; errors: Violation[]; warnings: Violation[] };
  vitest: {
    ran: boolean;
    /** `vitest run` exited 0, every test path selected a file, and no owned test file is left uncollected. */
    ok: boolean;
    cacheDir: string;
    /** Exit status of `vitest run`; `null` when it did not run. */
    status: number | null;
    /** The test paths that select no test file on their own. */
    emptyPaths: string[];
    /** Files under the test paths that carry a test suffix and that no vitest project collects. */
    uncollected: { errors: string[]; warnings: string[] };
  };
}

export interface UnitCheckOptions {
  root: string;
  unitId: string;
  planPath?: string;
  out?: { write(text: string): unknown };
}

const toPosix = (path: string) => path.split(sep).join('/');

export async function runUnitCheck(options: UnitCheckOptions): Promise<UnitCheckResult> {
  const root = realpathSync(options.root);
  const out = options.out ?? process.stdout;
  const say = (text: string) => void out.write(`${text}\n`);
  const planPath = options.planPath ?? PLAN_PATH;
  const unit = unitsOf(readPlan(root, planPath)).find((candidate) => candidate.id === options.unitId);
  if (!unit) throw new UsageError(`unit ${options.unitId} is not in ${planPath}`);
  const owned = createOwnedMatcher(unit.ownedPaths);
  const run = (tool: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
    spawnSync(process.execPath, [tool, ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  // 1. typecheck
  const tsc: UnitCheckResult['tsc'] = { ran: false, errors: [], warnings: [] };
  const config = join(CHECKS_DIRECTORY, `${unit.id}.json`);
  if (!existsSync(join(root, config))) {
    throw new UsageError(
      `${config} does not exist: an integrator regenerates it with \`node scripts/gen-unit-checks.ts\``,
    );
  }
  if (typeScriptIncludes(unit.ownedPaths).length === 0) {
    say(`unit-check ${unit.id}: tsc skipped (the unit owns no TypeScript path)`);
  } else {
    tsc.ran = true;
    const done = run(TOOLS.tsc, ['-p', config, '--noEmit', '--pretty', 'false']);
    const diagnostics = parseTscOutput(`${done.stdout}\n${done.stderr}`);
    for (const diagnostic of diagnostics) {
      const file = diagnostic.file === null ? null : toPosix(relative(root, resolve(root, diagnostic.file)));
      const located = { ...diagnostic, file };
      // A diagnostic without a file (no inputs, a broken config) is the unit's own problem.
      if (file === null || owned(file)) tsc.errors.push(located);
      else tsc.warnings.push(located);
    }
    if (done.status !== 0 && diagnostics.length === 0) {
      tsc.errors.push({
        file: null,
        line: 0,
        column: 0,
        code: 'TSC',
        message: `tsc exited ${done.status}: ${done.stderr || done.stdout}`,
      });
    }
    for (const d of tsc.warnings)
      say(`warning (not owned by ${unit.id}) ${d.file}(${d.line},${d.column}): ${d.code}: ${d.message}`);
    for (const d of tsc.errors) say(`error ${d.file ?? '<project>'}(${d.line},${d.column}): ${d.code}: ${d.message}`);
    say(
      `unit-check ${unit.id}: tsc ${tsc.errors.length} error(s), ${tsc.warnings.length} warning(s) outside the owned paths`,
    );
  }

  // 2. lint + format, on the owned paths that exist
  const biomePaths = [...new Set(unit.ownedPaths.flatMap((pattern) => existingPaths(root, pattern)))].sort();
  const biome: UnitCheckResult['biome'] = { ran: false, ok: true, paths: biomePaths };
  if (biomePaths.length === 0) {
    say(`unit-check ${unit.id}: biome skipped (no owned path exists yet)`);
  } else {
    biome.ran = true;
    const done = run(TOOLS.biome, ['check', '--no-errors-on-unmatched', ...biomePaths]);
    // Biome can abort a worker thread (stack overflow in a type-aware rule) and still exit 0:
    // the files it never reached would silently pass. A crash is a failed check, not a green one.
    const crashed = /overflowed its stack|fatal runtime error/i.test(`${done.stdout}${done.stderr}`);
    biome.ok = done.status === 0 && !crashed;
    if (!biome.ok) say(`${done.stdout}${done.stderr}`.trimEnd());
    if (crashed) say(`unit-check ${unit.id}: biome CRASHED (exit ${done.status}); its report cannot be trusted`);
    say(`unit-check ${unit.id}: biome ${biome.ok ? 'ok' : 'FAILED'} (${biomePaths.length} path(s))`);
  }

  // 3. layering
  const layers: UnitCheckResult['layers'] = { ran: false, errors: [], warnings: [] };
  if (!existsSync(join(root, LAYERS_FILE))) {
    say(`unit-check ${unit.id}: layers skipped (no ${LAYERS_FILE} in ${root})`);
  } else {
    layers.ran = true;
    const { violations } = checkLayers({ root, layers: loadLayers(join(root, LAYERS_FILE)) });
    for (const violation of violations) (owned(violation.file) ? layers.errors : layers.warnings).push(violation);
    const located = (v: Violation) => `${v.file}:${v.line} [${v.rule}] ${v.message}`;
    for (const v of layers.warnings) say(`warning (not owned by ${unit.id}) ${located(v)}`);
    for (const v of layers.errors) say(`error ${located(v)}`);
    say(
      `unit-check ${unit.id}: layers ${layers.errors.length} violation(s), ${layers.warnings.length} warning(s) outside the owned paths`,
    );
  }

  // 4. tests
  const cacheDir = join(root, '.build', '.vitest', unit.id);
  const vitest: UnitCheckResult['vitest'] = {
    ran: false,
    ok: false,
    cacheDir,
    status: null,
    emptyPaths: [],
    uncollected: { errors: [], warnings: [] },
  };
  const testPaths = unit.testPaths ?? [];
  if (testPaths.length === 0) {
    say(`unit-check ${unit.id}: vitest FAILED (the unit declares no testPaths, so no test file can match)`);
  } else {
    vitest.ran = true;
    mkdirSync(cacheDir, { recursive: true });
    const env = { ...process.env, COHORTE_VITEST_CACHE_DIR: cacheDir };

    // `vitest run a b` is green as soon as ONE filter selects a file: a test directory that was never
    // written hides behind its neighbour, or behind a Wave-0 canary under a broad path. `vitest list`
    // applies the same include / exclude / filter logic as `vitest run` and executes nothing.
    const collected = new Set<string>();
    let listed = true;
    // The opt-in live suite deliberately lives outside the default Vitest projects. Its unit
    // check still needs to prove collection, so use the dedicated config for that path.
    const vitestConfig = testPaths.some((path) => path === 'tests/live' || path.startsWith('tests/live/'))
      ? ['--config', 'vitest.live.config.ts']
      : [];
    for (const testPath of testPaths) {
      // The filter goes first: `--json <next argument>` would take it for an output file.
      const done = run(TOOLS.vitest, ['list', ...vitestConfig, testPath, '--filesOnly', '--json'], env);
      const files = done.status === 0 ? parseListedFiles(done.stdout) : null;
      if (files === null) {
        listed = false;
        say(`${done.stdout}${done.stderr}`.trimEnd());
        say(`error \`vitest list ${testPath}\` failed (exit ${done.status})`);
      } else if (files.length === 0) {
        vitest.emptyPaths.push(testPath);
        say(`error test path \`${testPath}\` selects no test file (it is one of the unit's testPaths in ${planPath})`);
      }
      for (const file of files ?? []) collected.add(toPosix(relative(root, file)));
    }

    // A file with a test suffix in a place no project collects never runs, whatever it asserts.
    for (const file of listed ? testLookingFiles(root, testPaths) : []) {
      if (collected.has(file)) continue;
      const isOwned = owned(file);
      if (isOwned && REPOSITORY_TEST_FILE.test(file)) {
        vitest.uncollected.errors.push(file);
        say(`error ${file}: no vitest project collects this file, so it never runs (${COLLECTED_WHERE})`);
      } else {
        vitest.uncollected.warnings.push(file);
        say(
          `warning${isOwned ? '' : ` (not owned by ${unit.id})`} ${file}: looks like a test, but no vitest project collects it (${COLLECTED_WHERE})`,
        );
      }
    }

    // No --passWithNoTests: vitest exits 1 on "No test files found", which is the behaviour we want.
    const done = run(TOOLS.vitest, ['run', ...vitestConfig, '--maxWorkers=2', ...testPaths], env);
    vitest.status = done.status;
    if (done.status !== 0) say(`${done.stdout}${done.stderr}`.trimEnd());
    vitest.ok = done.status === 0 && listed && vitest.emptyPaths.length === 0 && vitest.uncollected.errors.length === 0;
    say(
      `unit-check ${unit.id}: vitest ${vitest.ok ? 'ok' : 'FAILED'} (${testPaths.join(' ')}): run exit ${done.status}, ${vitest.emptyPaths.length} empty test path(s), ${vitest.uncollected.errors.length} uncollected test file(s)`,
    );
  }

  const ok = tsc.errors.length === 0 && biome.ok && layers.errors.length === 0 && vitest.ok;
  say(`unit-check ${unit.id}: ${ok ? 'GREEN' : 'RED'}`);
  return { ok, tsc, biome, layers, vitest };
}

function readPlan(root: string, planPath: string): Plan {
  try {
    return loadPlan(root, planPath);
  } catch (error) {
    if (error instanceof PlanFileError) throw new UsageError(error.message);
    throw error;
  }
}

/** The output of `vitest list --filesOnly --json`: absolute paths. `null` when it is not what vitest prints. */
function parseListedFiles(stdout: string): string[] | null {
  try {
    const listed: unknown = JSON.parse(stdout);
    if (!Array.isArray(listed)) return null;
    return listed.flatMap((entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'file' in entry && typeof entry.file === 'string'
        ? [entry.file]
        : [],
    );
  } catch {
    return null;
  }
}

/** The repository's own test suffixes (PLAN §3 rule 9). `*.live.ts` is absent: only vitest.live.config.ts collects it. */
const REPOSITORY_TEST_FILE = /\.(?:test|itest|e2e)\.ts$/;
/** Anything a reader would take for a test. Beyond the three suffixes above it may be fixture data: it only warns. */
const TEST_LOOKING_FILE = /\.(?:test|itest|e2e|spec)\.[cm]?[jt]sx?$/;
const COLLECTED_WHERE =
  'vitest.config.ts collects *.test.ts under {packages,apps}/*/{src,test} and scripts/test, *.itest.ts under {packages,apps}/*/test and tests/integration, *.e2e.ts under tests/<suite>';
/** The exclusions of vitest.config.ts: two directory names at any depth, three directories at the root. */
const EXCLUDED_ANYWHERE = new Set(['node_modules', 'dist']);
const EXCLUDED_AT_ROOT = new Set(['legacy', '.cohorte', '.build']);

/** A sibling unit may remove a directory between the stat and the listing. */
function namesIn(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Test-looking files below the test paths that are directories or files; a file-name prefix names nothing to walk. */
function testLookingFiles(root: string, testPaths: readonly string[]): string[] {
  const found = new Set<string>();
  const visit = (path: string) => {
    const stats = statSync(join(root, path), { throwIfNoEntry: false });
    if (stats?.isFile() && TEST_LOOKING_FILE.test(path)) found.add(path);
    if (!stats?.isDirectory()) return;
    for (const name of namesIn(join(root, path))) {
      const child = posix.join(path, name);
      if (!EXCLUDED_ANYWHERE.has(name) && !EXCLUDED_AT_ROOT.has(child)) visit(child);
    }
  };
  for (const testPath of testPaths) visit(posix.normalize(toPosix(testPath)));
  return [...found].sort();
}

/** Biome takes files and directories, not globs: `dir/**` becomes `dir`, any other pattern is expanded. */
function existingPaths(root: string, pattern: string): string[] {
  const plain = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  if (!/[*?]/.test(plain)) return existsSync(join(root, plain)) ? [plain] : [];
  return globSync(plain, { cwd: root }).map(toPosix);
}

// ── self-test ──────────────────────────────────────────────────────────────────────────────────

export const SELF_TEST_UNIT = 'U9.99';

/** A two-package tree: `owned` belongs to the unit and imports `foreign`, which does not. */
export function selfTestTree(toolRoot: string = TOOL_ROOT): Record<string, string> {
  const unit: PlanUnit = {
    id: SELF_TEST_UNIT,
    ownedPaths: ['packages/owned/src/**', 'packages/owned/test/**'],
    testPaths: ['packages/owned/test'],
  };
  return {
    'package.json': `${JSON.stringify({ name: 'unit-check-self-test', private: true, type: 'module' }, null, 2)}\n`,
    [PLAN_PATH]: `${JSON.stringify({ waves: [{ units: [unit] }] }, null, 2)}\n`,
    // The REAL base config, vitest config and layering rules: the self-test proves the shipped configuration.
    'tsconfig.base.json': readFileSync(join(toolRoot, 'tsconfig.base.json'), 'utf8'),
    'vitest.config.ts': readFileSync(join(toolRoot, 'vitest.config.ts'), 'utf8'),
    [LAYERS_FILE]: readFileSync(join(toolRoot, LAYERS_FILE), 'utf8'),
    'biome.json': `${JSON.stringify({ linter: { enabled: true }, formatter: { enabled: true, indentStyle: 'space' }, javascript: { formatter: { quoteStyle: 'single' } } }, null, 2)}\n`,
    'packages/foreign/src/index.ts': 'export const foreign: number = 1;\n',
    'packages/owned/src/index.ts':
      "import { foreign } from '../../foreign/src/index.ts';\n\nexport const owned: number = foreign + 1;\n",
    'packages/owned/test/owned.test.ts':
      "import { expect, test } from 'vitest';\nimport { owned } from '../src/index.ts';\n\ntest('owned', () => {\n  expect(owned).toBe(2);\n});\n",
  };
}

interface Scenario {
  name: string;
  files: Record<string, string>;
  testPaths?: string[];
  expect: (result: UnitCheckResult) => string | null;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a clean unit is green',
    files: {},
    expect: (r) =>
      r.ok && r.tsc.errors.length === 0 && r.tsc.warnings.length === 0 && r.layers.ran && r.layers.errors.length === 0
        ? null
        : 'expected GREEN without diagnostics',
  },
  {
    name: 'a type error in a NON-owned file is a warning',
    files: {
      'packages/foreign/src/index.ts':
        'export const foreign: number = 1;\nexport const halfWritten: string = 2; // a sibling is mid-edit\n',
    },
    expect: (r) =>
      r.ok && r.tsc.warnings.length === 1 && r.tsc.errors.length === 0
        ? null
        : 'expected GREEN with exactly one warning',
  },
  {
    name: 'a type error in an owned file is a failure',
    files: { 'packages/owned/src/extra.ts': "export const wrong: number = 'owned';\n" },
    expect: (r) => (!r.ok && r.tsc.errors.length === 1 ? null : 'expected RED with exactly one error'),
  },
  {
    name: 'a layering violation in an owned file is a failure',
    // Rule f: only the redactor mints Sealed<T>. The file typechecks and lints, so the layering step alone is red.
    files: {
      'packages/owned/src/mint.ts':
        'type SealedText = string & { readonly sealed: true };\n\nexport const mint = (text: string): SealedText => text as SealedText;\n',
    },
    expect: (r) =>
      !r.ok && r.layers.errors.length === 1 && r.tsc.errors.length === 0 && r.biome.ok && r.vitest.ok
        ? null
        : 'expected RED from the layering step alone',
  },
  {
    name: 'zero matched test files is a failure',
    files: {},
    testPaths: ['packages/owned/test/nothing-here'],
    expect: (r) =>
      !r.ok && r.tsc.errors.length === 0 && r.vitest.ran && !r.vitest.ok ? null : 'expected RED from vitest alone',
  },
  {
    name: 'one of two testPaths matches nothing is a failure',
    files: {},
    testPaths: ['packages/owned/test', 'packages/owned/test/never-written'],
    expect: (r) =>
      !r.ok && r.vitest.status === 0 && r.vitest.emptyPaths.join() === 'packages/owned/test/never-written'
        ? null
        : 'expected RED from the empty test path alone, the tests of the other path having passed',
  },
  {
    name: 'an owned test file that no project collects is a failure',
    // The e2e project collects tests/<suite>/** only: under a package this file never runs.
    files: {
      'packages/owned/test/misplaced.e2e.ts':
        "import { expect, test } from 'vitest';\n\ntest('never runs', () => {\n  expect(1).toBe(2);\n});\n",
    },
    expect: (r) =>
      !r.ok && r.vitest.status === 0 && r.vitest.uncollected.errors.join() === 'packages/owned/test/misplaced.e2e.ts'
        ? null
        : 'expected RED from the uncollected file alone',
  },
];

export async function selfTest(out: { write(text: string): unknown } = process.stdout): Promise<boolean> {
  let green = true;
  for (const scenario of SCENARIOS) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-unit-check-')));
    try {
      const files = { ...selfTestTree(), ...scenario.files };
      if (scenario.testPaths) {
        const plan = JSON.parse(files[PLAN_PATH] ?? '{}');
        plan.waves[0].units[0].testPaths = scenario.testPaths;
        files[PLAN_PATH] = JSON.stringify(plan);
      }
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      symlinkSync(join(TOOL_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
      generateUnitChecks({ root });
      const result = await runUnitCheck({ root, unitId: SELF_TEST_UNIT, out: { write: () => {} } });
      const problem = scenario.expect(result);
      out.write(
        `${problem === null ? 'ok  ' : 'FAIL'} ${scenario.name}${problem === null ? '' : ` — ${problem}: ${JSON.stringify(result)}`}\n`,
      );
      if (problem !== null) green = false;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  out.write(`unit-check --self-test: ${green ? 'OK' : 'FAILED'}\n`);
  return green;
}

// ── command line ───────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { root: { type: 'string' }, plan: { type: 'string' }, 'self-test': { type: 'boolean', default: false } },
  });
  if (values['self-test']) return (await selfTest()) ? 0 : 1;
  const [unitId] = positionals;
  if (unitId === undefined || positionals.length !== 1) {
    process.stderr.write('usage: node scripts/unit-check.ts <unitId> [--root <dir>] [--plan <file>] | --self-test\n');
    return 2;
  }
  const root = values.root === undefined ? TOOL_ROOT : isAbsolute(values.root) ? values.root : resolve(values.root);
  try {
    const result = await runUnitCheck({ root, unitId, ...(values.plan ? { planPath: values.plan } : {}) });
    return result.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`unit-check: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
