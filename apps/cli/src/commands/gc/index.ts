// apps/cli/src/commands/gc/index.ts — DESIGN §9 verb `gc` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/gc/**`.
import type { Dirent } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { PipelineState } from '@cohorte/protocol';
import { parse } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';

const gzipAsync = promisify(gzip);
const TERMINAL = new Set<PipelineState>(['COMPLETED', 'CANCELLED']);
const DEFAULT_RETENTION = { transcriptsDays: 30, artifactsDays: 90, compressAfterDays: 7 };
type Action =
  | { kind: 'compress' | 'delete' | 'delete-cas'; path: string; runId: string }
  | { kind: 'purge-events'; path: string; runId: string };

type RetentionStore = Awaited<ReturnType<Parameters<CommandModule['run']>[0]['openStore']>> & {
  purgeEvents?: (runId: string) => Promise<number>;
};

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  await visit(root);
  return result;
}

function classify(path: string): 'sensitive' | 'transcript' | 'artifact' | 'spool' | undefined {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  if (normalized.endsWith('.gz')) return undefined;
  if (normalized.includes('/sensitive/') || normalized.endsWith('.sensitive') || normalized.endsWith('.sensitive.json'))
    return 'sensitive';
  if (normalized.includes('/transcripts/') || normalized.includes('/wire/') || normalized.includes('/logs/'))
    return 'transcript';
  if (normalized.includes('/artifacts/')) return 'artifact';
  if (normalized.includes('/spool/') || normalized.includes('/stream/')) return 'spool';
  return undefined;
}

async function readRetention(cwd: string): Promise<typeof DEFAULT_RETENTION> {
  try {
    const value = parse(await readFile(join(cwd, '.cohorte', 'config.yaml'), 'utf8')) as {
      retention?: Partial<typeof DEFAULT_RETENTION>;
    };
    return { ...DEFAULT_RETENTION, ...(value.retention ?? {}) };
  } catch {
    return DEFAULT_RETENTION;
  }
}

const CAS_ADDRESS = /^[a-f0-9]{64}$/;

async function referencedCasAddresses(
  runs: Awaited<ReturnType<RetentionStore['listRuns']>>,
  casRoot: string,
): Promise<Set<string>> {
  const retained = new Set<string>();
  for (const run of runs) {
    const digest = run.snapshotDigest;
    if (!digest || !CAS_ADDRESS.test(digest)) continue;
    retained.add(digest);
    const path = join(casRoot, digest.slice(0, 2), digest);
    try {
      const text = (await readFile(path, 'utf8')).toString();
      for (const address of text.match(/[a-f0-9]{64}/g) ?? []) retained.add(address);
    } catch {
      // A missing snapshot is reported by resume/doctor; GC must not fail or invent a reference.
    }
  }
  return retained;
}

async function planGc(ctx: Parameters<CommandModule['run']>[0]): Promise<Action[]> {
  const store = (await ctx.openStore()) as RetentionStore;
  try {
    const runs = await store.listRuns({ limit: 100_000, offset: 0 });
    const retention = await readRetention(ctx.cwd);
    const root = join(ctx.cwd, '.cohorte', 'state', 'runs');
    const casRoot = join(ctx.cwd, '.cohorte', 'state', 'cas');
    const now = Date.parse(ctx.clock.now());
    const actions: Action[] = [];
    for (const run of runs) {
      if (!TERMINAL.has(run.state)) continue;
      if (run.purgeable && typeof store.purgeEvents === 'function') {
        actions.push({ kind: 'purge-events', path: `.cohorte/state/events/${run.runId}`, runId: run.runId });
      }
      for (const path of await filesUnder(join(root, run.runId))) {
        const kind = classify(path);
        if (!kind) continue;
        const age = Math.max(0, now - (await stat(path)).mtimeMs);
        if (kind === 'sensitive' && age >= retention.compressAfterDays * 86_400_000)
          actions.push({ kind: 'compress', path, runId: run.runId });
        else if (kind === 'transcript' && age >= retention.transcriptsDays * 86_400_000)
          actions.push({ kind: 'delete', path, runId: run.runId });
        else if (kind === 'artifact' && age >= retention.artifactsDays * 86_400_000)
          actions.push({ kind: 'delete', path, runId: run.runId });
        else if (kind === 'spool' && age >= 86_400_000) actions.push({ kind: 'delete', path, runId: run.runId });
      }
    }
    const retainedCas = await referencedCasAddresses(runs, casRoot);
    for (const path of await filesUnder(casRoot)) {
      const address = path.split('/').at(-1) ?? '';
      if (CAS_ADDRESS.test(address) && !retainedCas.has(address))
        actions.push({ kind: 'delete-cas', path, runId: 'cas' });
    }
    return actions.sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    await store.close();
  }
}

async function applyAction(action: Action, store: RetentionStore): Promise<void> {
  if (action.kind === 'purge-events') {
    await store.purgeEvents?.(action.runId);
    return;
  }
  if (action.kind === 'delete' || action.kind === 'delete-cas') return rm(action.path, { force: true });
  const compressed = await gzipAsync(await readFile(action.path));
  await writeFile(`${action.path}.gz`, compressed, { mode: 0o600 });
  await rm(action.path, { force: true });
}

const gc: CommandModule = {
  verb: 'gc',
  async run(ctx, args) {
    const dryRun = args.positionals.includes('--dry-run');
    const apply = args.positionals.includes('--apply');
    if (dryRun === apply) return 2;
    const actions = await planGc(ctx);
    if (apply) {
      const store = (await ctx.openStore()) as RetentionStore;
      try {
        for (const action of actions) await applyAction(action, store);
      } finally {
        await store.close();
      }
    }
    ctx.stdio.stdout.write(`${JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', actions })}\n`);
    return 0;
  },
};

export default gc;
