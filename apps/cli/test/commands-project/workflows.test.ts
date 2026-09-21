import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import alignDs from '../../src/commands/align-ds/index.ts';
import fleet from '../../src/commands/fleet/index.ts';
import retro from '../../src/commands/retro/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('V2 workflow compatibility commands', () => {
  test('retro mines repeated findings and only writes after explicit ratification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-retro-'));
    try {
      await mkdir(join(cwd, 'specs', 'reports'), { recursive: true });
      await writeFile(join(cwd, 'specs', 'reports', 'a.verdict.json'), 'HIGH apps/api/auth.ts:10 add authorization\n');
      await writeFile(join(cwd, 'specs', 'reports', 'b.verdict.json'), 'HIGH apps/api/auth.ts:10 add authorization\n');
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(await retro.run(ctx, { positionals: [], options: {}, json: true })).toBe(0);
      expect(JSON.parse(out.text()).patterns).toHaveLength(1);
      expect(
        await retro.run(ctx, {
          positionals: ['--apply', '--rule', 'Every auth route must authorize before handling'],
          options: {},
          json: false,
        }),
      ).toBe(0);
      await expect(readFile(join(cwd, 'PIPELINE.md'), 'utf8')).resolves.toContain('Every auth route');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('align-ds is a no-op when the project has no design system', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-ds-'));
    try {
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(await alignDs.run(ctx, { positionals: [], options: {}, json: false })).toBe(0);
      expect(out.text()).toContain('disabled');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('fleet plan requires frozen specs and persists an explicit plan', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-fleet-'));
    try {
      await mkdir(join(cwd, 'specs'), { recursive: true });
      await writeFile(join(cwd, 'specs', 'one.md'), '---\nstatus: frozen\n---\n');
      await writeFile(join(cwd, 'specs', 'two.md'), '---\nstatus: frozen\n---\n');
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(
        await fleet.run(ctx, { subVerb: 'plan', positionals: ['one', 'two', '--apply'], options: {}, json: false }),
      ).toBe(0);
      await expect(readFile(join(cwd, 'specs', 'reports', 'fleet.json'), 'utf8')).resolves.toContain('one');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
