import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { sha256Hex } from '@cohorte/base';
import type { CommandModule } from '../../contract/index.ts';

const exec = promisify(execFile);
type GitRow = { path: string; op: 'create' | 'modify' | 'delete'; added: number; removed: number };

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

function parseNumstat(text: string): GitRow[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [addedText, removedText, ...pathParts] = line.split('\t');
      const path = pathParts.join('\t');
      const added = addedText === '-' ? 0 : Number(addedText);
      const removed = removedText === '-' ? 0 : Number(removedText);
      return {
        path,
        op: added === 0 && removed > 0 ? 'delete' : added > 0 && removed === 0 ? 'create' : 'modify',
        added,
        removed,
      };
    });
}

const diff: CommandModule = {
  verb: 'diff',
  async run(ctx, args) {
    const runId = args.positionals[0];
    if (!runId) return 2;
    const store = await ctx.openStore();
    try {
      const tree = await store.readRunTree(runId as never);
      const run = tree.run;
      const worktree =
        tree.worktrees.find((item) => item.slot === (args.positionals[1] ?? '_integration')) ?? tree.worktrees[0];
      if (!worktree || !run.baseSha) return 3;
      const base = run.baseSha;
      const head = run.integrationHead ?? (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();
      const rows = parseNumstat(await git(worktree.path, ['diff', '--numstat', `${base}..${head}`]));
      const patch = await git(worktree.path, ['diff', '--binary', `${base}..${head}`]);
      const artifactId = ctx.ids.next<'ArtifactId'>('art');
      const artifactDir = `${ctx.cwd}/.cohorte/runs/${runId}/artifacts`;
      const relativePatch = `.cohorte/runs/${runId}/artifacts/${artifactId}.patch`;
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      await writeFile(`${ctx.cwd}/${relativePatch}`, patch, 'utf8');
      const document = {
        documentVersion: 1,
        runId,
        base: { branch: run.baseBranch, sha: base },
        head: {
          branch: run.integrationBranch ?? worktree.branch ?? 'HEAD',
          sha: head,
          treeDigest: (await git(worktree.path, ['rev-parse', `${head}^{tree}`])).trim(),
        },
        surfaces: [
          {
            surface: args.positionals[1] ?? 'shared',
            files: rows.map((row) => ({ path: row.path, op: row.op })),
            stat: {
              added: rows.reduce((sum, row) => sum + row.added, 0),
              removed: rows.reduce((sum, row) => sum + row.removed, 0),
            },
            patch: {
              artifactId,
              kind: 'patch',
              path: relativePatch,
              sha256: sha256Hex(patch),
              bytes: Buffer.byteLength(patch),
            },
          },
        ],
      };
      if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(document)}\n`);
      else ctx.stdio.stdout.write(patch);
      return 0;
    } finally {
      await store.close();
    }
  },
};

export default diff;
