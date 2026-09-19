import { Compile } from 'typebox/compile';
import { describe, expect, test } from 'vitest';
import {
  AgentId,
  EventId,
  ID_PATTERN,
  type IdKind,
  IsoInstant,
  idPatternOf,
  isSafeId,
  parseId,
  RunId,
  Sha256,
  toIsoInstant,
} from '../src/index.ts';

const HEX32 = '0192f0c1a2b37c4d8e9fa0b1c2d3e4f5';
const HEX64 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('ID_PATTERN', () => {
  const pattern = new RegExp(ID_PATTERN);

  test('is the DESIGN 2.1 pattern, verbatim', () => {
    expect(ID_PATTERN).toBe('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$');
  });

  test.for(['a', 'A9', '_x', 'a.b-c_d', 'run_0192f0c1a2b37c4d8e9fa0b1c2d3e4f5', 'x'.repeat(128)])(
    'accepts %s',
    (raw) => {
      expect(pattern.test(raw)).toBe(true);
    },
  );

  test.for([
    ['empty', ''],
    ['leading dot (hidden file, "." and "..")', '.a'],
    ['dot-dot', '..'],
    ['leading dash (reads as an option)', '-a'],
    ['path separator', 'a/b'],
    ['backslash', 'a\\b'],
    ['space', 'a b'],
    ['newline', 'a\n'],
    ['129 characters', 'x'.repeat(129)],
    ['non-ASCII', 'é'],
    ['dollar', 'a$'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of François' token slot
    ['token slot syntax', '${token}'],
    ['colon (refspec separator)', 'a:b'],
    ['tilde (ref suffix)', 'a~1'],
    ['caret (ref suffix)', 'a^'],
    ['glob ?', 'a?'],
    ['glob *', 'a*'],
    ['glob [', 'a['],
    ['reflog syntax', 'a@{1}'],
    ['NUL', 'a\0'],
  ] as const)('rejects %s', ([, raw]) => {
    expect(pattern.test(raw)).toBe(false);
  });
});

describe('isSafeId: what ID_PATTERN alone lets through but a git ref refuses', () => {
  test.for(['a..b', 'a.lock', 'a.', 'x.lock'])('rejects %s', (raw) => {
    expect(new RegExp(ID_PATTERN).test(raw)).toBe(true);
    expect(isSafeId(raw)).toBe(false);
  });

  test.for(['a.b', 'a.locks', 'lock', 'a-b.c_d'])('accepts %s', (raw) => {
    expect(isSafeId(raw)).toBe(true);
  });
});

describe('parseId', () => {
  const valid: ReadonlyArray<readonly [IdKind, string]> = [
    ['RunId', `run_${HEX32}`],
    ['AgentId', 'agt_implementer_web'],
    ['AgentId', 'agt_security-reviewer_main'],
    ['AgentId', 'agt_fixer_api.v2_3'],
    ['PhaseRunId', 'phs_BUILD_1'],
    ['PhaseRunId', 'phs_WAITING_APPROVAL_12'],
    ['EventId', `evt_${HEX32}`],
    ['CommandId', `cmd_${HEX32}`],
    ['ApprovalId', `apr_${HEX32}`],
    ['ToolCallId', 'tc_1_0'],
    ['ToolCallId', 'tc_12_345'],
    ['EffectId', `eff_${HEX32}`],
    ['ArtifactId', `art_${HEX32}`],
    ['FindingId', 'fnd_0192f0c1a2b37c4d'],
    ['SpecId', '0042-dark-mode'],
    ['SurfaceId', 'web'],
    ['SurfaceId', 'packages.api-v2'],
    ['Sha256', HEX64],
    ['IsoInstant', '2026-09-18T10:20:30.123Z'],
  ];

  test.for(valid)('%s accepts %s', ([kind, raw]) => {
    const parsed = parseId(kind, raw);
    expect(parsed).toEqual({ ok: true, value: raw });
  });

  const invalid: ReadonlyArray<readonly [IdKind, string, string]> = [
    ['RunId', 'run_', 'nothing after the prefix'],
    ['RunId', 'run_XYZ', 'not hex'],
    ['RunId', `run_${HEX32}0`, '33 hex digits'],
    ['RunId', `RUN_${HEX32}`, 'upper-case prefix'],
    ['RunId', `run_${HEX32.toUpperCase()}`, 'upper-case hex'],
    ['AgentId', 'agt_implementer', 'no surface segment'],
    ['AgentId', 'agt__web', 'empty role'],
    ['PhaseRunId', 'phs_build_1', 'lower-case state'],
    ['PhaseRunId', 'phs_BUILD', 'no iteration'],
    ['PhaseRunId', 'phs_BUILD_x', 'iteration is not a number'],
    ['ToolCallId', 'tc_1', 'no ordinal'],
    ['ToolCallId', 'tc_a_b', 'not numbers'],
    ['ArtifactId', `art_${HEX64}`, 'full digest instead of the first 32'],
    ['FindingId', `fnd_${HEX32}`, '32 hex instead of 16'],
    ['SpecId', '', 'empty'],
    ['SpecId', '../etc/passwd', 'path traversal'],
    ['SpecId', '.hidden', 'leading dot'],
    ['SpecId', '-rf', 'leading dash'],
    ['SurfaceId', 'a/b', 'path separator'],
    ['SurfaceId', 'a..b', 'dot-dot is not a legal git ref component'],
    ['SurfaceId', 'web.lock', '.lock suffix is not a legal git ref component'],
    ['SurfaceId', 'web.', 'trailing dot is not a legal git ref component'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of François' token slot
    ['SurfaceId', '${token}', 'token slot syntax'],
    ['SurfaceId', 'x'.repeat(129), 'too long'],
    ['Sha256', HEX64.toUpperCase(), 'upper-case hex'],
    ['Sha256', HEX32, '32 hex digits'],
    ['IsoInstant', '2026-09-18T10:20:30Z', 'no milliseconds'],
    ['IsoInstant', '2026-09-18T10:20:30.123+02:00', 'not UTC'],
    ['IsoInstant', '2026-13-18T10:20:30.123Z', 'month 13'],
    ['IsoInstant', '2026-02-30T10:20:30.123Z', 'February 30th'],
    ['IsoInstant', '2026-09-18 10:20:30.123Z', 'space instead of T'],
  ];

  test.for(invalid)('%s rejects %j (%s)', ([kind, raw]) => {
    const parsed = parseId(kind, raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({
      code: 'validation/invalid-id',
      class: 'validation',
      retryable: false,
      details: { kind },
    });
    expect(parsed.error.message).toContain(kind);
  });

  test('never echoes the rejected input (it may be a secret pasted by mistake)', () => {
    const parsed = parseId('RunId', 'sk-live-THIS-IS-A-SECRET');
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });

  test.for([
    ['RunId', `evt_${HEX32}`],
    ['EventId', `run_${HEX32}`],
    ['CommandId', `apr_${HEX32}`],
    ['ApprovalId', `cmd_${HEX32}`],
    ['EffectId', `art_${HEX32}`],
    ['AgentId', 'phs_BUILD_1'],
    ['ToolCallId', 'agt_fixer_web'],
  ] as const)('a %s is not minted from another kind of id (%s)', ([kind, raw]) => {
    expect(parseId(kind, raw).ok).toBe(false);
  });

  test('a kind outside the table is held to ID_PATTERN and ref safety', () => {
    expect(parseId('GrantId', 'grant-1')).toEqual({ ok: true, value: 'grant-1' });
    expect(parseId('GrantId', 'a/b').ok).toBe(false);
    expect(parseId('GrantId', 'a..b').ok).toBe(false);
  });

  test('is total on non-string input', () => {
    expect(parseId('RunId', undefined as unknown as string).ok).toBe(false);
    expect(parseId('RunId', 42 as unknown as string).ok).toBe(false);
  });
});

describe('id schemas', () => {
  test('carry the same shape as parseId', () => {
    expect(Compile(RunId).Check(`run_${HEX32}`)).toBe(true);
    expect(Compile(RunId).Check(`evt_${HEX32}`)).toBe(false);
    expect(Compile(EventId).Check(`evt_${HEX32}`)).toBe(true);
    expect(Compile(AgentId).Check('agt_implementer_web')).toBe(true);
    expect(Compile(Sha256).Check(HEX64)).toBe(true);
    expect(Compile(Sha256).Check(HEX32)).toBe(false);
    expect(Compile(IsoInstant).Check('2026-09-18T10:20:30.123Z')).toBe(true);
    expect(Compile(IsoInstant).Check('2026-09-18T10:20:30Z')).toBe(false);
  });

  test('are plain JSON Schema', () => {
    expect(JSON.parse(JSON.stringify(EventId))).toEqual({ type: 'string', pattern: '^evt_[0-9a-f]{32}$' });
    expect(idPatternOf('EventId')).toBe('^evt_[0-9a-f]{32}$');
    expect(idPatternOf('SpecId')).toBe(ID_PATTERN);
  });
});

describe('toIsoInstant', () => {
  test('renders UTC with millisecond precision', () => {
    expect(toIsoInstant(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toIsoInstant(new Date('2026-09-18T12:20:30.5+02:00'))).toBe('2026-09-18T10:20:30.500Z');
    expect(parseId('IsoInstant', toIsoInstant(1_789_000_000_123)).ok).toBe(true);
  });

  test('refuses an invalid date instead of minting "Invalid Date"', () => {
    expect(() => toIsoInstant(Number.NaN)).toThrow(RangeError);
  });
});
