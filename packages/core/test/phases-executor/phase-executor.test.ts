import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { PhaseRunContext } from '../../src/contract/types.ts';
import { createPhaseExecutor } from '../../src/phases/executor/index.ts';

describe('PhaseExecutor', () => {
  it('returns a durable failure when the state has no registered contract', async () => {
    const executor = createPhaseExecutor({
      contracts: { get: () => undefined },
      supervisor: { runAgents: async () => [] },
      worktrees: {} as never,
      integration: {} as never,
      events: {} as never,
    });

    const context = {
      run: {},
      phase: { phaseRunId: 'phr_missing', state: 'BUILD', iteration: 0 },
      now: '2026-01-01T00:00:00.000Z',
      lease: {},
      signal: new AbortController().signal,
    } as unknown as PhaseRunContext;

    await expect(executor.execute(context)).resolves.toMatchObject({
      kind: 'failed',
      failure: { code: 'outputs-invalid', error: { code: 'configuration/phase-contract-missing' } },
    });
  });

  it('acquires agent slots, commits results and merges them into integration', async () => {
    const calls: string[] = [];
    const executor = createPhaseExecutor({
      contracts: {
        get: () => ({
          id: 'build',
          version: 1,
          state: 'BUILD',
          objectives: [],
          resolveInputs: () => ({ ok: true as const, value: {} }),
          planAgents: () => [
            {
              agentId: 'agt_1' as never,
              role: 'implementer',
              owner: 'src',
              promptId: 'agents/implementer',
              task: { role: 'implementer', objective: 'build', stablePrefix: 'build', ownedPaths: [], facts: {} },
              context: { tiers: [], includePaths: [] },
              tools: [],
              grant: { role: 'implementer', ownedPaths: [], tools: [] },
              modelTier: 'coding',
              budget: { maxEngineRetries: 0 },
              workspace: { kind: 'slot', slot: 'src' },
            },
          ],
          outputSchema: Type.Unknown(),
          checks: [],
          budget: () => ({}),
          stop: [],
          retry: { maxAttempts: 1, retryOn: [], backoff: { baseMs: 1, factor: 2, maxMs: 1, jitter: 'none' } },
          approvals: [],
          assemble: () => ({ ok: true as const, value: { done: true } }),
        }),
      },
      supervisor: {
        runAgents: async () =>
          [
            {
              agent: { agentId: 'agt_1' as never, role: 'implementer', incarnation: 1, attempt: 1 },
              outcome: 'completed' as const,
              artifacts: [],
              usage: {},
            },
          ] as never,
      },
      worktrees: {
        acquire: async (slot: string) => {
          calls.push(`acquire:${slot}`);
          return {} as never;
        },
      } as never,
      integration: {
        commit: async (slot: string) => {
          calls.push(`commit:${slot}`);
          return { sha: 'sha', treeDigest: 'tree' };
        },
        merge: async (slot: string, into: string) => {
          calls.push(`merge:${slot}:${into}`);
          return { mergeSha: 'merge', treeDigest: 'tree' };
        },
      } as never,
      events: {} as never,
    });
    const result = await executor.execute({ phase: { state: 'BUILD' } } as PhaseRunContext);
    expect(result).toMatchObject({ kind: 'passed', output: { done: true } });
    expect(calls).toEqual(['acquire:src', 'commit:src', 'merge:src:_integration']);
  });

  it('returns red checks from the TEST phase as a failed outcome', async () => {
    const check = {
      name: 'unit',
      status: 'failed' as const,
      argv: ['pnpm', 'test'],
      durationMs: 4,
      treeDigest: 'tree',
    };
    const executor = createPhaseExecutor({
      contracts: {
        get: () => ({
          id: 'test',
          version: 1,
          state: 'TEST',
          objectives: [],
          resolveInputs: () => ({ ok: true as const, value: {} }),
          planAgents: () => [],
          outputSchema: Type.Unknown(),
          checks: [],
          budget: () => ({}),
          stop: [],
          retry: { maxAttempts: 1, retryOn: [], backoff: { baseMs: 1, factor: 2, maxMs: 1, jitter: 'none' } },
          approvals: [],
          assemble: () => ({ ok: true as const, value: {} }),
        }),
      },
      supervisor: { runAgents: async () => [] },
      worktrees: {} as never,
      integration: {} as never,
      events: {} as never,
      checkRunner: { run: async () => [check] },
    });

    await expect(executor.execute({ phase: { state: 'TEST' } } as PhaseRunContext)).resolves.toMatchObject({
      kind: 'failed',
      failure: { code: 'checks-red', error: { code: 'validation/checks-red' } },
      checks: [check],
    });
  });

  it('parks the run when a TEST check cannot execute', async () => {
    const check = {
      name: 'unit',
      status: 'errored' as const,
      argv: ['pnpm', 'test'],
      durationMs: 4,
      treeDigest: 'tree',
    };
    const executor = createPhaseExecutor({
      contracts: {
        get: () => ({
          id: 'test',
          version: 1,
          state: 'TEST',
          objectives: [],
          resolveInputs: () => ({ ok: true as const, value: {} }),
          planAgents: () => [],
          outputSchema: Type.Unknown(),
          checks: [],
          budget: () => ({}),
          stop: [],
          retry: { maxAttempts: 1, retryOn: [], backoff: { baseMs: 1, factor: 2, maxMs: 1, jitter: 'none' } },
          approvals: [],
          assemble: () => ({ ok: true as const, value: {} }),
        }),
      },
      supervisor: { runAgents: async () => [] },
      worktrees: {} as never,
      integration: {} as never,
      events: {} as never,
      checkRunner: { run: async () => [check] },
    });

    await expect(executor.execute({ phase: { state: 'TEST' } } as PhaseRunContext)).resolves.toMatchObject({
      kind: 'suspended',
      stop: { reason: 'check-environment', resumeRequires: 'environment-repair' },
      error: { code: 'validation/check-environment' },
    });
  });
});
