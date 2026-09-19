import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type JsonValue, type Sha256, sha256Hex } from '@cohorte/base';
import type { EffectRecord } from '@cohorte/persistence/contract';
import { CATALOGUE_ROWS } from '../../catalogue/schemas.ts';
import type {
  NormalizedCall,
  ToolExecContext,
  ToolExecuteResult,
  ToolImplementation,
  ToolPlan,
} from '../../catalogue/types.ts';

export const WRITE_TOOL_NAMES = ['write_file', 'patch_file'] as const;
type WriteName = (typeof WRITE_TOOL_NAMES)[number];
const row = (name: WriteName) => {
  const entry = CATALOGUE_ROWS.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing catalogue row: ${name}`);
  return entry;
};
const digest = (value: Uint8Array | string): Sha256 => sha256Hex(createHash('sha256').update(value).digest());
const fail = (code: string, message: string): never => {
  throw new Error(`${code}: ${message}`);
};
const requiredPath = (n: NormalizedCall): string =>
  n.paths[0]?.resolved.canonical ?? fail('permission/path-outside-grant', 'write tool has no resolved path');
const result = (
  output: JsonValue,
  modelText: string,
  filesTouched: ToolExecuteResult<JsonValue>['filesTouched'],
): ToolExecuteResult<JsonValue> => ({ output, modelText, filesTouched });

const make = (
  name: WriteName,
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
    plan: (input, _n): ToolPlan => ({
      kind: name === 'write_file' ? 'tool.write_file' : 'tool.patch_file',
      replayClass: 'verifiable',
      verify: { tool: name, input },
    }),
    execute,
    verifyAfterCrash: async (record: EffectRecord, ctx: ToolExecContext) => {
      const request = record.request as unknown as { path?: string; content?: string };
      if (!request.path) return 'in-doubt';
      try {
        const path = ctx.paths.resolve(request.path, ctx.workspaceRoot, 'read');
        if (!path.ok) return 'in-doubt';
        const bytes = await readFile(path.value.canonical);
        return request.content !== undefined && digest(bytes) === digest(request.content) ? 'done' : 'not-done';
      } catch {
        return 'not-done';
      }
    },
    describeForNote: (record) => `${name} ${record.idempotencyKey}`,
  };
};

const atomicWrite = async (target: string, content: string): Promise<void> => {
  const temporary = join(dirname(target), `.cohorte-write-${process.pid}-${Date.now()}`);
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, target);
};

const writeFileTool = make('write_file', async (input, n, _ctx, signal) => {
  if (signal.aborted) fail('tool-transient/cancelled', 'write was cancelled');
  const target = requiredPath(n);
  const value = input as { path: string; content: string };
  let before: Uint8Array | undefined;
  try {
    before = await readFile(target);
  } catch {
    /* create */
  }
  await atomicWrite(target, value.content);
  const after = Buffer.from(value.content);
  const path = n.paths[0]?.resolved.relative ?? value.path;
  return result({ path, bytes: after.byteLength, sha256: digest(after) }, `wrote ${after.byteLength} bytes`, [
    {
      path,
      op: before === undefined ? 'create' : 'modify',
      ...(before === undefined ? {} : { beforeSha256: digest(before) }),
      afterSha256: digest(after),
      bytes: after.byteLength,
    },
  ]);
});

const patchFileTool = make('patch_file', async (input, n, _ctx, signal) => {
  if (signal.aborted) fail('tool-transient/cancelled', 'patch was cancelled');
  const target = requiredPath(n);
  const value = input as { path: string; edits: { oldText: string; newText: string }[] };
  const before = await readFile(target, 'utf8');
  let next = before;
  for (const edit of value.edits) {
    const count = next.split(edit.oldText).length - 1;
    if (count !== 1) fail('tool-terminal/patch-mismatch', `expected one occurrence, found ${count}`);
    next = next.replace(edit.oldText, edit.newText);
  }
  await atomicWrite(target, next);
  const after = Buffer.from(next);
  const path = n.paths[0]?.resolved.relative ?? value.path;
  return result(
    { path, bytes: after.byteLength, sha256: digest(after), edits: value.edits.length },
    `patched ${path}`,
    [
      {
        path,
        op: 'modify',
        beforeSha256: digest(Buffer.from(before)),
        afterSha256: digest(after),
        bytes: after.byteLength,
      },
    ],
  );
});

export const WRITE_TOOLS: Readonly<Record<WriteName, ToolImplementation>> = Object.freeze({
  write_file: writeFileTool,
  patch_file: patchFileTool,
});
