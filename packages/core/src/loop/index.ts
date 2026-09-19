import type { CheckResult, EscalationStep, ReviewResult, StopRecord } from '@cohorte/protocol';
import type { LoopDecision, LoopPolicy, LoopState } from '../contract/types.ts';

export interface LoopController {
  decideAfterReview(review: ReviewResult | null, loop: LoopState, policy: LoopPolicy): LoopDecision;
  decideAfterTest(checks: readonly CheckResult[], loop: LoopState, policy: LoopPolicy): LoopDecision;
}
export type LoopDeps = Record<string, never>;

const stop = (
  reason: StopRecord['reason'],
  detail: string,
  resumeRequires?: StopRecord['resumeRequires'],
): LoopDecision => ({
  kind: 'stop',
  stop: { reason, detail, resumable: true, ...(resumeRequires === undefined ? {} : { resumeRequires }) },
});

function nextEscalation(loop: LoopState, policy: LoopPolicy): EscalationStep | undefined {
  if (loop.escalations.length >= policy.escalation.maxPerRun) return undefined;
  return policy.escalation.ladder[loop.escalations.length];
}

function stalled(fingerprint: string, blocking: number, loop: LoopState, policy: LoopPolicy): boolean {
  if (loop.seenFingerprints.includes(fingerprint)) return true;
  const window = loop.history.slice(-Math.max(1, policy.noProgressWindow));
  return window.length >= policy.noProgressWindow && window.every((record) => blocking >= record.blocking);
}

function decide(fingerprint: string, blocking: number, loop: LoopState, policy: LoopPolicy): LoopDecision {
  const previous = loop.history.at(-1);
  if (previous?.fingerprint === fingerprint) {
    const step = nextEscalation(loop, policy);
    return step
      ? // biome-ignore lint/suspicious/noThenProperty: `then` is part of the frozen LoopDecision contract.
        { kind: 'escalate', step, then: 'continue' }
      : stop('identical-failure', `review fingerprint ${fingerprint} repeated`);
  }
  if (stalled(fingerprint, blocking, loop, policy)) {
    const step = nextEscalation(loop, policy);
    return step
      ? // biome-ignore lint/suspicious/noThenProperty: `then` is part of the frozen LoopDecision contract.
        { kind: 'escalate', step, then: 'continue' }
      : stop('no-progress', `review fingerprint ${fingerprint} made no progress`);
  }
  if (loop.fixRounds >= Math.min(10, Math.max(1, policy.maxFixRounds))) {
    return stop('iteration-limit', `maximum fix rounds reached (${policy.maxFixRounds})`, 'budget-raise');
  }
  return { kind: 'continue', fingerprint };
}

export function createLoopController(_deps: LoopDeps): LoopController {
  return {
    decideAfterReview(review, loop, policy): LoopDecision {
      if (review === null) return stop('agent-dead', 'reviewer did not return a result', 'human-ack');
      if (review.unreviewed.length > 0)
        return stop('unreviewed', `${review.unreviewed.length} surface(s) were not reviewed`, 'human-ack');
      if (review.deferred.length > 0)
        return stop(
          'approval-required',
          `${review.deferred.length} deferred finding(s) need a human decision (review-leftovers)`,
          'approval',
        );
      if (review.clean) return { kind: 'ship' };
      if (review.kept.some((finding) => finding.kind === 'security'))
        return stop('approval-required', 'security finding requires human review', 'approval');
      return decide(review.fingerprint, review.blocking, loop, policy);
    },
    decideAfterTest(checks, loop, policy): LoopDecision {
      const errored = checks.find((check) => check.status === 'errored');
      if (errored) return stop('check-environment', `check errored: ${errored.name}`, 'environment-repair');
      const fingerprint = checks
        .filter((check) => check.status === 'failed')
        .map((check) => `${check.name}:${check.treeDigest}`)
        .sort()
        .join('\n');
      if (fingerprint === '') return { kind: 'continue', fingerprint: '' };
      return decide(fingerprint, checks.filter((check) => check.status === 'failed').length, loop, policy);
    },
  };
}
