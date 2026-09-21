import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';

type Card = { id: string; title: string; checked: boolean; column: string; line: number };

const COLUMNS = ['Ideas', 'Brainstorm', 'Spec', 'Ready to build', 'Building', 'Review', 'Fix', 'Ship', 'Shipped'];
const STAGES = new Map([
  ['ideas', 'Ideas'],
  ['brainstorm', 'Brainstorm'],
  ['spec', 'Spec'],
  ['ready', 'Ready to build'],
  ['building', 'Building'],
  ['review', 'Review'],
  ['fix', 'Fix'],
  ['ship', 'Ship'],
  ['shipped', 'Shipped'],
]);

const BOARD_TEMPLATE = `---
kanban-plugin: board
---

${COLUMNS.map((column) => `## ${column}\n`).join('\n')}
%% kanban:settings
\`\`\`
{"kanban-plugin":"board","list-collapse":[false,false,false,false,false,false,false,false,false]}
\`\`\`
%%
`;

function parseCards(source: string): Card[] {
  const lines = source.split(/\r?\n/);
  let column = '';
  const cards: Card[] = [];
  lines.forEach((line, lineIndex) => {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      column = heading[1] ?? '';
      return;
    }
    const card = /^-\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (!card || !column) return;
    const title = card[2] ?? '';
    const tag = /#([a-z0-9][a-z0-9-]*)\b/i.exec(title);
    if (!tag) return;
    cards.push({
      id: (tag[1] ?? '').toLowerCase(),
      title,
      checked: (card[1] ?? '').toLowerCase() === 'x',
      column,
      line: lineIndex,
    });
  });
  return cards;
}

async function loadUserConfig(home: string): Promise<{ path: string; value: Record<string, unknown> }> {
  const path = join(home, '.cohorte', 'config.yaml');
  try {
    const value = parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return { path, value: value && typeof value === 'object' ? value : {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path, value: {} };
  }
}

function configured(value: Record<string, unknown>): { vaultPath: string; board: string } | undefined {
  const integrations = value.integrations;
  if (!integrations || typeof integrations !== 'object') return undefined;
  const obsidian = (integrations as Record<string, unknown>).obsidian;
  if (!obsidian || typeof obsidian !== 'object') return undefined;
  const { vaultPath, board } = obsidian as Record<string, unknown>;
  return typeof vaultPath === 'string' && typeof board === 'string' ? { vaultPath, board } : undefined;
}

async function boardPath(home: string): Promise<{ config: { vaultPath: string; board: string }; path: string }> {
  const loaded = await loadUserConfig(home);
  const config = configured(loaded.value);
  if (!config) throw new Error('Obsidian is not configured; run `cohorte obsidian connect <vault> <board>`');
  const path = resolve(config.vaultPath, config.board);
  await access(path);
  return { config, path };
}

function replaceCard(source: string, id: string, target: string): string {
  const lines = source.split(/\r?\n/);
  const cards = parseCards(source);
  const card = cards.find((item) => item.id === id);
  if (!card) throw new Error(`Obsidian card #${id} was not found`);
  if (!COLUMNS.includes(target)) throw new Error(`Unknown Obsidian column: ${target}`);
  if (card.column === target) return source;
  const line = lines[card.line] ?? '';
  lines.splice(card.line, 1);
  let heading = lines.indexOf(`## ${target}`);
  if (heading < 0) {
    if (!source.endsWith('\n')) lines.push('');
    lines.push(`## ${target}`, '');
    heading = lines.length - 2;
  }
  let insert = heading + 1;
  while (insert < lines.length && !(lines[insert] ?? '').startsWith('## ')) insert++;
  lines.splice(insert, 0, line);
  return lines.join('\n');
}

const obsidian: CommandModule = {
  verb: 'obsidian',
  async run(ctx, args) {
    const home = ctx.env.HOME ?? ctx.cwd;
    if (args.subVerb === 'create') {
      const [vaultPath, board = 'Weave/Tasks.md'] = args.positionals;
      if (!vaultPath) return 2;
      const path = resolve(vaultPath, board);
      try {
        await access(path);
        throw new Error(`Obsidian board already exists: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, BOARD_TEMPLATE, 'utf8');
      const loaded = await loadUserConfig(home);
      const integrations = loaded.value.integrations;
      const nextIntegrations = integrations && typeof integrations === 'object' ? { ...(integrations as object) } : {};
      (nextIntegrations as Record<string, unknown>).obsidian = { vaultPath, board };
      loaded.value.integrations = nextIntegrations;
      await mkdir(dirname(loaded.path), { recursive: true });
      await writeFile(loaded.path, stringify(loaded.value), 'utf8');
      ctx.stdio.stdout.write(`created and connected ${path}\n`);
      return 0;
    }
    if (args.subVerb === 'connect') {
      const [vaultPath, board = 'Weave/Tasks.md'] = args.positionals;
      if (!vaultPath) return 2;
      const loaded = await loadUserConfig(home);
      const integrations = loaded.value.integrations;
      const nextIntegrations = integrations && typeof integrations === 'object' ? { ...(integrations as object) } : {};
      (nextIntegrations as Record<string, unknown>).obsidian = { vaultPath, board };
      loaded.value.integrations = nextIntegrations;
      await mkdir(dirname(loaded.path), { recursive: true });
      await writeFile(loaded.path, stringify(loaded.value), 'utf8');
      ctx.stdio.stdout.write(`connected ${resolve(vaultPath, board)}\n`);
      return 0;
    }
    if (args.subVerb === 'status') {
      const resolved = await boardPath(home);
      const cards = parseCards(await readFile(resolved.path, 'utf8'));
      if (args.json) ctx.stdio.stdout.write(`${JSON.stringify({ ...resolved.config, path: resolved.path, cards })}\n`);
      else
        ctx.stdio.stdout.write(
          `${resolved.path}\n${cards.map((card) => `${card.id}\t${card.column}\t${card.title}`).join('\n')}\n`,
        );
      return 0;
    }
    if (args.subVerb === 'move') {
      const [id, stage] = args.positionals;
      const target = stage ? (STAGES.get(stage) ?? stage) : undefined;
      if (!id || !target) return 2;
      const resolved = await boardPath(home);
      const source = await readFile(resolved.path, 'utf8');
      await writeFile(resolved.path, replaceCard(source, id, target), 'utf8');
      ctx.stdio.stdout.write(`moved #${id} to ${target}\n`);
      return 0;
    }
    return 2;
  },
};

export default obsidian;
