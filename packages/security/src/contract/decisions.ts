// Decisions, verdicts, grants and the pure engine (DESIGN 2.6.1, 2.6.2).
import {
  AgentId,
  ApprovalId,
  type BudgetCounters,
  type Clock,
  type JsonValue,
  JsonValueSchema,
  type RunId,
  Sha256,
  type ToolCallId,
} from '@cohorte/base';
import { CommandRule, type NetworkPolicyConfig, type Ownership } from '@cohorte/config/schema';
import { type TUnsafe, Type } from 'typebox';
import type { CommandPolicy, ProgramResolver } from './commands.ts';
import type { CanonicalPath, PathIntent, PathResolver, ResolvedPath, SymlinkPolicy } from './paths.ts';

/**
 * Spec 9, exactly. The pure engine returns allow | deny | ask. allow-once / allow-for-run are APPROVAL RESOLUTIONS:
 * rows in `approvals`, found by grantKey at stage 6, reported in the verdict with the approvalId so the audit trail
 * says WHY. An `ask` nobody can answer becomes `deny`: an unanswerable ask never silently runs.
 */
export const POLICY_DECISIONS = ['allow', 'deny', 'ask', 'allow-once', 'allow-for-run'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const GATE_STAGE_NAMES = [
  'liveness',
  'schema',
  'capability',
  'path',
  'command',
  'network',
  'budget',
  'approval',
] as const;
export type GateStageName = (typeof GATE_STAGE_NAMES)[number];

export interface GateCall {
  runId: RunId;
  agentId: AgentId;
  incarnation: number;
  toolCallId: ToolCallId;
  tool: string;
  input: JsonValue;
  phase: string;
  role: string;
}

export interface GlobSet {
  include: string[];
  exclude: string[];
}

/**
 * THE glob semantics of 2.6.3 step 7, implemented once (decide/paths) and exported as a contract so `tools`
 * (list_files, search, git_diff output filtering, WorkspaceReader) and `core` (grants, zones) never configure
 * picomatch themselves. `toExcludeArgs` renders a deny set for an external enumerator.
 */
export interface GlobMatcher {
  matches(relativePosixPath: string, set: GlobSet): boolean;
  isDenied(relativePosixPath: string, grant: AgentGrant, intent: 'read' | 'write'): boolean;
  toExcludeArgs(set: GlobSet, dialect: 'rg-glob' | 'git-pathspec'): string[];
}

export interface NormalizedCall {
  tool: string;
  paths: { arg: string; resolved: ResolvedPath; intent: PathIntent }[];
  command?: {
    file: CanonicalPath;
    args: string[];
    cwd: CanonicalPath;
    ruleId: string;
    replay: 'idempotent' | 'at-most-once';
    network: boolean;
    timeoutMs: number;
  };
  /** strictly validated, size-capped */
  input: JsonValue;
  /** canonical subject used for grant_key (DESIGN 4.5) */
  grantKeyMaterial: JsonValue;
}

/** facts pre-fetched; sync */
export interface BranchResolver {
  branchOf(
    cwd: CanonicalPath,
  ): { kind: 'branch'; name: string; protected: boolean } | { kind: 'detached-or-unknown'; protected: true };
}

export interface BudgetReader {
  remaining(level: 'run' | 'phase' | 'agent' | 'provider' | 'tool', id: string): BudgetCounters;
  callsInLastMinute(agentId: AgentId, tool: string): number;
}

/** every verdict is schema-valid */
export interface PolicyVerdict {
  decision: PolicyDecision;
  stage: GateStageName;
  ruleId: string;
  /** humans / events */
  reason: string;
  /** no secrets, no absolute host paths, no policy internals; ends with "Do not retry." for deny */
  modelFacingReason: string;
  /** false = built-in rule that no project config and no approval can lift */
  overridable: boolean;
  /** true => run goes BLOCKED (spec 24): symlink escape, protected path write, runtime path, MAC failure… */
  securityViolation: boolean;
  asks: { stage: GateStageName; ruleId: string; reason: string }[];
  /** every rule id evaluated, for `cohorte policy explain` and the audit event */
  evaluatedRules: string[];
  /** what will actually execute: canonical paths, resolved program realpath, clamped timeout, replay class */
  normalized: NormalizedCall | null;
  approvalId?: ApprovalId;
  grantId?: string;
}

/** computed by core from ownership.yaml + role defaults + phase contract; persisted in agents.grants_json */
export interface AgentGrant {
  agentId: AgentId;
  role: string;
  digest: Sha256;
  tools: string[];
  roots: { workspace: CanonicalPath | null; readOnly: CanonicalPath[] };
  read: GlobSet;
  /** write ⊆ owned paths of the surface; worktree-relative POSIX, dot:true, slash-less pattern means any depth */
  write: GlobSet;
  /** always win. Defaults: DEFAULT_DENY_GLOBS */
  denyRead: GlobSet;
  denyWrite: GlobSet;
  commands: CommandPolicy;
  /** ids only; values resolved inside the Executor and registered with the Redactor first */
  secrets: { id: string; exposeAs: 'env'; name: string }[];
  /** spec 8 "grant temporaire audité" */
  temporary: { grantId: string; approvalId: ApprovalId; grantKey: string; expires: 'call' | 'run' }[];
  limits: {
    maxToolCalls: number;
    maxCallsPerMinute: number;
    perTool: Record<string, { maxCalls?: number; timeoutMs: number; maxOutputBytes: number }>;
  };
}

/** all SYNCHRONOUS */
export interface PolicyPorts {
  paths: PathResolver;
  branches: BranchResolver;
  budgets: BudgetReader;
  programs: ProgramResolver;
  clock: Clock;
}

/** deterministic => table-testable */
export interface PolicyEngine {
  evaluate(call: GateCall, grant: AgentGrant, policy: PolicySnapshot, ports: PolicyPorts): PolicyVerdict;
}

/** Immutable, hashed, built from the RESOLVED config at run start and held in host memory (I4): the project file is never re-read. */
export interface PolicySnapshot {
  readonly digest: Sha256;
  /** `policy.commands.*`, `policy.dangerousCommands` (always `ask`) and `checks.*` (exact argv, idempotent), as one rule list */
  readonly commands: CommandPolicy;
  readonly symlinks: SymlinkPolicy;
  readonly network: NetworkPolicyConfig;
  readonly protectedBranches: readonly string[];
  /** for the `shared` / `approval: human` asks of stage 3 (DESIGN 5.6) */
  readonly ownership: Ownership;
  /** under L0 a rule flagged `network` is DENIED, not asked (DESIGN 2.6.6) */
  readonly sandboxLevel: 'L0-process' | 'L1-os';
}

/** So that stages 1 and 3 validate a call without importing `tools` (PLAN PC-4). Implemented from the tool catalogue. */
export interface ToolIntrospection {
  /** the STRICT JSON Schema of the tool's input; undefined = unknown tool */
  schemaOf(tool: string): JsonValue | undefined;
  /** every path-typed argument of this input, with what the tool does to it */
  pathArgsOf(tool: string, input: JsonValue): { arg: string; value: string; intent: PathIntent }[];
}

const closed = { additionalProperties: false } as const;
const oneOf = <const V extends readonly string[]>(values: V): TUnsafe<V[number]> =>
  Type.Unsafe<V[number]>({ type: 'string', enum: [...values] });
const count = () => Type.Integer({ minimum: 0 });
const canonicalPath = () => Type.String({ minLength: 1 });
const replay = () => oneOf(['idempotent', 'at-most-once']);
const globSet = () => Type.Object({ include: Type.Array(Type.String()), exclude: Type.Array(Type.String()) }, closed);

const ResolvedPathSchema = Type.Object(
  {
    canonical: canonicalPath(),
    relative: Type.String(),
    root: canonicalPath(),
    exists: Type.Boolean(),
    identity: Type.Optional(Type.Object({ dev: Type.Number(), ino: Type.Number(), nlink: Type.Number() }, closed)),
    viaSymlink: Type.Boolean(),
  },
  closed,
);

const NormalizedCallSchema = Type.Object(
  {
    tool: Type.String(),
    paths: Type.Array(
      Type.Object(
        {
          arg: Type.String(),
          resolved: ResolvedPathSchema,
          intent: oneOf(['read', 'write', 'create', 'list', 'exec-cwd']),
        },
        closed,
      ),
    ),
    command: Type.Optional(
      Type.Object(
        {
          file: canonicalPath(),
          args: Type.Array(Type.String()),
          cwd: canonicalPath(),
          ruleId: Type.String(),
          replay: replay(),
          network: Type.Boolean(),
          timeoutMs: count(),
        },
        closed,
      ),
    ),
    input: JsonValueSchema,
    grantKeyMaterial: JsonValueSchema,
  },
  closed,
);

const ask = () => Type.Object({ stage: oneOf(GATE_STAGE_NAMES), ruleId: Type.String(), reason: Type.String() }, closed);

/** [S] */
export const PolicyVerdict: TUnsafe<PolicyVerdict> = Type.Unsafe<PolicyVerdict>(
  Type.Object(
    {
      decision: oneOf(POLICY_DECISIONS),
      stage: oneOf(GATE_STAGE_NAMES),
      ruleId: Type.String({ minLength: 1 }),
      reason: Type.String(),
      modelFacingReason: Type.String(),
      overridable: Type.Boolean(),
      securityViolation: Type.Boolean(),
      asks: Type.Array(ask()),
      evaluatedRules: Type.Array(Type.String()),
      normalized: Type.Union([NormalizedCallSchema, Type.Null()]),
      approvalId: Type.Optional(ApprovalId),
      grantId: Type.Optional(Type.String()),
    },
    closed,
  ),
);

/** [S] */
export const AgentGrant: TUnsafe<AgentGrant> = Type.Unsafe<AgentGrant>(
  Type.Object(
    {
      agentId: AgentId,
      role: Type.String({ minLength: 1 }),
      digest: Sha256,
      tools: Type.Array(Type.String()),
      roots: Type.Object(
        { workspace: Type.Union([canonicalPath(), Type.Null()]), readOnly: Type.Array(canonicalPath()) },
        closed,
      ),
      read: globSet(),
      write: globSet(),
      denyRead: globSet(),
      denyWrite: globSet(),
      commands: Type.Object({ default: Type.Literal('deny'), rules: Type.Array(CommandRule) }, closed),
      secrets: Type.Array(
        Type.Object({ id: Type.String(), exposeAs: Type.Literal('env'), name: Type.String() }, closed),
      ),
      temporary: Type.Array(
        Type.Object(
          { grantId: Type.String(), approvalId: ApprovalId, grantKey: Type.String(), expires: oneOf(['call', 'run']) },
          closed,
        ),
      ),
      limits: Type.Object(
        {
          maxToolCalls: count(),
          maxCallsPerMinute: count(),
          perTool: Type.Record(
            Type.String(),
            Type.Object({ maxCalls: Type.Optional(count()), timeoutMs: count(), maxOutputBytes: count() }, closed),
          ),
        },
        closed,
      ),
    },
    closed,
  ),
);
