// DESIGN 2.2.3 — SpawnRequest: the ten spec-5.1 fields + what spec 6 / 10.1 / 16 require.
import { AgentId, AuthMode, ModelRef, RunId, Sha256, ThinkingLevel } from '@cohorte/base';
import { type Static, type TUnsafe, Type } from 'typebox';
import { TranscriptRef } from './session.ts';
import { ToolGrant } from './tools.ts';

const strict = { additionalProperties: false } as const;
const count = () => Type.Integer({ minimum: 0 });
const limit = () => Type.Optional(Type.Integer({ minimum: 1 }));
const ceiling = () => Type.Optional(count());
// The explicit TUnsafe keeps Biome's type inference out of `Static<TRecord>`: it overflows its stack there and then
// exits 0, so the lint LOOKS green while nothing was checked (docs/v3/requests/U0.02.md R1, U0.03.md R1).
const stringMap = (): TUnsafe<Record<string, string>> =>
  Type.Unsafe<Record<string, string>>(Type.Record(Type.String(), Type.String()));

/** opaque label; the runtime MUST NOT branch on it */
export const AgentRole = Type.String();
export type AgentRole = Static<typeof AgentRole>;

export const AuthRequirement = Type.Object(
  {
    mode: AuthMode,
    provider: Type.String(),
    /** pinned catalogue endpoint; a runtime that would talk to anything else MUST refuse to spawn */
    baseUrl: Type.String(),
    /** false unless the run plan carries an explicit api opt-in */
    allowApiKey: Type.Boolean(),
  },
  strict,
);
export type AuthRequirement = Static<typeof AuthRequirement>;

/** rendered by the host into the run snapshot dir */
export const TaskInput = Type.Object({ path: Type.String(), sha256: Sha256, bytes: count() }, strict);
export type TaskInput = Static<typeof TaskInput>;

/** The fixed line that precedes `Continuation.note` when the engine cannot carry two user messages in one prompt. */
export const CONTINUATION_NOTE_SEPARATOR = '\n\n[cohorte] continuation note\n\n';

/**
 * `note` is delivered by the runtime AFTER `task` and BEFORE the first model request: as a second user message when
 * the engine can carry two in one prompt, otherwise appended to the first user message after
 * CONTINUATION_NOTE_SEPARATOR. Either way each text is a byte-identical contiguous span and `task` comes first
 * (conformance rule 12).
 */
export const Continuation = Type.Object(
  {
    fromIncarnation: Type.Integer({ minimum: 1 }),
    note: TaskInput,
    /** used only if continuationFromTranscript = yes */
    transcript: Type.Optional(TranscriptRef),
  },
  strict,
);
export type Continuation = Static<typeof Continuation>;

/** runtime MUST verify sha256 before use */
export const PromptRef = Type.Object(
  { id: Type.String(), path: Type.String(), sha256: Sha256, bytes: count() },
  strict,
);
export type PromptRef = Static<typeof PromptRef>;

export const ContextEntry = Type.Object(
  {
    id: Type.String(),
    tier: Type.Union([
      Type.Literal('system'),
      Type.Literal('doctrine'),
      Type.Literal('data'),
      Type.Literal('task'),
      Type.Literal('prior-results'),
    ]),
    /** agent-output and untrusted-repository can never sit above 'data' */
    trust: Type.Union([
      Type.Literal('cohorte'),
      Type.Literal('human'),
      Type.Literal('untrusted-repository'),
      Type.Literal('agent-output'),
    ]),
    source: Type.Object(
      {
        kind: Type.Union([
          Type.Literal('asset'),
          Type.Literal('project-file'),
          Type.Literal('artifact'),
          Type.Literal('event-summary'),
          Type.Literal('inline'),
        ]),
        ref: Type.String(),
      },
      strict,
    ),
    sha256: Sha256,
    bytes: count(),
    tokenEstimate: count(),
  },
  strict,
);
export type ContextEntry = Static<typeof ContextEntry>;

/**
 * PROVENANCE ONLY. "Installer le contexte" (spec 5.2) is defined as: every byte the model sees is in exactly two
 * host-rendered files — `systemPrompt` (tiers `system` + `doctrine`) and `task` (tiers `data` + `task` +
 * `prior-results`) — plus, for a later incarnation, `continuation.note`. A runtime installs those three and NOTHING
 * else: it never opens `entries[].source`, never re-orders or re-renders tiers. The manifest travels so that the
 * runtime can record `manifestSha256` on `model.requested` and so that a second runtime has nothing to guess.
 * Tiers are trust/priority tiers (spec 7), not orchestration words.
 */
export const ContextManifest = Type.Object(
  {
    /** sha256(canonicalJson(entries)) = "hash du contexte" of spec 19 */
    manifestSha256: Sha256,
    tokenLimit: count(),
    tokenEstimate: count(),
    /** deterministic order: tier, then id */
    entries: Type.Array(ContextEntry),
    reductions: Type.Array(
      Type.Object(
        {
          entryId: Type.String(),
          strategy: Type.Union([
            Type.Literal('excerpt'),
            Type.Literal('outline'),
            Type.Literal('summary-with-refs'),
            Type.Literal('dropped'),
          ]),
          fromBytes: count(),
          toBytes: count(),
        },
        strict,
      ),
    ),
    exclusions: Type.Array(
      Type.Object(
        {
          pattern: Type.String(),
          reason: Type.Union([
            Type.Literal('secret'),
            Type.Literal('outside-scope'),
            Type.Literal('size'),
            Type.Literal('binary'),
          ]),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type ContextManifest = Static<typeof ContextManifest>;

/** Isolation of the RUNTIME'S OWN agent process (the brain). Tool isolation is host-side. */
export const SandboxPolicy = Type.Object(
  {
    /** spawn fails security/sandbox-unavailable below `os` */
    require: Type.Union([Type.Literal('os'), Type.Literal('os-if-available'), Type.Literal('process')]),
    /** absolute canonical roots */
    filesystem: Type.Object(
      {
        readOnly: Type.Array(Type.String()),
        readWrite: Type.Array(Type.String()),
        denyRead: Type.Array(Type.String()),
      },
      strict,
    ),
    network: Type.Object(
      {
        mode: Type.Union([Type.Literal('none'), Type.Literal('provider-only'), Type.Literal('unrestricted')]),
        allowHosts: Type.Array(Type.String()),
      },
      strict,
    ),
    /** allowlist; nothing else is inherited (D3) */
    env: Type.Object({ allow: Type.Array(Type.String()), set: stringMap() }, strict),
    limits: Type.Object({ maxOldSpaceMb: limit(), maxCpuSeconds: limit(), maxOpenFiles: limit() }, strict),
  },
  strict,
);
export type SandboxPolicy = Static<typeof SandboxPolicy>;

/** hard ceilings for ONE incarnation; absent = unlimited at this level */
export const Budget = Type.Object(
  {
    maxTurns: ceiling(),
    maxModelRequests: ceiling(),
    maxToolCalls: ceiling(),
    maxInputTokens: ceiling(),
    maxOutputTokens: ceiling(),
    maxTotalTokens: ceiling(),
    /** stop (never auto-compact) when the last request's context exceeds this */
    maxContextTokens: ceiling(),
    maxWallClockMs: ceiling(),
    maxModelRequestMs: ceiling(),
    /** 0 = every retry is the host's (spec 11.3 "tous les retries sont visibles") */
    maxEngineRetries: count(),
  },
  strict,
);
export type Budget = Static<typeof Budget>;

export const SpawnRequest = Type.Object(
  {
    runId: RunId,
    agentId: AgentId,
    role: AgentRole,
    model: ModelRef,
    systemPrompt: PromptRef,
    context: ContextManifest,
    tools: Type.Array(ToolGrant),
    sandbox: SandboxPolicy,
    budget: Budget,
    /** absolute, canonical; the path the MODEL is told about. The engine process MUST NOT use it as its cwd */
    workingDirectory: Type.String(),
    // additions (all required so that no runtime can forget them):
    /** spec 6: spawn is idempotent on (runId, agentId, incarnation) */
    incarnation: Type.Integer({ minimum: 1 }),
    thinking: ThinkingLevel,
    /** spec 10.1 / D3 */
    auth: AuthRequirement,
    /** the first user message, by reference */
    task: TaskInput,
    /** a later incarnation of the same attempt */
    continuation: Type.Union([Continuation, Type.Null()]),
  },
  strict,
);
export type SpawnRequest = Static<typeof SpawnRequest>;
