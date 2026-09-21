import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandModule } from '../../contract/index.ts';

type Pattern = { key: string; count: number; evidence: string[]; rule: string };
const normalise = (line: string) =>
  line
    .replace(/^-\s+\[[ xX]\]\s+/u, '')
    .replace(/\b[A-Za-z0-9_./-]+:\d+\b/gu, '<file>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
const listFiles = async (dir: string) => {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((x) => x.isFile()).map((x) => join(dir, x.name));
  } catch {
    return [];
  }
};

const retro: CommandModule = {
  verb: 'retro',
  async run(ctx, args) {
    const reportDir = join(ctx.cwd, 'specs', 'reports');
    let files = [...(await listFiles(reportDir)), ...(await listFiles(join(ctx.cwd, 'specs')))].filter(
      (file) => !file.endsWith('_decisions.md'),
    );
    const last = args.positionals.find((value, index) => value === 'last' && args.positionals[index + 1]);
    if (last) {
      const count = Number(args.positionals[args.positionals.indexOf('last') + 1]);
      if (!Number.isInteger(count) || count < 1) return 2;
      files = files.sort().slice(-count);
    }
    const grouped = new Map<string, Pattern>();
    for (const file of files) {
      let source = '';
      try {
        source = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of source
        .split(/\r?\n/u)
        .filter((x) => /\b(CRITICAL|HIGH|MEDIUM|LOW)\b|blocking_items|Remediation/iu.test(x))) {
        const key = normalise(line);
        if (key.length < 12) continue;
        const item = grouped.get(key) ?? { key, count: 0, evidence: [], rule: `Enforce: ${line.trim()}` };
        item.count++;
        if (item.evidence.length < 5) item.evidence.push(`${file.replace(`${ctx.cwd}/`, '')} · ${line.trim()}`);
        grouped.set(key, item);
      }
    }
    const patterns = [...grouped.values()]
      .map((pattern) => ({ ...pattern, count: new Set(pattern.evidence.map((value) => value.split(' · ')[0])).size }))
      .filter((x) => x.count >= 2)
      .sort((a, b) => b.count - a.count);
    const result = { patterns, evidenceFiles: files.map((x) => x.replace(`${ctx.cwd}/`, '')) };
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      join(reportDir, 'retro-scan.txt'),
      `${ctx.clock.now()}\n${patterns.map((pattern) => `${pattern.count}x ${pattern.rule}\n${pattern.evidence.join('\n')}`).join('\n')}\n`,
      'utf8',
    );
    if (!args.positionals.includes('--apply')) {
      ctx.stdio.stdout.write(
        `${args.json ? JSON.stringify(result) : patterns.length ? patterns.map((x) => `${x.count}x · ${x.rule}`).join('\n') : 'no recurring review patterns found'}\n`,
      );
      return 0;
    }
    const rules = args.positionals.flatMap((value, index, all) =>
      value === '--rule' && all[index + 1] ? [all[index + 1] as string] : [],
    );
    if (!rules.length) return 2;
    const pipeline = join(ctx.cwd, 'PIPELINE.md');
    let source = '';
    try {
      source = await readFile(pipeline, 'utf8');
    } catch {
      source = '# Cohorte Pipeline\n\n## Conventions\n\n';
    }
    if (!/^## Conventions\s*$/mu.test(source)) source += `${source.endsWith('\n') ? '' : '\n'}\n## Conventions\n\n`;
    await writeFile(
      pipeline,
      `${source}${source.endsWith('\n') ? '' : '\n'}${rules.map((x) => `- ${x}`).join('\n')}\n`,
      'utf8',
    );
    await mkdir(join(ctx.cwd, 'specs'), { recursive: true });
    await appendFile(
      join(ctx.cwd, 'specs', '_decisions.md'),
      `${ctx.clock.now().slice(0, 10)} · conventions · ${rules.join('; ')} — because retro ratification\n`,
    );
    ctx.stdio.stdout.write(`applied ${rules.length} convention(s); run cohorte update-pipeline to refresh agents\n`);
    return 0;
  },
};
export default retro;
