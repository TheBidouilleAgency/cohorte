import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { writeConfig } from '../../src/write/index.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('config writing', () => {
  test('edits and deletes JSON-pointer keys while retaining comments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-config-write-'));
    roots.push(root);
    const file = join(root, 'config.yaml');
    await writeFile(file, '# keep this comment\npolicy:\n  mode: strict\n  obsolete: true\n');

    await writeConfig(file, [
      { pointer: '/policy/mode', value: 'ask' },
      { pointer: '/policy/obsolete', value: undefined },
    ]);

    const text = await readFile(file, 'utf8');
    expect(text).toContain('# keep this comment');
    expect(text).toContain('mode: ask');
    expect(text).not.toContain('obsolete');
  });
});
