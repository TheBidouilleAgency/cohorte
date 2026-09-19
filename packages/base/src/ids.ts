import { Type } from 'typebox';
import type { ErrorInfo } from './errors.ts';
import type { Result } from './ports.ts';
import { errorOf } from './taxonomy.ts';

/** Token-safe for François' single ${token} slot, for refs and for paths. */
export const ID_PATTERN = '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$';
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Brand<string, 'RunId'>; // run_<uuidv7 without dashes>
export type AgentId = Brand<string, 'AgentId'>; // agt_<role>_<surface|main>[_<n>]   stable across incarnations
export type PhaseRunId = Brand<string, 'PhaseRunId'>; // phs_<STATE>_<iteration>
export type EventId = Brand<string, 'EventId'>; // evt_<uuidv7 hex>
export type CommandId = Brand<string, 'CommandId'>; // cmd_<uuidv7 hex>  (client-generated)
export type ApprovalId = Brand<string, 'ApprovalId'>; // apr_<uuidv7 hex>
export type ToolCallId = Brand<string, 'ToolCallId'>; // tc_<incarnation>_<ordinal>  (assigned by the runtime PARENT, deterministic)
export type EffectId = Brand<string, 'EffectId'>; // eff_<uuidv7 hex>
export type ArtifactId = Brand<string, 'ArtifactId'>; // art_<sha256[0:32]>
export type FindingId = Brand<string, 'FindingId'>; // fnd_<sha256(identity)[0:16]>
export type SpecId = Brand<string, 'SpecId'>;
export type SurfaceId = Brand<string, 'SurfaceId'>;
export type Sha256 = Brand<string, 'Sha256'>; // 64 lowercase hex
export type IsoInstant = Brand<string, 'IsoInstant'>; // RFC 3339 UTC, millisecond precision

const ISO_INSTANT_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';

/** The shape each kind of DESIGN 2.1 has, as a pattern (for schemas) and as words (for a human). */
const ID_SHAPES = {
  RunId: { pattern: '^run_[0-9a-f]{32}$', shape: 'run_<32 lowercase hex digits>' },
  AgentId: { pattern: '^agt_[A-Za-z0-9.-]+_[A-Za-z0-9_.-]+$', shape: 'agt_<role>_<surface|main>[_<n>]' },
  PhaseRunId: { pattern: '^phs_[A-Z][A-Z_]*_[0-9]+$', shape: 'phs_<STATE>_<iteration>' },
  EventId: { pattern: '^evt_[0-9a-f]{32}$', shape: 'evt_<32 lowercase hex digits>' },
  CommandId: { pattern: '^cmd_[0-9a-f]{32}$', shape: 'cmd_<32 lowercase hex digits>' },
  ApprovalId: { pattern: '^apr_[0-9a-f]{32}$', shape: 'apr_<32 lowercase hex digits>' },
  ToolCallId: { pattern: '^tc_[0-9]+_[0-9]+$', shape: 'tc_<incarnation>_<ordinal>' },
  EffectId: { pattern: '^eff_[0-9a-f]{32}$', shape: 'eff_<32 lowercase hex digits>' },
  ArtifactId: { pattern: '^art_[0-9a-f]{32}$', shape: 'art_<32 lowercase hex digits>' },
  FindingId: { pattern: '^fnd_[0-9a-f]{16}$', shape: 'fnd_<16 lowercase hex digits>' },
  SpecId: {
    pattern: ID_PATTERN,
    shape: 'letters, digits, "_", "." and "-" (at most 128, not starting with "." or "-")',
  },
  SurfaceId: {
    pattern: ID_PATTERN,
    shape: 'letters, digits, "_", "." and "-" (at most 128, not starting with "." or "-")',
  },
  Sha256: { pattern: '^[0-9a-f]{64}$', shape: '64 lowercase hex digits' },
  IsoInstant: {
    pattern: ISO_INSTANT_PATTERN,
    shape: 'an RFC 3339 UTC instant with milliseconds, such as 2026-01-01T00:00:00.000Z',
  },
} as const;

/** The kinds of DESIGN 2.1. `parseId` accepts any other brand name too and holds it to ID_PATTERN. */
export type IdKind = keyof typeof ID_SHAPES;

const isIdKind = (kind: string): kind is IdKind => Object.hasOwn(ID_SHAPES, kind);

const GENERIC_SHAPE = ID_SHAPES.SpecId;
const compiled = new Map<string, RegExp>();
const regExpOf = (pattern: string): RegExp => {
  let found = compiled.get(pattern);
  if (!found) {
    found = new RegExp(pattern);
    compiled.set(pattern, found);
  }
  return found;
};

/** The JSON Schema `pattern` of a kind; ID_PATTERN for a kind outside DESIGN 2.1. */
export function idPatternOf(kind: string): string {
  return isIdKind(kind) ? ID_SHAPES[kind].pattern : ID_PATTERN;
}

/**
 * ID_PATTERN plus the three things it lets through that `git check-ref-format` refuses in a ref component:
 * "..", a trailing "." and a trailing ".lock". Ids reach branch names (`cohorte/<runId>/<slot>/<n>`, DESIGN 5.1).
 */
export function isSafeId(raw: string): boolean {
  return regExpOf(ID_PATTERN).test(raw) && !raw.includes('..') && !raw.endsWith('.') && !raw.endsWith('.lock');
}

const isRealInstant = (raw: string): boolean => {
  const time = Date.parse(raw);
  // The round trip refuses what the pattern cannot: month 13, February 30th, 24:00, a leap second.
  return Number.isFinite(time) && new Date(time).toISOString() === raw;
};

/** The ONLY way to mint a brand from input. The rejected value is never echoed: it may be a secret pasted by mistake. */
export function parseId<B extends string>(kind: B, raw: string): Result<Brand<string, B>, ErrorInfo> {
  const { pattern, shape } = isIdKind(kind) ? ID_SHAPES[kind] : GENERIC_SHAPE;
  const wellFormed =
    typeof raw === 'string' &&
    regExpOf(pattern).test(raw) &&
    (kind === 'IsoInstant' ? isRealInstant(raw) : isSafeId(raw));
  if (wellFormed) return { ok: true, value: raw as Brand<string, B> };
  return {
    ok: false,
    error: errorOf('validation/invalid-id', `not a valid ${kind}: expected ${shape}`, {
      details: { kind, expected: shape },
    }),
  };
}

/** Renders a date as an IsoInstant. Throws a RangeError on an invalid date or a year outside 0000-9999. */
export function toIsoInstant(value: Date | number): IsoInstant {
  const text = new Date(value).toISOString();
  if (!regExpOf(ISO_INSTANT_PATTERN).test(text))
    throw new RangeError(`toIsoInstant: ${text} is outside the years 0000-9999`);
  return text as IsoInstant;
}

// [S] A schema per brand, under the name of its type, so that `Type.Object({ runId: RunId })` derives `runId: RunId`.
// Patterns that do not bound the length themselves get the 128 of ID_PATTERN.
const idSchema = <B extends IdKind>(kind: B, options: { maxLength?: number; format?: string } = {}) =>
  Type.Unsafe<Brand<string, B>>(Type.String({ ...options, pattern: ID_SHAPES[kind].pattern }));

export const RunId = idSchema('RunId');
export const AgentId = idSchema('AgentId', { maxLength: 128 });
export const PhaseRunId = idSchema('PhaseRunId', { maxLength: 128 });
export const EventId = idSchema('EventId');
export const CommandId = idSchema('CommandId');
export const ApprovalId = idSchema('ApprovalId');
export const ToolCallId = idSchema('ToolCallId', { maxLength: 128 });
export const EffectId = idSchema('EffectId');
export const ArtifactId = idSchema('ArtifactId');
export const FindingId = idSchema('FindingId');
export const SpecId = idSchema('SpecId');
export const SurfaceId = idSchema('SurfaceId');
export const Sha256 = idSchema('Sha256');
export const IsoInstant = idSchema('IsoInstant', { format: 'date-time' });
