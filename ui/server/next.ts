// The autopilot's routing between two checkpoints, as a pure function: where a feature stands (the pipeline's own
// reports, through pipelineOf) plus what the autopilot remembers (rounds, the last blocking count, failures) in;
// the next stage to run — or the checkpoint to open, and why — out.
//
// CP2 ("course check") opens only on a signal that a human should look before more money is spent:
//   - a stage failed twice (or a human stopped it);
//   - the spec is NOT-READY (the lead has to fix it), or a surface came back dead/failed from a build;
//   - the review found a security issue (BLOCK) — never auto-fixed;
//   - the spec had RESERVATIONS: after the first build, check the direction once before reviewing;
//   - the fix loop is out of rounds, or treading water (blocking findings not going down).
// CP3 opens when review and verification are clean: what ships is the human's call.

import type { CheckpointKind, PipelineInfo, ProjectSettings, StageRecord } from '../shared/api';
import { escalate } from './settings';

export type Stage = 'build' | 'review' | 'fix' | 'verify';
export interface Signals {
  pipeline: PipelineInfo;
  readiness: string | null;
  verdict: { verdict: string | null; blocking: number | null; high: number; medium: number; aborted: string | null } | null;
  verify: string | null;
  buildDead: boolean;
}
export interface Memory { rounds: number; lastBlocking: number | null; reservationsAck: boolean; failures: Record<string, number>; stages: StageRecord[] }
export type Step =
  | { kind: 'run'; stage: Stage; model: string; args: string; note: string }
  | { kind: 'checkpoint'; cp: CheckpointKind; reason: string };

const modelFor = (stage: Stage, s: ProjectSettings): string => s.models[stage];

export function nextStep(id: string, sig: Signals, mem: Memory, s: ProjectSettings): Step {
  const cp2 = (reason: string): Step => ({ kind: 'checkpoint', cp: 'cp2', reason });
  const last = mem.stages[mem.stages.length - 1];

  // 1. the stage that just ended did not finish
  if (last && last.status !== 'done' && last.stage !== 'ship') {
    if (last.status === 'stopped') return cp2(`you stopped the ${last.stage} run`);
    const n = mem.failures[last.stage] || 0;
    if (n >= 2) return cp2(`the ${last.stage} run failed twice${last.note ? `: ${last.note}` : ''}`);
    if (['build', 'review', 'fix', 'verify'].includes(last.stage)) {
      const st = last.stage as Stage;
      return { kind: 'run', stage: st, model: escalate(last.model || modelFor(st, s)), args: last.stage === 'fix' ? `${id} the previous fix run died before finishing — redo its open Remediation items` : id, note: 'retry after a failed run, one model up' };
    }
  }

  // 2. signals that stop the line
  if (sig.readiness === 'NOT-READY') return cp2('the spec is not ready to build — the lead has to complete it');

  // The pipeline's reports cannot tell a fixed tree from a reviewed one (verdict.json is only rewritten by a review),
  // so the autopilot's own memory routes the loop: after a fix, always a review — before the last verdict is read.
  const lastDone = [...mem.stages].reverse().find((x) => x.status === 'done');
  if (lastDone?.stage === 'fix') return { kind: 'run', stage: 'review', model: modelFor('review', s), args: id, note: 'after a fix round' };
  // a review that aborted certifies nothing: a red preflight is a fix round, anything else a human's call
  if (sig.verdict?.aborted && lastDone?.stage === 'review') {
    if (sig.verdict.aborted !== 'preflight') return cp2(`the review aborted (${sig.verdict.aborted})`);
    if (mem.rounds >= s.maxRounds) return cp2(`${mem.rounds} fix rounds and the preflight is still red`);
    return { kind: 'run', stage: 'fix', model: modelFor('fix', s), args: `${id} the review's preflight is red — read specs/reports/${id}.preflight.txt and make typecheck, lint and tests pass`, note: 'preflight red' };
  }
  if (sig.verdict?.verdict === 'BLOCK' && !sig.verdict.aborted) return cp2('the review found a security issue (BLOCK) — not fixed without you');

  let next = sig.pipeline.next?.command || null;
  // a verify.json FAIL from before the last fix/review is stale: verify again instead of fixing again
  if (next === 'cohorte-verify' && sig.verify === 'FAIL' && lastDone?.stage !== 'verify') next = 'cohorte-verify-again';
  const built = mem.stages.some((x) => x.stage === 'build' && x.status === 'done');

  // a SHIP that still carries HIGH/MEDIUM findings is not a clean bill: /cohorte-ship would refuse it
  const dirtyShip = sig.verdict?.verdict === 'SHIP' && (sig.verdict.high > 0 || sig.verdict.medium > 0);

  if (next === 'cohorte-build') {
    if (built && (sig.buildDead || sig.pipeline.stages.find((x) => x.key === 'build')?.state === 'blocked')) return cp2('a surface failed or died during the build');
    return { kind: 'run', stage: 'build', model: modelFor('build', s), args: id, note: '' };
  }
  if (next === 'cohorte-review') {
    if (sig.readiness === 'RESERVATIONS' && !mem.reservationsAck && built) return cp2('the spec had reservations — check the direction of the first build before the review');
    return { kind: 'run', stage: 'review', model: modelFor('review', s), args: id, note: '' };
  }
  const wantsFix = next === 'cohorte-fix' || dirtyShip || (next === 'cohorte-verify' && sig.verify === 'FAIL');
  if (wantsFix) {
    if (mem.rounds >= s.maxRounds) return cp2(`${mem.rounds} fix round${mem.rounds === 1 ? '' : 's'} and the review still says ${sig.verdict?.verdict || 'no'}`);
    const blocking = sig.verdict?.blocking ?? null;
    const stuck = mem.rounds >= 2 && blocking !== null && mem.lastBlocking !== null && blocking >= mem.lastBlocking;
    if (stuck) return cp2(`the fix loop is treading water (${blocking} blocking finding${blocking === 1 ? '' : 's'}, not going down)`);
    const noProgress = mem.rounds >= 1 && blocking !== null && mem.lastBlocking !== null && blocking >= mem.lastBlocking;
    const model = noProgress ? escalate(modelFor('fix', s)) : modelFor('fix', s);
    let args = id;
    if (next === 'cohorte-verify' && sig.verify === 'FAIL') args = `${id} the runtime verification failed — read specs/reports/${id}.verify.json for the failing checks`;
    else if (next !== 'cohorte-fix' && dirtyShip) args = `${id} the review passed with HIGH/MEDIUM findings left — fix them (specs/reports/${id}.md)`;
    return { kind: 'run', stage: 'fix', model, args, note: noProgress ? 'no progress last round — one model up' : '' };
  }
  if (next === 'cohorte-verify' || next === 'cohorte-verify-again') return { kind: 'run', stage: 'verify', model: modelFor('verify', s), args: id, note: '' };
  if (next === 'cohorte-ship') return { kind: 'checkpoint', cp: 'cp3', reason: 'review and verification are clean — ready to ship' };
  if (next === 'cohorte-spec') return cp2('the spec is not frozen');
  return cp2(sig.pipeline.next ? `unexpected next step: ${sig.pipeline.next.command}` : 'nothing left to run, but nothing shipped either');
}
