// DESIGN 2.3.5 — ONE [S] document per `--json` output (spec 21), all computable from the store alone (R2, R4).
// A document is a READ model: where an event payload says ClosedEnum, a document often says `string`, because it must
// stay printable when the store was written by a later minor.
import {
  AgentId,
  ApprovalId,
  AuthMode,
  BudgetCounters,
  CommandId,
  EffectId,
  ErrorInfo,
  IsoInstant,
  type JsonValue,
  JsonValueSchema,
  ModelRef,
  MonetaryCost,
  PhaseRunId,
  QuotaInfo,
  RunId,
  Sha256,
  SpecId,
  SurfaceId,
  TokenUsage,
  ToolCallId,
} from '@cohorte/base';
import { type Static, type TSchema, type TUnsafe, Type } from 'typebox';
import { COMMAND_TYPES, INSPECT_ARTIFACT_MAX_BYTES } from './commands.ts';
import { compileSchema, toOpenSchema, type Validator } from './compile.ts';
import { PROTOCOL_VERSION } from './envelope.ts';
import { ContextBuiltPayload } from './events/agent.ts';
import { ApprovalResolvedPayload } from './events/governance.ts';
import { ClosedEnum, OpenEnum } from './open-enum.ts';
import { ApprovalRequest, FileTouch, RunPlan, RuntimeRef } from './refs.ts';
import {
  ActivePipelineState,
  AgentState,
  ArtifactRef,
  CheckResult,
  NodeStatus,
  PipelineProfile,
  PipelineState,
  StopRecord,
} from './vocabulary.ts';

const count = () => Type.Integer({ minimum: 0 });
const documentVersion = () => Type.Literal(1);
const protocolVersion = () => Type.Literal(PROTOCOL_VERSION);
const BILLING = ['plan-limits', 'metered'] as const;

export const APPROVAL_VIEW_MAX_WHAT = 512;
export const ApprovalView = Type.Object({
  approvalId: ApprovalId,
  kind: Type.String(),
  agentId: Type.Optional(AgentId),
  /** sealed */
  what: Type.String({ maxLength: APPROVAL_VIEW_MAX_WHAT }),
  since: IsoInstant,
  expiresAt: Type.Optional(IsoInstant),
  cli: Type.String(),
});
export type ApprovalView = Static<typeof ApprovalView>;

export const AgentNode = Type.Object({
  agentId: AgentId,
  role: Type.String(),
  surface: Type.Optional(SurfaceId),
  label: Type.String(),
  status: NodeStatus,
  lifecycle: AgentState,
  attempt: count(),
  incarnation: count(),
  model: Type.Object({
    requested: ModelRef,
    effective: Type.Optional(Type.Object({ provider: Type.String(), model: Type.String() })),
  }),
  authMode: Type.Optional(AuthMode),
  worktree: Type.Optional(Type.String()),
  usage: BudgetCounters,
  summary: Type.Optional(Type.String()),
  lastError: Type.Optional(ErrorInfo),
  pendingApproval: Type.Optional(ApprovalId),
  /** R8: optional and opaque */
  runtimeRef: Type.Optional(RuntimeRef),
});
export type AgentNode = Static<typeof AgentNode>;

export const PhaseNode = Type.Object({
  state: ActivePipelineState,
  label: Type.String(),
  status: NodeStatus,
  runs: Type.Array(
    Type.Object({
      phaseRunId: PhaseRunId,
      iteration: count(),
      status: NodeStatus,
      startedAt: Type.Optional(IsoInstant),
      endedAt: Type.Optional(IsoInstant),
      outcome: Type.Optional(Type.String()),
      agents: Type.Array(AgentNode),
      checks: Type.Array(CheckResult),
    }),
  ),
});
export type PhaseNode = Static<typeof PhaseNode>;

const RunNode = Type.Object({
  runId: RunId,
  profile: PipelineProfile,
  title: Type.String(),
  spec: Type.Object({ id: SpecId, kind: Type.String(), sha256: Sha256 }),
  state: PipelineState,
  status: NodeStatus,
  since: IsoInstant,
  resumeTo: Type.Optional(ActivePipelineState),
  stop: Type.Optional(StopRecord),
  lastError: Type.Optional(ErrorInfo),
  iteration: Type.Object({ fixRounds: count(), maxFixRounds: count(), reviewRounds: count() }),
  host: Type.Object({
    hostId: Type.Optional(Type.String()),
    alive: Type.Boolean(),
    heartbeatAt: Type.Optional(IsoInstant),
    pid: Type.Optional(count()),
  }),
  git: Type.Object({
    base: Type.Object({ branch: Type.String(), sha: Type.String() }),
    integrationBranch: Type.String(),
    integrationHead: Type.Optional(Type.String()),
    approvedTreeDigest: Type.Optional(Type.String()),
  }),
  plan: RunPlan,
  snapshotDigest: Sha256,
  startedAt: IsoInstant,
  endedAt: Type.Optional(IsoInstant),
});

/** `cohorte status <run> --json`, `inspect { kind: 'snapshot' }`, and the first line of every stream (R2). */
export const RunSnapshotDocument = Type.Object({
  documentVersion: documentVersion(),
  protocolVersion: protocolVersion(),
  cohorteVersion: Type.String(),
  generatedAt: IsoInstant,
  lastSequence: count(),
  run: RunNode,
  /** table order for the profile, not-yet-run phases as 'pending' */
  phases: Type.Array(PhaseNode),
  approvals: Type.Object({ pending: Type.Array(ApprovalView), resolved: count() }),
  budgets: Type.Array(
    Type.Object({
      scope: Type.Object({ level: Type.String(), id: Type.String() }),
      consumed: BudgetCounters,
      limit: BudgetCounters,
    }),
  ),
  usage: Type.Object({
    tokens: TokenUsage,
    monetaryCost: MonetaryCost,
    byProvider: Type.Array(
      Type.Object({
        provider: Type.String(),
        authMode: AuthMode,
        billing: ClosedEnum(BILLING),
        tokens: TokenUsage,
        quota: QuotaInfo,
        accountLabel: Type.Optional(Type.String()),
      }),
    ),
  }),
  locks: Type.Array(Type.Object({ scope: Type.String(), key: Type.String(), mode: Type.String() })),
  inDoubtEffects: Type.Array(EffectId),
});
export type RunSnapshotDocument = Static<typeof RunSnapshotDocument>;

export const PROJECT_RUN_SUMMARY_KEYS = [
  'runId',
  'profile',
  'title',
  'state',
  'status',
  'since',
  'startedAt',
  'endedAt',
  'stop',
] as const;
export type ProjectRunSummary = Pick<RunSnapshotDocument['run'], (typeof PROJECT_RUN_SUMMARY_KEYS)[number]>;
/**
 * One row of `ProjectStatusDocument.runs`: a PROJECTION of `RunSnapshotDocument.run`, never a second definition.
 *
 * KEEP THE EXPLICIT ANNOTATION. Biome 2.5.14 overflows its stack when it has to INFER the type of this pick, in every
 * file that names the const, and then exits 0 having linted nothing (docs/v3/requests/U0.02.md R1).
 */
export const ProjectRunSummary: TUnsafe<ProjectRunSummary> = Type.Unsafe<ProjectRunSummary>(
  Type.Pick(RunNode, PROJECT_RUN_SUMMARY_KEYS),
);

/** `cohorte status --json` without a run: the "current pipeline" of R4. */
export const ProjectStatusDocument = Type.Object({
  documentVersion: documentVersion(),
  protocolVersion: protocolVersion(),
  project: Type.Object({ id: Type.String(), root: Type.String() }),
  runs: Type.Array(ProjectRunSummary),
  pendingApprovals: Type.Array(ApprovalView),
});
export type ProjectStatusDocument = Static<typeof ProjectStatusDocument>;

/** spec 17.1 "diffs"; `cohorte diff --json`. A patch is fetched with `inspect { kind: 'artifact' }`. */
export const RunDiffDocument = Type.Object({
  documentVersion: documentVersion(),
  runId: RunId,
  base: Type.Object({ branch: Type.String(), sha: Type.String() }),
  head: Type.Object({ branch: Type.String(), sha: Type.String(), treeDigest: Type.String() }),
  surfaces: Type.Array(
    Type.Object({
      surface: Type.Union([Type.Literal('shared'), SurfaceId]),
      files: Type.Array(FileTouch),
      stat: Type.Object({ added: count(), removed: count() }),
      patch: ArtifactRef,
    }),
  ),
});
export type RunDiffDocument = Static<typeof RunDiffDocument>;

/**
 * The artifact window is capped in BYTES by the command (`maxBytes` <= INSPECT_ARTIFACT_MAX_BYTES). `content` is
 * those bytes as utf8 (never more characters than bytes) or as base64 (4 characters per 3 bytes): the base64 length
 * of the byte cap bounds both.
 */
export const INSPECT_ARTIFACT_MAX_CONTENT_LENGTH = 4 * Math.ceil(INSPECT_ARTIFACT_MAX_BYTES / 3);

const inspectHeader = () => ({
  documentVersion: documentVersion(),
  protocolVersion: protocolVersion(),
  runId: RunId,
  lastSequence: count(),
});

/**
 * `cohorte inspect --json`: one variant per target of the `inspect` command. Every variant repeats the header instead
 * of intersecting with it: the members of an `allOf` cannot be closed (docs/v3/requests/U0.04.md R1).
 */
export const InspectDocument = Type.Union([
  Type.Object({
    ...inspectHeader(),
    kind: Type.Literal('agent'),
    agent: AgentNode,
    grantsDigest: Sha256,
    tools: Type.Array(Type.String()),
    incarnations: Type.Array(
      Type.Object({
        n: count(),
        state: Type.String(),
        startedAt: Type.Optional(IsoInstant),
        endedAt: Type.Optional(IsoInstant),
        stop: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
      }),
    ),
  }),
  /** R9 */
  Type.Object({
    ...inspectHeader(),
    kind: Type.Literal('context'),
    agentId: AgentId,
    incarnation: count(),
    context: ContextBuiltPayload,
  }),
  /** R6 */
  Type.Object({
    ...inspectHeader(),
    kind: Type.Literal('approval'),
    request: ApprovalRequest,
    status: Type.String(),
    decision: Type.Optional(ApprovalResolvedPayload),
  }),
  Type.Object({
    ...inspectHeader(),
    kind: Type.Literal('effect'),
    effect: Type.Object({
      effectId: EffectId,
      kind: Type.String(),
      replayClass: Type.String(),
      state: Type.String(),
      toolCallId: Type.Optional(ToolCallId),
      slot: Type.Optional(Type.String()),
      request: JsonValueSchema,
      result: Type.Optional(JsonValueSchema),
      error: Type.Optional(ErrorInfo),
    }),
  }),
  Type.Object({ ...inspectHeader(), kind: Type.Literal('snapshot'), document: RunSnapshotDocument }),
  Type.Object({
    ...inspectHeader(),
    kind: Type.Literal('locks'),
    locks: Type.Array(
      Type.Object({
        scope: Type.String(),
        key: Type.String(),
        mode: Type.String(),
        owner: Type.String(),
        leaseExpiresAt: IsoInstant,
      }),
    ),
  }),
  Type.Object({ ...inspectHeader(), kind: Type.Literal('diff'), diff: RunDiffDocument }),
  Type.Object({
    ...inspectHeader(),
    kind: Type.Literal('artifact'),
    artifact: ArtifactRef,
    offset: count(),
    bytes: Type.Integer({ minimum: 0, maximum: INSPECT_ARTIFACT_MAX_BYTES }),
    truncated: Type.Boolean(),
    encoding: ClosedEnum(['utf8', 'base64']),
    /** sealed at write time */
    content: Type.String({ maxLength: INSPECT_ARTIFACT_MAX_CONTENT_LENGTH }),
  }),
]);
export type InspectDocument = Static<typeof InspectDocument>;

export const COMMAND_RESULT_STATUSES = ['completed', 'rejected', 'pending'] as const;
/**
 * What every controller prints. Also `config validate`, `spec validate`, `migrate --check` and `policy explain`, whose
 * `result` is respectively the issue list, the issue list, the MigrationReport and a PolicyVerdict.
 */
export const CommandResultDocument = Type.Object({
  documentVersion: documentVersion(),
  commandId: CommandId,
  /** open on the wire: a MINOR may add commands */
  type: OpenEnum(COMMAND_TYPES),
  status: ClosedEnum(COMMAND_RESULT_STATUSES),
  result: Type.Optional(JsonValueSchema),
  error: Type.Optional(ErrorInfo),
  lastSequence: Type.Optional(count()),
});
export type CommandResultDocument = Static<typeof CommandResultDocument>;

export const DOCTOR_CHECK_STATUSES = ['ok', 'warning', 'error', 'skipped'] as const;
/**
 * `sandbox` and `runtimeCapabilities` are SandboxCapabilities / RuntimeCapabilities VERBATIM, carried opaque: protocol
 * imports neither `security` nor `runtime-contract` (C4). Their own schemas are published beside this one.
 */
export const DoctorReport = Type.Object({
  documentVersion: documentVersion(),
  cohorteVersion: Type.String(),
  generatedAt: IsoInstant,
  ok: Type.Boolean(),
  checks: Type.Array(
    Type.Object({
      id: Type.String(),
      status: OpenEnum(DOCTOR_CHECK_STATUSES),
      summary: Type.String(),
      detail: Type.Optional(Type.String()),
      remediation: Type.Optional(Type.String()),
    }),
  ),
  sandbox: JsonValueSchema,
  runtimeCapabilities: JsonValueSchema,
});
export type DoctorReport = Static<typeof DoctorReport>;

/** Declared here a second time, not imported from runtime-contract (C4). */
export const AuthStatusDocument = Type.Object({
  documentVersion: documentVersion(),
  generatedAt: IsoInstant,
  runtime: Type.Object({ id: Type.String(), version: Type.String() }),
  providers: Type.Array(
    Type.Object({
      provider: Type.String(),
      state: Type.String(),
      subscription: Type.Boolean(),
      billing: ClosedEnum([...BILLING, 'unknown']),
      source: Type.Optional(Type.String()),
      accountLabel: Type.Optional(Type.String()),
      accountLabelNote: Type.Optional(Type.String()),
      caveat: Type.Optional(Type.String()),
      checkedAt: IsoInstant,
    }),
  ),
});
export type AuthStatusDocument = Static<typeof AuthStatusDocument>;

/** Keyed by the published file name: `schemas/<name>.schema.json` (DESIGN 7.5 AC-07 lists them). */
export const DOCUMENTS = {
  'run-state': RunSnapshotDocument,
  'project-status': ProjectStatusDocument,
  inspect: InspectDocument,
  'run-diff': RunDiffDocument,
  'command-result': CommandResultDocument,
  'doctor-report': DoctorReport,
  'auth-status': AuthStatusDocument,
} as const satisfies Record<string, TSchema>;
export type DocumentName = keyof typeof DOCUMENTS;
export const DOCUMENT_NAMES = Object.keys(DOCUMENTS) as readonly DocumentName[];

const DOCUMENT_TITLES: Record<DocumentName, string> = {
  'run-state': 'Cohorte run snapshot (status <run> --json, inspect snapshot, first stream line)',
  'project-status': 'Cohorte project status (status --json)',
  inspect: 'Cohorte inspect document (inspect --json)',
  'run-diff': 'Cohorte run diff (diff --json)',
  'command-result': 'Cohorte command result (every controller, and the validators)',
  'doctor-report': 'Cohorte doctor report (doctor --json)',
  'auth-status': 'Cohorte authentication status (auth status --json)',
};

export type DocumentOf<N extends DocumentName> = Static<(typeof DOCUMENTS)[N]>;

/** Writer side: the strict validator of one document. Every `--json` printer validates what it prints with it. */
export function compileDocument<N extends DocumentName>(name: N): Validator<DocumentOf<N>> {
  return compileSchema(DOCUMENTS[name]) as Validator<DocumentOf<N>>;
}

export const documentSchemaId = (name: DocumentName): string => `https://cohorte.dev/schemas/3/${name}.schema.json`;

/** Published side: the open form of one document, with its stable `$id`. */
export function toOpenDocumentJsonSchema(name: DocumentName): JsonValue {
  const open = toOpenSchema(DOCUMENTS[name]);
  if (typeof open !== 'object' || open === null || Array.isArray(open)) throw new TypeError(`${name}: not a schema`);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: documentSchemaId(name),
    title: DOCUMENT_TITLES[name],
    ...open,
  };
}
