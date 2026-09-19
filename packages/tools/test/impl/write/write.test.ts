import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { NormalizedCall } from '../../../src/catalogue/types.ts';
import { WRITE_TOOLS } from '../../../src/impl/write/index.ts';

const roots: string[] = [];

const normalized = (canonical: string, relative: string): NormalizedCall =>
  ({
    tool: 'write_file',
    paths: [{ arg: relative, resolved: { canonical, relative }, intent: 'write' }],
    input: {},
  }) as NormalizedCall;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('write tools', () => {
  test('writes a new file and reports its digest metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-write-'));
    roots.push(root);
    const target = join(root, 'note.txt');

    const result = await WRITE_TOOLS.write_file.execute(
      { path: 'note.txt', content: 'hello' },
      normalized(target, 'note.txt'),
      {} as never,
      new AbortController().signal,
    );

    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(result.filesTouched[0]).toMatchObject({ path: 'note.txt', op: 'create', bytes: 5 });
    expect(result.output).toMatchObject({ path: 'note.txt', bytes: 5 });
  });

  test('patches exactly one occurrence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cohorte-patch-'));
    roots.push(root);
    const target = join(root, 'note.txt');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(target, 'before');

    await WRITE_TOOLS.patch_file.execute(
      { path: 'note.txt', edits: [{ oldText: 'before', newText: 'after' }] },
      normalized(target, 'note.txt'),
      {} as never,
      new AbortController().signal,
    );

    expect(await readFile(target, 'utf8')).toBe('after');
  });
});
