import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as testkit from '../../src/index.ts';

const SRC = join(import.meta.dirname, '..', '..', 'src');
const FOUNDATION_AREAS = ['fake-redactor', 'fault-injector', 'fixed-clock', 'git-env', 'seq-ids', 'temp-repo'];

describe('@cohorte/testkit barrel', () => {
  test('exports the foundation', () => {
    expect(Object.keys(testkit).sort()).toEqual(
      [
        'FaultInjector',
        'FixedClock',
        'GIT_ENV',
        'GIT_ENV_VARS',
        'InjectedFault',
        'SeqIds',
        'createTempRepo',
        'fakeRedactor',
        'gitEnv',
        'makeTempDir',
        'removeTempDir',
        'sealedJson',
        'sealedText',
        'test',
      ].sort(),
    );
  });

  // PLAN U0.02: a later area (fake-brain, store-factory, http-provider, crash, run-cli, golden) is reached through
  // its own subpath, so a half-written one can never break a sibling's test run.
  test('re-exports the foundation areas and nothing else', () => {
    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8');
    const reExported = [...barrel.matchAll(/from '\.\/([a-z-]+)\/index\.ts'/g)].map((match) => match[1]);
    expect([...reExported].sort()).toEqual(FOUNDATION_AREAS);
    expect(barrel).not.toMatch(/from '@cohorte\//);
  });

  test('every foundation area is reachable through its own subpath too', () => {
    const areas = readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const area of FOUNDATION_AREAS) {
      expect(areas).toContain(area);
      expect(readdirSync(join(SRC, area))).toContain('index.ts');
    }
  });

  test('only the fixture area loads vitest: clocks, ids and fakes stay importable from a plain Node child process', () => {
    for (const area of FOUNDATION_AREAS.filter((name) => name !== 'temp-repo')) {
      for (const file of readdirSync(join(SRC, area))) {
        expect(readFileSync(join(SRC, area, file), 'utf8'), `${area}/${file}`).not.toMatch(/from 'vitest'/);
      }
    }
  });
});
