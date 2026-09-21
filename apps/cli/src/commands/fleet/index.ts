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
const specDependencies = async (cwd: string, id: string, candidates: readonly string[]): Promise<string[]> => {
  const text = await specText(cwd, id);
  if (!text) return [];
  const declared = new Set<string>();
  const matches = [
    ...text.matchAll(/(?:^|\n)\s*(?:dependsOn|depends-on|depends on)\s*:\s*([^\n]+)/giu),
    ...text.matchAll(/(?:dependsOn|depends-on|depends on)\s+([^\n]+)/giu),
  ];
  for (const match of matches) {
    for (const value of (match[1] ?? '').split(/[,\s[\]"']/u)) {
      if (candidates.includes(value) && value !== id) declared.add(value);
    }
  }
  return [...declared].sort();
};
function dependencyOrder(ids: readonly string[], dependencies: ReadonlyMap<string, readonly string[]>): string[] {
  const result: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  };
  for (const id of ids) visit(id);
  return result;
}
const statusOf = async (cwd: string, id: string) => {
  try {
    const text = await readFile(join(cwd, 'specs', `${id}.md`), 'utf8');
    return /^status:\s*(\S+)/mu.exec(text.slice(0, 1500))?.[1] ?? 'unknown';
  } catch {
    return 'missing';
  }
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
      const dependencyMap = new Map<string, string[]>();
      const featureData = Object.fromEntries(
        await Promise.all(
          ids.map(async (id) => {
            const ownership = await specSurfaces(ctx.cwd, id, keys);
            const dependsOn = await specDependencies(ctx.cwd, id, ids);
            dependencyMap.set(id, dependsOn);
            return [id, { dependsOn, overlap: ownership.keys, overlapInferred: ownership.inferred, worktree: null }];
          }),
        ),
      );
      const order = dependencyOrder(ids, dependencyMap);
      const plan = {
        documentVersion: 1,
        generatedAt: ctx.clock.now(),
        order,
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
        const defaultBranch = 'main';
        const rows = [];
        for (const id of plan.order ?? []) {
          const worktree = plan.features?.[id]?.worktree ?? null;
          const root = worktree ?? ctx.cwd;
          const status = await statusOf(root, id);
          let loop: Record<string, unknown> = {};
          let verdict: Record<string, unknown> = {};
          try {
            loop = JSON.parse(await readFile(join(root, 'specs', 'reports', `${id}.loop.json`), 'utf8'));
          } catch {}
          try {
            verdict = JSON.parse(await readFile(join(root, 'specs', 'reports', `${id}.verdict.json`), 'utf8'));
          } catch {}
          let ahead = 0;
          let behind = 0;
          try {
            await exec('git', ['-C', root, 'fetch', '--quiet', 'origin', defaultBranch]);
            const { stdout } = await exec('git', [
              '-C',
              root,
              'rev-list',
              '--left-right',
              '--count',
              `origin/${defaultBranch}...HEAD`,
            ]);
            const counts = stdout.trim().split(/\s+/u).map(Number);
            behind = counts[0] ?? 0;
            ahead = counts[1] ?? 0;
          } catch {}
          rows.push({
            id,
            status,
            worktree,
            loop: { phase: loop.phase ?? null, round: loop.round ?? null, outcome: loop.outcome ?? null },
            blocking: verdict.blocking ?? null,
            ahead,
            behind,
          });
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
        const defaultBranch = 'main';
        const requestedShipped = args.positionals.find((value) => value !== mode && !value.startsWith('--'));
        const mergedBranches = await exec('git', ['branch', '--merged', defaultBranch], { cwd: ctx.cwd })
          .then(({ stdout }) => stdout)
          .catch(() => '');
        const requested =
          requestedShipped && (plan.order ?? []).includes(requestedShipped) ? requestedShipped : undefined;
        const detectedShipped =
          requested ??
          (plan.order ?? []).find((id) => {
            const branch = plan.features?.[id]?.branch;
            return branch
              ? mergedBranches.split(/\r?\n/u).some((line) => line.replace(/^\*?\s*/u, '') === branch)
              : false;
          });
        if (detectedShipped) {
          plan.order = (plan.order ?? []).filter((id) => id !== detectedShipped);
          if (plan.features) delete plan.features[detectedShipped];
          await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
        }
        const rows: Array<{ id: string; action: string; worktree?: string }> = detectedShipped
          ? [{ id: detectedShipped, action: 'shipped: removed from fleet plan' }]
          : [];
        for (const id of plan.order ?? []) {
          const worktree = plan.features?.[id]?.worktree;
          if (!worktree) {
            rows.push({ id, action: 'no worktree' });
            continue;
          }
          try {
            await exec('git', ['-C', worktree, 'fetch', '--quiet', 'origin', defaultBranch]);
            const loopPath = join(worktree, 'specs', 'reports', `${id}.loop.json`);
            let loop: { outcome?: string } = {};
            try {
              loop = JSON.parse(await readFile(loopPath, 'utf8')) as { outcome?: string };
            } catch {}
            const { stdout } = await exec('git', ['-C', worktree, 'status', '--porcelain']);
            if (stdout.trim()) {
              rows.push({ id, action: 'rebase needed: dirty worktree', worktree });
            } else if (!loop.outcome) {
              rows.push({ id, action: 'rebase needed: loop in flight', worktree });
            } else {
              try {
                await exec('git', ['-C', worktree, 'rebase', `origin/${defaultBranch}`]);
                rows.push({ id, action: 'rebased; fresh review required', worktree });
              } catch (error) {
                rows.push({
                  id,
                  action: `rebase conflict: ${error instanceof Error ? error.message : String(error)}`,
                  worktree,
                });
              }
            }
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
