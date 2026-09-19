import type { JsonValue } from '@cohorte/base';
import type { EffectRecord } from '@cohorte/persistence/contract';
import { CATALOGUE_ROWS } from '../../catalogue/schemas.ts';
import type { ToolExecContext, ToolExecuteResult, ToolImplementation, ToolPlan } from '../../catalogue/types.ts';

export const EXEC_TOOL_NAMES = ['run_command'] as const;
const metadata = CATALOGUE_ROWS.find((row) => row.name === 'run_command');
if (!metadata) throw new Error('missing catalogue row: run_command');
const fail = (code: string, message: string): never => {
  throw new Error(`${code}: ${message}`);
};

const runCommand: ToolImplementation = {
  ...metadata,
  plan(input, n): ToolPlan {
    return {
      kind: 'tool.run_command',
      replayClass: n.command?.replay ?? 'at-most-once',
      verify: { tool: 'run_command', input, normalized: JSON.parse(JSON.stringify(n)) as JsonValue },
    };
  },
  async execute(input, n, ctx: ToolExecContext, signal): Promise<ToolExecuteResult<JsonValue>> {
    if (signal.aborted) fail('tool-transient/cancelled', 'command was cancelled');
    const command = n.command ?? fail('permission/command-not-allowed', 'run_command has no normalized command');
    const value = input as { argv: string[]; timeoutMs?: number };
    const result = await ctx.executor.run(
      {
        file: command.file,
        args: command.args,
        cwd: command.cwd,
        env: {},
        fs: { readWrite: [ctx.workspaceRoot], readOnly: [], denyRead: [] },
        network: 'none',
        timeoutMs: value.timeoutMs ?? command.timeoutMs,
        maxOutputBytes: 1024 * 1024,
        stdin: 'ignore',
        limits: {},
        require: 'best-effort',
      },
      signal,
    );
    const text = String(result.tail);
    return {
      output: {
        argv: value.argv,
        exitCode: result.exitCode,
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        outcome: result.outcome,
        text,
        outputSha256: result.outputSha256,
        outputBytes: result.outputBytes,
        truncated: result.truncated,
      },
      modelText: text,
      filesTouched: [],
    };
  },
  verifyAfterCrash: async (_record: EffectRecord) => 'in-doubt',
  describeForNote: (record) => `run_command ${record.idempotencyKey}`,
};

export const EXEC_TOOLS: Readonly<Record<(typeof EXEC_TOOL_NAMES)[number], ToolImplementation>> = Object.freeze({
  run_command: runCommand,
});
