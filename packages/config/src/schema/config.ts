// `.cohorte/config.yaml` (DESIGN 2.10). NO open question of spec 32 is frozen as a literal type: `runtime.id`,
// provider names and role keys are open strings; what 3.0 accepts among them is a LOADER rule, not a schema rule.
import { AuthMode, BudgetCounters, ID_PATTERN, ModelCapability, ModelRef, ThinkingLevel } from '@cohorte/base';
import { ActivePipelineState, type CohorteRole, EscalationPolicy } from '@cohorte/protocol';
import { type TUnsafe, Type } from 'typebox';
import { CommandRule, DEFAULT_SYMLINK_POLICY, SymlinkPolicy } from './policy.ts';

const closed = { additionalProperties: false } as const;

/** The ONLY env channel of a provisioning effect (DESIGN 5.7): a closed allowlist of NAMES. */
export const PROVISION_ENV_NAMES = [
  'npm_config_store_dir',
  'npm_config_cache',
  'YARN_CACHE_FOLDER',
  'COREPACK_HOME',
] as const;
export type ProvisionEnvName = (typeof PROVISION_ENV_NAMES)[number];

export interface TierTarget {
  ref: ModelRef;
  thinking: ThinkingLevel;
}
export interface ApprovalsConfig {
  unattended: 'deny' | 'wait';
  expiryMinutes?: number;
  /** 10 */
  parkAfterMinutes: number;
  ship: 'human' | 'auto';
  notify: boolean;
  /** approve may spawn a host */
  autoResume: boolean;
}

/** DESIGN 2.10, verbatim. [S] schemas/config.schema.json */
export interface CohorteConfig {
  schemaVersion: 1;
  project: { id: string; defaultBranch: string; protectedBranches: string[] };
  runtime: { id: string /* 'pi' | 'fake' */; pi?: { loadFrom: 'package' | 'bundle' } };
  authentication: {
    mode: AuthMode;
    allowApiKeys: boolean;
    /** D2: all three true; accounted METERED (DESIGN 3.7) */
    anthropicSubscriptionViaPi?: {
      enabled: boolean;
      acknowledgePerTokenBilling: boolean;
      acknowledgeProviderTermsRisk: boolean;
    };
  };
  routing: {
    allowedProviders: string[];
    defaults: Partial<Record<CohorteRole, ModelCapability>>;
    tiers: Partial<Record<ModelCapability, TierTarget>>;
    escalation: EscalationPolicy;
    fallback: { enabled: boolean };
  };
  budgets: {
    run: BudgetCounters;
    phase: BudgetCounters;
    agent: BudgetCounters;
    provider: Record<string, BudgetCounters>;
    tool: Record<string, BudgetCounters>;
    /** 3 */
    concurrency: number;
    /** 5 */
    maxIncarnations: number;
  };
  loop: {
    maxFixRounds: number;
    noProgressWindow: number;
    maxDeniedCallsPerAgent: number;
    leftovers: Record<'major' | 'minor' | 'info', 'fix' | 'park' | 'ask'>;
  };
  /** argv arrays */
  checks: { typecheck?: string[]; lint?: string[]; test?: string[]; timeoutMs: number };
  provision: {
    argv?: string[];
    network: boolean;
    cacheDirs: string[];
    lockfiles: string[];
    env: Partial<Record<ProvisionEnvName, string>>;
    // default: every node_modules directory; read-only for agent commands and checks
    dependencyDirs: string[];
    /** writable, excluded from the dependency manifest, wiped before every check sequence */
    writableCaches: string[];
  };
  policy: {
    commands: { allow: CommandRule[]; ask: CommandRule[]; deny: CommandRule[] };
    dangerousCommands: CommandRule[];
    symlinks: SymlinkPolicy;
    approvals: ApprovalsConfig;
    /** default ask: an in-doubt effect needs a human ack before the agent continues (DESIGN 4.4) */
    inDoubt: 'ask' | 'continue';
    skip: ActivePipelineState[];
    steer: { enabled: boolean };
    admin: { runTool: boolean };
    quota: { autoResume: boolean };
  };
  host: { idleExitMinutes: number; pauseKeepAliveMinutes: number; pollMs: number };
  /** forward HTTP(S)_PROXY to the brain; default false */
  network: { proxyEnv: boolean };
  /** `require` absent = the computed default of DESIGN 2.6.6 */
  sandbox: { require?: 'native' | 'best-effort'; brain: 'os-if-available' | 'os' | 'process' };
  git: {
    worktreeRoot?: string;
    branchPrefix: string;
    commitIdentity: 'user' | 'cohorte';
    keepWorktrees: 'on-failure' | 'always' | 'never';
  };
  retention: {
    transcriptsDays: number;
    eventsDays: number | 'forever';
    artifactsDays: number;
    compressAfterDays: number;
  };
  /** default false; `true` is rejected by the LOADER in 3.0 (configuration/telemetry-remote-unavailable, ADR-0013) */
  telemetry: { remote: boolean };
}

const oneOf = <const V extends readonly string[]>(values: V): TUnsafe<V[number]> =>
  Type.Unsafe<V[number]>({ type: 'string', enum: [...values] });
const count = (minimum = 0) => Type.Integer({ minimum });
const argv = () => Type.Array(Type.String(), { minItems: 1 });
const strings = () => Type.Array(Type.String({ minLength: 1 }));
const rules = () => Type.Array(CommandRule);
// Explicit return types: a `Static<TRecord>` that Biome has to infer overflows its stack (docs/v3/requests/U0.03.md R1).
const budgetMap = (): TUnsafe<Record<string, BudgetCounters>> =>
  Type.Unsafe<Record<string, BudgetCounters>>(Type.Record(Type.String(), BudgetCounters));
const roleDefaults = (): TUnsafe<Partial<Record<CohorteRole, ModelCapability>>> =>
  Type.Unsafe<Partial<Record<CohorteRole, ModelCapability>>>(Type.Record(Type.String(), ModelCapability));
const tier = () => Type.Optional(Type.Object({ ref: ModelRef, thinking: ThinkingLevel }, closed));
const envValue = () => Type.Optional(Type.String({ minLength: 1 }));
const leftover = () => oneOf(['fix', 'park', 'ask']);

const CohorteConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    project: Type.Object(
      {
        id: Type.String({ pattern: ID_PATTERN }),
        defaultBranch: Type.String({ minLength: 1 }),
        protectedBranches: strings(),
      },
      closed,
    ),
    runtime: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        pi: Type.Optional(Type.Object({ loadFrom: oneOf(['package', 'bundle']) }, closed)),
      },
      closed,
    ),
    authentication: Type.Object(
      {
        mode: AuthMode,
        allowApiKeys: Type.Boolean(),
        anthropicSubscriptionViaPi: Type.Optional(
          Type.Object(
            {
              enabled: Type.Boolean(),
              acknowledgePerTokenBilling: Type.Boolean(),
              acknowledgeProviderTermsRisk: Type.Boolean(),
            },
            closed,
          ),
        ),
      },
      closed,
    ),
    routing: Type.Object(
      {
        allowedProviders: strings(),
        defaults: roleDefaults(),
        tiers: Type.Object({ fast: tier(), coding: tier(), reasoning: tier(), vision: tier(), cheap: tier() }, closed),
        escalation: EscalationPolicy,
        fallback: Type.Object({ enabled: Type.Boolean() }, closed),
      },
      closed,
    ),
    budgets: Type.Object(
      {
        run: BudgetCounters,
        phase: BudgetCounters,
        agent: BudgetCounters,
        provider: budgetMap(),
        tool: budgetMap(),
        concurrency: count(1),
        maxIncarnations: count(1),
      },
      closed,
    ),
    loop: Type.Object(
      {
        maxFixRounds: count(),
        noProgressWindow: count(1),
        maxDeniedCallsPerAgent: count(),
        leftovers: Type.Object({ major: leftover(), minor: leftover(), info: leftover() }, closed),
      },
      closed,
    ),
    checks: Type.Object(
      {
        typecheck: Type.Optional(argv()),
        lint: Type.Optional(argv()),
        test: Type.Optional(argv()),
        timeoutMs: count(1),
      },
      closed,
    ),
    provision: Type.Object(
      {
        argv: Type.Optional(argv()),
        network: Type.Boolean(),
        cacheDirs: strings(),
        lockfiles: strings(),
        env: Type.Object(
          {
            npm_config_store_dir: envValue(),
            npm_config_cache: envValue(),
            YARN_CACHE_FOLDER: envValue(),
            COREPACK_HOME: envValue(),
          },
          closed,
        ),
        dependencyDirs: strings(),
        writableCaches: strings(),
      },
      closed,
    ),
    policy: Type.Object(
      {
        commands: Type.Object({ allow: rules(), ask: rules(), deny: rules() }, closed),
        dangerousCommands: rules(),
        symlinks: SymlinkPolicy,
        approvals: Type.Object(
          {
            unattended: oneOf(['deny', 'wait']),
            expiryMinutes: Type.Optional(count(1)),
            parkAfterMinutes: count(),
            ship: oneOf(['human', 'auto']),
            notify: Type.Boolean(),
            autoResume: Type.Boolean(),
          },
          closed,
        ),
        inDoubt: oneOf(['ask', 'continue']),
        skip: Type.Array(ActivePipelineState),
        steer: Type.Object({ enabled: Type.Boolean() }, closed),
        admin: Type.Object({ runTool: Type.Boolean() }, closed),
        quota: Type.Object({ autoResume: Type.Boolean() }, closed),
      },
      closed,
    ),
    host: Type.Object({ idleExitMinutes: count(), pauseKeepAliveMinutes: count(), pollMs: count(1) }, closed),
    network: Type.Object({ proxyEnv: Type.Boolean() }, closed),
    sandbox: Type.Object(
      {
        require: Type.Optional(oneOf(['native', 'best-effort'])),
        brain: oneOf(['os-if-available', 'os', 'process']),
      },
      closed,
    ),
    git: Type.Object(
      {
        worktreeRoot: Type.Optional(Type.String({ minLength: 1 })),
        branchPrefix: Type.String({ minLength: 1 }),
        commitIdentity: oneOf(['user', 'cohorte']),
        keepWorktrees: oneOf(['on-failure', 'always', 'never']),
      },
      closed,
    ),
    retention: Type.Object(
      {
        transcriptsDays: count(),
        eventsDays: Type.Union([count(), Type.Literal('forever')]),
        artifactsDays: count(),
        compressAfterDays: count(),
      },
      closed,
    ),
    telemetry: Type.Object({ remote: Type.Boolean() }, closed),
  },
  closed,
);

/** [S]. Annotated on purpose: Biome must not infer this type (docs/v3/requests/U0.02.md R1, U0.05.md R1). */
export const CohorteConfig: TUnsafe<CohorteConfig> = Type.Unsafe<CohorteConfig>(CohorteConfigSchema);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

const MINUTE = 60_000;

/**
 * The lowest layer of the load order (DESIGN 2.10): shipped defaults < user file < project file < CLI flags.
 * `project.id` is a placeholder that `cohorte init` always replaces. DESIGN gives the numbers it cares about
 * (concurrency 3, maxIncarnations 5, loop 5/3/5, host 30/30/250, parkAfterMinutes 10); the budget and retention
 * figures are provisional defaults of this file.
 */
export const DEFAULT_CONFIG: CohorteConfig = deepFreeze<CohorteConfig>({
  schemaVersion: 1,
  project: { id: 'project', defaultBranch: 'main', protectedBranches: ['main', 'master'] },
  runtime: { id: 'pi', pi: { loadFrom: 'package' } },
  authentication: { mode: 'subscription', allowApiKeys: false },
  routing: {
    allowedProviders: ['openai-codex'],
    defaults: { implementer: 'coding', fixer: 'coding', reviewer: 'reasoning', 'security-reviewer': 'reasoning' },
    tiers: {
      coding: { ref: { provider: 'openai-codex', model: 'gpt-5.5', capability: 'coding' }, thinking: 'medium' },
      reasoning: { ref: { provider: 'openai-codex', model: 'gpt-5.5', capability: 'reasoning' }, thinking: 'high' },
      fast: { ref: { provider: 'openai-codex', model: 'gpt-5.4-mini', capability: 'fast' }, thinking: 'low' },
      cheap: { ref: { provider: 'openai-codex', model: 'gpt-5.4-mini', capability: 'cheap' }, thinking: 'low' },
    },
    escalation: { sameFailureCount: 2, ladder: [{ kind: 'human' }], maxPerRun: 2 },
    fallback: { enabled: false },
  },
  budgets: {
    run: { modelRequests: 2000, toolCalls: 10_000, wallClockMs: 360 * MINUTE },
    phase: { wallClockMs: 120 * MINUTE },
    agent: { modelRequests: 200, toolCalls: 400, wallClockMs: 45 * MINUTE, contextTokens: 200_000 },
    provider: {},
    tool: {},
    concurrency: 3,
    maxIncarnations: 5,
  },
  loop: {
    maxFixRounds: 5,
    noProgressWindow: 3,
    maxDeniedCallsPerAgent: 5,
    leftovers: { major: 'fix', minor: 'park', info: 'park' },
  },
  checks: { timeoutMs: 10 * MINUTE },
  provision: {
    network: false,
    cacheDirs: [],
    lockfiles: ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'],
    env: {},
    dependencyDirs: ['**/node_modules'],
    writableCaches: ['node_modules/.cache', 'node_modules/.vite', 'node_modules/.vitest', 'node_modules/.vite-temp'],
  },
  policy: {
    commands: { allow: [], ask: [], deny: [] },
    dangerousCommands: [],
    symlinks: { ...DEFAULT_SYMLINK_POLICY },
    approvals: { unattended: 'deny', parkAfterMinutes: 10, ship: 'human', notify: false, autoResume: false },
    inDoubt: 'ask',
    skip: [],
    steer: { enabled: false },
    admin: { runTool: false },
    quota: { autoResume: false },
  },
  host: { idleExitMinutes: 30, pauseKeepAliveMinutes: 30, pollMs: 250 },
  network: { proxyEnv: false },
  sandbox: { brain: 'os-if-available' },
  git: { branchPrefix: 'cohorte/', commitIdentity: 'user', keepWorktrees: 'on-failure' },
  retention: { transcriptsDays: 30, eventsDays: 'forever', artifactsDays: 90, compressAfterDays: 7 },
  telemetry: { remote: false },
});
