import { type ErrorInfo, type JsonValue, toErrorInfo } from '@cohorte/base';
import type { CheckResult, Finding, StopRecord } from '@cohorte/protocol';
import { Value } from 'typebox/value';
import type { PhasesExecutorDeps } from '../../contract/factories.ts';
import type { PhaseExecutor as PhaseExecutorPort } from '../../contract/internal.ts';
import type { AgentResult, PhaseOutcome } from '../../contract/types.ts';

function slotsOf(plans: readonly Parameters<PhasesExecutorDeps['supervisor']['runAgents']>[0][number][]) {
  return [...new Set(plans.flatMap((plan) => (plan.workspace.kind === 'slot' ? [plan.workspace.slot] : [])))];
}

const error = (code: string, message: string, remediation: string): ErrorInfo => ({
  code,
  class: 'validation' as const,
  message,
  impact: 'The current phase cannot produce a valid durable outcome.',
  retryable: false,
  remediation,
});

const failed = (
  code: 'agent-dead' | 'outputs-invalid' | 'checks-red',
  failure: ReturnType<typeof error>,
  findings: Finding[] = [],
  checks: CheckResult[] = [],
): PhaseOutcome => ({
  kind: 'failed',
  failure: { code, error: failure, findings },
  checks,
});

/** Provider auth/quota failures park the run; they are not ordinary failed phases. */
function suspendedProviderStop(info: ErrorInfo): StopRecord | undefined {
  const code = info.code.toLowerCase();
  if (
    code.includes('auth') ||
    code.includes('unauthorized') ||
    code.includes('forbidden') ||
    info.class === 'human-required'
  ) {
    return { reason: 'auth-required', detail: info.message, resumable: true };
  }
  if (code.includes('quota') || code.includes('rate-limit') || code.includes('rate_limited')) {
    return { reason: 'quota-exceeded', detail: info.message, resumable: true };
  }
  return undefined;
}

/**
 * Executes the deterministic phase contract around the supervisor.
 *
 * Worktree acquisition, commit and merge are deliberately owned by the phase
 * contracts and their services; the executor only coordinates the frozen
 * contract boundary: resolve -> plan -> run -> assemble.
 */
export function createPhaseExecutor(deps: PhasesExecutorDeps): PhaseExecutorPort {
  return {
    async execute(ctx) {
      const contract = deps.contracts.get(ctx.phase.state);
      if (!contract) {
        return failed(
          'outputs-invalid',
          error(
            'configuration/phase-contract-missing',
            `No contract is registered for ${ctx.phase.state}.`,
            'Install a compatible phase contract.',
          ),
        );
      }

      const resolved = contract.resolveInputs(ctx);
      if (!resolved.ok) return failed('outputs-invalid', resolved.error);

      let results: AgentResult[];
      try {
        const plans = contract.planAgents(resolved.value, ctx);
        const slots = slotsOf(plans);
        if (typeof deps.worktrees.acquire === 'function') {
          for (const plan of plans) {
            if (plan.workspace.kind === 'slot') {
              const worktree = await deps.worktrees.acquire(plan.workspace.slot, plan.agentId);
              if (deps.store) {
                await deps.store.transact({ runId: ctx.run.run.runId }, ctx.lease, (tx) => {
                  tx.putWorktree(worktree);
                });
              }
            }
          }
        }
        results = await deps.supervisor.runAgents(plans, ctx);
        if (ctx.phase.state === 'TEST' && deps.checkRunner) {
          const checks = await deps.checkRunner.run(ctx);
          const erroredCheck = checks.find((check) => check.status === 'errored');
          if (erroredCheck)
            return {
              kind: 'suspended',
              stop: {
                reason: 'check-environment',
                detail: `check errored: ${erroredCheck.name}`,
                resumable: true,
                resumeRequires: 'environment-repair',
              },
              error: error(
                'validation/check-environment',
                `Project check ${erroredCheck.name} could not run.`,
                'Repair the check environment and resume the run.',
              ),
            };
          const failedChecks = checks.filter((check) => check.status === 'failed');
          if (failedChecks.length > 0)
            return failed(
              'checks-red',
              error(
                'validation/checks-red',
                `${failedChecks.length} project check(s) failed.`,
                'Fix the integration tree and run the checks again.',
              ),
              [],
              checks,
            );
          return { kind: 'passed', output: { checks } as JsonValue, artifacts: [], checks };
        }
        const failedAgent = results.find((result) => result.outcome !== 'completed');
        if (!failedAgent && slots.length > 0 && typeof deps.integration.commit === 'function') {
          for (const slot of slots) await deps.integration.commit(slot, 'result');
          if (typeof deps.integration.merge === 'function' && slots.length > 0) {
            for (const slot of slots) {
              const merged = await deps.integration.merge(slot, '_integration');
              if ('kind' in merged && merged.kind === 'conflict') {
                return {
                  kind: 'failed',
                  failure: {
                    code: 'merge-conflict',
                    error: error(
                      'conflict/merge-conflict',
                      `Integration conflict in ${slot}: ${merged.files.join(', ') || 'unknown files'}.`,
                      'Resolve the conflict and retry the phase.',
                    ),
                    findings: [],
                  },
                };
              }
            }
          }
          if (typeof deps.worktrees.release === 'function') {
            for (const slot of slots) await deps.worktrees.release(slot);
          }
        }
      } catch (cause) {
        const providerStop = suspendedProviderStop(
          toErrorInfo(cause, { code: 'provider-terminal/agent-failed', class: 'provider-terminal' }),
        );
        if (providerStop)
          return {
            kind: 'suspended',
            stop: providerStop,
            error: toErrorInfo(cause, { code: 'provider-terminal/agent-failed', class: 'provider-terminal' }),
          };
        return failed(
          'agent-dead',
          error(
            'provider-terminal/phase-agent-failed',
            cause instanceof Error ? cause.message : 'The phase supervisor failed.',
            'Inspect the agent runtime and resume the run.',
          ),
        );
      }

      const failedAgent = results.find((result) => result.outcome !== 'completed');
      if (failedAgent) {
        const providerStop = failedAgent.error && suspendedProviderStop(failedAgent.error);
        if (providerStop)
          return {
            kind: 'suspended',
            stop: providerStop,
            ...(failedAgent.error ? { error: failedAgent.error } : {}),
          };
        return failed(
          'agent-dead',
          failedAgent.error ??
            error(
              'provider-terminal/agent-incomplete',
              `Agent ${failedAgent.agent.agentId} did not complete.`,
              'Retry or replace the failed agent.',
            ),
        );
      }

      const assembled = contract.assemble(resolved.value, results, ctx);
      if (!assembled.ok) return failed('outputs-invalid', assembled.error);
      if (!Value.Check(contract.outputSchema, assembled.value))
        return failed(
          'outputs-invalid',
          error(
            'validation/phase-output-invalid',
            `Phase ${ctx.phase.state} produced an output that does not match contract ${contract.id}@${contract.version}.`,
            'Inspect the phase handoff and retry it with a valid structured output.',
          ),
        );
      for (const check of contract.checks) {
        if (!check.evaluate(resolved.value, assembled.value, ctx))
          return failed(
            'outputs-invalid',
            error(
              `validation/phase-check-${check.id}`,
              `Phase check ${check.id} failed for ${ctx.phase.state}.`,
              'Resolve the failed phase check and retry the phase.',
            ),
          );
      }
      if (
        ctx.phase.state === 'REVIEW' &&
        typeof assembled.value === 'object' &&
        assembled.value !== null &&
        'review' in assembled.value &&
        typeof assembled.value.review === 'object' &&
        assembled.value.review !== null &&
        'clean' in assembled.value.review &&
        assembled.value.review.clean === false
      ) {
        const review = assembled.value.review as {
          blockingItems?: string[];
          kept?: Finding[];
        };
        return failed(
          'checks-red',
          error(
            'validation/review-findings',
            `Review found ${review.kept?.length ?? 0} finding(s).`,
            'Run the FIX phase and review again.',
          ),
          review.kept ?? [],
        );
      }

      return {
        kind: 'passed',
        output: assembled.value as JsonValue,
        artifacts: results.flatMap((result) => result.artifacts),
      };
    },
  };
}
