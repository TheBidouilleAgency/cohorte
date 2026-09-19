import type { RuntimeToolCall } from '@cohorte/runtime-contract';
import type { PolicyVerdict } from '@cohorte/security/contract';
import { createRedactor } from '@cohorte/security/redact';
import { describe, expect, it } from 'vitest';
import type { ToolHostDeps } from '../../src/contract/factories.ts';
import { createToolHost } from '../../src/toolhost/index.ts';

const denied: PolicyVerdict = {
  decision: 'deny',
  stage: 'capability',
  ruleId: 'grant/tool-not-granted',
  reason: 'tool is not granted',
  modelFacingReason: 'This tool is not available. Do not retry.',
  overridable: false,
  securityViolation: false,
  asks: [],
  evaluatedRules: ['builtin/tool-schema', 'grant/tool-not-granted'],
  normalized: null,
};

const call = {
  runId: 'run_00000000000000000000000000000000',
  agentId: 'agt_implementer_main',
  incarnation: 1,
  toolCallId: 'tc_1_1',
  ordinal: 1,
  tool: 'write_file',
  input: {},
} as RuntimeToolCall;

describe('ToolHost', () => {
  it('returns a model-facing denial without invoking the registry', async () => {
    let lookedUp = false;
    const deps = {
      policy: { evaluate: () => denied },
      paths: {},
      toolRegistry: {
        get: () => {
          lookedUp = true;
          return undefined;
        },
        names: () => [],
      },
      journal: {},
      events: {},
      approvals: {},
      redactor: createRedactor(),
      policySnapshot: {},
      policyPorts: {},
      grantFor: () => ({}),
      executionFor: () => ({}),
      leaseFor: () => ({}),
      sandbox: {},
      requestApproval: async () => ({ decision: 'deny' as const }),
      recordRequested: async () => undefined,
      recordDenied: async () => undefined,
    } as unknown as ToolHostDeps;

    const result = await createToolHost(deps).handleToolCall(call, {
      signal: new AbortController().signal,
      progress: () => undefined,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(lookedUp).toBe(false);
  });
});
