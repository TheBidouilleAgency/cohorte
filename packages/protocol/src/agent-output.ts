// DESIGN 2.9 / spec 22 — the agent output envelope and review findings.
//
// AgentOutput IS `submit_result.inputSchema`: a model reads it. It is therefore FLAT — everything inlined, no $ref,
// no $defs, no oneOf/anyOf — and built from ClosedEnum (`enum`) rather than unions of literals.
// A Finding without `location` or without `reproduction` VALIDATES: routing it to `needsInvestigation` is
// TypeScript in core (review/normalize.ts), never a schema failure that would cost the agent its whole output.
import { FindingId, SurfaceId } from '@cohorte/base';
import { type Static, Type } from 'typebox';
import { ClosedEnum } from './open-enum.ts';
import { Severity } from './vocabulary.ts';

export const AGENT_OUTPUT_MAX_SUMMARY = 2000;
export const AGENT_OUTPUT_MAX_FINDINGS = 30;

const confidence = () => Type.Number({ minimum: 0, maximum: 1 });
const lineNumber = () => Type.Integer({ minimum: 1 });

export const FINDING_KINDS = ['spec-violation', 'security', 'quality', 'complexity', 'check-failure'] as const;

export const Finding = Type.Object({
  /** assigned by Cohorte */
  id: Type.Optional(FindingId),
  severity: Severity,
  kind: ClosedEnum(FINDING_KINDS),
  rule: Type.String(),
  location: Type.Optional(
    Type.Object({
      file: Type.String(),
      line: Type.Optional(lineNumber()),
      endLine: Type.Optional(lineNumber()),
      symbol: Type.Optional(Type.String()),
    }),
  ),
  reproduction: Type.Optional(Type.String()),
  expected: Type.String(),
  actual: Type.String(),
  confidence: confidence(),
  suggestedFix: Type.Optional(Type.String()),
  scope: ClosedEnum(['in-scope', 'deferred']),
  outOfScopeReason: Type.Optional(Type.String()),
});
export type Finding = Static<typeof Finding>;

export const AgentOutput = Type.Object({
  status: ClosedEnum(['completed', 'failed', 'blocked', 'needs-input']),
  summary: Type.String({ maxLength: AGENT_OUTPUT_MAX_SUMMARY }),
  artifacts: Type.Array(
    Type.Object({
      path: Type.String(),
      kind: ClosedEnum(['diff', 'file', 'test', 'report', 'contract']),
      /** ignored; Cohorte recomputes. A plain string on purpose: a wrong digest from a model must not fail its output. */
      sha256: Type.Optional(Type.String()),
    }),
  ),
  findings: Type.Array(Finding, { maxItems: AGENT_OUTPUT_MAX_FINDINGS }),
  /** claims; TEST is the truth */
  checks: Type.Array(
    Type.Object({
      name: Type.String(),
      status: ClosedEnum(['passed', 'failed', 'skipped', 'not-run']),
      command: Type.Optional(Type.String()),
    }),
  ),
  questions: Type.Array(Type.String()),
  confidence: confidence(),
  assumptions: Type.Optional(Type.Array(Type.Object({ gap: Type.String(), decision: Type.String() }))),
  remediationAddressed: Type.Optional(Type.Array(Type.Object({ findingId: Type.String(), how: Type.String() }))),
});
export type AgentOutput = Static<typeof AgentOutput>;

const count = () => Type.Integer({ minimum: 0 });

/** Computed by core, never read from a model (2.9 rule 5). */
export const ReviewResult = Type.Object({
  verdict: ClosedEnum(['approved', 'findings', 'needs-human']),
  kept: Type.Array(Finding),
  refuted: Type.Array(Finding),
  deferred: Type.Array(Finding),
  needsInvestigation: Type.Array(Finding),
  blocking: count(),
  blockingItems: Type.Array(Type.String()),
  /** sha256(items)[0:16]; '' when there is nothing to fix */
  fingerprint: Type.String({ pattern: '^(?:[0-9a-f]{16})?$' }),
  unreviewed: Type.Array(SurfaceId),
  clean: Type.Boolean(),
  counts: Type.Object({ critical: count(), major: count(), minor: count(), info: count() }),
});
export type ReviewResult = Static<typeof ReviewResult>;
