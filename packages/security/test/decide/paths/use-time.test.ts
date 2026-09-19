// DESIGN 2.6.3 step 8: use-time re-verification, inside the per-slot effect mutex. S-06 (symlink swapped between
// gate and use) lives here: it is a property of `openVerified`, not of `resolve()`.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { CanonicalPath } from '../../../src/contract/index.ts';
import { openVerified, writeAtomicVerified } from '../../../src/decide/paths/index.ts';
import { resolverFor, siblingDir } from './helpers.ts';

describe('openVerified', () => {
  test('opens the file the gate resolved, when nothing has changed', async ({ tempDir }) => {
    writeFileSync(join(tempDir, 'a.txt'), 'hello');
    const gate = resolverFor(tempDir).resolve('a.txt', tempDir as CanonicalPath, 'read');
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    const opened = openVerified(gate.value.canonical, gate.value.identity, 'read');
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      const buffer = Buffer.alloc(5);
      readSync(opened.value, buffer, 0, 5, 0);
      expect(buffer.toString('utf8')).toBe('hello');
      closeSync(opened.value);
    }
  });

  test('S-06: a symlink swapped in between the gate decision and use is refused, not silently opened', async ({
    tempDir,
  }) => {
    writeFileSync(join(tempDir, 'real.txt'), 'trusted content');
    const gate = resolverFor(tempDir).resolve('real.txt', tempDir as CanonicalPath, 'read');
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    const identityAtGateTime = gate.value.identity;

    // Between the gate decision and use, an attacker (or a race with another agent) removes the real file and
    // plants a symlink of the SAME name pointing elsewhere.
    const outside = siblingDir(tempDir);
    writeFileSync(join(outside, 'swapped.txt'), 'attacker content');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(tempDir, 'real.txt'));
    symlinkSync(join(outside, 'swapped.txt'), join(tempDir, 'real.txt'));

    const opened = openVerified(gate.value.canonical, identityAtGateTime, 'read');
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe('symlink-escape');
      expect(opened.error.security).toBe(true);
    }
  });

  test('an identity swap onto a DIFFERENT regular file (no symlink involved) is also caught', async ({ tempDir }) => {
    writeFileSync(join(tempDir, 'a.txt'), 'first');
    writeFileSync(join(tempDir, 'replacement.txt'), 'second');
    const gate = resolverFor(tempDir).resolve('a.txt', tempDir as CanonicalPath, 'read');
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(tempDir, 'a.txt'));
    renameSync(join(tempDir, 'replacement.txt'), join(tempDir, 'a.txt')); // a distinct inode under the same name
    const opened = openVerified(gate.value.canonical, gate.value.identity, 'read');
    expect(opened.ok).toBe(false);
  });

  test('without a captured identity (the path did not exist at gate time), any existing file opens', async ({
    tempDir,
  }) => {
    const gate = resolverFor(tempDir).resolve('new.txt', tempDir as CanonicalPath, 'create');
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.value.identity).toBeUndefined();
    writeFileSync(gate.value.canonical, 'created after the gate ran');
    const opened = openVerified(gate.value.canonical, gate.value.identity, 'read');
    expect(opened.ok).toBe(true);
    if (opened.ok) closeSync(opened.value);
  });

  test('O_NOFOLLOW refuses a final component that is itself a symlink, as a SECURITY violation', async ({
    tempDir,
  }) => {
    writeFileSync(join(tempDir, 'real.txt'), 'x');
    symlinkSync(join(tempDir, 'real.txt'), join(tempDir, 'link.txt'));
    const opened = openVerified(join(tempDir, 'link.txt') as CanonicalPath, undefined, 'read');
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe('symlink-escape');
      expect(opened.error.security).toBe(true);
    }
  });

  // `security: true` sends the whole run to BLOCKED (DESIGN 2.6.1 `PolicyVerdict.securityViolation`, spec 24).
  // An ordinary "the file a tool is about to create is not there yet" must never do that: only the errno codes
  // a planted symlink actually produces are a security event (fix round 2).
  test.for<[label: string, makePath: (dir: string) => string, intent: 'read' | 'write']>([
    ['a missing file on the write intent (ENOENT)', (dir) => join(dir, 'not-there.txt'), 'write'],
    ['a missing file on the read intent (ENOENT)', (dir) => join(dir, 'not-there.txt'), 'read'],
    ['a path whose parent is a regular file (ENOTDIR)', (dir) => join(dir, 'plain.txt', 'child.txt'), 'read'],
    ['a directory opened for writing (EISDIR)', (dir) => join(dir, 'a-dir'), 'write'],
  ])('%s is refused but is NOT a security violation', ([, makePath, intent], { tempDir }) => {
    writeFileSync(join(tempDir, 'plain.txt'), 'x');
    mkdirSync(join(tempDir, 'a-dir'), { recursive: true });
    const opened = openVerified(makePath(tempDir) as CanonicalPath, undefined, intent);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.security).toBe(false);
  });
});

describe('writeAtomicVerified', () => {
  test('writes the full content atomically and it is readable afterwards', async ({ tempDir }) => {
    const target = join(tempDir, 'out.txt') as CanonicalPath;
    const result = writeAtomicVerified(target, 'hello atomic world');
    expect(result.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello atomic world');
  });

  test('leaves no temp file behind on success', async ({ tempDir }) => {
    const { readdirSync } = await import('node:fs');
    const target = join(tempDir, 'out.txt') as CanonicalPath;
    writeAtomicVerified(target, 'x');
    const entries = readdirSync(tempDir);
    expect(entries).toEqual(['out.txt']);
  });

  test('overwrites an existing file in place, atomically, and keeps its permission bits', async ({ tempDir }) => {
    const target = join(tempDir, 'out.txt') as CanonicalPath;
    writeFileSync(target, 'old', { mode: 0o644 });
    chmodSync(target, 0o644); // umask does not apply to an explicit chmod
    const before = statSync(target).mode & 0o7777;
    const result = writeAtomicVerified(target, 'new');
    expect(result.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new');
    // The rename replaces the inode, so without carrying the mode over a 0644 source file would silently
    // become the temp file's 0600 on every write — gratuitous mode churn in the agent's own worktree.
    expect(statSync(target).mode & 0o7777).toBe(before);
  });

  test('a file that did not exist is created 0600, not with the process umask', async ({ tempDir }) => {
    const target = join(tempDir, 'fresh.txt') as CanonicalPath;
    expect(writeAtomicVerified(target, 'x').ok).toBe(true);
    expect(statSync(target).mode & 0o7777).toBe(0o600);
  });

  test('an executable script keeps its executable bit across an atomic overwrite', async ({ tempDir }) => {
    const target = join(tempDir, 'run.sh') as CanonicalPath;
    writeFileSync(target, '#!/bin/sh\necho old\n');
    chmodSync(target, 0o755);
    expect(writeAtomicVerified(target, '#!/bin/sh\necho new\n').ok).toBe(true);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
  });

  test('refuses to write when the directory was replaced by a symlink after resolution', async ({ tempDir }) => {
    const realDir = join(tempDir, 'real-dir');
    mkdirSync(realDir);
    const target = join(realDir, 'out.txt') as CanonicalPath;
    // Simulate the swap a resolver would have rejected at gate time by writing straight through the low-level
    // primitive against a directory that is, by the time it runs, a symlink rather than the real directory.
    const { rmSync } = await import('node:fs');
    rmSync(realDir, { recursive: true });
    const outside = siblingDir(tempDir);
    symlinkSync(outside, realDir);
    const result = writeAtomicVerified(target, 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('symlink-escape');
  });

  test('a write into a directory that does not exist fails without claiming a security violation', async ({
    tempDir,
  }) => {
    const result = writeAtomicVerified(join(tempDir, 'no-such-dir', 'out.txt') as CanonicalPath, 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.security).toBe(false);
  });

  test('accepts bytes as well as strings', async ({ tempDir }) => {
    const target = join(tempDir, 'out.bin') as CanonicalPath;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = writeAtomicVerified(target, bytes);
    expect(result.ok).toBe(true);
    const { readFileSync: read } = await import('node:fs');
    expect(new Uint8Array(read(target))).toEqual(bytes);
  });
});
