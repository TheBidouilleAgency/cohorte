import type { RunId } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { createApprovalService } from '../../src/approvals/index.ts';

describe('approval service', () => {
  test('records a pending approval with a stable grant key', () => {
    let stored: Record<string, unknown> | undefined;
    const tx = {
      run: () => ({ runId: 'run_01J0000000000000000000000A' as RunId, lastSequence: 0 }),
      putApproval: (record: Record<string, unknown>) => {
        stored = record;
      },
    };
    const service = createApprovalService({
      store: {} as never,
      clock: { now: () => '2026-01-01T00:00:00.000Z' } as never,
      ids: { next: () => 'apr_01J0000000000000000000000A' } as never,
      events: {
        append: () => [{ sequence: 1 }],
      } as never,
    });

    const id = service.request(
      tx as never,
      {
        idempotencyKey: 'tool:one',
        grantKey: '',
        kind: 'tool',
        tool: 'write_file',
        preview: { text: 'write note.txt' },
        call: { tool: 'write_file' },
      } as never,
    );

    expect(id).toBe('apr_01J0000000000000000000000A');
    expect(stored).toMatchObject({ status: 'pending', idempotencyKey: 'tool:one', requestedSeq: 1 });
    expect(typeof stored?.grantKey).toBe('string');
  });
});
