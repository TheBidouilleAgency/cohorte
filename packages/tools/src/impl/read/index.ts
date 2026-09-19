import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { JsonValue } from '@cohorte/base';
import type { EffectRecord } from '@cohorte/persistence/contract';
import { CATALOGUE_ROWS } from '../../catalogue/schemas.ts';
import type {
  NormalizedCall,
  ToolExecContext,
  ToolExecuteResult,
  ToolImplementation,
  ToolPlan,
} from '../../catalogue/types.ts';

export const READ_TOOL_NAMES = ['read_file', 'list_files', 'search', 'git_diff'] as const;
type ReadName = (typeof READ_TOOL_NAMES)[number];
const row = (name: ReadName) => {
  const entry = CATALOGUE_ROWS.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing catalogue row: ${name}`);
  return entry;
};
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const result = (output: JsonValue, modelText: string): ToolExecuteResult<JsonValue> => ({
  output,
  modelText,
  filesTouched: [],
});
const fail = (code: string, message: string): never => {
  throw new Error(`${code}: ${message}`);
};
const requiredPath = (value: string | undefined, message: string): string =>
  value ?? fail('permission/path-outside-grant', message);
const make = (
  name: ReadName,
  execute: (
    input: JsonValue,
    n: NormalizedCall,
    ctx: ToolExecContext,
    signal: AbortSignal,
  ) => Promise<ToolExecuteResult<JsonValue>>,
): ToolImplementation => {
  const metadata = row(name);
  return {
    ...metadata,
    plan: (input, n): ToolPlan => ({
      kind: 'tool.read',
      replayClass: 'idempotent',
      verify: { tool: name, input, normalized: JSON.parse(JSON.stringify(n)) as JsonValue },
    }),
    execute,
    verifyAfterCrash: async (_record: EffectRecord) => 'done',
    describeForNote: (record) => `${name} ${record.idempotencyKey}`,
  };
};

const readFileTool = make('read_file', async (input, n, _ctx, signal) => {
  if (signal.aborted) fail('tool-transient/cancelled', 'read was cancelled');
  const target = requiredPath(n.paths[0]?.resolved.canonical, 'read_file has no resolved path');
  const bytes = await readFile(target);
  if (bytes.byteLength > 256 * 1024) fail('tool-terminal/output-too-large', 'file exceeds the 256 KiB read limit');
  if (bytes.includes(0)) fail('tool-terminal/binary-file', 'binary files are not returned as text');
  const value = input as { path: string; offset?: number; limit?: number };
  const offset = value.offset ?? 0;
  const selected = bytes
    .toString('utf8')
    .split(/\r?\n/)
    .slice(offset, value.limit === undefined ? undefined : offset + value.limit);
  const text = selected.map((line, index) => `${offset + index + 1}: ${line}`).join('\n');
  return result(
    { path: n.paths[0]?.resolved.relative ?? value.path, text, sha256: sha256(bytes), offset, lines: selected.length },
    text,
  );
});

const walk = async (root: string, current: string, output: string[], max: number): Promise<void> => {
  if (output.length >= max) return;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.cohorte' || entry.name === '.pi' || entry.isSymbolicLink()) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) await walk(root, absolute, output, max);
    else output.push(relative(root, absolute).split('\\').join('/'));
    if (output.length >= max) return;
  }
};
const globMatch = (value: string, pattern?: string): boolean => {
  if (!pattern || pattern === '**') return true;
  const escaped = pattern
    .replace(/[.*+?^()|[\]\\]/g, '\\$&')
    .replaceAll('\\*\\*', '.*')
    .replaceAll('\\*', '[^/]*')
    .replaceAll('\\?', '[^/]');
  return new RegExp(`^${escaped}$`).test(value);
};

const listFilesTool = make('list_files', async (input, n, _ctx, signal) => {
  if (signal.aborted) fail('tool-transient/cancelled', 'listing was cancelled');
  const root = requiredPath(n.paths[0]?.resolved.canonical, 'list_files has no resolved root');
  const value = input as { glob?: string; maxEntries?: number };
  const files: string[] = [];
  await walk(root, root, files, value.maxEntries ?? 1000);
  const filtered = files.filter((file) => globMatch(file, value.glob));
  return result({ files: filtered, truncated: files.length >= (value.maxEntries ?? 1000) }, filtered.join('\n'));
});

const searchTool = make('search', async (input, n, _ctx, signal) => {
  if (signal.aborted) fail('tool-transient/cancelled', 'search was cancelled');
  const root = requiredPath(n.paths[0]?.resolved.canonical, 'search has no resolved root');
  const value = input as { pattern: string; caseInsensitive?: boolean; glob?: string; maxMatches?: number };
  const expression = new RegExp(value.pattern, value.caseInsensitive ? 'i' : '');
  const files: string[] = [];
  await walk(root, root, files, 10_000);
  const matches: { path: string; line: number; text: string }[] = [];
  for (const file of files.filter((candidate) => globMatch(candidate, value.glob))) {
    if (matches.length >= (value.maxMatches ?? 100)) break;
    const text = await readFile(join(root, file), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (matches.length < (value.maxMatches ?? 100) && expression.test(line))
        matches.push({ path: file, line: index + 1, text: line });
    });
  }
  return result(
    { matches, filteredPaths: 0 },
    matches.map((match) => `${match.path}:${match.line}:${match.text}`).join('\n'),
  );
});

const gitDiffTool = make('git_diff', async (input, _n, ctx, signal) => {
  if (signal.aborted) fail('tool-transient/cancelled', 'diff was cancelled');
  const value = input as { base?: 'run-base' | 'integration' | 'checkpoint'; stat?: boolean };
  const output = await ctx.git.diffBySurface({
    repo: ctx.workspaceRoot,
    base: value.base ?? 'integration',
    head: 'HEAD',
    surfaces: { surfaceOf: () => 'shared' },
  });
  const text = output.map((item) => new TextDecoder().decode(item.patch.bytes)).join('\\n');
  return result(
    {
      base: value.base ?? 'integration',
      stat: value.stat ?? false,
      files: output.flatMap((item) => item.files),
      diff: text,
    },
    text,
  );
});

export const READ_TOOLS: Readonly<Record<ReadName, ToolImplementation>> = Object.freeze({
  read_file: readFileTool,
  list_files: listFilesTool,
  search: searchTool,
  git_diff: gitDiffTool,
});
