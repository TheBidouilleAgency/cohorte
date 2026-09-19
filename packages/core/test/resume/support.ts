// Shared test fixtures for U1.10 (packages/core/test/resume/**). Helper file, not a test: matches no vitest suffix
// and is never collected. Reuses U1.08's `packages/core/test/durability/support.ts` fixtures (same package, a
// relative import — not a cross-package edge) rather than declaring a second `idleRun`/`activeRun`.
import {
  type AgentId,
  type ApprovalId,
  type ArtifactId,
  type CommandId,
  type EffectId,
  type IsoInstant,
  type PhaseRunId,
  type RunId,
  type Sha256,
  type ToolCallId,
  toIsoInstant,
} from '@cohorte/base';
import type { CanonicalPath, GitPort, RepoFacts } from '@cohorte/git/contract';
import type {
  AgentRecord,
  ApprovalRecord,
  EffectKind,
  EffectRecord,
  IncarnationRecord,
  LeaseToken,
  PhaseRecord,
  ReplayClass,
  StateStore,
  WorktreeRecord,
} from '@cohorte/persistence/contract';
import type { ArtifactRef, CommandEnvelope, CommandType } from '@cohorte/protocol';
import { PROTOCOL_VERSION } from '@cohorte/protocol';
import type { RuntimeToolResult } from '@cohorte/runtime-contract';
import { FixedClock, fakeRedactor, SeqIds } from '@cohorte/testkit';
import { makeSpool, sealForTest } from '@cohorte/testkit/store-factory';
import type { Provisioner, ToolHostReplay, WorktreeService } from '../../src/contract/internal.ts';
import type { InstallInspector, ProcessSweeper } from '../../src/contract/ports.ts';
import type { EventDraftInput, HostContext, LedgerAudit } from '../../src/contract/types.ts';
import { createEventWriter } from '../../src/events/index.ts';
import { type BuiltinEffectVerifiers, createBuiltinEffectVerifiers } from '../../src/resume/verifiers.ts';
import { asRunId, HOST_COLUMNS, idleRun, lockOwner, T0 } from '../durability/support.ts';

export { asAgentId, asRunId, HOST_COLUMNS, idleRun, lockOwner, T0 } from '../durability/support.ts';
export { sealForTest };

/** The 32 lowercase hex digits every `<prefix>_<32 hex>` brand of `base/ids.ts` is made of, derived from a readable
 * name so a failing assertion still says WHICH fixture it is about. */
function hex32(name: string): string {
  return Buffer.from(name).toString('hex').padEnd(32, '0').slice(0, 32);
}

/** `agt_<role>_<n>` (base/ids.ts: `AgentId` = `agt_<role>_<surface|main>[_<n>]`) — `asAgentId` (durability/support)
 * mints a single-segment id, which the catalogue's `AgentRef.agentId` pattern refuses; resume writes agent ids into
 * event payloads (`agent.state.changed`, `ResumeReport.orphans`), so this module needs the two-segment shape. */
export function agentId2(name: string): AgentId {
  return `agt_implementer_${name}` as AgentId;
}

/** `apr_<32 lowercase hex>` (base/ids.ts). */
export function approvalId2(name: string): ApprovalId {
  return `apr_${hex32(name)}` as ApprovalId;
}

/** `eff_<32 lowercase hex>` (base/ids.ts). */
export function effectId2(name: string): EffectId {
  return `eff_${hex32(name)}` as EffectId;
}

/** `art_<32 lowercase hex>` (base/ids.ts). */
export function artifactId2(name: string): ArtifactId {
  return `art_${hex32(name)}` as ArtifactId;
}

/** `cmd_<32 lowercase hex>` (base/ids.ts). */
export function commandId2(name: string): CommandId {
  return `cmd_${hex32(name)}` as CommandId;
}

/** `tc_<incarnation>_<ordinal>` (base/ids.ts), the shape the runtime parent assigns. */
export function toolCallId2(incarnation: number, ordinal: number): ToolCallId {
  return `tc_${incarnation}_${ordinal}` as ToolCallId;
}

/** An absolute, symlink-resolved path, as `CanonicalPath` — `@cohorte/git/contract`'s brand — rather than a bare
 * cast at each call site. These fixtures never touch the filesystem, so the canonicalisation is nominal. */
export function canonicalPath(path: string): CanonicalPath {
  return path as CanonicalPath;
}

/** A 64-hex content hash, as `Sha256` rather than a bare cast at each call site. */
export function sha256Of(hex: string): Sha256 {
  return hex as Sha256;
}

/** `phs_<STATE>_<iteration>` (base/ids.ts). */
export function phaseRunId2(state: string, iteration: number): PhaseRunId {
  return `phs_${state}_${iteration}` as PhaseRunId;
}

/** An RFC-3339 instant, parsed rather than cast (`toIsoInstant` is `@cohorte/base`'s own constructor). */
export function at(iso: string): IsoInstant {
  return toIsoInstant(Date.parse(iso));
}

export function hostContext(overrides: Partial<HostContext> = {}): HostContext {
  return {
    hostId: 'host-1',
    pid: 4242,
    startToken: 'start-host-1',
    cohorteVersion: '3.0.0',
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A one-shot `EventWriter` for seeding: real sealing/validation (`createEventWriter`), a throwaway redactor/ids —
 * seed events are not inspected for their own sake, only replayed by `evolve()` (DESIGN 4.4 step 2). */
function seedEventWriter() {
  return createEventWriter({
    redactor: fakeRedactor(),
    clock: new FixedClock(T0),
    ids: new SeqIds(),
    spool: makeSpool(),
  });
}

/** Creates the run row AND a REAL `pipeline.started` (+ `run.state.changed` if the target state isn't IDLE) event
 * pair, so `evolve()`'s replay of the event stream agrees with the final `runs` row (DESIGN 4.4 step 2's own check
 * would otherwise refuse every synthetic fixture as `corruption/projection-mismatch` — a direct `putRun` with no
 * matching events is exactly the divergence that check exists to catch). Needs the run's OWN lease (a run-scoped
 * transaction), so the caller acquires the lock first — `seedResumableRun` below does both for the common case. */
export async function putResumableRun(
  store: StateStore,
  lease: LeaseToken,
  finalRun: ReturnType<typeof idleRun>,
): Promise<void> {
  await store.transact('project', null, (tx) => {
    tx.putRun(idleRun(finalRun.runId));
  });
  const events = seedEventWriter();
  await store.transact({ runId: finalRun.runId }, lease, (tx) => {
    const startedPayload = {
      profile: finalRun.profile,
      tableVersion: finalRun.tableVersion,
      spec: { id: finalRun.specId, sha256: finalRun.specSha256, kind: 'feature' },
      snapshotDigest: finalRun.snapshotDigest ?? '0'.repeat(64),
      runtime: { id: 'fake', version: '0.0.0', pinDigest: '0'.repeat(64) },
      plan: finalRun.plan ?? HOST_COLUMNS.plan,
      base: { branch: finalRun.baseBranch, sha: finalRun.baseSha ?? '' },
      integrationBranch: finalRun.integrationBranch ?? '',
      cohorteVersion: finalRun.cohorteVersion,
      hostId: 'seed-host',
    };
    const started: EventDraftInput = {
      type: 'pipeline.started',
      summary: `run ${finalRun.runId} started (seed)`,
      severity: 'success',
      payload: startedPayload as unknown as EventDraftInput['payload'],
    };
    events.append(tx, [started]);
    if (finalRun.state !== 'IDLE') {
      const changed: EventDraftInput = {
        type: 'run.state.changed',
        summary: `run ${finalRun.runId} -> ${finalRun.state} (seed)`,
        severity: 'info',
        payload: {
          transitionId: 'seed-t1',
          defId: 'T04',
          tableVersion: finalRun.tableVersion,
          from: 'IDLE',
          to: finalRun.state,
          reason: 'start',
          actor: { kind: 'system', id: 'seed', transport: 'cli' },
          guards: [],
          idempotencyKey: `seed:${finalRun.runId}`,
        },
      };
      events.append(tx, [changed]);
    }
    tx.putRun(finalRun);
  });
}

/** A run past T04 (has every host-computed column), with an ACTIVE state and a run lock owned by a DEAD process —
 * the shape every resume test starts from. Grants the lease so the caller can seed effects / agents / approvals
 * before calling `recover()`, which itself takes the lease over (`putResumableRun`'s own doc explains why this
 * writes real events rather than a bare `putRun`). */
export async function seedResumableRun(
  store: StateStore,
  id: RunId,
  overrides: Partial<Parameters<typeof idleRun>[1]> = {},
): Promise<{ lease: LeaseToken }> {
  const acquired = await store.acquireLock({
    scope: 'run',
    key: id,
    mode: 'exclusive',
    owner: lockOwner('dead-host', id),
    ttlMs: 60_000,
  });
  if (!acquired.ok) throw new Error(`seedResumableRun: could not lock a fresh run ${id}`);
  const finalRun = idleRun(id, { ...HOST_COLUMNS, state: 'BUILD', zones: ['src/app'], ...overrides });
  await putResumableRun(store, acquired.lease, finalRun);
  return { lease: acquired.lease };
}

/** Like `seedResumableRun`, but releases its seeding lease afterwards: for a test that wants to control the run's
 * lock itself (a live owner, or none at all) before calling `recover()`. */
export async function seedResumableRunNoLock(
  store: StateStore,
  id: RunId,
  overrides: Partial<Parameters<typeof idleRun>[1]> = {},
): Promise<void> {
  const { lease } = await seedResumableRun(store, id, overrides);
  await store.releaseLock(lease.lockId);
}

export function installInspectorFor(installDir: string): InstallInspector {
  return {
    installDir: () => installDir,
    bundleManifest: async () => [],
  };
}

/** Nothing alive by default (a "host crashed" fixture, matching `lockOwner`'s dead-host default and an unlisted
 * incarnation alike); `alivePids` names the `(pid, startToken)` pairs this fake reports alive, spelled `"pid:token"`.
 * `killRejects` makes every `kill` reject, the way a real sweeper does when it may not signal the process. */
export function fakeSweeper(
  alivePids: ReadonlySet<string> = new Set(),
  options: { killRejects?: boolean } = {},
): ProcessSweeper & { killed: string[] } {
  const killed: string[] = [];
  return {
    killed,
    isAlive: (pid, startToken) => alivePids.has(`${pid}:${startToken}`),
    kill(pid, startToken) {
      killed.push(`${pid}:${startToken}`);
      return options.killRejects
        ? Promise.reject(new Error(`kill ${pid}: operation not permitted`))
        : Promise.resolve();
    },
  };
}

export function agentRecord(id: AgentId, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    runId: asRunId('placeholder'),
    agentId: id,
    phaseRunId: 'phr_build_1' as AgentRecord['phaseRunId'],
    role: 'implementer',
    label: 'implementer',
    state: 'running',
    attempt: 1,
    incarnation: 1,
    maxAttempts: 3,
    maxIncarnations: 5,
    model: { provider: 'fake', model: 'fake-standard' },
    usage: {},
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function incarnationRecord(
  agentId: AgentId,
  incarnation: number,
  overrides: Partial<IncarnationRecord> = {},
): IncarnationRecord {
  return {
    runId: asRunId('placeholder'),
    agentId,
    incarnation,
    attempt: 1,
    state: 'running',
    ...overrides,
  };
}

export function effectRecord(
  overrides: Partial<EffectRecord> & { effectId: EffectId; kind: EffectKind; replayClass: ReplayClass },
): EffectRecord {
  return {
    runId: asRunId('placeholder'),
    idempotencyKey: `key:${overrides.effectId}`,
    state: 'intent',
    request: sealForTest({}),
    verify: sealForTest({}),
    fencingToken: 1,
    intentSeq: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function approvalRecord(overrides: Partial<ApprovalRecord> & { approvalId: ApprovalId }): ApprovalRecord {
  return {
    runId: asRunId('placeholder'),
    idempotencyKey: `apr:${overrides.approvalId}`,
    kind: 'tool',
    status: 'pending',
    request: sealForTest({}),
    grantKey: `grant:${overrides.approvalId}`,
    requestedSeq: 1,
    createdAt: T0,
    ...overrides,
  };
}

export function worktreeRecord(slot: string, overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    runId: asRunId('placeholder'),
    slot,
    path: `/repo/.cohorte/worktrees/${slot}`,
    baseSha: 'a'.repeat(40),
    checkpointSha: 'a'.repeat(40),
    state: 'ready',
    ...overrides,
  };
}

/** A `WorktreeService` fake whose `audit()` answer is scripted per slot and whose `quarantineAndReset` just records
 * the call (no real git): everything U1.10's tests need from the port DESIGN 4.4 step 8 delegates to. */
export function fakeWorktreeService(
  auditBySlot: Record<string, LedgerAudit['verdict']> = {},
): WorktreeService & { quarantined: { slot: string; because: EffectId }[] } {
  const quarantined: { slot: string; because: EffectId }[] = [];
  return {
    quarantined,
    acquire(): Promise<WorktreeRecord> {
      return Promise.reject(new Error('fakeWorktreeService.acquire: not used by resume tests'));
    },
    async checkpoint() {
      return 'a'.repeat(40);
    },
    async release() {},
    async audit(slot: string): Promise<LedgerAudit> {
      return { slot, verdict: auditBySlot[slot] ?? 'ok', entries: [] };
    },
    async quarantineAndReset(slot: string, because: EffectId): Promise<ArtifactRef> {
      quarantined.push({ slot, because });
      return {
        artifactId: artifactId2(slot),
        kind: 'diff',
        path: `${slot}.patch`,
        sha256: 'b'.repeat(64) as Sha256,
        bytes: 10,
      };
    },
    async resetClean() {},
  };
}

export function fakeToolHostReplay(
  outcome: 'executed' | 'binding-changed' | 'denied-by-gate' = 'executed',
): ToolHostReplay & { calls: { call: { toolCallId: ToolCallId } }[] } {
  const calls: { call: { toolCallId: ToolCallId } }[] = [];
  return {
    calls,
    async replayApproved(_lease, approved) {
      calls.push(approved);
      const result: RuntimeToolResult = { isError: false, content: [] };
      return outcome === 'executed' ? { outcome, result } : { outcome };
    },
  };
}

/** A minimal `GitPort` fake: `facts()` returns a fixed `RepoFacts`, `findCommitByTrailer` answers from a map keyed
 * `branch:key -> sha`. Enough for `createBuiltinEffectVerifiers`'s tests — no real git process. */
export function fakeGitPort(
  options: {
    worktrees?: RepoFacts['worktrees'];
    commits?: Record<string, string>;
    changedPathsBySlot?: Record<string, number>;
  } = {},
): GitPort {
  const worktrees = options.worktrees ?? [];
  const commits = options.commits ?? {};
  const changed = options.changedPathsBySlot ?? {};
  return {
    async facts(repo: CanonicalPath): Promise<RepoFacts> {
      return {
        gitVersion: '2.50.1',
        supported: true,
        commonDir: repo,
        defaultBranch: 'main',
        head: { kind: 'branch', name: 'main', sha: 'a'.repeat(40) },
        worktrees,
      };
    },
    async treeDigest() {
      return 'digest';
    },
    async addWorktree() {},
    async switchToNewBranch() {},
    async removeWorktree() {
      return 'removed';
    },
    async resetHardClean() {},
    async commitAll() {
      return { kind: 'nothing' };
    },
    async findCommitByTrailer(_repo, branch, _key, value) {
      return commits[`${branch}:${value}`] ?? null;
    },
    async mergeTree() {
      return { clean: true, tree: 'x' };
    },
    async commitTree() {
      return 'sha';
    },
    async updateRefCas() {
      return 'ok';
    },
    async createRef() {},
    async diffBySurface() {
      return [];
    },
    async changedPaths(worktree: CanonicalPath) {
      const count = changed[worktree as unknown as string] ?? 0;
      return Array.from({ length: count }, (_, i) => ({ path: `f${i}.ts`, op: 'modify' as const }));
    },
  };
}

export function fakeProvisioner(ensureOutcome: 'fresh' | 'reused' = 'reused'): Provisioner {
  return {
    async ensure() {
      return ensureOutcome;
    },
    async verifyDependencies() {
      return { ok: true, value: true };
    },
  };
}

export function builtinVerifiersFor(
  options: {
    worktrees?: RepoFacts['worktrees'];
    commits?: Record<string, string>;
    changedPathsBySlot?: Record<string, number>;
    ensureOutcome?: 'fresh' | 'reused';
    sweeper?: ProcessSweeper;
    runSnapshotDigest?: Sha256 | undefined;
  } = {},
): BuiltinEffectVerifiers {
  return createBuiltinEffectVerifiers({
    git: fakeGitPort(options),
    provisioner: fakeProvisioner(options.ensureOutcome),
    sweeper: options.sweeper ?? fakeSweeper(),
    runSnapshotDigest: () => options.runSnapshotDigest,
  });
}

export function phaseRecord(overrides: Partial<PhaseRecord> & { phaseRunId: PhaseRunId }): PhaseRecord {
  return {
    runId: asRunId('placeholder'),
    state: 'BUILD',
    iteration: 1,
    status: 'running',
    checks: [],
    ...overrides,
  };
}

/** An UNSIGNED `CommandEnvelope` for the inbox: `StateStore.enqueueCommand` stores what it is given and never
 * verifies a MAC (that is `CommandAuthenticator`'s job, in the engine), so these tests seed the inbox directly. */
export function commandEnvelope<T extends CommandType>(
  runId: RunId,
  type: T,
  payload: CommandEnvelope<T>['payload'],
  name: string = type,
): CommandEnvelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId: commandId2(name),
    type,
    runId,
    issuedAt: T0,
    actor: { kind: 'human', id: 'tester', transport: 'cli' },
    payload,
  } as CommandEnvelope<T>;
}
