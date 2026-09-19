import { canonicalCommandBody, PROTOCOL_VERSION } from '@cohorte/protocol';
import { describe, expect, test } from 'vitest';

describe('public protocol', () => {
  test('canonical command bodies are stable and versioned', () => {
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'cmd_1',
      type: 'status',
      runId: 'run_1',
      issuedAt: '2026-09-19T00:00:00.000Z',
      actor: { kind: 'human', id: 'test', transport: 'cli' },
      payload: {},
    } as never;
    expect(PROTOCOL_VERSION).toBe('1.0');
    expect(canonicalCommandBody(body)).toContain('protocolVersion');
  });
});
