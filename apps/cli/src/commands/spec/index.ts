// apps/cli/src/commands/spec/index.ts — DESIGN §9 verb `spec` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/spec/**`.
import { access, readFile, writeFile } from 'node:fs/promises';
import { freezeSpec, loadSpec } from '@cohorte/config';
import { stringify } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';
import { resolveSpecPath } from '../../project/spec-path.ts';

const spec: CommandModule = {
  verb: 'spec',
  async run(ctx, args) {
    const input = args.positionals.find((item) => !item.startsWith('--'));
    if (!input) return 2;
    let file = resolveSpecPath(ctx.cwd, input);
    if (!input.includes('/') && !input.endsWith('.yaml') && !input.endsWith('.yml') && !input.endsWith('.md')) {
      for (const candidate of [resolveSpecPath(ctx.cwd, `specs/${input}.md`), file]) {
        try {
          await access(candidate);
          file = candidate;
          break;
        } catch {}
      }
    }
    if (file.endsWith('.md')) {
      const source = await readFile(file, 'utf8');
      const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(source)?.[1] ?? '';
      const status = /^status:\s*(\S+)/mu.exec(frontmatter)?.[1] ?? 'draft';
      if (args.subVerb === 'freeze') {
        if (status === 'frozen') {
          ctx.stdio.stdout.write(`${JSON.stringify({ path: file, status, valid: true })}\n`);
          return 0;
        }
        const next = frontmatter ? frontmatter.replace(/^status:\s*\S+/mu, 'status: frozen') : 'status: frozen';
        const body = source.startsWith('---\n')
          ? source.replace(/^---\n[\s\S]*?\n---/u, `---\n${next}\n---`)
          : `---\n${next}\n---\n\n${source}`;
        await writeFile(file, body, 'utf8');
        ctx.stdio.stdout.write(`${JSON.stringify({ path: file, status: 'frozen', valid: true })}\n`);
        return 0;
      }
      const result = { path: file, status, valid: source.trim().length > 0 };
      ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
      return result.valid ? 0 : 11;
    }
    const frozen = args.subVerb === 'freeze';
    const value = frozen ? await freezeSpec(file) : await loadSpec(file);
    if (frozen) await writeFile(file, stringify(value));
    ctx.stdio.stdout.write(`${JSON.stringify(value)}\n`);
    return 0;
  },
};

export default spec;
