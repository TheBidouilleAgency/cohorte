// DESIGN 2.3.4 / spec 17.2 / ADR-0004 — commands. One-shot CLI spawns are the only V3.0 transport, so every command
// type has a CLI verb, and what differs between them is DATA: the COMMANDS table below (payload schema, route,
// whether it carries an authenticator, whether it produces a result event).
import {
  AgentId,
  ApprovalId,
  ArtifactId,
  BudgetCounters,
  CommandId,
  canonicalJson,
  EffectId,
  IsoInstant,
  type JsonValue,
  JsonValueSchema,
  ModelRef,
  RunId,
  Sha256,
  SpecId,
  SurfaceId,
} from '@cohorte/base';
import { type Static, type TSchema, Type } from 'typebox';
import { compileSchema, toOpenTableSchema, type Validator } from './compile.ts';
import { PROTOCOL_VERSION } from './envelope.ts';
import { ClosedEnum, OpenEnum } from './open-enum.ts';
import { ActivePipelineState, Actor, PipelineProfile } from './vocabulary.ts';

export const COMMANDS_SCHEMA_ID = 'https://cohorte.dev/schemas/3/commands.schema.json';

/** `inspect { kind: 'artifact' }`: default 1 MiB, cap 3 MiB, so the document stays under a 4 MiB one-shot client. */
export const INSPECT_ARTIFACT_DEFAULT_BYTES = 1024 * 1024;
export const INSPECT_ARTIFACT_MAX_BYTES = 3 * 1024 * 1024;

const count = () => Type.Integer({ minimum: 0 });

export const COMMAND_AUTH_SCHEMES = ['hmac-sha256'] as const;
/**
 * Scheme-neutral, so an asymmetric signature (ADR-0022 "Revisit") is a MINOR. V3.0: value = hex
 * HMAC-SHA256(projectKey, canonicalCommandBody(envelope)). An unknown scheme VALIDATES under the open schema:
 * refusing it (`security/command-auth-invalid`) is the host's job, not the parser's.
 */
export const CommandAuth = Type.Object({
  scheme: OpenEnum(COMMAND_AUTH_SCHEMES),
  value: Type.String({ minLength: 1 }),
});
export type CommandAuth = Static<typeof CommandAuth>;

const StartPayload = Type.Object({
  profile: PipelineProfile,
  spec: Type.Optional(Type.Union([Type.Object({ id: SpecId }), Type.Object({ path: Type.String() })])),
  reviewTarget: Type.Optional(
    Type.Union([
      Type.Object({ ref: Type.String() }),
      Type.Object({ base: Type.String(), head: Type.String() }),
      Type.Object({ runId: RunId }),
    ]),
  ),
  withFix: Type.Optional(Type.Boolean()),
  phases: Type.Optional(Type.Array(ActivePipelineState)),
  /** keyed by role */
  modelOverrides: Type.Optional(Type.Record(Type.String(), ModelRef)),
  runtime: Type.Optional(Type.String()),
  fakeScript: Type.Optional(Type.String()),
  unattended: Type.Boolean(),
  budgets: Type.Optional(BudgetCounters),
  sandboxRequire: Type.Optional(ClosedEnum(['native', 'best-effort'])),
  /** 2.10.1: `--trust-project-config` travels in the SIGNED start command, so the host's re-check sees the consent the CLI saw */
  consent: Type.Optional(Type.Object({ policySha256: Sha256, via: Type.Literal('cli-flag') })),
});

const InspectPayload = Type.Object({
  target: Type.Union([
    Type.Object({ kind: Type.Literal('agent'), agentId: AgentId }),
    Type.Object({ kind: Type.Literal('context'), agentId: AgentId, incarnation: count() }),
    Type.Object({ kind: Type.Literal('approval'), approvalId: ApprovalId }),
    Type.Object({ kind: Type.Literal('effect'), effectId: EffectId }),
    Type.Object({ kind: Type.Literal('snapshot') }),
    Type.Object({ kind: Type.Literal('locks') }),
    Type.Object({ kind: Type.Literal('diff'), surface: Type.Optional(SurfaceId) }),
    Type.Object({
      kind: Type.Literal('artifact'),
      artifactId: ArtifactId,
      maxBytes: Type.Optional(
        Type.Integer({ minimum: 1, maximum: INSPECT_ARTIFACT_MAX_BYTES, default: INSPECT_ARTIFACT_DEFAULT_BYTES }),
      ),
      offset: Type.Optional(count()),
    }),
  ]),
});

export type CommandRoute =
  /** read of the store by the CLI process itself: no inbox, no authenticator, no host needed, no lock (SIGKILL-safe) */
  | 'direct-read'
  /** the CLI validates, then ONE project transaction: putRun(IDLE) + enqueue the signed start; spawns the detached host */
  | 'start'
  /** signed, INSERT ... ON CONFLICT(command_id) DO NOTHING, poke file; the CLI waits at most `--wait` */
  | 'inbox'
  /** runs inside the CLI with no run at all */
  | 'cli-local';

export interface CommandDeclaration<P extends TSchema = TSchema> {
  readonly payload: P;
  readonly route: CommandRoute;
  /** `auth` is REQUIRED: the host answers command.rejected{security/command-auth-invalid} without it and applies nothing */
  readonly authenticated: boolean;
  /** false for the pure readers (D-23): a SIGKILL-safe reader writes nothing; its result is the document itself */
  readonly emitsResultEvent: boolean;
}

const reader = <P extends TSchema>(payload: P, route: 'direct-read' | 'cli-local') =>
  ({ payload, route, authenticated: false, emitsResultEvent: false }) as const;
const mutating = <P extends TSchema, R extends 'start' | 'inbox' = 'inbox'>(payload: P, route?: R) =>
  ({ payload, route: route ?? 'inbox', authenticated: true, emitsResultEvent: true }) as const;

export const COMMANDS = {
  start: mutating(StartPayload, 'start'),
  /** no runId => ProjectStatusDocument (R4 "current pipeline") */
  status: reader(Type.Object({ runId: Type.Optional(RunId) }), 'direct-read'),
  inspect: reader(InspectPayload, 'direct-read'),
  tail: reader(
    Type.Object({
      sinceSequence: Type.Optional(count()),
      replay: Type.Optional(count()),
      follow: Type.Boolean(),
      ephemeral: Type.Boolean(),
    }),
    'direct-read',
  ),
  pause: mutating(Type.Object({ reason: Type.Optional(Type.String()) })),
  resume: mutating(
    Type.Object({
      acknowledge: Type.Optional(Type.Literal('blocked-inspected')),
      raiseBudgets: Type.Optional(BudgetCounters),
      takeover: Type.Optional(Type.Boolean()),
    }),
  ),
  cancel: mutating(Type.Object({ reason: Type.Optional(Type.String()), keepWorktrees: Type.Boolean() })),
  approve: mutating(
    Type.Object({
      approvalId: ApprovalId,
      scope: ClosedEnum(['once', 'run']),
      /** required when the request carries `options`; must be one of them; echoed in the tool result */
      answer: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
    }),
  ),
  deny: mutating(Type.Object({ approvalId: ApprovalId, note: Type.Optional(Type.String()) })),
  retry: mutating(
    Type.Object({
      target: Type.Union([
        Type.Object({ kind: Type.Literal('phase'), state: Type.Optional(ActivePipelineState) }),
        Type.Object({ kind: Type.Literal('agent'), agentId: AgentId }),
      ]),
    }),
  ),
  /** only if policy.skip lists that phase */
  skip: mutating(Type.Object({ phase: ActivePipelineState, justification: Type.String({ minLength: 1 }) })),
  /** admin; rejected unless policy.admin.runTool; still goes through the full gate chain */
  'run-tool': mutating(
    Type.Object({
      agentId: Type.Optional(AgentId),
      tool: Type.String({ minLength: 1 }),
      input: JsonValueSchema,
      justification: Type.String({ minLength: 1 }),
    }),
  ),
  /** V3.0: 'plan' only */
  reconcile: reader(Type.Object({ mode: ClosedEnum(['plan', 'apply']) }), 'cli-local'),
  shutdown: mutating(Type.Object({ graceMs: count() })),
  /** R11: optional, policy.steer.enabled, default false */
  'agent.send': mutating(
    Type.Object({ agentId: AgentId, text: Type.String(), delivery: ClosedEnum(['steer', 'follow-up']) }),
  ),
} as const satisfies Record<string, CommandDeclaration>;

export type CommandType = keyof typeof COMMANDS;
export const COMMAND_TYPES = Object.keys(COMMANDS) as readonly CommandType[];
export type CommandPayloads = { [T in CommandType]: Static<(typeof COMMANDS)[T]['payload']> };

export const CommandEnvelopeBase = Type.Object({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  /** client-generated; THE idempotency key. Same id + same body = same outcome; same id + other body = conflict/command-id-reuse */
  commandId: CommandId,
  /** narrowed per command */
  type: Type.String({ minLength: 1 }),
  runId: Type.Optional(RunId),
  issuedAt: IsoInstant,
  actor: Actor,
  /** optimistic guard: reject if the run moved past this sequence */
  expectedSequence: Type.Optional(count()),
  /** narrowed per command */
  payload: Type.Unknown(),
  auth: Type.Optional(CommandAuth),
});

export type CommandEnvelope<T extends CommandType = CommandType> = {
  [K in T]: Omit<Static<typeof CommandEnvelopeBase>, 'type' | 'payload'> & { type: K; payload: CommandPayloads[K] };
}[T];

/** Writer side: the payload of one command type, unknown keys rejected. */
export function compileCommandPayload<T extends CommandType>(type: T): Validator<CommandPayloads[T]> {
  return compileSchema(COMMANDS[type].payload) as Validator<CommandPayloads[T]>;
}

const envelopeSchemas = new Map<CommandType, TSchema>();

/** Writer side: the whole envelope of one command type, unknown keys rejected at every depth. */
export function compileCommand<T extends CommandType>(type: T): Validator<CommandEnvelope<T>> {
  let schema = envelopeSchemas.get(type);
  if (!schema) {
    // Built from the base's own properties rather than an intersection: a closed intersection refuses every value.
    const { type: _type, payload: _payload, ...shared } = CommandEnvelopeBase.properties;
    schema = Type.Object({ ...shared, type: Type.Literal(type), payload: COMMANDS[type].payload });
    envelopeSchemas.set(type, schema);
  }
  return compileSchema(schema) as Validator<CommandEnvelope<T>>;
}

/** Published side: open envelope, one branch per known command and a catch-all (a MINOR may add commands). */
export function toOpenCommandsJsonSchema(): JsonValue {
  return toOpenTableSchema({
    $id: COMMANDS_SCHEMA_ID,
    title: 'Cohorte Protocol command envelope',
    base: CommandEnvelopeBase,
    discriminant: 'type',
    body: 'payload',
    rows: COMMAND_TYPES.map((type) => ({ type, body: COMMANDS[type].payload })),
  });
}

/**
 * The envelope MINUS `auth`, as canonical JSON: exactly what the authenticator covers, and the only thing `security`
 * ever sees of a command (it signs bytes, not envelopes). Key order never matters; every other field does.
 */
export function canonicalCommandBody(
  envelope: CommandEnvelope | (Omit<CommandEnvelope, 'auth'> & { auth?: unknown }),
): string {
  const { auth: _auth, ...body } = envelope;
  return canonicalJson(body as JsonValue);
}

/** Controller exit codes. 4 is not an error: the inbox is durable, the command is accepted but still pending at `--wait` expiry. */
export const CONTROLLER_EXIT_CODES = { completed: 0, usage: 2, rejected: 3, pending: 4 } as const;
export type ControllerOutcome = keyof typeof CONTROLLER_EXIT_CODES;

/** Default `--wait` of a controller, under the 10 s after which François kills a one-shot spawn. */
export const CONTROLLER_DEFAULT_WAIT_MS = 8000;
