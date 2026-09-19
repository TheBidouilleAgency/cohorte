import { describe, expect, test } from 'vitest';
import type { NormalizedCall, ToolExecContext } from '../../../src/catalogue/types.ts';
import { EXEC_TOOLS } from '../../../src/impl/exec/index.ts';

describe('exec tools', () => {
  test('passes the normalized command to the executor and returns output', async () => {
    const calls: unknown[] = [];
    const normalized = {
      tool: 'run_command',
      paths: [],
      command: {
        file: '/bin/echo',
        args: ['hello'],
        cwd: '/workspace',
        ruleId: 'echo',
        replay: 'safe',
        timeoutMs: 1000,
      },
      input: {},
    } as unknown as NormalizedCall;
    const ctx = {
      workspaceRoot: '/workspace',
      executor: {
        run: async (...args: unknown[]) => {
          calls.push(args);
          return {
            exitCode: 0,
            outcome: 'success',
            tail: 'hello\n',
            outputSha256: `sha256:${'a'.repeat(64)}`,
            outputBytes: 6,
            truncated: false,
          };
        },
      },
    } as unknown as ToolExecContext;

    const result = await EXEC_TOOLS.run_command.execute(
      { argv: ['echo', 'hello'] },
      normalized,
      ctx,
      new AbortController().signal,
    );

    expect(calls).toHaveLength(1);
    expect(result.output).toMatchObject({ argv: ['echo', 'hello'], exitCode: 0, outcome: 'success', text: 'hello\n' });
    expect(result.modelText).toBe('hello\n');
  });
});
