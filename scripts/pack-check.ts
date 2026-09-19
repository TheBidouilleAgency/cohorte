#!/usr/bin/env node
//
// scripts/pack-check.ts — DESIGN 1.4: pack `<dir>/.publish`, `npm install --ignore-scripts` the tarball into an
// EMPTY temp directory (the real acceptance test — F-4: this step needs the network, unlike `build.ts`'s linked
// self-run), run the INSTALLED `cohorte` bin and `agent-host.mjs`, and check the tarball allowlist (the
// `node_modules` symlink is never packed), no test-hook strings (DESIGN 1.3), and that `cli.mjs` imports no
// `@earendil-works/*` (DESIGN 1.2 net 4).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT_CODE_BY_CLASS } from '@cohorte/base';

/** DESIGN 1.3: the shipped `agent-host.mjs` must contain no test hook (a packaging test greps both bundles). */
export const FORBIDDEN_TEST_HOOK_STRINGS = ['faux', 'registerNativeProvider', 'InMemoryCredentialStore'] as const;
const ALLOWED_TOP_LEVEL_PACKED_PATHS = new Set(['dist', 'assets', 'package.json', 'LICENSE', 'README.md']);
/** DESIGN 2.8: the `configuration` class exits 10 — where every unbuilt Wave-0 path lands. */
const CONFIGURATION_EXIT_CODE = EXIT_CODE_BY_CLASS.configuration;

export interface PackCheckResult {
  readonly tarballPath: string;
  readonly packedTopLevelPaths: readonly string[];
  readonly installDir: string;
  /** Printed by the INSTALLED `cohorte` bin (`node_modules/.bin/cohorte`), which is a symlink: the plan says
   * literally "run `cohorte --version`", and running `dist/cli.mjs` directly cannot catch a main-module guard
   * that is false through a symlink (the shipped CLI would then print nothing and exit 0). */
  readonly cliVersionOutput: string;
  readonly cliBinPath: string;
  readonly agentHostSelftestOutput: string;
  /** `cohorte <verb>` through the installed bin: proves the verb modules are really in the bundle. */
  readonly verbProbe: { readonly argv: readonly string[]; readonly status: number | null; readonly stderr: string };
}

interface NpmPackEntry {
  readonly filename: string;
  readonly files: readonly { path: string }[];
}

function readAllText(dir: string): string {
  let text = '';
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const abs = join(current, name);
      if (statSync(abs).isDirectory()) visit(abs);
      else text += readFileSync(abs, 'utf8');
    }
  };
  visit(dir);
  return text;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const done = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

export async function packCheck(outDirArg: string): Promise<PackCheckResult> {
  const outDir = resolve(outDirArg);
  const publishDir = join(outDir, '.publish');
  if (!existsSync(publishDir)) {
    throw new Error(`pack-check: ${publishDir} does not exist; run \`node scripts/build.ts --out ${outDir}\` first`);
  }

  const packed = run('npm', ['pack', '--json'], publishDir);
  if (packed.status !== 0) throw new Error(`pack-check: npm pack failed: ${packed.stderr}`);
  const entries = JSON.parse(packed.stdout) as NpmPackEntry[];
  const entry = entries[0];
  if (!entry) throw new Error('pack-check: npm pack produced no entry');
  const tarballPath = join(publishDir, entry.filename);

  const packedTopLevelPaths = [...new Set(entry.files.map((file) => file.path.split('/')[0] ?? ''))].sort();
  for (const top of packedTopLevelPaths) {
    if (!ALLOWED_TOP_LEVEL_PACKED_PATHS.has(top)) {
      throw new Error(`pack-check: unexpected top-level packed path "${top}" (node_modules must never be packed)`);
    }
  }

  const distText = readAllText(join(publishDir, 'dist'));
  for (const needle of FORBIDDEN_TEST_HOOK_STRINGS) {
    if (distText.includes(needle)) throw new Error(`pack-check: forbidden test-hook string "${needle}" found in dist/`);
  }
  const cliSource = readFileSync(join(publishDir, 'dist/cli.mjs'), 'utf8');
  if (cliSource.includes('@earendil-works/')) {
    throw new Error('pack-check: dist/cli.mjs imports @earendil-works/* (DESIGN 1.2 net 4 violation)');
  }

  const installDir = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-pack-check-')));
  try {
    const install = run('npm', ['install', '--ignore-scripts', tarballPath], installDir);
    if (install.status !== 0) throw new Error(`pack-check: npm install failed: ${install.stderr}`);

    // The INSTALLED bin, not `dist/cli.mjs`: DESIGN 1.4 / PLAN U0.10 say "run `cohorte --version`", and `bin` is
    // the only user-facing entry point of the package. npm links it as a symlink, which is exactly the shape a
    // hand-rolled `import.meta.url === file://argv[1]` main-module guard gets wrong (silent exit 0).
    const cliBinPath = join(installDir, 'node_modules/.bin/cohorte');
    if (!existsSync(cliBinPath)) throw new Error(`pack-check: the installed package has no bin at ${cliBinPath}`);
    const agentHostEntry = join(installDir, 'node_modules/cohorte/dist/agent-host.mjs');
    const version = run(cliBinPath, ['--version'], installDir);
    if (version.status !== 0) throw new Error(`pack-check: cohorte --version failed: ${version.stderr}`);
    const cliVersionOutput = version.stdout.trim();
    if (!cliVersionOutput) {
      throw new Error('pack-check: cohorte --version printed nothing (a main-module guard that a symlink defeats?)');
    }
    const selftest = run(agentHostEntry, ['--selftest'], installDir);
    if (selftest.status !== 0) throw new Error(`pack-check: agent-host --selftest failed: ${selftest.stderr}`);

    // A verb through the installed bin. It must reach a CLASSIFIED `configuration` failure (exit 10), never
    // `Cannot find module …/dist/commands/<verb>/index.ts` — which is what a runtime-computed `import()` specifier
    // produces, because no bundler can resolve one and no verb chunk is emitted. That failure used to be invisible:
    // `cli.ts` converted it into the same exit code and message the verb stubs are meant to produce.
    const verb = run(cliBinPath, ['status'], installDir);
    if (verb.stderr.includes('Cannot find module') || verb.stderr.includes('ERR_MODULE_NOT_FOUND')) {
      throw new Error(`pack-check: \`cohorte status\` could not load its command module: ${verb.stderr.trim()}`);
    }
    if (verb.status !== CONFIGURATION_EXIT_CODE) {
      throw new Error(
        `pack-check: \`cohorte status\` exited ${verb.status}, expected ${CONFIGURATION_EXIT_CODE} ` +
          `(the configuration class of DESIGN 2.8): ${verb.stderr.trim()}`,
      );
    }

    return {
      tarballPath,
      packedTopLevelPaths,
      installDir,
      cliVersionOutput,
      cliBinPath,
      agentHostSelftestOutput: selftest.stdout.trim(),
      verbProbe: { argv: ['status'], status: verb.status, stderr: verb.stderr },
    };
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outDir = args.find((arg) => !arg.startsWith('--'));
  if (!outDir) {
    process.stderr.write('usage: pack-check.ts <out-dir> [--json]\n');
    process.exitCode = 2;
    return;
  }
  const result = await packCheck(outDir);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`pack-check: ${result.cliVersionOutput}\n`);
  process.stdout.write(`pack-check: ${result.agentHostSelftestOutput}\n`);
  process.stdout.write(`pack-check: cohorte status -> exit ${result.verbProbe.status} (verb modules are bundled)\n`);
  process.stdout.write(`pack-check: OK (${result.tarballPath})\n`);
}

// `import.meta.main` (node >= 24.2), not a hand-rolled `import.meta.url === `file://${argv[1]}``: the latter is
// false whenever the file is reached through a symlink (how npm installs a `bin`) and breaks on any path
// carrying a space or a non-ASCII character (`import.meta.url` is percent-encoded, `argv[1]` is not).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `pack-check failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
