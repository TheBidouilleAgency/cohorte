// AgentHostProtocol v1 — private contract #3 (DESIGN 3.3): the frames between the runtime parent and its per-agent
// child. Engine-free and transport-agnostic: the same frames travel over the Node 'ipc' channel (serialization
// 'json') and as LF-delimited JSON over fd 3/4. Frozen in Wave 0 so that the parent and the fake brain are built in
// parallel. NO engine type crosses the channel.
import {
  type AuthMode,
  ErrorInfo,
  err,
  IsoInstant,
  type JsonValue,
  JsonValueSchema,
  ok,
  type Result,
  Sha256,
} from '@cohorte/base';
import {
  AgentExit,
  ProviderAuthStatus,
  RUNTIME_EVENT_TYPE_NAMES,
  RUNTIME_EVENT_TYPES,
  type RuntimeEventOf,
  type RuntimeEventType,
  SpawnRequest,
  ToolContent,
} from '@cohorte/runtime-contract';
import { type Static, type TSchema, type TUnsafe, Type } from 'typebox';
import { Compile } from 'typebox/compile';

export const HOST_PROTOCOL = 1;

const strict = { additionalProperties: false } as const;
const count = () => Type.Integer({ minimum: 0 });
// The explicit TUnsafe keeps Biome's type inference out of `Static<TRecord>`: it overflows its stack there and then
// exits 0, so the lint LOOKS green while nothing was checked (docs/v3/requests/U0.02.md R1, U0.03.md R1).
const stringMap = (): TUnsafe<Record<string, string>> =>
  Type.Unsafe<Record<string, string>>(Type.Record(Type.String(), Type.String()));
const delivery = () => Type.Union([Type.Literal('steer'), Type.Literal('follow-up')]);

/**
 * The spawn request as it crosses the channel. Every member of `SpawnRequest` is JSON already and the child reads
 * the prompt by reference (`readVerified(req.systemPrompt)`, DESIGN 3.4), so the wire shape IS the contract shape.
 */
export const SpawnRequestWire = SpawnRequest;
export type SpawnRequestWire = SpawnRequest;

export const EngineSettings = Type.Object(
  {
    authPath: Type.String(),
    agentDir: Type.String(),
    sessionFile: Type.String(),
    loadFrom: Type.Union([Type.Literal('package'), Type.Literal('bundle')]),
    expectedEngineVersion: Type.String(),
    responseHeaderAllowlist: Type.Array(Type.String()),
  },
  strict,
);
export type EngineSettings = Static<typeof EngineSettings>;
const AuthEngineSettings = Type.Object({ authPath: Type.String(), agentDir: Type.String() }, strict);

/**
 * What the child extracts from a thrown value or an error message, so that the classifier is a PURE, engine-free
 * function in the parent (DESIGN 3.8). Only child code looks at engine classes.
 */
export const ErrorSignal = Type.Object(
  {
    /** the engine's own error code */
    modelsErrorCode: Type.Optional(Type.String()),
    /** errno-style code of the innermost cause: ELOCKED, EPERM, EACCES, EBUSY, ECONNRESET, ABORT_ERR… */
    causeCode: Type.Optional(Type.String()),
    httpStatus: Type.Optional(Type.Integer()),
    /** sealed by the parent before it goes anywhere */
    text: Type.String(),
    origin: Type.Union([
      Type.Literal('prompt-preflight'),
      Type.Literal('model-response'),
      Type.Literal('auth-check'),
      Type.Literal('login'),
      Type.Literal('engine'),
    ]),
  },
  strict,
);
export type ErrorSignal = Static<typeof ErrorSignal>;

const attestationShape = {
  /** the engine's packages MUST all be at the same version */
  engine: Type.Object({ name: Type.String(), version: Type.String(), packageVersions: stringMap() }, strict),
  /** MUST equal the grant exactly, and so must the registry (allowlist typos vanish silently in the engine) */
  activeTools: Type.Array(Type.String()),
  /** sha256 of the system prompt the engine really holds: Cohorte's prompt + the engine's own suffix */
  effectiveSystemPromptSha256: Sha256,
  systemPromptPrefixOk: Type.Boolean(),
  /** from the engine's model runtime, no secret (DESIGN 3.7) */
  auth: Type.Object(
    {
      provider: Type.String(),
      type: Type.Union([Type.Literal('oauth'), Type.Literal('api_key')]),
      source: Type.String(),
      subscription: Type.Boolean(),
    },
    strict,
  ),
  /** MUST equal AuthRequirement.baseUrl / the requested model */
  effective: Type.Object(
    { provider: Type.String(), model: Type.String(), api: Type.String(), baseUrl: Type.String() },
    strict,
  ),
  hooks: Type.Object(
    {
      streamWrapperInstalled: Type.Boolean(),
      guardFetchInstalled: Type.Boolean(),
      onResponseChained: Type.Boolean(),
      shouldStopAfterTurn: Type.Boolean(),
    },
    strict,
  ),
  sessionFile: Type.String(),
  sessionId: Type.String({ minLength: 1 }),
  /** NAMES of env vars visible to the child; checked against allow ∪ OS_INJECTED_ENV[platform] */
  envKeys: Type.Array(Type.String()),
  platform: Type.String(),
};

/** What the child PROVES before the first prompt; the parent fails the spawn closed on ANY mismatch. */
export const Attestation = Type.Object(
  {
    ...attestationShape,
    hostProtocol: Type.Literal(1),
    extensionsLoaded: Type.Literal(0),
    extensionErrors: Type.Literal(0),
    modelFallback: Type.Literal(false),
    settings: Type.Object(
      {
        compaction: Type.Literal(false),
        agentRetry: Type.Literal(false),
        providerMaxRetries: Type.Literal(0),
        transport: Type.Literal('sse'),
      },
      strict,
    ),
  },
  strict,
);
export type Attestation = Static<typeof Attestation>;

/**
 * What a `ready` frame CARRIES: an Attestation whose fixed members are not fixed yet. A child that fell back to
 * another model says `modelFallback: true`; were the frame schema to refuse that, the spawn would fail as a schema
 * violation at a JSON pointer. It fails instead on what `diffAttestation` names. Every Attestation is a claim.
 */
export const AttestationClaim = Type.Object(
  {
    ...attestationShape,
    hostProtocol: Type.Integer(),
    extensionsLoaded: count(),
    extensionErrors: count(),
    modelFallback: Type.Boolean(),
    settings: Type.Object(
      { compaction: Type.Boolean(), agentRetry: Type.Boolean(), providerMaxRetries: count(), transport: Type.String() },
      strict,
    ),
  },
  strict,
);
export type AttestationClaim = Static<typeof AttestationClaim>;

/**
 * A runtime event as the child knows it: already normalised, without the envelope. The PARENT stamps `runId`,
 * `agentId`, `incarnation` and the durability of the type; `seq` travels on the frame.
 */
export type HostEvent = {
  [T in RuntimeEventType]: { type: T; at: IsoInstant; data: RuntimeEventOf<T>['data'] };
}[RuntimeEventType];
export const HostEvent: TUnsafe<HostEvent> = Type.Unsafe<HostEvent>(
  Type.Union(
    RUNTIME_EVENT_TYPE_NAMES.map((type) =>
      Type.Object({ type: Type.Literal(type), at: IsoInstant, data: RUNTIME_EVENT_TYPES[type].data }, strict),
    ),
  ),
);

const frame = <T extends string, P extends Record<string, TSchema>>(t: T, members: P) =>
  Type.Object({ t: Type.Literal(t), ...members }, strict);
const init = <M extends string, P extends Record<string, TSchema>>(mode: M, members: P) =>
  frame('init', { v: Type.Literal(1), nonce: Type.String({ minLength: 1 }), mode: Type.Literal(mode), ...members });

/** parent -> child */
export const ParentFrame = Type.Union([
  init('agent', { request: SpawnRequestWire, engine: EngineSettings }),
  init('auth-status', { providers: Type.Array(Type.String()), engine: AuthEngineSettings }),
  init('auth-login', { provider: Type.String(), engine: AuthEngineSettings }),
  init('auth-logout', { provider: Type.String(), engine: AuthEngineSettings }),
  // `text` and `note.text` are read by the PARENT (TaskInput / Continuation.note, hash-verified). The child delivers
  // `text`, then `note.text`, before the first model request (conformance rule 12).
  frame('prompt', {
    id: Type.String(),
    text: Type.String(),
    note: Type.Optional(Type.Object({ text: Type.String() }, strict)),
  }),
  frame('send', { id: Type.String(), messageId: Type.String(), text: Type.String(), delivery: delivery() }),
  frame('tool.result', {
    toolCallId: Type.String(),
    isError: Type.Boolean(),
    content: Type.Array(ToolContent),
    terminate: Type.Boolean(),
    resultRef: Type.Optional(Type.String()),
  }),
  frame('pause', {}),
  frame('resume', {}),
  frame('stop-after-turn', { reason: Type.String() }),
  frame('abort', { id: Type.String(), reason: Type.String() }),
  frame('auth.answer', { id: Type.String(), value: Type.String() }),
  frame('inspect', { id: Type.String() }),
  frame('shutdown', {}),
]);
export type ParentFrame = Static<typeof ParentFrame>;

/** child -> parent. All of it is untrusted input: validated here, sealed by the parent, tool input re-validated by the host. */
export const ChildFrame = Type.Union([
  // first thing the entry does
  frame('hello', { v: Type.Literal(1), pid: Type.Integer({ minimum: 1 }), nonce: Type.String({ minLength: 1 }) }),
  frame('ready', { attestation: AttestationClaim }),
  frame('event', { seq: count(), event: HostEvent }),
  frame('tool.call', {
    seq: count(),
    ordinal: Type.Integer({ minimum: 1 }),
    engineToolCallId: Type.String(),
    tool: Type.String(),
    input: JsonValueSchema,
  }),
  frame('tool.call.abandoned', {
    engineToolCallId: Type.String(),
    reason: Type.Union([Type.Literal('aborted'), Type.Literal('shutdown')]),
  }),
  // ALLOWLISTED header names only
  frame('provider.response', {
    requestId: Type.String(),
    status: Type.Integer(),
    headers: stringMap(),
  }),
  // from the GUARD FETCH (DESIGN 3.7 layer 5): what actually left the process. Never a header VALUE.
  frame('provider.request', {
    requestId: Type.String(),
    origin: Type.String(),
    authScheme: Type.Union([
      Type.Literal('bearer-jwt'),
      Type.Literal('bearer-opaque'),
      Type.Literal('api-key-header'),
      Type.Literal('none'),
    ]),
    refused: Type.Boolean(),
  }),
  frame('parked', { at: Type.Literal('model-boundary') }),
  frame('heartbeat', { rssMb: Type.Number({ minimum: 0 }), state: Type.String() }),
  frame('auth.status', { statuses: Type.Array(ProviderAuthStatus) }),
  frame('auth.show', { event: JsonValueSchema }),
  frame('auth.ask', { id: Type.String(), prompt: JsonValueSchema }),
  frame('auth.done', { status: ProviderAuthStatus }),
  // the PARENT classifies: exit.error = classify(signal) (DESIGN 3.8)
  frame('settled', { exit: Type.Omit(AgentExit, ['error'], strict), signal: Type.Optional(ErrorSignal) }),
  frame('response', {
    id: Type.String(),
    ok: Type.Boolean(),
    data: Type.Optional(JsonValueSchema),
    error: Type.Optional(ErrorInfo),
  }),
  // `error` for the child's OWN typed fatals (asset hash, endpoint mismatch…); `signal` when an engine error caused it
  frame('fatal', { error: ErrorInfo, signal: Type.Optional(ErrorSignal) }),
]);
export type ChildFrame = Static<typeof ChildFrame>;

export type FrameSender = 'parent' | 'child';
/** 'ipc' = a message of the Node 'ipc' channel (serialization 'json'); 'lf' = one LF-terminated line of JSON. */
export type FrameWire = 'ipc' | 'lf';
export type FrameOf<S extends FrameSender> = S extends 'parent' ? ParentFrame : ChildFrame;

/** One frame is one line on the 'lf' wire; a longer line is refused before it is parsed. */
export const MAX_FRAME_CHARS = 16 * 1024 * 1024;

export interface FrameRejection {
  reason: 'not-a-frame' | 'too-large' | 'not-json' | 'unknown-frame' | 'schema-violation';
  /** Where and why, never WHAT: a refused frame may hold anything, a secret included. */
  detail: string;
}

export function encodeFrame(frame: ParentFrame | ChildFrame, wire: 'lf'): string;
export function encodeFrame(frame: ParentFrame | ChildFrame, wire: 'ipc'): JsonValue;
export function encodeFrame(frame: ParentFrame | ChildFrame, wire: FrameWire): string | JsonValue;
export function encodeFrame(frame: ParentFrame | ChildFrame, wire: FrameWire): string | JsonValue {
  // JSON.stringify escapes every line terminator inside a string, so the only raw LF of a line is its end.
  return wire === 'lf' ? `${JSON.stringify(frame)}\n` : (frame as JsonValue);
}

type VariantSchema = TSchema & { properties: { t: { const: unknown }; mode?: { const: unknown } } };
interface VariantCheck {
  /** the `mode` literal of the variants that share one `t` (the four `init`); absent when the tag names one variant */
  mode: string | undefined;
  check: ReturnType<typeof Compile>;
}
// One validator per VARIANT: against the whole union, the first error is the one of the union's first member.
const checksOf = (union: { anyOf: readonly TSchema[] }): Map<string, VariantCheck[]> => {
  const byTag = new Map<string, VariantCheck[]>();
  for (const variant of union.anyOf) {
    const { t, mode } = (variant as VariantSchema).properties;
    const tag = String(t.const);
    const entry = { mode: mode === undefined ? undefined : String(mode.const), check: Compile(variant) };
    byTag.set(tag, [...(byTag.get(tag) ?? []), entry]);
  }
  return byTag;
};
const CHECKS = { parent: checksOf(ParentFrame), child: checksOf(ChildFrame) };

/** Total: whatever arrives, the answer is a frame or a rejection. It never throws and never echoes a value. */
export function decodeFrame<S extends FrameSender>(
  sender: S,
  raw: unknown,
  wire: FrameWire,
): Result<FrameOf<S>, FrameRejection> {
  let value: unknown = raw;
  if (wire === 'lf') {
    if (typeof raw !== 'string')
      return err({ reason: 'not-a-frame', detail: `expected a line of text, got ${typeof raw}` });
    if (raw.length > MAX_FRAME_CHARS) return err({ reason: 'too-large', detail: `a line of ${raw.length} characters` });
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.includes('\n')) return err({ reason: 'not-a-frame', detail: 'more than one line' });
    try {
      value = JSON.parse(line);
    } catch {
      return err({ reason: 'not-json', detail: 'the line is not JSON' });
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return err({ reason: 'not-a-frame', detail: 'a frame is a JSON object' });
  try {
    const tag: unknown = (value as { t?: unknown }).t;
    const variants = typeof tag === 'string' ? CHECKS[sender].get(tag) : undefined;
    if (typeof tag !== 'string' || variants === undefined)
      return err({ reason: 'unknown-frame', detail: `no ${sender} frame has that "t"` });
    const mode: unknown = (value as { mode?: unknown }).mode;
    const variant = variants.length === 1 ? variants[0] : variants.find((candidate) => candidate.mode === mode);
    if (variant === undefined)
      return err({ reason: 'schema-violation', detail: `${tag}: /mode is not a mode of that frame` });
    if (variant.check.Check(value)) return ok(value as FrameOf<S>);
    const [first] = variant.check.Errors(value);
    return err({
      reason: 'schema-violation',
      detail: `${tag}: ${first?.instancePath || '/'} ${first?.message ?? 'is invalid'}`,
    });
  } catch {
    // A hostile 'ipc' value (throwing getters) is not a frame.
    return err({ reason: 'not-a-frame', detail: 'the value could not be read' });
  }
}

/**
 * Env var NAMES the OS puts into every process, whatever `env` the parent passes (PLAN F-8: a Node child spawned on
 * macOS with `env: { PATH }` reports PATH and __CF_USER_TEXT_ENCODING; Node removes NODE_CHANNEL_FD itself).
 * MIRRORED from `@cohorte/security/contract/builtin.ts`, which this package may not import; a test of that package
 * asserts that the two copies are equal.
 */
export const OS_INJECTED_ENV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  darwin: Object.freeze(['__CF_USER_TEXT_ENCODING']),
});

/** What the parent knows BEFORE the child speaks, and holds the claim against. */
export interface AttestationExpectation {
  engineVersion: string;
  /** the grant: `SpawnRequest.tools[].tool` */
  activeTools: readonly string[];
  effectiveSystemPromptSha256: Sha256;
  auth: { provider: string; mode: AuthMode; allowApiKey: boolean };
  /** the requested model and `AuthRequirement.baseUrl` */
  effective: { provider: string; model: string; baseUrl: string };
  sessionFile: string;
  /** every NAME the parent put into the child's env: `sandbox.env.allow` ∪ the keys of `sandbox.env.set` */
  envAllow: readonly string[];
  /** the parent's `process.platform` */
  platform: string;
}

export interface AttestationMismatch {
  /** a dotted member of the attestation: 'activeTools', 'effective.baseUrl', 'hooks.guardFetchInstalled'… */
  field: string;
  expected: string;
  got: string;
}

export function attestationExpectation(
  request: SpawnRequest,
  engine: Pick<EngineSettings, 'expectedEngineVersion' | 'sessionFile'>,
  effectiveSystemPromptSha256: Sha256,
  platform: string,
): AttestationExpectation {
  const { provider, mode, allowApiKey, baseUrl } = request.auth;
  return {
    engineVersion: engine.expectedEngineVersion,
    activeTools: request.tools.map((grant) => grant.tool),
    effectiveSystemPromptSha256,
    auth: { provider, mode, allowApiKey },
    effective: { provider: request.model.provider, model: request.model.model, baseUrl },
    sessionFile: engine.sessionFile,
    envAllow: [...request.sandbox.env.allow, ...Object.keys(request.sandbox.env.set)],
    platform,
  };
}

const list = (names: readonly string[]): string => JSON.stringify([...names].sort());

/** Empty = the claim is an Attestation and matches. The parent refuses the spawn on ANY entry. */
export function diffAttestation(expected: AttestationExpectation, got: AttestationClaim): AttestationMismatch[] {
  const mismatches: AttestationMismatch[] = [];
  const same = (field: string, want: string | number | boolean, have: string | number | boolean): void => {
    if (want !== have) mismatches.push({ field, expected: String(want), got: String(have) });
  };

  same('hostProtocol', HOST_PROTOCOL, got.hostProtocol);
  same('engine.version', expected.engineVersion, got.engine.version);
  const strays = Object.entries(got.engine.packageVersions).filter(([, version]) => version !== got.engine.version);
  if (strays.length > 0)
    mismatches.push({
      field: 'engine.packageVersions',
      expected: `every package at ${got.engine.version}`,
      got: list(strays.map(([name, version]) => `${name}@${version}`)),
    });

  if (list(expected.activeTools) !== list(got.activeTools) || got.activeTools.length !== expected.activeTools.length)
    mismatches.push({ field: 'activeTools', expected: list(expected.activeTools), got: list(got.activeTools) });

  same('effectiveSystemPromptSha256', expected.effectiveSystemPromptSha256, got.effectiveSystemPromptSha256);
  same('systemPromptPrefixOk', true, got.systemPromptPrefixOk);
  same('extensionsLoaded', 0, got.extensionsLoaded);
  same('extensionErrors', 0, got.extensionErrors);
  same('modelFallback', false, got.modelFallback);

  same('auth.provider', expected.auth.provider, got.auth.provider);
  if (expected.auth.mode === 'subscription') {
    same('auth.type', 'oauth', got.auth.type);
    same('auth.subscription', true, got.auth.subscription);
  } else {
    same('auth.type', 'api_key', got.auth.type);
  }
  // in subscription mode the key is already flagged above: one defect, one entry per field
  if (got.auth.type === 'api_key' && !expected.auth.allowApiKey && expected.auth.mode !== 'subscription')
    mismatches.push({ field: 'auth.type', expected: 'no API key without an explicit opt-in', got: 'api_key' });

  same('effective.provider', expected.effective.provider, got.effective.provider);
  same('effective.model', expected.effective.model, got.effective.model);
  same('effective.baseUrl', expected.effective.baseUrl, got.effective.baseUrl);

  same('settings.compaction', false, got.settings.compaction);
  same('settings.agentRetry', false, got.settings.agentRetry);
  same('settings.providerMaxRetries', 0, got.settings.providerMaxRetries);
  same('settings.transport', 'sse', got.settings.transport);
  for (const [hook, installed] of Object.entries(got.hooks)) same(`hooks.${hook}`, true, installed);

  same('sessionFile', expected.sessionFile, got.sessionFile);
  same('platform', expected.platform, got.platform);
  const visible = new Set([...expected.envAllow, ...(OS_INJECTED_ENV[expected.platform] ?? [])]);
  const foreign = got.envKeys.filter((name) => !visible.has(name));
  if (foreign.length > 0)
    mismatches.push({ field: 'envKeys', expected: `a subset of ${list([...visible])}`, got: list(foreign) });

  return mismatches;
}
