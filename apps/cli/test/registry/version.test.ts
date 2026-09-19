// apps/cli/test/registry/version.test.ts — the version the CLI prints and the version the tarball carries are the
// same string. `COHORTE_VERSION` is a literal (so `--version` reads no file on the one-shot start-up path) and
// `stage-publish.ts` copies `apps/cli/package.json`'s "version" into the published package.json: without this test
// a bump to one side leaves `cohorte --version` printing the other.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROLLER_EXIT_CODES } from '@cohorte/protocol';
import { describe, expect, test } from 'vitest';
import { COHORTE_VERSION, runCli } from '../../src/cli.ts';
import { testDeps } from './helpers.ts';

const PACKAGE_JSON_PATH = join(import.meta.dirname, '../../package.json');

function packageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const version = (pkg as { version?: unknown }).version;
  if (typeof version !== 'string') throw new TypeError('apps/cli/package.json has no string "version"');
  return version;
}

describe('version', () => {
  test('COHORTE_VERSION is apps/cli/package.json "version"', () => {
    expect(COHORTE_VERSION).toBe(packageVersion());
  });

  test('--version prints it and exits 0', async () => {
    const deps = testDeps();
    const code = await runCli(['--version'], deps);
    expect(code).toBe(CONTROLLER_EXIT_CODES.completed);
    expect(deps.out.text().trim()).toBe(packageVersion());
  });
});
