import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import diff from '../../src/commands/diff/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('diff command', () => {
  it('requires a run id', async () => {
    const result = await diff.run(fakeCliContext(), { positionals: [], options: {}, json: true });
    expect(result).toBe(2);
  });

  it('publishes a run-diff document from the integration worktree', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cohorte-diff-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
      writeFileSync(join(cwd, 'README.md'), 'before\n');
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd });
      const baseSha = git(cwd, 'rev-parse', 'HEAD');
      writeFileSync(join(cwd, 'README.md'), 'after\n');
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-qm', 'change'], { cwd });
      const out = captureStream();
      const context = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        openStore: async () =>
          ({
            readRunTree: async () => ({
              run: {
                runId: 'run_1',
                baseSha,
                baseBranch: 'main',
                integrationBranch: 'main',
                integrationHead: undefined,
              },
              worktrees: [{ slot: '_integration', path: cwd }],
            }),
            close: async () => {},
          }) as never,
      });
      const result = await diff.run(context, { positionals: ['run_1'], options: {}, json: true });
      expect(result).toBe(0);
      const document = JSON.parse(out.text()) as {
        surfaces: Array<{ files: Array<{ path: string }>; stat: { added: number } }>;
      };
      expect(document.surfaces[0]?.files[0]?.path).toBe('README.md');
      expect(document.surfaces[0]?.stat.added).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
