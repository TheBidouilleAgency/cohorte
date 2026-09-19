import { describe, expect, test } from 'vitest';
import type { ToolExecContext } from '../../../src/catalogue/types.ts';
import { STATE_TOOLS } from '../../../src/impl/state/index.ts';

describe('state tools', () => {
  test('delegates approval requests to the host context', async () => {
    const ctx = {
      requestApproval: async (question: string, options?: readonly string[]) => ({
        decision: 'allow-once' as const,
        answer: `${question}:${options?.join(',') ?? ''}`,
      }),
    } as unknown as ToolExecContext;

    const result = await STATE_TOOLS.approval_request.execute(
      { question: 'Continue?', options: ['yes'] },
      {} as never,
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toEqual({ decision: 'allow-once', answer: 'Continue?:yes' });
    expect(result.modelText).toBe('Continue?:yes');
  });

  test('rejects a result that the host does not accept', async () => {
    const ctx = {
      acceptResult: async () => ({ accepted: false, reason: 'missing field' }),
    } as unknown as ToolExecContext;

    await expect(
      STATE_TOOLS.submit_result.execute({ value: 1 }, {} as never, ctx, new AbortController().signal),
    ).rejects.toThrow('validation/agent-output: missing field');
  });
});
