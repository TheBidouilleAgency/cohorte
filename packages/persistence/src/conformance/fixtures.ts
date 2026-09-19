// Builders of the store conformance suite: plain, valid-shaped values. Nothing here is sealed — sealing goes through
// the hook the caller supplies, because only a Redactor may mint `Sealed<T>` (I7, check-layers rule f).
import type {
  AgentId,
  ApprovalId,
  ArtifactId,
  CommandId,
  EffectId,
  EventId,
  FindingId,
  IsoInstant,
  PhaseRunId,
  RunId,
  Sha256,
  SpecId,
} from '@cohorte/base';
import type { Actor, CommandEnvelope, RunPlan } from '@cohorte/protocol';
import type { EventDraft, LockOwner, LockRequest, RunRecord, TransitionRecord } from '../contract.ts';

export const T0 = '2026-01-01T00:00:00.000Z' as IsoInstant;
export const SHA_A = 'a'.repeat(64) as Sha256;
export const SHA_B = 'b'.repeat(64) as Sha256;

export const runId = (name: string): RunId => `run_${name}` as RunId;
export const agentId = (name: string): AgentId => `agt_${name}` as AgentId;
export const eventId = (name: string): EventId => `evt_${name}` as EventId;
export const commandId = (name: string): CommandId => `cmd_${name}` as CommandId;
export const approvalId = (name: string): ApprovalId => `apr_${name}` as ApprovalId;
export const effectIdOf = (name: string): EffectId => `eff_${name}` as EffectId;
export const artifactId = (name: string): ArtifactId => `art_${name}` as ArtifactId;
export const findingId = (name: string): FindingId => `fnd_${name}` as FindingId;
export const phaseRunId = (name: string): PhaseRunId => `phs_${name}` as PhaseRunId;

export const HUMAN: Actor = { kind: 'human', id: 'tester', transport: 'cli' };
export const SYSTEM: Actor = { kind: 'system', id: 'host-1', transport: 'cli' };

export const PLAN: RunPlan = {
  profile: 'feature',
  runtime: { id: 'fake', version: '0.0.0' },
  trust: { policySha256: SHA_A, loosenedKeys: [], grantedBy: 'none-needed' },
  models: [],
  apiBillingEnabled: false,
  meteredProviders: [],
  sandbox: { level: 'L0-process', backend: 'none', filesystem: 'advisory', network: 'unenforced' },
  sandboxRequire: 'best-effort',
  brainIsolation: 'process',
  budgets: { run: {}, perPhase: {}, perAgent: {}, perProvider: {}, perTool: {} },
  network: { provisioning: false },
  promptOverrides: [],
  unattended: true,
};

/** What the CLI writes at `start`: an IDLE row without the six host-computed columns. */
export function idleRun(id: RunId, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: id,
    profile: 'feature',
    tableVersion: 1,
    specId: 'spec-29' as SpecId,
    specSha256: SHA_A,
    title: `run ${id}`,
    state: 'IDLE',
    lastSequence: 0,
    lastHash: '',
    version: 0,
    pinnedInstallDir: '/opt/cohorte/3.0.0',
    baseBranch: 'main',
    cancelRequested: false,
    pauseRequested: false,
    schemaVersion: 1,
    cohorteVersion: '3.0.0',
    purgeable: false,
    startedAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** The six columns only the host can compute (T04). */
export const HOST_COLUMNS = {
  snapshotDigest: SHA_B,
  runtimePin: { runtime: 'fake', version: '0.0.0' },
  plan: PLAN,
  baseSha: '1'.repeat(40),
  integrationBranch: 'cohorte/run/integration',
  zones: ['src/app'],
} satisfies Partial<RunRecord>;

export function activeRun(id: RunId, overrides: Partial<RunRecord> = {}): RunRecord {
  return idleRun(id, { state: 'BUILD', ...HOST_COLUMNS, ...overrides });
}

export function draft(id: RunId, name: string, slot = 'main'): EventDraft {
  return {
    protocolVersion: '1.0',
    eventId: eventId(`${id}_${name}`),
    timestamp: T0,
    runId: id,
    type: 'check.started',
    source: 'cohorte',
    summary: `check ${name} started`,
    severity: 'info',
    payload: { name, argv: ['pnpm', 'test'], slot },
    redactions: [],
  };
}

export function hostDetachedDraft(id: RunId, name: string): EventDraft {
  return {
    protocolVersion: '1.0',
    eventId: eventId(`${id}_${name}`),
    timestamp: T0,
    runId: id,
    type: 'run.host.detached',
    source: 'cohorte',
    summary: 'host detached',
    severity: 'info',
    payload: { hostId: 'host-1', cause: 'exit' },
    redactions: [],
  };
}

export function anchorDraft(
  id: RunId,
  name: string,
  anchor: { atSequence: number; chainHash: string; chainMac: string },
): EventDraft {
  return {
    protocolVersion: '1.0',
    eventId: eventId(`${id}_${name}`),
    timestamp: T0,
    runId: id,
    type: 'checkpoint.created',
    source: 'cohorte',
    summary: `checkpoint at ${anchor.atSequence}`,
    severity: 'info',
    payload: { ...anchor, snapshotSha256: SHA_A, cause: 'interval' },
    redactions: [],
  };
}

export function pauseCommand(name: string, id: RunId | undefined, reason = 'lunch'): CommandEnvelope<'pause'> {
  return {
    protocolVersion: '1.0',
    commandId: commandId(name),
    type: 'pause',
    ...(id ? { runId: id } : {}),
    issuedAt: T0,
    actor: HUMAN,
    payload: { reason },
    auth: { scheme: 'hmac-sha256', value: 'ab'.repeat(32) },
  };
}

export function startCommand(name: string, id: RunId): CommandEnvelope<'start'> {
  return {
    protocolVersion: '1.0',
    commandId: commandId(name),
    type: 'start',
    runId: id,
    issuedAt: T0,
    actor: HUMAN,
    payload: { profile: 'feature', unattended: true },
    auth: { scheme: 'hmac-sha256', value: 'cd'.repeat(32) },
  };
}

export function owner(hostId: string, id?: RunId): LockOwner {
  return { ...(id ? { runId: id } : {}), hostId, pid: 4242, startToken: `start-${hostId}` };
}

export function runLock(id: RunId, hostId = 'host-1'): LockRequest {
  return { scope: 'run', key: id, mode: 'exclusive', owner: owner(hostId, id), ttlMs: 60_000 };
}

export function transition(id: RunId, key: string): TransitionRecord {
  return {
    transitionId: `trn_${key}`,
    runId: id,
    defId: 'T05',
    tableVersion: 1,
    from: 'BUILD',
    to: 'TEST',
    reason: 'built',
    actor: SYSTEM,
    guards: [{ id: 'phase.passed', ok: true }],
    effects: [],
    idempotencyKey: key,
    eventId: eventId(`${id}_${key}`),
  };
}
