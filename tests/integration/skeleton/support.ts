// Walking skeleton (a) — the world one case runs in: a REAL temp-file SQLite store, the real `EventWriter`,
// `EffectJournal`, `LeaseManager`, `Resumer` and `RunEngine`, a toy `PhaseExecutor` that spawns ONE agent on the
// FakeRuntime, and a trivial `ToolHost` that journals that agent's single tool call.
//
// Helper file (no test suffix): never collected by vitest.
//
// The ports that belong to Wave 2/3 (`GuardRegistry`, `FactCollector`, `TransitionEffectRunner`,
// `CommandAuthenticator`, `ProcessSweeper`, `WorktreeService`, `ToolHostReplay`, `InstallInspector`) are faked here,
// small and honest. Everything the gate is about — the engine loop, the journal, the writer, recovery, and the store
// under them — is the shipped implementation.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, CommandId, EffectId, IsoInstant, RunId, Sha256, SpecId } from '@cohorte/base';
import { computeAnchorMac } from '@cohorte/base';
import {
  type Crashpoint,
  createEffectJournal,
  createEngine,
  createEventWriter,
  createLeaseManager,
  createResumer,
  type FaultInjector,
  resetCrashpointOccurrences,
  SimulatedCrash,
  setFaultInjector,
} from '@cohorte/core';
import type {
  CommandAuthenticator,
  EffectVerifier,
  EffectVerifierRegistry,
  EventDraftInput,
  FactCollector,
  GlobalFacts,
  GuardRegistry,
  HostContext,
  InstallInspector,
  LedgerAudit,
  PhaseOutcome,
  PhaseRunContext,
  ProcessSweeper,
  ToolHostReplay,
  TransitionDef,
  TransitionEffectRunner,
  TransitionTable,
  WorktreeService,
} from '@cohorte/core/contract';
import { GUARD_IDS } from '@cohorte/core/contract';
import { effectKeys } from '@cohorte/core/durability/journal';
import { createBuiltinEffectVerifiers } from '@cohorte/core/resume';
import type { GitPort, RepoFacts } from '@cohorte/git/contract';
import type { DurableEnvelope, EffectRecord, StateStore, WorktreeRecord } from '@cohorte/persistence/contract';
import type { ArtifactRef, CommandEnvelope } from '@cohorte/protocol';
import { canonicalCommandBody, PROTOCOL_VERSION } from '@cohorte/protocol';
import type {
  RuntimeToolCall,
  RuntimeToolResult,
  SpawnRequest,
  ToolCallContext,
  ToolGrant,
} from '@cohorte/runtime-contract';
import { createFakeRuntimeProvider, type FakeScript } from '@cohorte/runtime-fake';
import { FixedClock, fakeRedactor, SeqIds, sealedText } from '@cohorte/testkit';
import { makeSpool, makeStore } from '@cohorte/testkit/store-factory';

const sha256 = (text: string): Sha256 => createHash('sha256').update(text, 'utf8').digest('hex') as Sha256;

export const BASE_URL = 'https://skeleton.test.invalid/v1';
export const AGENT_ID = 'agt_implementer_main' as AgentId;
export const TOOL = 'write_file';
export const WRITTEN_FILE = 'out.txt';
export const WRITTEN_TEXT = 'the walking skeleton wrote this';
export const PROJECT_KEY = new Uint8Array(32).fill(7);

// ── the toy table: IDLE -start-> BUILD -built-> COMPLETED ────────────────────────────────────────────────────────
// Real vocabulary (`PipelineState`, `TransitionReason`), one active phase. The tail rows a real table carries
// (pause/cancel/resume/retry) are deliberately absent: this skeleton never sends one of those commands, and a row
// that no case can fire would be dead weight in a gate test.
const TOY_START: TransitionDef = {
  id: 'SK-START',
  from: 'IDLE',
  to: 'BUILD',
  reason: 'start',
  actor: 'either',
  preconditions: [],
  effects: [],
};
const TOY_BUILT: TransitionDef = {
  id: 'SK-BUILT',
  from: 'BUILD',
  to: 'COMPLETED',
  reason: 'built',
  actor: 'system',
  preconditions: [],
  effects: [],
};
export const TOY_TABLE: TransitionTable = {
  profile: 'feature',
  version: 1,
  initial: 'IDLE',
  phases: ['BUILD'],
  rows: [TOY_START, TOY_BUILT],
};

// ── the fake ports (Wave 2/3 work) ───────────────────────────────────────────────────────────────────────────────

function permissiveGuards(): GuardRegistry {
  return { get: (id) => () => ({ id, ok: true }), ids: () => GUARD_IDS };
}

function quietFacts(store: StateStore, runId: RunId): FactCollector {
  return {
    async collect(): Promise<GlobalFacts> {
      const run = await store.getRun(runId);
      return {
        cancelRequested: run?.cancelRequested ?? false,
        pauseRequested: run?.pauseRequested ?? false,
        leaseLost: false,
        pinMismatch: false,
        tableVersionKnown: true,
        securityErrorPending: false,
        deniedCallsByAgent: {},
        unexplainedWorktreeChange: false,
        blockingApprovalPending: false,
        authProbeMatchesExpected: true,
        quotaWindowExhausted: false,
        budgets: { run: {} },
        nowMs: Date.now(),
        startedAtMs: Date.now(),
      };
    },
  };
}

const noTransitionEffects: TransitionEffectRunner = { async run() {} };

/** Real HMAC-SHA256 over the canonical body (DESIGN 2.6.7's algorithm), standing in for `U2.02`'s authenticator. */
function hmacAuthenticator(): CommandAuthenticator {
  return {
    scheme: 'hmac-sha256',
    sign: (body, key) => createHmac('sha256', key).update(body).digest('hex'),
    verify: (body, value, key) => {
      const expected = Buffer.from(createHmac('sha256', key).update(body).digest('hex'), 'hex');
      const given = Buffer.from(value, 'hex');
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
    // `base.computeAnchorMac` (PLAN PC-4), NOT a formula of this file's own: `StateStore.verifyChain(runId, key)`
    // recomputes the anchor with exactly that function, so any other spelling makes every checkpoint anchor fail to
    // verify. Recorded in docs/v3/gates/G1.md.
    anchor: (runId, atSequence, chainHash, key) => computeAnchorMac(key, runId, atSequence, chainHash),
  };
}

/** Only the hosts this skeleton declares alive are alive: the killed host never is, which is what lets recovery
 * steal its run lease (DESIGN 4.4 step 3). */
function sweeperAlive(alive: ReadonlySet<string>): ProcessSweeper {
  return { isAlive: (pid, startToken) => alive.has(`${pid}:${startToken}`), async kill() {} };
}

function unusedWorktreeService(): WorktreeService {
  const no = (what: string) => (): never => {
    throw new Error(`skeleton: WorktreeService.${what} is not part of walking skeleton (a)`);
  };
  return {
    acquire: no('acquire') as unknown as (slot: string, forAgent: AgentId) => Promise<WorktreeRecord>,
    async checkpoint() {
      return 'a'.repeat(40);
    },
    async release() {},
    async audit(slot: string): Promise<LedgerAudit> {
      return { slot, verdict: 'ok', entries: [] };
    },
    quarantineAndReset: no('quarantineAndReset') as unknown as (
      slot: string,
      because: EffectId,
    ) => Promise<ArtifactRef>,
    async resetClean() {},
  };
}

/**
 * DESIGN 4.1: a `verifiable` effect's verifier is registered by whoever OWNS the kind — `createBuiltinEffectVerifiers`
 * covers the git / provisioning / spawn kinds and deliberately leaves the tool kinds to their tool host ("the resume
 * orchestration treats an unregistered kind as `in-doubt`, never a blind re-execution"). This skeleton's tool host
 * owns `tool.write_file`, so it registers the verifier its own intent describes: the file named by `verify.path`,
 * with the content hash `verify.sha256`, is either there (`done`) or it is not (`not-done`, and the next incarnation
 * re-issues the write under the same key).
 */
function composeVerifiers(dir: string, builtin: EffectVerifierRegistry): EffectVerifierRegistry {
  const writeFile: EffectVerifier = {
    async verify(record: EffectRecord): Promise<'done' | 'not-done' | 'in-doubt'> {
      const payload = record.verify as unknown as { path?: string; sha256?: string };
      if (typeof payload.path !== 'string' || typeof payload.sha256 !== 'string') return 'in-doubt';
      const path = join(dir, 'work', payload.path);
      if (!existsSync(path)) return 'not-done';
      return sha256(readFileSync(path, 'utf8')) === payload.sha256 ? 'done' : 'not-done';
    },
  };
  return { get: (kind) => (kind === 'tool.write_file' ? writeFile : builtin.get(kind)) };
}

const noToolHostReplay: ToolHostReplay = {
  async replayApproved() {
    return { outcome: 'executed', result: { isError: false, content: [] } };
  },
};

/** A `GitPort` that answers only what `createBuiltinEffectVerifiers` asks of it here (no real git: this skeleton has
 * no worktree — its single effect is a `tool.write_file`, whose verifier reads the ledger, not the repository). */
function inertGitPort(): GitPort {
  const facts: RepoFacts = {
    gitVersion: '0.0.0',
    supported: true,
    commonDir: '/nowhere' as RepoFacts['commonDir'],
    defaultBranch: 'main',
    head: { kind: 'branch', name: 'main', sha: 'a'.repeat(40) },
    worktrees: [],
  };
  return {
    async facts() {
      return facts;
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
    async findCommitByTrailer() {
      return null;
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
    async changedPaths() {
      return [];
    },
  };
}

// ── the FakeRuntime side ─────────────────────────────────────────────────────────────────────────────────────────

const FLAT_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };
const GRANTS: ToolGrant[] = [
  { tool: TOOL, description: 'Writes one file.', inputSchema: FLAT_SCHEMA, effect: 'write', terminal: false },
  {
    tool: 'submit_result',
    description: 'Delivers the result.',
    inputSchema: FLAT_SCHEMA,
    effect: 'control',
    terminal: true,
  },
];

/** One turn: write one file, then submit. Exactly ONE journaled tool call per agent run. */
export const SKELETON_SCRIPT: FakeScript = {
  version: 1,
  agents: [
    {
      match: {},
      steps: [
        { do: 'tool', tool: TOOL, input: { path: WRITTEN_FILE, text: WRITTEN_TEXT } },
        { do: 'submit', output: { status: 'done' } },
      ],
    },
  ],
};

// ── the world ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SkeletonHost {
  hostId: string;
  pid: number;
  startToken: string;
}

export const HOST_A: SkeletonHost = { hostId: 'host-a', pid: 999_001, startToken: 'start-a' };
export const HOST_B: SkeletonHost = { hostId: 'host-b', pid: 999_002, startToken: 'start-b' };

export interface Skeleton {
  readonly dir: string;
  readonly store: StateStore;
  readonly runId: RunId;
  readonly clock: FixedClock;
  /** Every `(tool, toolCallId)` the trivial ToolHost saw, including a replayed one. */
  readonly toolCalls: { toolCallId: string; status: 'done' | 'replayed' }[];
  /**
   * How many times the effect's `perform()` really RAN, counted at its first statement and across EVERY host of this
   * world. This is the only number that can tell a correct replay from a second execution: `toolCalls` is pushed
   * after `journal.run` returns, so a host killed inside the effect pushes nothing and a host that wrongly
   * re-performed a `done` effect looks exactly like one that replayed it. I4.1 says this stays 1.
   */
  readonly performs: number;
  /** Runs one host incarnation: a fresh `RunEngine` over the same store, under `host`'s identity. */
  runHost(host: SkeletonHost): Promise<{ reason: string }>;
  close(): Promise<void>;
}

/** Everything a host incarnation builds for itself, over the ONE shared store. */
interface SkeletonWorld {
  dir: string;
  store: StateStore;
  runId: RunId;
  clock: FixedClock;
  ids: SeqIds;
  toolCalls: { toolCallId: string; status: 'done' | 'replayed' }[];
  /** Incremented at the FIRST statement of `perform()`; see {@link Skeleton.performs}. */
  performs: number;
}

function buildHost(world: SkeletonWorld, host: SkeletonHost, aliveHosts: ReadonlySet<string>) {
  const { store, runId, clock, ids } = world;
  const redactor = fakeRedactor();
  const events = createEventWriter({ redactor, clock, ids, spool: makeSpool() });
  const journal = createEffectJournal({ store, events, clock, redactor });
  const leases = createLeaseManager({ store, clock }, host);
  const installDir = join(world.dir, 'install');

  const resumer = createResumer({
    store,
    clock,
    sweeper: sweeperAlive(aliveHosts),
    effectVerifiers: composeVerifiers(
      world.dir,
      createBuiltinEffectVerifiers({
        git: inertGitPort(),
        provisioner: {
          async ensure() {
            return 'reused';
          },
          async verifyDependencies() {
            return { ok: true, value: true };
          },
        },
        sweeper: sweeperAlive(aliveHosts),
        runSnapshotDigest: () => undefined,
      }),
    ),
    worktrees: unusedWorktreeService(),
    events,
    redactor,
    toolHostReplay: noToolHostReplay,
    installInspector: { installDir: () => installDir, bundleManifest: async () => [] } satisfies InstallInspector,
    ids,
  });

  /** A `SimulatedCrash` raised inside the ToolHost is the HOST PROCESS dying, runtime included — but the runtime is
   * in-process here and, per its own contract (C1), a ToolHost rejection is an agent failure it reports rather than
   * an exception it propagates. So the crash is stashed and rethrown out of the phase executor, which is where a
   * real SIGKILL would have left the loop: dead, with nothing committed after the point. */
  let pendingCrash: SimulatedCrash | undefined;

  /** The trivial ToolHost of the deliverable: the agent's ONE real tool call is one journaled effect. The terminal
   * `submit_result` is answered directly — it delivers the agent's output and ends the loop (DESIGN 3.10), it is not
   * an effect on the world, so journaling it would give this skeleton two effect keys and prove nothing more. */
  const handleToolCall = async (
    ctx: PhaseRunContext,
    call: RuntimeToolCall,
    tool: ToolCallContext,
  ): Promise<RuntimeToolResult> => {
    if (call.tool !== TOOL) {
      return { isError: false, content: [{ type: 'text', text: sealedText('accepted') }], terminate: true };
    }
    const key = effectKeys.toolCall(runId, call.agentId, call.incarnation, call.ordinal);
    const argsSha256 = sha256(JSON.stringify(call.input));
    const effectId = ids.next<'EffectId'>('eff');
    const agent = { agentId: call.agentId, role: 'implementer', incarnation: call.incarnation, attempt: 1 };
    const requested: EventDraftInput = {
      type: 'tool.requested',
      payload: { toolCallId: call.toolCallId, tool: call.tool, args: call.input, argsSha256 },
      summary: `${call.tool} requested`,
      agent,
    };
    const text = String((call.input as { text?: string }).text ?? '');
    const completed = (): EventDraftInput => ({
      type: 'tool.completed',
      payload: {
        toolCallId: call.toolCallId,
        tool: call.tool,
        effectId,
        isError: false,
        timedOut: false,
        durationMs: 1,
        waitedMs: 0,
        output: { sha256: sha256(text), bytes: text.length, truncated: false, preview: text.slice(0, 40) },
        filesTouched: [{ path: WRITTEN_FILE, op: 'create' }],
        replayed: false,
      },
      summary: `${call.tool} completed`,
      agent,
    });

    const outcome = await runJournaled();
    world.toolCalls.push({ toolCallId: call.toolCallId, status: outcome.status });
    return { isError: false, content: [{ type: 'text', text: sealedText(`wrote ${outcome.result.path}`) }] };

    async function runJournaled(): Promise<{ status: 'done' | 'replayed'; result: { path: string; bytes: number } }> {
      try {
        return await journalRun();
      } catch (thrown) {
        if (thrown instanceof SimulatedCrash) pendingCrash = thrown;
        throw thrown;
      }
    }

    function journalRun(): Promise<{ status: 'done' | 'replayed'; result: { path: string; bytes: number } }> {
      return journal.run<{ path: string; bytes: number }>(
        ctx.lease,
        {
          intent: {
            runId,
            idempotencyKey: key,
            kind: 'tool.write_file',
            replayClass: 'verifiable',
            agentId: call.agentId,
            toolCallId: call.toolCallId,
            request: { tool: call.tool, input: call.input },
            verify: { path: WRITTEN_FILE, sha256: sha256(text) },
          },
          before: [requested],
          async perform() {
            // FIRST statement: a crash anywhere later in this body still counts as one execution of the effect.
            world.performs += 1;
            const path = join(world.dir, 'work', WRITTEN_FILE);
            mkdirSync(join(world.dir, 'work'), { recursive: true });
            writeFileSync(path, text, 'utf8');
            return { result: { path, bytes: text.length }, after: [completed()] };
          },
        },
        tool.signal,
      );
    }
  };

  /** The toy `PhaseExecutor`: spawns ONE agent on the FakeRuntime and passes when it completes. */
  const phases = {
    async execute(ctx: PhaseRunContext): Promise<PhaseOutcome> {
      const provider = createFakeRuntimeProvider({ script: SKELETON_SCRIPT, baseUrl: BASE_URL, clock });
      const runtime = await provider.create(
        {
          toolHost: { handleToolCall: (call, tool) => handleToolCall(ctx, call, tool) },
          stateDir: (run, agentId, incarnation) => {
            const state = join(world.dir, 'state', run, agentId, String(incarnation));
            mkdirSync(state, { recursive: true });
            return state;
          },
          clock,
          ids,
          log: () => {},
        },
        await provider.pin(),
      );
      try {
        const handle = await runtime.spawn(spawnRequest(world.dir, runId, ctx));
        const exit = await handle.exit;
        if (exit.outcome !== 'completed' && !pendingCrash) {
          throw new Error(`skeleton agent did not complete: ${exit.outcome} / ${exit.error?.message ?? ''}`);
        }
      } finally {
        await runtime.close();
      }
      if (pendingCrash) throw pendingCrash;
      return { kind: 'passed', output: { wrote: WRITTEN_FILE }, artifacts: [] };
    },
  };

  const engine = createEngine({
    store,
    clock,
    ids,
    resume: resumer,
    phases,
    loopPolicy: {
      maxFixRounds: 1,
      noProgressWindow: 2,
      maxDeniedCallsPerAgent: 1,
      runWallClockMs: 60_000,
      escalation: { sameFailureCount: 1, ladder: [], maxPerRun: 1 },
    },
    guards: permissiveGuards(),
    factCollector: quietFacts(store, runId),
    transitionEffects: noTransitionEffects,
    checkGlobalStops: () => null,
    authenticator: hmacAuthenticator(),
    projectKey: PROJECT_KEY,
    events,
    redactor,
    leases,
    resolveTable: () => ({ ok: true, table: TOY_TABLE }),
    schemaVersion: 1,
    leaseTtlMs: 15_000,
    pollIntervalMs: 1,
  });

  return { engine, installDir };
}

function spawnRequest(dir: string, runId: RunId, ctx: PhaseRunContext): SpawnRequest {
  const write = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text, 'utf8');
    return { path, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') };
  };
  return {
    runId,
    agentId: AGENT_ID,
    role: 'implementer',
    model: { provider: 'fake', model: 'scripted' },
    systemPrompt: { id: 'implementer', ...write('system-prompt.md', 'You are scripted.\n') },
    context: {
      manifestSha256: sha256('manifest'),
      tokenLimit: 100_000,
      tokenEstimate: 10,
      entries: [],
      reductions: [],
      exclusions: [],
    },
    tools: GRANTS,
    sandbox: {
      require: 'process',
      filesystem: { readOnly: [dir], readWrite: [], denyRead: [] },
      network: { mode: 'none', allowHosts: [] },
      env: { allow: ['PATH'], set: {} },
      limits: {},
    },
    budget: { maxEngineRetries: 0 },
    workingDirectory: join(dir, 'work'),
    incarnation: ctx.phase.iteration,
    thinking: 'off',
    auth: { mode: 'subscription', provider: 'fake', baseUrl: BASE_URL, allowApiKey: false },
    task: write('task.md', '# Task\n\nWrite one file.\n'),
    continuation: null,
  };
}

export interface SkeletonOptions {
  /** Hosts that are alive while this world runs. `HOST_A` is deliberately NOT one of them: it is the killed host. */
  alive?: ReadonlySet<string>;
}

export async function openSkeleton(options: SkeletonOptions = {}): Promise<Skeleton> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-skeleton-')));
  const clock = new FixedClock();
  const ids = new SeqIds();
  const store = await makeStore({ kind: 'sqlite', clock, ids });
  const runId = ids.next<'RunId'>('run');
  const toolCalls: { toolCallId: string; status: 'done' | 'replayed' }[] = [];
  const alive = options.alive ?? new Set([`${HOST_B.pid}:${HOST_B.startToken}`]);
  const world: SkeletonWorld = { dir, store, runId, clock, ids, toolCalls, performs: 0 };

  return {
    dir,
    store,
    runId,
    clock,
    toolCalls,
    get performs() {
      return world.performs;
    },
    async runHost(host: SkeletonHost) {
      const { engine } = buildHost(world, host, alive);
      return engine.run(runId, hostContext(host));
    },
    async close() {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function hostContext(host: SkeletonHost): HostContext {
  return {
    hostId: host.hostId,
    pid: host.pid,
    startToken: host.startToken,
    cohorteVersion: '3.0.0-test',
    signal: new AbortController().signal,
  };
}

/** Seeds the IDLE run row the `start` command then moves (the toy table's `SK-START`). */
export async function seedIdleRun(skeleton: Skeleton): Promise<void> {
  const now = skeleton.clock.now();
  await skeleton.store.transact('project', null, (tx) => {
    tx.putRun({
      runId: skeleton.runId,
      profile: 'feature',
      tableVersion: 1,
      // Branded, never `as never`: G1.md §5 records that a `Partial`-shaped `as never` on a store record is exactly
      // the cast that hid a missing REQUIRED column until SQLite refused it.
      specId: 'spc_skeleton' as SpecId,
      specSha256: sha256('skeleton-spec'),
      title: 'walking skeleton (a)',
      state: 'IDLE',
      lastSequence: 0,
      lastHash: '',
      version: 0,
      pinnedInstallDir: join(skeleton.dir, 'install'),
      baseBranch: 'main',
      cancelRequested: false,
      pauseRequested: false,
      schemaVersion: 1,
      cohorteVersion: '3.0.0-test',
      purgeable: false,
      startedAt: now,
      updatedAt: now as IsoInstant,
    });
  });
}

/** Builds and signs the `start` command with the same authenticator the engine verifies with. The body is typed as
 * the real envelope minus its signature, so the gate proves the PROTOCOL SHAPE as well as the MAC: a payload or an
 * actor that `CommandEnvelope<'start'>` does not accept fails `tsc -p tsconfig.tests.json`, not a runtime assertion. */
export function signedStart(skeleton: Skeleton): CommandEnvelope<'start'> {
  const auth = hmacAuthenticator();
  const base: Omit<CommandEnvelope<'start'>, 'auth'> = {
    protocolVersion: PROTOCOL_VERSION,
    commandId: `cmd_${'0'.repeat(31)}1` as CommandId,
    type: 'start',
    runId: skeleton.runId,
    issuedAt: skeleton.clock.now(),
    actor: { kind: 'human', id: 'gate', transport: 'cli' },
    payload: { profile: 'feature', unattended: true },
  };
  const value = auth.sign(canonicalCommandBody(base), PROJECT_KEY);
  return { ...base, auth: { scheme: auth.scheme, value } };
}

// ── crash-point recording ────────────────────────────────────────────────────────────────────────────────────────

export interface CrashHit {
  point: Crashpoint;
  occurrence: number;
}

/** Records every `(point, occurrence)` the golden run hits, and fails none of them. */
export function recordingInjector(into: CrashHit[]): FaultInjector {
  return {
    shouldFail(point, occurrence) {
      into.push({ point, occurrence });
      return false;
    },
  };
}

/** Fails at exactly one `(point, occurrence)` and records nothing else. */
export function armedInjector(target: CrashHit): FaultInjector {
  return {
    shouldFail: (point, occurrence) => point === target.point && occurrence === target.occurrence,
  };
}

/** Installs an injector for the duration of `body`, and always uninstalls it (a leaked injector would arm every
 * later case in this file's process). */
export async function withInjector<T>(injector: FaultInjector, body: () => Promise<T>): Promise<T> {
  resetCrashpointOccurrences();
  setFaultInjector(injector);
  try {
    return await body();
  } finally {
    setFaultInjector(null);
    resetCrashpointOccurrences();
  }
}

/**
 * The `type` of every durable event of the run, in sequence order — the run's final SHAPE, which
 * `expectSettled`'s per-row invariants (one effect, gapless, chain ok) cannot see: a resumed run that re-performed a
 * `done` effect, or re-entered a phase it had finished, differs here and nowhere else.
 */
export async function eventTypes(store: StateStore, runId: RunId): Promise<string[]> {
  const events = await store.readEvents(runId, { afterSequence: 0, limit: 1000 });
  return events.map((event) => event.type);
}

/**
 * The rows that are not part of a run's STATE, and the MEASURED reason each one is here (the first two were
 * described from the armchair until the U1.INT reviewer counted them — G1 §1):
 *
 * - `run.resumed` is recovery's own report, emitted once per HOST INCARNATION: `RunEngine.run` calls
 *   `Resumer.recover()` unconditionally (G1-D1), so the golden run has exactly one and every crash case has two.
 *   It is not "only a resumed run has it".
 * - `lock.stolen` is emitted by a host that takes a DEAD owner's run lease over (`Resumer` step 3), so the golden
 *   run has none and every crash case has exactly one.
 * - `checkpoint.created` — "snapshots are an optimisation" (DESIGN 4.3 row 18), so a host killed after the last
 *   transition and before its checkpoint leaves a run that is COMPLETED and has none.
 *
 * All three are therefore asserted by COUNT (`engine-sqlite-fake.itest.ts`) instead of by position.
 */
const NON_STATE_EVENT_TYPES: ReadonlySet<string> = new Set(['run.resumed', 'lock.stolen', 'checkpoint.created']);

/**
 * The run's lifecycle SPINE: {@link eventTypes} with the {@link NON_STATE_EVENT_TYPES} and the journaled effect's
 * own `tool.*` rows removed. Those are the only families a crash may legitimately change, and each change is
 * recorded behaviour, not slack:
 *
 * - recovery appends its `run.resumed` once per host incarnation and its `lock.stolen` once per takeover, and a
 *   checkpoint is an optimisation a killed host may simply not have written (DESIGN 4.3 row 18);
 * - an effect the verifier reconciles to `done` is completed by `Resumer`, so the host that then REPLAYS it emits no
 *   second `tool.completed` (G1 §3, U1.10 D3), while a crash before the effect ever ran costs one extra
 *   `tool.requested` when the next incarnation re-issues under the same key.
 *
 * Everything else — every command, every state change, every phase boundary — must be exactly the golden run's, once
 * each, in the same order. That is what "the same final state" means for a stream nobody may rewrite: a resumed run
 * that re-entered a finished phase or re-accepted the `start` command differs HERE and in no other assertion the
 * gate makes, because appending extra events is otherwise perfectly legal.
 */
export function lifecycleSpine(types: readonly string[]): string[] {
  return types.filter((type) => !NON_STATE_EVENT_TYPES.has(type) && !type.startsWith('tool.'));
}

/**
 * The payload of every `lock.stolen` row of the run, in sequence order — the only durable place a fencing token is
 * written, and the only evidence that a takeover really happened rather than a fresh acquisition of a lock the dead
 * host had (wrongly) released. Read through `readEvents`'s own types, so a payload field that moved is a type error.
 */
export async function lockStolenPayloads(
  store: StateStore,
  runId: RunId,
): Promise<Extract<DurableEnvelope, { type: 'lock.stolen' }>['payload'][]> {
  const events = await store.readEvents(runId, { afterSequence: 0, limit: 1000, types: ['lock.stolen'] });
  return events.flatMap((event) => (event.type === 'lock.stolen' ? [event.payload] : []));
}

/** Every effect of the run, by idempotency key. */
export async function effectsByKey(store: StateStore, runId: RunId): Promise<Map<string, EffectRecord[]>> {
  const rows = await store.listEffects(runId, {
    states: ['intent', 'done', 'failed', 'in-doubt', 'compensated'],
  });
  const byKey = new Map<string, EffectRecord[]>();
  for (const effect of rows) {
    const existing = byKey.get(effect.idempotencyKey) ?? [];
    existing.push(effect);
    byKey.set(effect.idempotencyKey, existing);
  }
  return byKey;
}
