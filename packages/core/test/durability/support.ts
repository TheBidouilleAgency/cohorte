// Shared test fixtures for U1.08 (packages/core/test/durability/** and packages/core/test/events/**). Helper file,
// not a test: `support.ts` matches no vitest suffix and is never collected.
import type { AgentId, IsoInstant, RunId, Sha256, SpecId } from '@cohorte/base';
import type { LeaseToken, LockOwner, RunRecord, StateStore } from '@cohorte/persistence/contract';

export const T0 = '2026-01-01T00:00:00.000Z' as IsoInstant;
export const SHA_A = 'a'.repeat(64) as Sha256;
export const SHA_B = 'b'.repeat(64) as Sha256;

export const asRunId = (name: string): RunId => `run_${name.padEnd(32, '0')}` as RunId;
export const asAgentId = (name: string): AgentId => `agt_${name}` as AgentId;

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

/** The six columns only the host can compute (T04), needed to leave IDLE (DESIGN 2.4 DDL). */
export const HOST_COLUMNS = {
  snapshotDigest: SHA_B,
  runtimePin: { runtime: 'fake', version: '0.0.0' },
  plan: {
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
  },
  baseSha: '1'.repeat(40),
  integrationBranch: 'cohorte/run/integration',
  zones: ['src/app'],
} satisfies Partial<RunRecord>;

export function activeRun(id: RunId, overrides: Partial<RunRecord> = {}): RunRecord {
  return idleRun(id, { state: 'BUILD', ...HOST_COLUMNS, ...overrides });
}

export function lockOwner(hostId: string, id?: RunId): LockOwner {
  return { ...(id ? { runId: id } : {}), hostId, pid: 4242, startToken: `start-${hostId}` };
}

/** Puts an ACTIVE run into `store` (a project tx creating it, then a run tx moving it to BUILD) and returns a
 * held run lease for it — the two-step dance `transact` itself requires (a run cannot be created already active). */
export async function seedActiveRun(
  store: StateStore,
  id: RunId,
  overrides: Partial<RunRecord> = {},
): Promise<LeaseToken> {
  await store.transact('project', null, (tx) => {
    tx.putRun(idleRun(id));
  });
  const acquired = await store.acquireLock({
    scope: 'run',
    key: id,
    mode: 'exclusive',
    owner: lockOwner('host-1', id),
    ttlMs: 60_000,
  });
  if (!acquired.ok) throw new Error(`seedActiveRun: could not lock a fresh run ${id}`);
  await store.transact({ runId: id }, acquired.lease, (tx) => {
    tx.putRun(activeRun(id, overrides));
  });
  return acquired.lease;
}
