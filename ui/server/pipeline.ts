// Where a spec stands in the pipeline, derived ONLY from what the pipeline itself writes: the spec's `status`
// (profile/schema/spec-status.md) and the machine reports under specs/reports/ — readiness.json and build.json
// (/cohorte-build), verdict.json (/cohorte-review), verify.json (/cohorte-verify), loop.json (the loop workflow).
// Nothing here guesses; an unreadable report counts as absent.

import fs from 'fs';
import path from 'path';
import type { PipelineInfo, PipelineStage, StageState } from '../shared/api';

const STAGES: { key: string; label: string }[] = [
  { key: 'spec', label: 'Spec' }, { key: 'build', label: 'Build' }, { key: 'review', label: 'Review' },
  { key: 'verify', label: 'Verify' }, { key: 'ship', label: 'Ship' },
];

type Json = Record<string, any> | null;
function readJson(file: string): Json {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

export function reportsOf(root: string, id: string): Record<'readiness' | 'build' | 'verdict' | 'verify' | 'loop', Json> {
  const r = (k: string): Json => readJson(path.join(root, 'specs', 'reports', `${id}.${k}.json`));
  return { readiness: r('readiness'), build: r('build'), verdict: r('verdict'), verify: r('verify'), loop: r('loop') };
}

export function pipelineOf(root: string, spec: { id: string; status?: string; kind?: string }): PipelineInfo {
  const status = String(spec.status || 'draft');
  const rep = reportsOf(root, spec.id);
  const closed = status === 'shipped' || status === 'merged';
  const abandoned = status === 'abandoned';

  const built = !!rep.build;
  const buildFailed = built && (Object.values(rep.build?.surfaces || {}).some((v) => v !== 'ok') || (rep.build?.dead || []).length > 0);
  const notReady = rep.readiness && rep.readiness.verdict && rep.readiness.verdict !== 'READY';
  const verdict = rep.verdict?.verdict as string | undefined;
  const reviewed = !!rep.verdict && !rep.verdict.aborted;
  const shipOk = verdict === 'SHIP' && !(rep.verdict?.unreviewed || []).length;
  const verifyVerdict = rep.verify?.verdict as string | undefined;

  const state: Record<string, StageState> = {};
  state.spec = status === 'draft' ? 'current' : 'done';
  state.build = closed || built ? (buildFailed ? 'blocked' : 'done') : notReady ? 'blocked' : state.spec === 'done' ? 'current' : 'todo';
  state.review = closed ? 'done' : reviewed ? (shipOk ? 'done' : 'blocked') : state.build === 'done' ? 'current' : 'todo';
  state.verify = closed ? 'done' : verifyVerdict === 'PASS' ? 'done' : verifyVerdict === 'FAIL' ? 'blocked' : verifyVerdict === 'SKIPPED' ? 'skipped' : shipOk ? 'current' : 'todo';
  state.ship = closed ? 'done' : shipOk && (verifyVerdict === 'PASS' || verifyVerdict === 'SKIPPED') ? 'current' : 'todo';
  if (abandoned) for (const k of Object.keys(state)) if (state[k] !== 'done') state[k] = 'todo';

  // The next command a human would type — the same routing the commands themselves document.
  let next: PipelineInfo['next'] = null;
  const id = spec.id;
  if (abandoned || status === 'merged') next = null;
  else if (status === 'shipped') next = { command: 'cohorte-ship', args: id, why: 'reconcile the PR with the host (merged / closed)' };
  else if (status === 'draft') next = { command: 'cohorte-spec', args: id, why: 'the interview is open — freeze the contract' };
  else if (status === 'blocked') next = { command: 'cohorte-fix', args: id, why: `a round gave up${rep.loop?.reason ? `: ${rep.loop.reason}` : ''}` };
  else if (state.build === 'blocked') next = { command: 'cohorte-build', args: id, why: notReady ? 'the spec is not ready to build' : 'a surface failed to build' };
  else if (state.build === 'current') next = { command: 'cohorte-build', args: id, why: 'the contract is frozen' };
  else if (state.review === 'current') next = { command: 'cohorte-review', args: id, why: 'built — audit it against the spec' };
  else if (state.review === 'blocked') next = { command: 'cohorte-fix', args: id, why: verdict ? `review verdict ${verdict}` : 'review has no usable verdict' };
  else if (state.verify === 'blocked') next = { command: 'cohorte-verify', args: id, why: 'the last verification failed' };
  else if (state.verify === 'current') next = { command: 'cohorte-verify', args: id, why: 'review passed — run it for real' };
  else if (state.ship === 'current') next = { command: 'cohorte-ship', args: id, why: 'review and verification are clean' };

  const stages: PipelineStage[] = STAGES.map((s) => ({ ...s, state: state[s.key] }));
  return {
    stages, next,
    verdict: reviewed ? {
      verdict: String(verdict || ''), blocking: num(rep.verdict?.blocking), findings: num(rep.verdict?.findings), security: num(rep.verdict?.security),
      deferred: num(rep.verdict?.deferred), ts: str(rep.verdict?.ts),
    } : null,
    loop: rep.loop ? { outcome: str(rep.loop.outcome), reason: str(rep.loop.reason) } : null,
  };
}
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
