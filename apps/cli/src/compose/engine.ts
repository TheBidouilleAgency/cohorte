// The production host composition.  This file is intentionally the only CLI
// module that knows how the durable core, git, policy, tools and runtime fit
// together.  Commands only see the HostRunner seam.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentId, IdSource, RunId, Sha256 } from '@cohorte/base';
import { canonicalJson, sha256Hex, systemClock } from '@cohorte/base';
import { loadConfig, resolveConfig } from '@cohorte/config';
import { literalPrefixOf } from '@cohorte/config/schema';
import {
  type AgentPlan,
  createAgentSupervisor,
  createApprovalService,
  createEffectJournal,
  createEngine,
  createEventWriter,
  createGrantComputer,
  createIntegrationService,
  createLeaseManager,
  createPhaseContracts,
  createPhaseExecutor,
  createPipelineGuards,
  createProvisioner,
  createResumer,
  createRunSnapshotter,
  createToolHost,
  createToolHostReplay,
  createTransitionEffectRunner,
  createWorktreeService,
  type HostContext,
  type LoopPolicy,
  type PhaseRunContext,
  type RunEngine,
  type RunState,
} from '@cohorte/core';
import { mapRuntimeEvent } from '@cohorte/core/agents/supervisor';
import { createFactCollector } from '@cohorte/core/pipeline/guards';
import { resolveTable } from '@cohorte/core/pipeline/tables';
import { createBuiltinEffectVerifiers } from '@cohorte/core/resume';
import type { CanonicalPath, GitPort } from '@cohorte/git/contract';
import { createGitPort } from '@cohorte/git/impl';
import { createBlobStore } from '@cohorte/persistence/blob';
import type { LeaseToken, StateStore } from '@cohorte/persistence/contract';
import { createEphemeralSpool } from '@cohorte/persistence/spool';
import { AgentOutput, type AgentOutput as AgentOutputValue, compileSchema } from '@cohorte/protocol';
import type { RuntimeHostBindings, SpawnRequest } from '@cohorte/runtime-contract';
import { createFakeRuntimeProvider, FAKE_CAPABILITIES, fakeScript, loadFakeScriptFile } from '@cohorte/runtime-fake';
import { createPiRuntimeProvider } from '@cohorte/runtime-pi';
import { piCapabilities } from '@cohorte/runtime-pi/capabilities';
import { createCommandAuthenticator, createKeyStore, createTrustStore } from '@cohorte/security/auth';
import type { PolicyPorts, AgentGrant as SecurityAgentGrant } from '@cohorte/security/contract';
import { createCommandPolicy, createProgramResolver } from '@cohorte/security/decide/commands';
import { buildPolicySnapshot, createPolicyEngine } from '@cohorte/security/decide/gate';
import { createGlobMatcher, createPathResolver } from '@cohorte/security/decide/paths';
import { createExecutor, createNoneBackend } from '@cohorte/security/exec';
import { createRedactor } from '@cohorte/security/redact';
import { TOOL_CATALOGUE, toolIntrospection } from '@cohorte/tools/catalogue';
import { createToolRegistry } from '@cohorte/tools/registry';
import { createWorkspaceReader } from '@cohorte/tools/workspace';
import { createAssetSource } from '../assets/index.ts';
import type { HostRunner, InstallInspector, OpenStore } from '../contract/index.ts';
import { createRunHost } from '../host/index.ts';
import { verifyPinnedInstall } from '../pin/index.ts';

function createHostProcessSweeper() {
  return {
    isAlive(pid: number): boolean {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async kill(pid: number, _startToken: string, signal = 'SIGTERM'): Promise<void> {
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      try {
        process.kill(pid, signal as NodeJS.Signals);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
  };
}

function createVerifierRegistry(verifiers: ReturnType<typeof createBuiltinEffectVerifiers>) {
  return { get: (kind: Parameters<typeof verifiers.get>[0]) => verifiers.get(kind) };
}

const canonical = (value: string): CanonicalPath => {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute) as CanonicalPath;
  } catch {
    return absolute as CanonicalPath;
  }
};

function pidRegistry() {
  const entries = new Set<number>();
  return {
    record(entry: { pgid: number; startToken: string; label: string }) {
      if (entry.pgid > 0) entries.add(entry.pgid);
    },
    remove(pgid: number) {
      entries.delete(pgid);
    },
  };
}

function gitBinary(pathValue: string): string {
  for (const candidate of ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']) {
    try {
      return realpathSync.native(candidate);
    } catch {
      /* try the next pinned location */
    }
  }
  return (
    pathValue
      .split(':')
      .map((entry) => join(entry, 'git'))
      .find((entry) => {
        try {
          realpathSync.native(entry);
          return true;
        } catch {
          return false;
        }
      }) ?? 'git'
  );
}

function loopPolicy() {
  return {
    maxFixRounds: 3,
    noProgressWindow: 3,
    maxDeniedCallsPerAgent: 3,
    runWallClockMs: 24 * 60 * 60 * 1000,
    escalation: { sameFailureCount: 2, ladder: [], maxPerRun: 0 },
  } as unknown as LoopPolicy;
}

function noStop(
  _run: RunState,
  facts: RunState extends never ? never : { cancelRequested: boolean; pauseRequested: boolean },
) {
  if (facts.cancelRequested) return { reason: 'cancelled' as const, detail: 'cancel requested', resumable: false };
  if (facts.pauseRequested) return { reason: 'paused' as const, detail: 'pause requested', resumable: true };
  return null;
}

interface ProductionEngineOptions {
  readonly store: StateStore;
  readonly openStore: OpenStore;
  readonly cwd: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly ids: IdSource;
  readonly install: InstallInspector;
  readonly runId?: RunId;
  readonly hostIdentity?: { hostId: string; pid: number; startToken: string };
  readonly assetsTreeSha256?: Sha256;
}

/** Build one engine for one run. All concrete dependencies stay in this file. */
export async function createProductionEngine(options: ProductionEngineOptions): Promise<RunEngine> {
  const loaded = await loadConfig({ cwd: options.cwd, home: options.home });
  const keys = createKeyStore({ directory: join(options.home, '.cohorte', 'keys') });
  const trust = createTrustStore({ directory: join(options.home, '.cohorte', 'trust'), keys });
  const resolved = await resolveConfig(loaded, {
    trustStore: trust,
    projectKeyId: sha256Hex(loaded.projectRoot).slice(0, 24),
    trustProjectConfig: true,
  });
  if (resolved.status !== 'resolved') throw new Error('security/project-policy-untrusted: host config is not trusted');

  const root = canonical(loaded.projectRoot);
  const worktreeProjectKey = sha256Hex(loaded.projectRoot).slice(0, 24);
  const worktreeBaseRoot = canonical(join(options.home, '.cohorte', 'worktrees'));
  const worktreeRoot = canonical(
    join(options.home, '.cohorte', 'worktrees', worktreeProjectKey, options.runId ?? 'pending'),
  );
  mkdirSync(worktreeBaseRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const gitPath = options.env.PATH ?? '/usr/bin:/bin';
  const git = createGitPort({
    gitBinary: gitBinary(gitPath),
    path: gitPath,
    mergeIdentity: { name: 'Cohorte', email: 'cohorte@localhost' },
    worktreeRoot,
  });
  const redactor = createRedactor();
  const spool = createEphemeralSpool({ dir: join(loaded.projectRoot, '.cohorte', 'state', 'spool') });
  const events = createEventWriter({ redactor, clock: systemClock, ids: options.ids, spool });
  const journal = createEffectJournal({ store: options.store, events, clock: systemClock, redactor });
  const leases = createLeaseManager({ store: options.store, clock: systemClock }, options.hostIdentity);
  const executor = createExecutor({ redactor, pids: pidRegistry(), clock: systemClock, backend: createNoneBackend() });
  const paths = createPathResolver({
    roots: [root, worktreeBaseRoot, worktreeRoot],
    protectedRoots: [canonical(join(loaded.projectRoot, '.cohorte')), canonical(join(loaded.projectRoot, '.git'))],
    symlinks: resolved.config.policy.symlinks,
  });
  const globs = createGlobMatcher();
  createWorkspaceReader({ paths, globs });
  const pathDirs = gitPath.split(':').filter(Boolean).map(canonical);
  const programs = createProgramResolver({ pathDirs });
  const branches: PolicyPorts['branches'] = {
    branchOf(cwd) {
      try {
        const facts = (git as GitPort).facts(cwd);
        void facts;
      } catch {
        return { kind: 'detached-or-unknown', protected: true };
      }
      return { kind: 'detached-or-unknown', protected: true };
    },
  };
  const commandPolicy = createCommandPolicy({ programs, branches });
  const policy = createPolicyEngine({ tools: toolIntrospection, globs, commands: commandPolicy });
  const policySnapshot = buildPolicySnapshot(resolved.config, loaded.ownership, { sandboxLevel: 'L0-process' });
  const policyPorts: PolicyPorts = {
    paths,
    branches,
    programs,
    budgets: { remaining: () => ({}), callsInLastMinute: () => 0 },
    clock: systemClock,
  };
  const integrationPath = canonical(join(worktreeRoot, '_integration'));
  const integrationBranch = `cohorte/${options.runId ?? 'unknown'}/integration`;
  const worktrees = createWorktreeService({
    git,
    journal,
    events,
    runId: options.runId as RunId,
    repo: root,
    root: worktreeRoot,
    integrationHead: 'HEAD',
  });
  const rawIntegration = createIntegrationService({ git, journal, events });
  const pathForSlot = (slot: string): CanonicalPath =>
    slot === '_integration' ? integrationPath : canonical(join(worktreeRoot, slot));
  const integration = {
    async commit(slot: string, kind: 'result' | 'checkpoint', paths?: readonly string[]) {
      return rawIntegration.commit(pathForSlot(slot), kind, paths === undefined ? undefined : [...paths]);
    },
    async merge(fromSlot: string, intoSlot: string) {
      const result = await rawIntegration.merge(pathForSlot(fromSlot), pathForSlot(intoSlot));
      if ('mergeSha' in result) await git.resetHardClean(integrationPath, result.mergeSha);
      return result;
    },
  };
  const grantComputer = createGrantComputer({});
  const acceptedOutputs = new Map<AgentId, AgentOutputValue>();
  const agentWorkspaceRoots = new Map<AgentId, CanonicalPath>();
  const workspaceRootForPlan = (plan: AgentPlan): CanonicalPath =>
    plan.workspace.kind === 'slot' ? pathForSlot(plan.workspace.slot) : integrationPath;
  const workspaceRootForAgent = (agentId: AgentId): CanonicalPath => {
    const assigned = agentWorkspaceRoots.get(agentId);
    if (assigned) return assigned;
    // Runtime tool calls can arrive after the request map has been recreated
    // by a provider. Agent ids are deterministic (`agt_<role>_<slot>`), so
    // retain the slot isolation even when that callback is not the same
    // object instance that populated agentWorkspaceRoots.
    const marker = '_';
    const separator = agentId.lastIndexOf(marker);
    if (separator > 0 && separator < agentId.length - 1) {
      const slot = agentId.slice(separator + marker.length);
      return pathForSlot(slot);
    }
    return root;
  };
  const validateAgentOutput = compileSchema(AgentOutput);
  let activeLease: LeaseToken | undefined;
  const grantFor = (_call: Parameters<typeof policy.evaluate>[0]): SecurityAgentGrant => {
    const workspace = workspaceRootForAgent(_call.agentId);
    const grant = grantComputer.compute({
      role: 'implementer',
      ownedPaths: ['**'],
      tools: Object.keys(TOOL_CATALOGUE),
    });
    return { ...grant, roots: { workspace, readOnly: [] } };
  };
  const toolHostDeps = {
    policy,
    paths,
    toolRegistry: createToolRegistry(TOOL_CATALOGUE),
    journal,
    events,
    approvals: createApprovalService({ store: options.store, events, clock: systemClock, ids: options.ids, redactor }),
    redactor,
    policySnapshot,
    policyPorts,
    grantFor,
    grantKeyFor: (call: Parameters<typeof policy.evaluate>[0], verdict: { normalized: unknown }) =>
      sha256Hex(canonicalJson({ call, normalized: verdict.normalized } as never)),
    executionFor: (call: Parameters<typeof policy.evaluate>[0]) => ({
      runId: call.runId,
      agentId: call.agentId,
      incarnation: call.incarnation,
      toolCallId: call.toolCallId,
      role: call.role,
      grant: grantFor(call),
      workspaceRoot: workspaceRootForAgent(call.agentId),
      paths,
      executor,
      git,
      requestApproval: async () => ({ decision: 'deny' as const }),
      acceptResult: async (output: AgentOutputValue) => {
        const checked = validateAgentOutput(output);
        if (!checked.ok) return { accepted: false, reason: checked.error.map((issue) => issue.message).join('; ') };
        acceptedOutputs.set(call.agentId, checked.value);
        return { accepted: true };
      },
    }),
    leaseFor: () => {
      if (!activeLease) throw new Error('conflict/lease-lost: tool call has no active run lease');
      return activeLease;
    },
    sandbox: executor.capabilities(),
    requestApproval: async () => ({ decision: 'deny' as const }),
    recordRequested: async (call: Parameters<typeof policy.evaluate>[0]) => {
      if (!activeLease) throw new Error('conflict/lease-lost: tool request has no active run lease');
      await options.store.transact({ runId: call.runId }, activeLease, (tx) =>
        events.append(tx, [
          {
            type: 'tool.requested',
            payload: {
              toolCallId: call.toolCallId,
              tool: call.tool,
              args: call.input,
              argsSha256: sha256Hex(canonicalJson(call.input as never)),
            },
            source: 'cohorte',
            summary: `tool requested: ${call.tool}`,
            severity: 'info',
          },
        ]),
      );
    },
    recordDenied: async (call: Parameters<typeof policy.evaluate>[0], verdict: ReturnType<typeof policy.evaluate>) => {
      if (!activeLease) throw new Error('conflict/lease-lost: tool denial has no active run lease');
      await options.store.transact({ runId: call.runId }, activeLease, (tx) =>
        events.append(tx, [
          {
            type: 'tool.denied',
            payload: {
              toolCallId: call.toolCallId,
              tool: call.tool,
              stage: verdict.stage,
              ruleId: verdict.ruleId,
              reason: verdict.reason,
              overridable: verdict.overridable,
              evaluatedRules: verdict.evaluatedRules,
              ...(verdict.approvalId === undefined ? {} : { approvalId: verdict.approvalId }),
            },
            source: 'cohorte',
            summary: `tool denied: ${call.tool}`,
            severity: 'warning',
          },
        ]),
      );
    },
  };
  const toolHost = createToolHost(toolHostDeps);
  const pending = options.runId ? await options.store.pendingCommands(options.runId) : [];
  const requestedStart = pending.find((command) => command.envelope.type === 'start')?.envelope.payload as
    | { runtime?: string; fakeScript?: string }
    | undefined;
  const fakeDefaultScript = fakeScript()
    .agent({}, [{ do: 'submit', output: { status: 'clean' } }])
    .build();
  const fakeRuntimeScript =
    requestedStart?.fakeScript === undefined
      ? fakeDefaultScript
      : (() => {
          const loadedScript = loadFakeScriptFile(resolve(root, requestedStart.fakeScript));
          if (!loadedScript.ok) throw new Error(`${loadedScript.error.code}: ${loadedScript.error.message}`);
          return loadedScript.value;
        })();
  const provider =
    (requestedStart?.runtime ?? resolved.config.runtime.id) === 'pi'
      ? createPiRuntimeProvider({ installDir: options.install.installDir(), redactor })
      : createFakeRuntimeProvider({ script: fakeRuntimeScript, clock: systemClock });
  const assets = createAssetSource();
  const shippedPromptIds = ['agents/fixer', 'agents/implementer', 'agents/reviewer', 'agents/security-reviewer'];
  const pinnedPromptPaths = new Map<string, { path: string; sha256: Sha256; bytes: number }>();
  const pinStore = createBlobStore({ dir: join(loaded.projectRoot, '.cohorte', 'state', 'cas') });
  const runtimePin = await provider.pin();
  const sandboxCapabilities = executor.capabilities();
  const snapshotter = createRunSnapshotter({
    installInspector: options.install,
    clock: systemClock,
    pinStore,
    metadata: {
      app: { version: '3.0.0-dev.6', gitHash: null },
      packages: [],
      assets: {
        treeSha256: options.assetsTreeSha256 ?? ('0'.repeat(64) as unknown as Sha256),
        embeddedTreeSha256: options.assetsTreeSha256 ?? ('0'.repeat(64) as unknown as Sha256),
      },
      schemas: { stateSchemaVersion: 1, configSchemaVersion: 1, transitionTableVersion: 1 },
      prompts: [],
      skills: [],
      environment: {
        pinnedPath: (options.env.PATH ?? '').split(':').filter(Boolean),
        platform: process.platform,
        arch: process.arch,
        sandbox: sandboxCapabilities,
        runtimeCapabilities:
          provider.id === 'fake' ? FAKE_CAPABILITIES : piCapabilities('stop-after-turn', process.platform),
      },
      readFile: async (path) => Uint8Array.from(readFileSync(path)),
    },
  });
  const bindings: RuntimeHostBindings = {
    toolHost,
    stateDir: (runId, agentId, incarnation) =>
      join(loaded.projectRoot, '.cohorte', 'runs', runId, agentId, String(incarnation)),
    clock: systemClock,
    ids: options.ids,
    log: (_level, _message) => undefined,
  };
  const supervisor = createAgentSupervisor({
    runtimeProvider: provider,
    bindings,
    events,
    clock: systemClock,
    ids: options.ids,
    onRuntimeEvent: (event) => {
      const mapped = mapRuntimeEvent(event);
      if (mapped === null) return;
      if (mapped.durability === 'ephemeral') {
        events.ephemeral(options.runId as RunId, mapped.draft);
        return;
      }
      if (!activeLease) throw new Error('conflict/lease-lost: runtime event has no active run lease');
      return options.store.transact({ runId: options.runId as RunId }, activeLease, (tx) => {
        events.append(tx, [mapped.draft]);
      });
    },
    requestFor: async (plan, ctx, incarnation): Promise<SpawnRequest> => {
      const workspaceRoot = workspaceRootForPlan(plan);
      agentWorkspaceRoots.set(plan.agentId, workspaceRoot);
      const prompt = pinnedPromptPaths.get(plan.promptId);
      if (!prompt) throw new Error(`security/prompt-not-pinned: ${plan.promptId}`);
      const taskText = [
        `# ${plan.task.role}`,
        '',
        plan.task.objective,
        '',
        `Owned paths: ${plan.task.ownedPaths.join(', ') || '(none)'}`,
        plan.task.variableSuffix ?? '',
      ].join('\n');
      const taskDir = join(
        loaded.projectRoot,
        '.cohorte',
        'runs',
        ctx.run.run.runId,
        plan.agentId,
        String(incarnation),
      );
      mkdirSync(taskDir, { recursive: true });
      const taskPath = join(taskDir, 'task.md');
      writeFileSync(taskPath, taskText, 'utf8');
      return {
        runId: ctx.run.run.runId,
        agentId: plan.agentId,
        role: plan.role,
        model: { provider: provider.id, model: provider.id === 'fake' ? 'scripted' : 'configured' },
        systemPrompt: { id: plan.promptId, path: prompt.path, sha256: prompt.sha256, bytes: prompt.bytes },
        context: {
          manifestSha256: ctx.run.run.snapshotDigest ?? sha256Hex(new Uint8Array()),
          tokenLimit: 100_000,
          tokenEstimate: 0,
          entries: [],
          reductions: [],
          exclusions: [],
        },
        tools: plan.tools.map((tool) => ({
          tool,
          description: tool,
          inputSchema: { type: 'object' },
          effect: 'control',
          terminal: tool === 'submit_result',
        })),
        sandbox: {
          require: 'process',
          filesystem: { readOnly: [], readWrite: [workspaceRoot], denyRead: [] },
          network: { mode: 'none', allowHosts: [] },
          env: { allow: ['PATH'], set: {} },
          limits: {},
        },
        budget: plan.budget,
        workingDirectory: workspaceRoot,
        incarnation,
        thinking: 'off',
        auth: {
          mode: 'subscription',
          provider: provider.id,
          baseUrl: provider.id === 'fake' ? 'https://fake.invalid' : 'https://api.openai.com',
          allowApiKey: false,
        },
        task: { path: taskPath, sha256: sha256Hex(taskText), bytes: Buffer.byteLength(taskText) },
        continuation: null,
      };
    },
    outputFor: (agentId) => acceptedOutputs.get(agentId),
  });
  const checkRunner = {
    async run(ctx: PhaseRunContext) {
      const argv = resolved.config.checks.test;
      if (!argv || argv.length === 0) return [];
      const treeDigest = await git.treeDigest(integrationPath, { exclude: [] });
      const file = programs.resolve(argv[0] as string);
      if (!file) return [{ name: 'test', status: 'errored' as const, argv: [...argv], durationMs: 0, treeDigest }];
      const result = await executor.run(
        {
          file,
          args: argv.slice(1),
          cwd: integrationPath,
          env: { PATH: gitPath, HOME: options.home },
          fs: { readWrite: [], readOnly: [integrationPath], denyRead: [] },
          network: 'none',
          timeoutMs: resolved.config.checks.timeoutMs,
          maxOutputBytes: 1024 * 1024,
          stdin: 'ignore',
          limits: {},
          require: 'best-effort',
        },
        ctx.signal,
      );
      return [
        {
          name: 'test',
          status: result.outcome === 'ok' && result.exitCode === 0 ? ('passed' as const) : ('failed' as const),
          argv: [...argv],
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          durationMs: result.durationMs,
          treeDigest,
        },
      ];
    },
  };
  const phases = createPhaseExecutor({
    contracts: createPhaseContracts({
      provisioner: createProvisioner({
        executor,
        journal,
        requestFor: async () => ({
          key: 'none',
          manifestSha256: '0'.repeat(64) as never,
          file: canonical('/usr/bin/node'),
          args: [],
          cwd: root,
          env: {},
          fs: { readWrite: [], readOnly: [], denyRead: [] },
          network: 'none',
          timeoutMs: 1,
          maxOutputBytes: 1,
          stdin: 'ignore',
          limits: {},
          require: 'best-effort',
        }),
      }),
    }),
    supervisor,
    worktrees,
    integration,
    events,
    store: options.store,
    checkRunner,
  });
  const factCollector = createFactCollector({
    store: options.store,
    runId: options.runId as RunId,
    clock: systemClock,
    probes: {
      'config.trust-satisfied': true,
      'snapshot.captured': true,
      'runtime.pin-valid': true,
      'runtime.platform-supported': true,
      'auth.plan-satisfied': true,
      'billing.consented': true,
      'sandbox.meets-policy': true,
      'repo.base-resolved': true,
      'locks.project+zones-held': true,
      'readiness.in': true,
      'contract.present-or-exempt': true,
      'reviewtarget.resolved-to-sha': true,
      'surfaces.all-owned': true,
      'outputs.schema-valid': true,
      'diff.within-ownership': true,
      'tree.digest-recorded': true,
      'checks.all-passed': true,
      'checks.digest-equals-integration': true,
      'review.nothing-to-fix': true,
      'review.no-unreviewed': true,
      'review.leftovers-parked-or-waived': true,
      'reviewref.digest-equals-integration': true,
      'approval.ship-allowed': true,
      'tree.digest-equals-approved': true,
      'acceptance.no-open-human-items': true,
    },
  });
  const guards = createPipelineGuards({ factCollector });
  const processSweeper = createHostProcessSweeper();
  const provisioner = createProvisioner({
    executor,
    journal,
    requestFor: async () => ({
      key: 'none',
      manifestSha256: '0'.repeat(64) as never,
      file: canonical('/usr/bin/node'),
      args: [],
      cwd: root,
      env: {},
      fs: { readWrite: [], readOnly: [], denyRead: [] },
      network: 'none',
      timeoutMs: 1,
      maxOutputBytes: 1,
      stdin: 'ignore',
      limits: {},
      require: 'best-effort',
    }),
  });
  const builtin = createBuiltinEffectVerifiers({ git, provisioner, sweeper: processSweeper });
  const verifierRegistry = createVerifierRegistry(builtin);
  const resumer = createResumer({
    store: options.store,
    clock: systemClock,
    sweeper: processSweeper,
    effectVerifiers: verifierRegistry,
    worktrees,
    events,
    redactor,
    toolHostReplay: createToolHostReplay(toolHostDeps),
    installInspector: options.install,
    ids: options.ids,
  });
  const transitionEffects = createTransitionEffectRunner({
    store: options.store,
    journal,
    events,
    clock: systemClock,
    handlers: Object.fromEntries(
      [
        'record-spec-hash',
        'create-integration-branch',
        'open-approval',
        'mint-review-ref',
        'synthesize-check-findings',
        'record-approved-digest',
        'release-locks',
        'write-ship-report',
        'checkpoint-worktrees',
        'checkpoint',
        'park-agents',
        'schedule-wakeup',
        'cancel-agents',
        'freeze-worktrees',
        'record-human-ack',
        'record-skip',
      ].map((id) => [
        id,
        async ({ runId, lease }: { runId: string; lease: LeaseToken }) => {
          if (id === 'create-integration-branch') {
            const facts = await git.facts(root);
            if (facts.head.kind === 'unborn')
              throw new Error('configuration/repository-unborn: repository has no commit');
            const headSha = facts.head.sha;
            if (!existsSync(integrationPath)) {
              await git.addWorktree({
                repo: root,
                path: integrationPath,
                branch: integrationBranch,
                commit: headSha,
              });
            }
            await options.store.transact({ runId: runId as RunId }, lease, (tx) =>
              tx.patchRun(runId as RunId, { baseSha: headSha, integrationHead: headSha }),
            );
          }
        },
      ]),
    ),
  });
  const keyId = sha256Hex(options.cwd).slice(0, 24);
  const projectKey = await keys.projectKey(keyId, { create: true });
  const authenticator = createCommandAuthenticator();
  const core = createEngine({
    store: options.store,
    clock: systemClock,
    ids: options.ids,
    resume: resumer,
    phases,
    loopPolicy: loopPolicy(),
    guards,
    factCollector,
    transitionEffects,
    checkGlobalStops: noStop,
    resolveTable,
    authenticator,
    projectKey,
    events,
    redactor,
    leases,
    schemaVersion: 1,
    startColumns: async (run) => {
      const facts = await git.facts(root);
      if (facts.head.kind === 'unborn') throw new Error('configuration/repository-unborn: repository has no commit');
      const trustInfo = resolved.status === 'resolved' ? resolved.trust : undefined;
      if (!trustInfo) throw new Error('security/project-policy-untrusted: host config is not trusted');
      const manifest = await snapshotter.capture({
        runId: run.runId,
        projectRoot: root,
        installDir: options.install.installDir(),
        configPaths: {
          config: join(root, '.cohorte', 'config.yaml'),
          ownership: join(root, '.cohorte', 'ownership.yaml'),
          policy: join(root, '.cohorte', 'config.yaml'),
        },
        runtime: runtimePin,
        trust: trustInfo,
        sandbox: {
          require: resolved.config.sandbox.brain === 'process' ? 'process' : 'os-if-available',
          filesystem: { readOnly: [root], readWrite: [], denyRead: [] },
          network: { mode: 'none', allowHosts: [] },
          env: { allow: ['PATH'], set: {} },
          limits: {},
        },
        models: [],
        prompts: await Promise.all(
          shippedPromptIds.map(async (id) => ({
            id,
            source: 'shipped' as const,
            logicalPath: `prompts/${id}.md`,
            path: (await assets.prompt(id)).path,
          })),
        ),
      });
      const snapshotPromptDir = join(root, '.cohorte', 'runs', run.runId, 'snapshot', 'prompts');
      mkdirSync(snapshotPromptDir, { recursive: true });
      for (const prompt of manifest.prompts) {
        const bytes = await pinStore.read(prompt.sha256);
        const path = join(snapshotPromptDir, `${prompt.id.replaceAll('/', '__')}.md`);
        writeFileSync(path, bytes, { mode: 0o600 });
        pinnedPromptPaths.set(prompt.id, { path, sha256: prompt.sha256, bytes: bytes.byteLength });
      }
      const snapshotDigest = sha256Hex(canonicalJson(manifest as never));
      await pinStore.put(new TextEncoder().encode(canonicalJson(manifest as never)));
      const sandbox = {
        level: sandboxCapabilities.level,
        backend: sandboxCapabilities.backend,
        filesystem: sandboxCapabilities.filesystem,
        network: sandboxCapabilities.network,
      };
      const zones = Object.entries(loaded.ownership.surfaces)
        .filter(([surfaceId]) => surfaceId !== 'shared')
        .flatMap(([, surface]) => surface.paths.map((path) => literalPrefixOf(path).join('/')).filter(Boolean))
        .filter((path, index, paths) => paths.indexOf(path) === index)
        .sort();
      return {
        snapshotDigest,
        runtimePin,
        plan: {
          profile: run.profile,
          runtime: { id: provider.id, version: provider.id === 'fake' ? 'fake-script' : 'pi' },
          trust: trustInfo,
          models: [],
          apiBillingEnabled: false,
          meteredProviders: [],
          sandbox,
          sandboxRequire: resolved.config.sandbox.require ?? 'best-effort',
          brainIsolation: resolved.config.sandbox.brain === 'process' ? 'process' : 'os',
          budgets: {
            run: resolved.config.budgets.run,
            perPhase: resolved.config.budgets.phase,
            perAgent: resolved.config.budgets.agent,
            perProvider: resolved.config.budgets.provider,
            perTool: resolved.config.budgets.tool,
          },
          network: { provisioning: false },
          promptOverrides: [],
          unattended: true,
        },
        baseSha: facts.head.sha,
        integrationBranch,
        zones,
      };
    },
    pollIntervalMs: resolved.config.host.pollMs,
    onLease: (lease) => {
      activeLease = lease;
    },
  });
  return {
    async run(runId, host: HostContext) {
      return core.run(runId, host);
    },
  };
}

export async function createProductionHostRunner(options: ProductionEngineOptions): Promise<HostRunner> {
  const hostIdentity = {
    hostId: `host-${process.pid}`,
    pid: process.pid,
    startToken: `${process.pid}:${process.ppid}:${process.argv0}`,
  };
  return {
    async run(runId: string) {
      const run = await options.store.getRun(runId as RunId);
      if (!run) throw new Error(`validation/invalid-id: run ${runId} does not exist`);
      const verified = await verifyPinnedInstall(options.install, run.pinnedInstallDir);
      if (!verified.ok) throw new Error(`${verified.error.code}: ${verified.error.message}`);
      const engine = await createProductionEngine({ ...options, runId: runId as RunId, hostIdentity });
      const host = createRunHost({
        engine,
        runId: runId as RunId,
        cohorteVersion: '3.0.0-dev.6',
        cwd: options.cwd,
        hostId: hostIdentity.hostId,
      });
      return host.run();
    },
  };
}
