import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';
import review from '../review/index.ts';

const exec = promisify(execFile);

type BacklogItem = { severity: string; file: string; line: number; kind: string; fix: string };

async function configuredDomains(root: string): Promise<string[]> {
  try {
    const pipeline = await readFile(join(root, 'PIPELINE.md'), 'utf8');
    const block = /```yaml pipeline-profile\s*\n([\s\S]*?)\n```/u.exec(pipeline)?.[1];
    const profile = block ? (parse(block) as { surfaces?: unknown[] }) : {};
    const keys = (profile.surfaces ?? []).flatMap((surface) =>
      surface && typeof surface === 'object' && 'key' in surface && typeof surface.key === 'string'
        ? [surface.key]
        : [],
    );
    return [...new Set([...keys, 'shared'])];
  } catch {
    return [];
  }
}

async function configuredGates(root: string): Promise<string[]> {
  try {
    const pipeline = await readFile(join(root, 'PIPELINE.md'), 'utf8');
    const block = /```yaml pipeline-profile\s*\n([\s\S]*?)\n```/u.exec(pipeline)?.[1];
    const commands = block ? (parse(block) as { commands?: Record<string, unknown> })?.commands : undefined;
    if (!commands) return [];
    return ['format', 'lint', 'typecheck', 'test']
      .map((key) => commands[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0 && !value.startsWith('<'));
  } catch {
    return [];
  }
}

async function runGates(root: string): Promise<string> {
  const commands = await configuredGates(root);
  if (commands.length === 0) {
    try {
      const result = await exec('git', ['diff', '--check'], { cwd: root, maxBuffer: 1_000_000 });
      return `git diff --check\n${result.stdout || 'clean\n'}`;
    } catch (error) {
      return `git diff --check\n${error instanceof Error ? error.message : String(error)}\n`;
    }
  }
  const chunks: string[] = [];
  for (const command of commands) {
    try {
      const result = await exec('sh', ['-lc', command], { cwd: root, maxBuffer: 2_000_000 });
      chunks.push(`$ ${command}\n${result.stdout || '(no output)'}${result.stderr || ''}`);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      chunks.push(`$ ${command}\n${failure.stdout ?? ''}${failure.stderr ?? failure.message ?? String(error)}\n`);
    }
  }
  return `${chunks.join('\n')}\n`;
}

async function readExistingFindings(root: string): Promise<BacklogItem[]> {
  const reports = join(root, 'specs', 'reports');
  let names: string[];
  try {
    names = (await readdir(reports)).filter((name) => /\.(json|md|txt)$/u.test(name));
  } catch {
    return [];
  }
  const items: BacklogItem[] = [];
  for (const name of names) {
    const path = join(reports, name);
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    try {
      const value = JSON.parse(text) as unknown;
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const child of node) visit(child);
          return;
        }
        if (!node || typeof node !== 'object') return;
        const row = node as Record<string, unknown>;
        if (typeof row.file === 'string' && typeof row.fix === 'string') {
          items.push({
            severity: typeof row.severity === 'string' ? row.severity : 'MEDIUM',
            file: row.file,
            line: typeof row.line === 'number' ? row.line : 1,
            kind: typeof row.kind === 'string' ? row.kind : 'tdd',
            fix: row.fix,
          });
        }
        for (const child of Object.values(row)) visit(child);
      };
      visit(value);
    } catch {
      for (const line of text.split(/\r?\n/u)) {
        const match = /^- \[ \] (?:(CRITICAL|HIGH|MEDIUM|LOW) · )?([^:]+):(\d+) · ([^·]+) · (.+)$/u.exec(line);
        if (match)
          items.push({
            severity: match[1] ?? 'MEDIUM',
            file: match[2] ?? 'unknown',
            line: Number(match[3]),
            kind: match[4]?.trim() ?? 'tdd',
            fix: match[5]?.trim() ?? 'inspect and fix',
          });
      }
    }
  }
  return items;
}

function domainFor(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts[0] === 'apps' || parts[0] === 'packages') return parts.slice(0, 2).join('/') || 'shared';
  return parts[0] && !['scripts', 'specs'].includes(parts[0]) ? parts[0] : 'shared';
}

const audit: CommandModule = {
  verb: 'audit',
  async run(ctx, args) {
    const target = args.positionals.find((value) => !value.startsWith('--'));
    if (target === undefined && args.positionals.length > 0) return 2;
    await mkdir(join(ctx.cwd, 'specs', 'reports'), { recursive: true });
    const gatePath = join(ctx.cwd, 'specs', 'reports', 'audit-gates.txt');
    await writeFile(gatePath, await runGates(ctx.cwd), 'utf8');
    const findings = (await readExistingFindings(ctx.cwd))
      .filter((item) => target === undefined || item.file.includes(target) || domainFor(item.file) === target)
      .filter((item, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) === index)
      .sort((a, b) => a.severity.localeCompare(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
    const grouped = new Map<string, BacklogItem[]>();
    for (const item of findings) {
      const domain = domainFor(item.file);
      grouped.set(domain, [...(grouped.get(domain) ?? []), item]);
    }
    const backlog = ['# Refactor backlog', '', `> Generated by cohorte audit (${ctx.clock.now()}).`];
    for (const [domain, items] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      backlog.push('', `## ${domain}`, '');
      for (const item of items)
        backlog.push(`- [ ] ${item.severity} · ${item.file}:${item.line} · ${item.kind} · ${item.fix}`);
    }
    if (findings.length === 0) backlog.push('', 'No open findings were recovered from the durable reports.', '');
    const backlogPath = join(ctx.cwd, 'specs', 'refactor-backlog.md');
    await writeFile(backlogPath, `${backlog.join('\n')}\n`, 'utf8');
    const configured = await configuredDomains(ctx.cwd);
    const domains = configured.filter((domain) => !target || target === domain || domain.startsWith(target));
    const dispatch = domains.length > 0 ? domains : [target ?? 'all'];
    const outcomes = await Promise.all(
      dispatch.map(async (domain) => {
        try {
          const result = await review.run(ctx, {
            ...args,
            // Audit targets are domains/paths, not feature spec IDs. Forward each
            // domain as a review surface so Pi reviews one ownership slice at a time.
            positionals:
              configured.length === 0 && target === undefined
                ? args.positionals
                : ['--surface', domain, ...args.positionals.filter((value) => value.startsWith('--'))],
          });
          return { domain, status: result };
        } catch (error) {
          return { domain, status: 3, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const dispatchPath = join(ctx.cwd, 'specs', 'reports', 'audit-dispatch.json');
    await writeFile(
      dispatchPath,
      `${JSON.stringify(
        {
          generatedAt: ctx.clock.now(),
          requestedTarget: target ?? null,
          domains: outcomes,
          deadDomains: outcomes.filter((item) => item.error).map((item) => item.domain),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const result = outcomes.some((item) => item.status === 3) ? 3 : outcomes.some((item) => item.status === 4) ? 4 : 0;
    ctx.stdio.stdout.write(
      `audit gates written to ${relative(ctx.cwd, gatePath)}; backlog written to ${relative(ctx.cwd, backlogPath)}; ` +
        `review dispatched for ${outcomes.length} domain(s)\n`,
    );
    return result;
  },
};

export default audit;
