import { createHash } from 'node:crypto';
import { access, cp, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const walk = async (root: string, dir = root): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(root, p)));
    else if (e.isFile()) out.push(relative(root, p));
  }
  return out;
};
const alignDs: CommandModule = {
  verb: 'align-ds',
  async run(ctx, args) {
    let profile: Record<string, unknown> = {};
    try {
      const source = await readFile(join(ctx.cwd, 'PIPELINE.md'), 'utf8');
      const match = /```yaml pipeline-profile\s*\n([\s\S]*?)\n```/u.exec(source);
      profile = match?.[1] ? ((parse(match[1]) as Record<string, unknown>) ?? {}) : {};
    } catch {}
    const design =
      profile.design && typeof profile.design === 'object' ? (profile.design as Record<string, unknown>) : {};
    if (design.enabled !== true) {
      ctx.stdio.stdout.write('design system disabled; nothing to align\n');
      return 0;
    }
    const snapshot = typeof design.snapshot_dir === 'string' ? resolve(ctx.cwd, design.snapshot_dir) : undefined;
    const uiKit = typeof design.ui_kit_path === 'string' ? resolve(ctx.cwd, design.ui_kit_path) : undefined;
    const tokens = typeof design.tokens_path === 'string' ? resolve(ctx.cwd, design.tokens_path) : undefined;
    if (!snapshot || !uiKit || !tokens) {
      ctx.stdio.stderr.write('design system enabled but snapshot_dir, ui_kit_path and tokens_path are required\n');
      return 10;
    }
    if (!(await exists(snapshot)) || !(await exists(uiKit)) || !(await exists(tokens))) {
      ctx.stdio.stderr.write('design system paths are missing; configure a committed snapshot and code targets\n');
      return 10;
    }
    const files = (await walk(snapshot)).filter((file) => file !== 'README.md');
    const missing: string[] = [];
    const changed: string[] = [];
    for (const file of files) {
      const source = await readFile(join(snapshot, file));
      try {
        const target = await readFile(join(uiKit, file));
        if (createHash('sha256').update(source).digest('hex') !== createHash('sha256').update(target).digest('hex'))
          changed.push(file);
      } catch {
        missing.push(file);
      }
    }
    const snapshotSet = new Set(files);
    const removed = (await walk(uiKit)).filter((file) => !snapshotSet.has(file));
    const result = {
      snapshot,
      uiKit,
      tokens,
      files,
      missing,
      changed,
      removed,
      delta: missing.length + changed.length,
    };
    if (args.positionals.includes('--apply')) {
      for (const file of [...missing, ...changed])
        await cp(join(snapshot, file), join(uiKit, file), { recursive: true });
      ctx.stdio.stdout.write(
        `aligned ${missing.length + changed.length} design-system file(s); ${removed.length} stale file(s) reported\n`,
      );
    } else
      ctx.stdio.stdout.write(
        `${args.json ? JSON.stringify(result) : `${result.delta} design-system file(s) require alignment; ${removed.length} stale file(s)`}\n`,
      );
    return 0;
  },
};
export default alignDs;
