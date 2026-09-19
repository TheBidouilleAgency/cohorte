import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CohorteError } from '@cohorte/base';
import { RuntimePin } from '@cohorte/runtime-contract';
import { Compile } from 'typebox/compile';
import { test as base, describe, expect } from 'vitest';
import { pin } from '../../src/pin/index.ts';
import { createPinVerifier, ENGINE_PACKAGES, pinWithDiagnostics } from '../../src/pin/pin.ts';

interface Install {
  root: string;
  installDir: string;
  file(relative: string, text: string): string;
}

function writeEngine(nodeModules: string, version = '0.85.1'): void {
  for (const name of ENGINE_PACKAGES) {
    const dir = join(nodeModules, name);
    mkdirSync(join(dir, 'dist', 'core'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
    writeFileSync(join(dir, 'dist', 'index.js'), `export const name = ${JSON.stringify(name)};\n`);
    writeFileSync(join(dir, 'dist', 'core', 'deep.js'), 'export const deep = true;\n');
  }
}

const test = base.extend<{ install: Install }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest reads the fixture's dependencies from this pattern
  install: async ({}, use) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-pin-')));
    const installDir = join(root, 'install');
    const file = (relative: string, text: string): string => {
      const path = join(installDir, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
      return path;
    };
    file('dist/cli.mjs', 'console.log("cli");\n');
    file('dist/agent-host.mjs', 'console.log("guardFetch");\n');
    file('dist/chunks/shared.mjs', 'export const shared = 1;\n');
    writeEngine(join(installDir, 'node_modules'));
    file('node_modules/.package-lock.json', '{"lockfileVersion":3}\n');
    await use({ root, installDir, file });
    rmSync(root, { recursive: true, force: true });
  },
});

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  return thrown instanceof CohorteError ? thrown.info.code : `not a CohorteError: ${String(thrown)}`;
};

describe('pin() (DESIGN 3.9)', () => {
  test('hashes the dist tree, the three engine package trees, the lock evidence and names node', async ({
    install,
  }) => {
    const value = await pin({ installDir: install.installDir, loadFrom: 'package' });
    expect(Compile(RuntimePin).Check(value)).toBe(true);
    expect(value.artifacts.map((artifact) => artifact.role)).toEqual([
      'agent-host-bundle',
      'engine-package-tree',
      'engine-package-tree',
      'engine-package-tree',
      'install-lock',
    ]);
    expect(value.artifacts[0]).toMatchObject({ path: join(install.installDir, 'dist'), files: 3 });
    expect(value.artifacts[1]).toMatchObject({ files: 3 });
    expect(value.engine).toEqual({ name: 'pi', version: '0.85.1' });
    expect(value.node).toEqual({ version: process.version, execPath: process.execPath });
    const again = await pin({ installDir: install.installDir, loadFrom: 'package' });
    expect(again.digest).toBe(value.digest);
  });

  test('engine packages at different versions are refused', async ({ install }) => {
    install.file(
      `node_modules/${ENGINE_PACKAGES[1]}/package.json`,
      JSON.stringify({ name: ENGINE_PACKAGES[1], version: '0.85.0' }),
    );
    expect(await codeOf(pin({ installDir: install.installDir, loadFrom: 'package' }))).toBe(
      'configuration/engine-init',
    );
  });

  test('a linked development build has no lock evidence of its own: the artifact is skipped and the diagnostics say so', async ({
    install,
  }) => {
    const linked = join(install.root, 'gate', '.publish');
    mkdirSync(join(linked, 'dist'), { recursive: true });
    writeFileSync(join(linked, 'dist', 'agent-host.mjs'), 'console.log("guardFetch");\n');
    symlinkSync(join(install.installDir, 'node_modules'), join(linked, 'node_modules'));
    const { pin: value, diagnostics } = await pinWithDiagnostics({ installDir: linked, loadFrom: 'package' });
    expect(value.artifacts.map((artifact) => artifact.role)).not.toContain('install-lock');
    expect(value.artifacts.filter((artifact) => artifact.role === 'engine-package-tree')).toHaveLength(3);
    expect(diagnostics.installLock).toBe('absent (linked development build)');
  });

  test('an entry override (tests only) pins that one file and no engine', async ({ install }) => {
    const entry = install.file('fake/child.ts', 'process.exit(0);\n');
    const { pin: value } = await pinWithDiagnostics({
      installDir: install.installDir,
      loadFrom: 'package',
      entryOverride: entry,
    });
    expect(value.engine).toBeNull();
    expect(value.artifacts).toHaveLength(1);
    expect(value.artifacts[0]).toMatchObject({ role: 'agent-host-bundle', path: entry, files: 1 });
  });
});

describe('per-spawn verification', () => {
  test('a tampered dist file is security/runtime-pin-mismatch', async ({ install }) => {
    const options = { installDir: install.installDir, loadFrom: 'package' } as const;
    const verifier = createPinVerifier(options);
    const pinned = await pin(options);
    await verifier.verify(pinned);
    install.file('dist/agent-host.mjs', 'console.log("tampered");\n');
    expect(await codeOf(verifier.verify(pinned))).toBe('security/runtime-pin-mismatch');
  });

  test('a tampered engine file, an added file and a missing file are all mismatches', async ({ install }) => {
    const options = { installDir: install.installDir, loadFrom: 'package' } as const;
    const pinned = await pin(options);
    install.file(`node_modules/${ENGINE_PACKAGES[2]}/dist/core/deep.js`, 'export const deep = "evil";\n');
    expect(await codeOf(createPinVerifier(options).verify(pinned))).toBe('security/runtime-pin-mismatch');
    const repinned = await pin(options);
    install.file('dist/extra.mjs', '');
    expect(await codeOf(createPinVerifier(options).verify(repinned))).toBe('security/runtime-pin-mismatch');
    const third = await pin(options);
    rmSync(join(install.installDir, 'dist', 'extra.mjs'));
    expect(await codeOf(createPinVerifier(options).verify(third))).toBe('security/runtime-pin-mismatch');
  });

  test('the stat cache hashes nothing twice, and re-hashes exactly what changed', async ({ install }) => {
    const options = { installDir: install.installDir, loadFrom: 'package' } as const;
    const verifier = createPinVerifier(options);
    const pinned = await pin(options);
    await verifier.verify(pinned);
    const first = verifier.stats().hashed;
    expect(first).toBeGreaterThanOrEqual(13);
    await verifier.verify(pinned);
    expect(verifier.stats().hashed).toBe(first);

    // Same size, same content, another mtime: the key changed, so the file is read again and still matches.
    const target = join(install.installDir, 'dist', 'cli.mjs');
    utimesSync(target, new Date(1_000_000), new Date(1_000_000));
    await verifier.verify(pinned);
    expect(verifier.stats().hashed).toBe(first + 1);

    // Same size, another content: caught although the size did not move.
    install.file('dist/cli.mjs', 'console.log("clI");\n');
    expect(await codeOf(verifier.verify(pinned))).toBe('security/runtime-pin-mismatch');
  });

  test('another node binary is a mismatch', async ({ install }) => {
    const options = { installDir: install.installDir, loadFrom: 'package' } as const;
    const pinned = await pin(options);
    const other = { ...pinned, node: { ...pinned.node, execPath: '/somewhere/else/node' } };
    expect(await codeOf(createPinVerifier(options).verify(other))).toBe('security/runtime-pin-mismatch');
  });
});
