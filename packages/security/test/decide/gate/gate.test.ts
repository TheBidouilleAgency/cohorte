import type { AgentId, RunId, ToolCallId } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import type { PolicyPorts, PolicySnapshot, ToolIntrospection } from '../../../src/contract/index.ts';
import { createCommandPolicy } from '../../../src/decide/commands/index.ts';
import { createPolicyEngine } from '../../../src/decide/gate/index.ts';
import { createGlobMatcher } from '../../../src/decide/paths/index.ts';

const schema = { type: 'object', properties: {}, additionalProperties: false } as const;

const ports = {
  paths: {},
  branches: { branchOf: () => ({ kind: 'detached-or-unknown', protected: true }) },
  budgets: { remaining: () => ({}), callsInLastMinute: () => 0 },
  programs: { resolve: () => undefined },
  clock: { now: () => '2026-09-19T00:00:00.000Z' },
} as unknown as PolicyPorts;

const policy = {
  commands: { default: 'deny', rules: [] },
  symlinks: { read: 'deny', write: 'deny' },
  network: { default: 'deny', allowHosts: [] },
  protectedBranches: ['main'],
  ownership: {},
  sandboxLevel: 'L0-process',
  digest: 'a'.repeat(64),
} as unknown as PolicySnapshot;

const grant = {
  agentId: 'agt_gate_test',
  role: 'implementer',
  digest: 'a'.repeat(64),
  tools: [],
  roots: { workspace: '/tmp/work', readOnly: [] },
  read: { include: ['**'], exclude: [] },
  write: { include: [], exclude: [] },
  denyRead: { include: [], exclude: [] },
  denyWrite: { include: [], exclude: [] },
  commands: { default: 'deny', rules: [] },
  secrets: [],
  temporary: [],
  limits: { maxToolCalls: 1, maxCallsPerMinute: 1, perTool: {} },
} as never;

function engine(tools: ToolIntrospection) {
  return createPolicyEngine({
    tools,
    globs: createGlobMatcher(),
    commands: createCommandPolicy({
      programs: { resolve: () => undefined },
      branches: { branchOf: ports.branches.branchOf },
    }),
  });
}

describe('PolicyEngine gate', () => {
  test('fails closed for an unknown tool before path or command evaluation', () => {
    const result = engine({ schemaOf: () => undefined, pathArgsOf: () => [] }).evaluate(
      {
        runId: 'run_gate_test' as RunId,
        agentId: 'agt_gate_test' as AgentId,
        incarnation: 1,
        toolCallId: 'tc_gate_test_1' as ToolCallId,
        tool: 'unknown_tool',
        input: {},
        phase: 'BUILD',
        role: 'implementer',
      },
      grant,
      policy,
      ports,
    );

    expect(result.decision).toBe('deny');
    expect(result.stage).toBe('schema');
    expect(result.securityViolation).toBe(true);
    expect(result.normalized).toBeNull();
  });

  test('denies a valid tool that is absent from the agent grant', () => {
    const result = engine({ schemaOf: () => schema, pathArgsOf: () => [] }).evaluate(
      {
        runId: 'run_gate_test' as RunId,
        agentId: 'agt_gate_test' as AgentId,
        incarnation: 1,
        toolCallId: 'tc_gate_test_1' as ToolCallId,
        tool: 'read_file',
        input: {},
        phase: 'BUILD',
        role: 'implementer',
      },
      grant,
      policy,
      ports,
    );

    expect(result.decision).toBe('deny');
    expect(result.stage).toBe('capability');
    expect(result.ruleId).toBe('grant/tool-not-granted');
  });
});
