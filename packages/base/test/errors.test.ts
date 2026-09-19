import { Compile } from 'typebox/compile';
import { describe, expect, test } from 'vitest';
import {
  CohorteError,
  ERROR_CATALOGUE,
  ERROR_CATALOGUE_ROWS,
  ERROR_CLASSES,
  type ErrorClass,
  type ErrorCode,
  type ErrorExtra,
  ErrorInfo,
  EXIT_CODE_BY_CLASS,
  errorOf,
  isErrorCode,
  MAX_CAUSE_DEPTH,
  NotImplemented,
  toErrorInfo,
} from '../src/index.ts';

const checkErrorInfo = Compile(ErrorInfo);
const codes = Object.keys(ERROR_CATALOGUE);

const causeDepth = (info: ErrorInfo): number => (info.cause ? 1 + causeDepth(info.cause) : 0);

describe('ERROR_CATALOGUE', () => {
  test('the thirteen classes of spec 24, in spec order', () => {
    expect(ERROR_CLASSES).toEqual([
      'configuration',
      'validation',
      'permission',
      'security',
      'provider-transient',
      'provider-terminal',
      'tool-transient',
      'tool-terminal',
      'conflict',
      'budget',
      'timeout',
      'corruption',
      'human-required',
    ]);
  });

  test('one exit code per class, as in DESIGN 2.8', () => {
    expect(EXIT_CODE_BY_CLASS).toEqual({
      configuration: 10,
      validation: 11,
      permission: 12,
      security: 13,
      'provider-transient': 14,
      'provider-terminal': 14,
      'tool-transient': 15,
      'tool-terminal': 15,
      conflict: 16,
      budget: 17,
      timeout: 18,
      corruption: 19,
      'human-required': 20,
    });
  });

  test('codes are unique: no row of the append-only list is shadowed by a later one', () => {
    const listed = ERROR_CATALOGUE_ROWS.map((row) => row.code);
    expect(new Set(listed).size).toBe(listed.length);
    expect(codes).toEqual(listed);
  });

  test.for(codes)(
    '%s has the <class>/<slug> shape, its prefix is its class, and its exit code is the class code',
    (code) => {
      const entry = ERROR_CATALOGUE[code];
      expect(entry).toBeDefined();
      if (!entry) return;
      expect(code).toMatch(/^[a-z]+(?:-[a-z]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const prefix = code.slice(0, code.indexOf('/'));
      expect(prefix).toBe(entry.class);
      expect(ERROR_CLASSES).toContain(entry.class);
      expect(entry.exit).toBe(EXIT_CODE_BY_CLASS[entry.class]);
      expect(typeof entry.retryable).toBe('boolean');
    },
  );

  test.for(codes)('%s says what it means and what to do, each in one paragraph', (code) => {
    const entry = ERROR_CATALOGUE[code];
    if (!entry) throw new Error('unreachable');
    for (const text of [entry.impact, entry.remediation]) {
      expect(text.length).toBeGreaterThan(15);
      expect(text).not.toMatch(/[\r\n\t]/);
      expect(text).toBe(text.trim());
      expect(text.endsWith('.')).toBe(true);
    }
  });

  test.for(ERROR_CLASSES)('class %s has at least one specific code and its /unexpected fallback', (errorClass) => {
    const ofClass = codes.filter((code) => ERROR_CATALOGUE[code]?.class === errorClass);
    expect(ofClass).toContain(`${errorClass}/unexpected`);
    expect(ofClass.length).toBeGreaterThanOrEqual(2);
    expect(ERROR_CATALOGUE[`${errorClass}/unexpected`]?.retryable).toBe(false);
  });

  test('retryability follows the class column of DESIGN 2.8', () => {
    const retryable = codes.filter((code) => ERROR_CATALOGUE[code]?.retryable);
    for (const code of retryable) {
      expect(['provider-transient', 'tool-transient', 'timeout']).toContain(ERROR_CATALOGUE[code]?.class);
    }
    expect(ERROR_CATALOGUE['provider-transient/rate-limited']?.retryable).toBe(true);
    expect(ERROR_CATALOGUE['tool-transient/spawn-failed']?.retryable).toBe(true);
    expect(ERROR_CATALOGUE['timeout/tool']?.retryable).toBe(true);
    expect(ERROR_CATALOGUE['timeout/agent']?.retryable).toBe(true);
    // "timeout: yes (agent/tool), no (run)"
    expect(ERROR_CATALOGUE['timeout/run']?.retryable).toBe(false);
  });

  // Every code named anywhere in DESIGN.md (2.8 table, 2.4, 2.5.1, 2.5.4, 2.6.2, 2.6.5, 3.4, 3.10) plus the one base mints itself.
  const NAMED_IN_DESIGN: readonly ErrorCode[] = [
    'configuration/policy-invalid',
    'configuration/phase-not-available',
    'configuration/incompatible-state-schema',
    'configuration/platform-unsupported',
    'configuration/telemetry-remote-unavailable',
    'configuration/worktree-root-protected',
    'configuration/provision-store-unavailable',
    'configuration/engine-init',
    'configuration/fake-script-unmatched',
    'validation/tool-input',
    'validation/agent-output',
    'validation/agent-no-result',
    'validation/spec',
    'validation/invalid-id',
    'permission/tool-not-granted',
    'permission/path-outside-grant',
    'permission/command-not-allowed',
    'permission/network-denied',
    'permission/denied-by-human',
    'security/symlink-escape',
    'security/protected-path',
    'security/write-outside-ownership',
    'security/runtime-pin-mismatch',
    'security/asset-hash-mismatch',
    'security/pin-tampered',
    'security/runtime-inside-target',
    'security/auth-mode-violation',
    'security/auth-endpoint-mismatch',
    'security/command-auth-invalid',
    'security/event-chain-broken',
    'security/root-refused',
    'security/sandbox-unavailable',
    'security/secret-staged',
    'security/command-trampoline',
    'security/project-policy-untrusted',
    'security/deps-tampered',
    'security/review-ref-mutated',
    'security/command-global-option',
    'security/gate-internal-error',
    'security/redaction-failed',
    'provider-transient/rate-limited',
    'provider-transient/overloaded',
    'provider-transient/network',
    'provider-transient/credential-store-locked',
    'provider-terminal/auth-required',
    'provider-terminal/quota-exceeded',
    'provider-terminal/entitlement',
    'provider-terminal/model-not-found',
    'provider-terminal/policy-refused',
    'tool-transient/spawn-failed',
    'tool-transient/interrupted',
    'tool-transient/agent-process-exit',
    'tool-transient/cancelled',
    'tool-terminal/nonzero-exit',
    'tool-terminal/output-cap',
    'tool-terminal/patch-preimage-mismatch',
    'conflict/merge',
    'conflict/zone-reserved',
    'conflict/incarnation-exists',
    'conflict/command-id-reuse',
    'conflict/run-host-alive',
    'conflict/lease-lost',
    'conflict/reconcile-human-edit',
    'conflict/not-running',
    'conflict/run-terminal',
    'conflict/run-active',
    // Added at gate G0 (docs/v3/requests/U0.09.md R2): the five codes `COMMAND_MATRIX` (DESIGN 2.5.1's command
    // matrix, packages/core/src/pipeline/command-matrix.ts) already rejects with, which had no catalogue row.
    'conflict/run-halted',
    'conflict/use-retry',
    'conflict/use-resume',
    'conflict/use-resume-ack',
    'conflict/run-blocked',
    'budget/tokens',
    'budget/tool-calls-exhausted',
    'budget/context-window',
    'budget/fix-rounds',
    'budget/provider',
    'budget/estimated-quota',
    'budget/incarnations',
    'timeout/tool',
    'timeout/model-request',
    'timeout/agent',
    'timeout/run',
    'corruption/event-gap',
    'corruption/projection-mismatch',
    'corruption/snapshot-hash',
    'corruption/incompatible-schema',
    'human-required/approval',
    'human-required/approval-timeout',
    'human-required/blocked-ack',
    'human-required/in-doubt-effect',
  ];

  test.for(NAMED_IN_DESIGN)('contains %s', (code) => {
    expect(isErrorCode(code)).toBe(true);
  });

  test('contains nothing else but the thirteen /unexpected fallbacks', () => {
    const expected = [...NAMED_IN_DESIGN, ...ERROR_CLASSES.map((c) => `${c}/unexpected`)].sort();
    expect([...codes].sort()).toEqual(expected);
  });

  test('is frozen', () => {
    expect(Object.isFrozen(ERROR_CATALOGUE)).toBe(true);
    expect(Object.isFrozen(ERROR_CATALOGUE['security/symlink-escape'])).toBe(true);
    expect(isErrorCode('security/nope')).toBe(false);
    expect(isErrorCode('toString')).toBe(false);
  });
});

describe('errorOf', () => {
  test('mints a complete ErrorInfo from the catalogue', () => {
    const info = errorOf('security/symlink-escape', 'src/x resolves outside the worktree');
    expect(info).toEqual({
      code: 'security/symlink-escape',
      class: 'security',
      message: 'src/x resolves outside the worktree',
      impact: ERROR_CATALOGUE['security/symlink-escape']?.impact,
      retryable: false,
      remediation: ERROR_CATALOGUE['security/symlink-escape']?.remediation,
    });
    expect(checkErrorInfo.Check(info)).toBe(true);
  });

  test('carries retryAfterMs, cause and details, and nothing undefined (JSON on a wire never contains undefined)', () => {
    const cause = errorOf('provider-transient/network', 'socket hang up');
    const info = errorOf('provider-terminal/quota-exceeded', 'plan limit reached', {
      retryAfterMs: 60_000,
      cause,
      details: { provider: 'openai-codex' },
    });
    expect(info.retryAfterMs).toBe(60_000);
    expect(info.cause).toEqual(cause);
    expect(info.details).toEqual({ provider: 'openai-codex' });
    expect(Object.values(errorOf('timeout/tool', 'x', {}))).not.toContain(undefined);
    expect(Object.keys(errorOf('timeout/tool', 'x'))).toEqual([
      'code',
      'class',
      'message',
      'impact',
      'retryable',
      'remediation',
    ]);
    expect(checkErrorInfo.Check(info)).toBe(true);
  });

  test('keeps the message to a single paragraph', () => {
    expect(errorOf('validation/spec', '  line one\n\n  line two\r\n\tline three  ').message).toBe(
      'line one line two line three',
    );
  });

  test('a code outside the catalogue is a programming error', () => {
    expect(() => errorOf('security/nope' as ErrorCode, 'x')).toThrow(TypeError);
  });

  test.for<readonly [string, object]>([
    ['a NaN retryAfterMs', { retryAfterMs: Number.NaN }],
    ['a negative retryAfterMs', { retryAfterMs: -5 }],
    ['details that are not JSON', { details: { at: new Date(0) } }],
    ['details that are not an object', { details: null }],
    ['a cause that is not a well-formed ErrorInfo', { cause: { code: 'made/up', class: 'security', message: 'm' } }],
  ])('never mints a schema-invalid ErrorInfo from %s', ([, extra]) => {
    const info = errorOf('timeout/tool', 'x', extra as ErrorExtra);
    expect(checkErrorInfo.Check(info)).toBe(true);
    expect(checkErrorInfo.Check(JSON.parse(JSON.stringify(info)))).toBe(true);
    expect(info.retryAfterMs).toBeUndefined();
  });

  test('replaces details it cannot keep with a marker', () => {
    expect(errorOf('timeout/tool', 'x', { details: { big: 1n } } as unknown as ErrorExtra).details).toEqual({
      detailsDropped: true,
    });
  });
});

describe('CohorteError', () => {
  test('is an Error that carries its ErrorInfo', () => {
    const info = errorOf('conflict/lease-lost', 'fencing token 3 < 4');
    const thrown = new Error('low level');
    const error = new CohorteError(info, { cause: thrown });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CohorteError');
    expect(error.message).toBe('conflict/lease-lost: fencing token 3 < 4');
    expect(error.info).toEqual(info);
    expect(error.cause).toBe(thrown);
    expect(Object.isFrozen(error.info)).toBe(true);
  });

  test('has no cause property when none was given', () => {
    expect('cause' in new CohorteError(errorOf('timeout/run', 'x'))).toBe(false);
  });
});

describe('NotImplemented', () => {
  test('is what a Wave-0 stub throws', () => {
    const error = new NotImplemented('createPathResolver');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NotImplemented');
    expect(error.message).toBe('not implemented: createPathResolver');
    expect(new NotImplemented().message).toBe('not implemented');
    expect(() => {
      throw new NotImplemented();
    }).toThrow(NotImplemented);
  });
});

describe('toErrorInfo', () => {
  const fallback = { code: 'tool-transient/spawn-failed', class: 'tool-transient' } as const;

  test.for<readonly [string, unknown, string]>([
    ['a string', 'boom', 'boom'],
    ['an empty string', '', 'unknown error (string)'],
    ['null', null, 'unknown error (null)'],
    ['undefined', undefined, 'unknown error (undefined)'],
    ['a number', 42, '42'],
    ['a bigint', 7n, '7'],
    ['a symbol', Symbol('s'), 'Symbol(s)'],
    ['an Error', new Error('spawn ENOENT'), 'spawn ENOENT'],
    ['an Error without a message', new RangeError(''), 'RangeError'],
    ['an object with a message', { message: 'from object' }, 'from object'],
    ['an object without one', { a: 1 }, 'unknown error (object)'],
    ['a function', () => 1, 'unknown error (function)'],
  ])('is total on %s', ([, thrown, message]) => {
    const info = toErrorInfo(thrown, fallback);
    expect(info.code).toBe('tool-transient/spawn-failed');
    expect(info.class).toBe('tool-transient');
    expect(info.message).toBe(message);
    expect(info.retryable).toBe(true);
    expect(info.impact).toBe(ERROR_CATALOGUE['tool-transient/spawn-failed']?.impact);
    expect(checkErrorInfo.Check(info)).toBe(true);
  });

  test('is total on hostile throwables', () => {
    const hostile = [
      Object.create(null) as unknown,
      {
        get message(): string {
          throw new Error('getter');
        },
      },
      {
        toString: () => {
          throw new Error('toString');
        },
      },
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('trap');
          },
          getPrototypeOf: () => {
            throw new Error('trap');
          },
        },
      ),
    ];
    for (const thrown of hostile) {
      const info = toErrorInfo(thrown, fallback);
      expect(info.code).toBe('tool-transient/spawn-failed');
      expect(checkErrorInfo.Check(info)).toBe(true);
    }
  });

  test('returns the info of a CohorteError untouched by the fallback', () => {
    const info = errorOf('security/protected-path', '.git/hooks/pre-commit');
    expect(toErrorInfo(new CohorteError(info), fallback)).toEqual(info);
  });

  test('chains the JavaScript cause of a CohorteError that has no ErrorInfo cause', () => {
    const error = new CohorteError(errorOf('tool-transient/spawn-failed', 'cannot start pnpm'), {
      cause: new Error('EACCES'),
    });
    const info = toErrorInfo(error, fallback);
    expect(info.cause?.message).toBe('EACCES');
    expect(info.cause?.code).toBe('tool-transient/spawn-failed');
  });

  test('unknown throwables become <class>/unexpected when the fallback code is not a catalogue code of that class', () => {
    expect(toErrorInfo('x', { code: 'tool-transient/made-up', class: 'tool-transient' }).code).toBe(
      'tool-transient/unexpected',
    );
    expect(toErrorInfo('x', { code: 'security/symlink-escape', class: 'budget' }).code).toBe('budget/unexpected');
    expect(toErrorInfo('x', { code: '', class: 'corruption' })).toMatchObject({
      code: 'corruption/unexpected',
      class: 'corruption',
      retryable: false,
    });
  });

  test.for(ERROR_CLASSES)('the %s/unexpected fallback is always available', (errorClass: ErrorClass) => {
    const info = toErrorInfo(new Error('x'), { code: `${errorClass}/unexpected`, class: errorClass });
    expect(info.code).toBe(`${errorClass}/unexpected`);
    expect(info.class).toBe(errorClass);
    expect(checkErrorInfo.Check(info)).toBe(true);
  });

  test('records what was thrown, never a stack', () => {
    const thrown = Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' });
    const info = toErrorInfo(thrown, fallback);
    expect(info.details).toEqual({ thrown: 'Error', errorCode: 'ENOENT' });
    expect(JSON.stringify(info)).not.toContain('errors.test.ts');
  });

  test('keeps the message to one paragraph of bounded length', () => {
    expect(toErrorInfo(new Error('a\n  b\r\n\tc'), fallback).message).toBe('a b c');
    const long = toErrorInfo('x'.repeat(10_000), fallback).message;
    expect(long.length).toBeLessThanOrEqual(2_000);
    expect(long.endsWith('…')).toBe(true);
  });

  test('follows Error.cause', () => {
    const info = toErrorInfo(new Error('outer', { cause: new Error('inner', { cause: 'root' }) }), fallback);
    expect(info.message).toBe('outer');
    expect(info.cause?.message).toBe('inner');
    expect(info.cause?.cause?.message).toBe('root');
    expect(info.cause?.cause?.cause).toBeUndefined();
  });

  test(`caps the cause chain at ${MAX_CAUSE_DEPTH}`, () => {
    expect(MAX_CAUSE_DEPTH).toBe(5);
    let thrown = new Error('level 0');
    for (let level = 1; level <= 12; level += 1) thrown = new Error(`level ${level}`, { cause: thrown });
    const info = toErrorInfo(thrown, fallback);
    expect(causeDepth(info)).toBe(5);
    expect(info.message).toBe('level 12');
    expect(checkErrorInfo.Check(info)).toBe(true);
    // Same marker as a truncated ErrorInfo chain: a reader can tell that causes were dropped.
    let deepest = info;
    while (deepest.cause) deepest = deepest.cause;
    expect(deepest.details).toEqual({ thrown: 'Error', causeChainTruncated: true });
    expect(toErrorInfo(new Error('shallow', { cause: 'root' }), fallback).cause?.details).toEqual({ thrown: 'string' });
  });

  test('survives a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(causeDepth(toErrorInfo(a, fallback))).toBe(5);
  });

  test('caps an over-deep ErrorInfo chain handed to errorOf or CohorteError', () => {
    let chain = errorOf('timeout/tool', 'level 0');
    for (let level = 1; level <= 9; level += 1) chain = { ...errorOf('timeout/tool', `level ${level}`), cause: chain };
    expect(causeDepth(chain)).toBe(9);
    expect(causeDepth(errorOf('timeout/agent', 'top', { cause: chain }))).toBe(5);
    expect(causeDepth(new CohorteError(chain).info)).toBe(5);
    expect(causeDepth(toErrorInfo(new CohorteError(chain), fallback))).toBe(5);
  });

  describe('a CohorteError whose ErrorInfo is not strict JSON', () => {
    const terminal = { code: 'tool-terminal/unexpected', class: 'tool-terminal' } as const;
    const security = errorOf('security/symlink-escape', 'link leaves the worktree');
    // What a cast or a JS caller can build despite exactOptionalPropertyTypes.
    const unchecked = (info: object): ErrorInfo => info as ErrorInfo;

    test('keeps its classification when an optional member is undefined', () => {
      const error = new CohorteError(unchecked({ ...security, retryAfterMs: undefined, details: undefined }));
      expect(error.info).toEqual(security);
      expect(toErrorInfo(error, terminal)).toEqual(security);
    });

    test('keeps its classification and drops details that are not JSON', () => {
      const error = new CohorteError(unchecked({ ...security, details: { at: new Date(0) } }));
      const info = toErrorInfo(error, terminal);
      expect(info).toEqual({ ...security, details: { detailsDropped: true } });
      expect(error.info).toEqual(info);
      expect(checkErrorInfo.Check(info)).toBe(true);
    });

    test('sanitises the cause chain too', () => {
      const cause = unchecked({ ...errorOf('timeout/tool', 'inner'), details: { big: 1n } });
      const info = toErrorInfo(new CohorteError({ ...security, cause }), terminal);
      expect(info.code).toBe('security/symlink-escape');
      expect(info.cause).toEqual({ ...errorOf('timeout/tool', 'inner'), details: { detailsDropped: true } });
    });

    test('is sanitised again when shared details are edited after the throw', () => {
      const details: Record<string, unknown> = { path: 'a' };
      const error = new CohorteError(unchecked({ ...security, details }));
      details.at = new Date(0);
      const info = toErrorInfo(error, terminal);
      expect(info.code).toBe('security/symlink-escape');
      expect(info.details).toEqual({ detailsDropped: true });
    });

    test('restores catalogue text for members of the wrong type', () => {
      const error = new CohorteError(unchecked({ ...security, impact: 7, remediation: undefined, retryable: 'no' }));
      expect(toErrorInfo(error, terminal)).toEqual(security);
    });

    test('takes the fallback only when the code is not a catalogue code of its class', () => {
      const madeUp = unchecked({ ...security, code: 'security/made-up', details: { at: new Date(0) } });
      expect(toErrorInfo(new CohorteError(madeUp), terminal)).toMatchObject({
        code: 'tool-terminal/unexpected',
        class: 'tool-terminal',
        message: 'link leaves the worktree',
      });
      const wrongClass = unchecked({ ...security, class: 'budget', retryAfterMs: undefined });
      expect(toErrorInfo(new CohorteError(wrongClass), terminal).code).toBe('tool-terminal/unexpected');
    });
  });

  describe('a CohorteError whose ErrorInfo is strict JSON but not a well-formed ErrorInfo', () => {
    const terminal = { code: 'tool-terminal/unexpected', class: 'tool-terminal' } as const;
    const unchecked = (info: object): ErrorInfo => info as ErrorInfo;
    const timeout = errorOf('timeout/tool', 'x');

    test.for<readonly [string, object, string]>([
      [
        'a made-up code',
        { code: 'made/up', class: 'security', message: 'm', impact: 'i', retryable: true, remediation: 'r' },
        'tool-terminal/unexpected',
      ],
      [
        'a catalogue code under another class',
        {
          code: 'security/symlink-escape',
          class: 'tool-transient',
          message: 'm',
          impact: 'i',
          retryable: true,
          remediation: 'r',
        },
        'tool-terminal/unexpected',
      ],
      ['missing members', { code: 'timeout/tool', class: 'timeout', message: 'm' }, 'timeout/tool'],
      ['call-site retryability', { ...timeout, retryable: !timeout.retryable }, 'timeout/tool'],
      ['call-site impact and remediation', { ...timeout, impact: 'i', remediation: 'r' }, 'timeout/tool'],
      ['a negative retryAfterMs and a stack', { ...timeout, retryAfterMs: -5, stack: 'at secret.ts' }, 'timeout/tool'],
      ['a message that is not a string', { ...timeout, message: 7 }, 'timeout/tool'],
      ['details that are not an object', { ...timeout, details: null }, 'timeout/tool'],
      ['a malformed cause', { ...timeout, cause: { ...timeout, retryable: 'yes', stack: 's' } }, 'timeout/tool'],
    ])('rebuilds %s from the catalogue', ([, raw, code]) => {
      const info = toErrorInfo(new CohorteError(unchecked(raw)), terminal);
      const row = ERROR_CATALOGUE[code as ErrorCode];
      expect(info).toMatchObject({
        code,
        class: row?.class,
        impact: row?.impact,
        retryable: row?.retryable,
        remediation: row?.remediation,
      });
      expect(info).not.toHaveProperty('stack');
      expect(info.cause ?? {}).not.toHaveProperty('stack');
      expect(info.retryAfterMs).toBeUndefined();
      expect(checkErrorInfo.Check(info)).toBe(true);
    });

    test('returns a well-formed ErrorInfo as it is', () => {
      const info = errorOf('timeout/tool', 'x', { retryAfterMs: 5, cause: timeout, details: { a: [1, null] } });
      expect(toErrorInfo(new CohorteError(info), terminal)).toEqual(info);
    });
  });

  test('is total on a fallback class that is not one of the thirteen', () => {
    const bogus = { code: 'nope', class: 'nope' } as unknown as { code: string; class: ErrorClass };
    const info = toErrorInfo(new Error('x'), bogus);
    expect(info.code).toBe('validation/unexpected');
    expect(info.message).toBe('x');
    expect(checkErrorInfo.Check(info)).toBe(true);
    const hostile = {
      get message(): string {
        throw new Error('getter');
      },
    };
    expect(toErrorInfo(hostile, bogus).code).toBe('validation/unexpected');
  });
});

describe('ErrorInfo schema', () => {
  const valid = errorOf('budget/tokens', 'run budget of 2000000 tokens reached');

  test('accepts a catalogue-minted value and a chained one', () => {
    expect(checkErrorInfo.Check(valid)).toBe(true);
    expect(checkErrorInfo.Check({ ...valid, cause: valid, details: { used: 2_000_001, by: ['agt_a', null] } })).toBe(
      true,
    );
  });

  test.for<readonly [string, unknown]>([
    ['unknown key (strict)', { ...valid, extra: 1 }],
    ['unknown class', { ...valid, class: 'fatal' }],
    ['code without a slash', { ...valid, code: 'budget' }],
    ['upper-case code', { ...valid, code: 'Budget/Tokens' }],
    ['missing impact', { ...valid, impact: undefined }],
    ['negative retryAfterMs', { ...valid, retryAfterMs: -1 }],
    ['cause that is not an ErrorInfo', { ...valid, cause: { message: 'x' } }],
    ['details that are not JSON', { ...valid, details: { f: () => 1 } }],
  ])('rejects %s', ([, value]) => {
    expect(checkErrorInfo.Check(value)).toBe(false);
  });
});
