import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';

const exec = promisify(execFile);
const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const specText = async (cwd: string, id: string): Promise<string | undefined> => {
  for (const path of [join(cwd, 'specs', `${id}.md`), join(cwd, '.cohorte', 'specs', `${id}.yaml`)]) {
    try {
      return await readFile(path, 'utf8');
    } catch {}
  }
  return undefined;
};
const frozen = async (cwd: string, id: string) => {
  const text = await specText(cwd, id);
  return text !== undefined && (/^status:\s*frozen\s*$/mu.test(text.slice(0, 1500)) || /status:\s*frozen/u.test(text));
};
const specSurfaces = async (cwd: string, id: string, known: readonly string[]) => {
  const text = await specText(cwd, id);
  if (!text) return { keys: [...known], inferred: true };
  const listed = known.filter((key) =>
    new RegExp(`(?:^|[\\s"'])${key.replaceAll('-', '[^A-Za-z0-9]?')}([\\s"']|$)`, 'mu').test(text),
  );
  return { keys: listed.length ? listed : [...known], inferred: listed.length === 0 };
};
const surfaces = async (cwd: string): Promise<string[]> => {
  try {
    const text = await readFile(join(cwd, 'PIPELINE.md'), 'utf8');
    const match = /```yaml pipeline-profile\s*\n([\s\S]*?)\n```/u.exec(text);
    const profile = match?.[1] ? (parse(match[1]) as Record<string, unknown>) : {};
    return (Array.isArray(profile.surfaces) ? profile.surfaces : []).flatMap((x) =>
      x && typeof x === 'object' && 'key' in x && typeof x.key === 'string' ? [x.key] : [],
    );
  } catch {
    return [];
  }
};
const fleet: CommandModule = {
  verb: 'fleet',
  async run(ctx, args) {
    const mode = args.subVerb ?? args.positionals[0];
    const ids = args.positionals.filter((value) => !value.startsWith('--') && value !== mode);
    const file = join(ctx.cwd, 'specs', 'reports', 'fleet.json');
    if (mode === 'plan') {
      if (ids.length < 2) return 2;
      const invalid = [];
      for (const id of ids) if (!(await frozen(ctx.cwd, id))) invalid.push(id);
      if (invalid.length) {
        ctx.stdio.stderr.write(`fleet requires frozen specs: ${invalid.join(', ')}\n`);
        return 11;
      }
      const keys = await surfaces(ctx.cwd);
      const featureData = Object.fromEntries(
        await Promise.all(
          ids.map(async (id) => {
            const ownership = await specSurfaces(ctx.cwd, id, keys);
            return [
              id,
              { dependsOn: [], overlap: ownership.keys, overlapInferred: ownership.inferred, worktree: null },
            ];
          }),
        ),
      );
      const plan = {
        documentVersion: 1,
        generatedAt: ctx.clock.now(),
        order: ids,
        surfaces: keys,
        features: featureData,
        status: 'planned',
      };
      if (args.positionals.includes('--apply')) {
        await mkdir(join(ctx.cwd, 'specs', 'reports'), { recursive: true });
        if (await exists(join(ctx.cwd, '.git'))) {
          const worktreeRoot = resolve(ctx.cwd, '.cohorte', 'worktrees');
          await mkdir(worktreeRoot, { recursive: true });
          for (const id of ids) {
            const worktree = resolve(worktreeRoot, id);
            if (!(await exists(worktree))) {
              await exec('git', ['worktree', 'add', '-b', `cohorte/${id}`, worktree, 'HEAD'], { cwd: ctx.cwd });
            }
            (plan.features[id] as { worktree: string; branch: string }).worktree = worktree;
            (plan.features[id] as { branch: string }).branch = `cohorte/${id}`;
          }
        }
        await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      }
      ctx.stdio.stdout.write(
        `${args.json ? JSON.stringify(plan) : `${ids.length} feature(s) planned in order: ${ids.join(' → ')}${args.positionals.includes('--apply') ? `\nwritten ${file}` : '\nre-run with --apply to persist the plan'}`}\n`,
      );
      return 0;
    }
    if (mode === 'status') {
      try {
        const plan = JSON.parse(await readFile(file, 'utf8')) as {
          order?: string[];
          features?: Record<string, { worktree?: string }>;
        };
        const rows = [];
        for (const id of plan.order ?? []) {
          let status = 'missing';
          try {
            const text = (await specText(ctx.cwd, id)) ?? '';
            status = /^status:\s*(\S+)/mu.exec(text.slice(0, 1500))?.[1] ?? 'unknown';
          } catch {}
          rows.push({ id, status, worktree: plan.features?.[id]?.worktree ?? null });
        }
        ctx.stdio.stdout.write(
          `${args.json ? JSON.stringify({ rows }) : rows.map((x) => `${x.id} · ${x.status} · ${x.worktree ?? 'no worktree'}`).join('\n')}\n`,
        );
        return 0;
      } catch {
        ctx.stdio.stderr.write('fleet plan not found; run cohorte fleet plan <id> <id> --apply\n');
        return 1;
      }
    }
    if (mode === 'sync') {
      try {
        const plan = JSON.parse(await readFile(file, 'utf8')) as {
          order?: string[];
          features?: Record<string, { worktree?: string; branch?: string }>;
        };
        const rows = [];
        for (const id of plan.order ?? []) {
          const worktree = plan.features?.[id]?.worktree;
          if (!worktree) {
            rows.push({ id, action: 'no worktree' });
            continue;
          }
          try {
            const { stdout } = await exec('git', ['-C', worktree, 'status', '--porcelain']);
            const branch = plan.features?.[id]?.branch;
            let divergence = '';
            if (branch) {
              try {
                const { stdout: counts } = await exec('git', [
                  '-C',
                  worktree,
                  'rev-list',
                  '--left-right',
                  '--count',
                  `HEAD...${branch}`,
                ]);
                divergence = counts.trim();
              } catch {}
            }
            rows.push({
              id,
              action: stdout.trim() ? 'rebase needed: dirty worktree' : 'ready for supervised rebase',
              worktree,
              divergence,
            });
          } catch {
            rows.push({ id, action: 'worktree missing', worktree });
          }
        }
        ctx.stdio.stdout.write(
          `${args.json ? JSON.stringify({ rows }) : rows.map((x) => `${x.id} · ${x.action}`).join('\n')}\n`,
        );
        return 0;
      } catch {
        return 1;
      }
    }
    return 2;
  },
};
export default fleet;
