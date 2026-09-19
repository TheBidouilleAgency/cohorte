import { ErrorInfo, JsonValueSchema } from '@cohorte/base';
// ajv and ajv-formats are CJS: under `module: nodenext` + `verbatimModuleSyntax`
// a default import resolves to the namespace, so take the named export and unwrap
// the plugin's `default` ourselves.
import { Ajv2020, type SchemaObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { Type } from 'typebox';
import { describe, expect, test } from 'vitest';
import {
  bindCatalogue,
  compileOpen,
  compileStrict,
  compileStrictEnvelope,
  EVENTS_SCHEMA_ID,
  type EventTable,
  toOpenJsonSchema,
  toOpenSchema,
  toStrictSchema,
} from '../../src/compile.ts';
import { EnvelopeBase, PROTOCOL_VERSION } from '../../src/envelope.ts';
import { OPEN_ENUM_KEYWORD, OpenEnum } from '../../src/open-enum.ts';

// ajv-formats is CJS: the plugin sits on `default` when the namespace is imported.
const addFormats = addFormatsModule.default ?? addFormatsModule;

const MINI = {
  'demo.started': {
    durability: 'durable',
    payload: Type.Object({
      flavour: OpenEnum(['plain', 'salted']),
      count: Type.Integer({ minimum: 0 }),
      nested: Type.Optional(Type.Object({ label: Type.String() })),
    }),
  },
  'demo.delta': {
    durability: 'ephemeral',
    payload: Type.Object({ text: Type.String() }, { additionalProperties: false }),
  },
} as const;

const TUPLES = {
  'demo.pair': {
    durability: 'durable',
    payload: Type.Object({
      // the first member is left open by its author, the second one is closed: each transform has one to correct
      pair: Type.Tuple([
        Type.Object({ y: Type.Number() }),
        Type.Object({ w: Type.String() }, { additionalProperties: false }),
      ]),
    }),
  },
} as const;

const envelope = (over: Record<string, unknown> = {}) => ({
  protocolVersion: PROTOCOL_VERSION,
  eventId: `evt_${'a'.repeat(32)}`,
  sequence: 7,
  sub: 0,
  durability: 'durable',
  timestamp: '2026-09-18T10:00:00.000Z',
  runId: `run_${'b'.repeat(32)}`,
  type: 'demo.started',
  source: 'cohorte',
  summary: 'demo started',
  severity: 'info',
  payload: { flavour: 'plain', count: 1 },
  redactions: [],
  ...over,
});

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const collect = (node: unknown, visit: (object: Record<string, unknown>) => void): void => {
  if (Array.isArray(node)) for (const item of node) collect(item, visit);
  else if (typeof node === 'object' && node !== null) {
    visit(node as Record<string, unknown>);
    for (const value of Object.values(node)) collect(value, visit);
  }
};

describe('strict (writer side)', () => {
  test('accepts a well-formed payload and gives it back', () => {
    const payload = { flavour: 'salted', count: 2, nested: { label: 'x' } };
    expect(compileStrict(MINI, 'demo.started')(payload)).toEqual({ ok: true, value: payload });
  });

  test.for([
    ['an unknown key', { flavour: 'plain', count: 1, extra: true }, 'additionalProperties'],
    [
      'an unknown NESTED key, even where the author did not close the object',
      { flavour: 'plain', count: 1, nested: { label: 'x', more: 1 } },
      'additionalProperties',
    ],
    ['a value outside the known open-enum values', { flavour: 'peppered', count: 1 }, 'enum'],
    ['a wrong type', { flavour: 'plain', count: '1' }, 'type'],
  ] as const)('rejects %s', ([, payload, keyword]) => {
    const result = compileStrict(MINI, 'demo.started')(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.map((issue) => issue.keyword)).toContain(keyword);
  });

  test('closes an object that is a tuple member or a rest item', () => {
    const check = compileStrict(TUPLES, 'demo.pair');
    expect(check({ pair: [{ y: 1 }, { w: 'a' }] }).ok).toBe(true);
    const result = check({ pair: [{ y: 1, z: 2 }, { w: 'a' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.map((issue) => issue.keyword)).toContain('additionalProperties');
    const legacy = { type: 'array', items: [{ type: 'string' }], additionalItems: { properties: { y: {} } } };
    expect(toStrictSchema(legacy)).toEqual({
      type: 'array',
      items: [{ type: 'string' }],
      additionalItems: { properties: { y: {} }, additionalProperties: false },
    });
  });

  test('issues carry a JSON pointer', () => {
    const result = compileStrict(MINI, 'demo.started')({ flavour: 'plain', count: -1 });
    expect(result).toEqual({ ok: false, error: [expect.objectContaining({ path: '/count', keyword: 'minimum' })] });
  });

  test('the strict envelope refuses an unknown envelope key, the wrong durability and another type', () => {
    const check = compileStrictEnvelope(MINI, 'demo.started');
    expect(check(envelope()).ok).toBe(true);
    expect(check(envelope({ extra: 1 })).ok).toBe(false);
    expect(check(envelope({ durability: 'ephemeral' })).ok).toBe(false);
    expect(check(envelope({ type: 'demo.delta' })).ok).toBe(false);
    expect(check(envelope({ payload: { flavour: 'plain', count: 1, extra: 1 } })).ok).toBe(false);
  });

  test.for([
    ['a newline', `line one${String.fromCharCode(10)}line two`],
    ['a tab', `a${String.fromCharCode(9)}b`],
    ['an escape character', `red ${String.fromCharCode(27)}[31m`],
    ['a C1 control character', `x${String.fromCharCode(0x85)}y`],
  ] as const)('the envelope summary refuses %s', ([, summary]) => {
    expect(compileStrictEnvelope(MINI, 'demo.started')(envelope({ summary })).ok).toBe(false);
  });

  test('a bound catalogue has the signatures of DESIGN 2.3.2', () => {
    const catalogue = bindCatalogue(MINI);
    expect(catalogue.compileStrict('demo.delta')({ text: 'hi' }).ok).toBe(true);
    expect(catalogue.compileStrictEnvelope('demo.started')(envelope()).ok).toBe(true);
    expect(catalogue.toOpenJsonSchema()).toEqual(toOpenJsonSchema(MINI));
  });

  test('an unknown event type cannot be compiled', () => {
    const loose: EventTable = MINI;
    expect(() => compileStrict(loose, 'demo.unknown')).toThrow(/demo\.unknown/);
  });
});

describe('open (published side)', () => {
  const published = toOpenJsonSchema(MINI);
  const check = compileOpen(published);

  test('has a stable $id and a oneOf over `type` with a catch-all branch', () => {
    const schema = published as { $id: string; oneOf: { properties: { type: Record<string, unknown> } }[] };
    expect(schema.$id).toBe(EVENTS_SCHEMA_ID);
    expect(EVENTS_SCHEMA_ID).toBe('https://cohorte.dev/schemas/3/events.schema.json');
    expect(schema.oneOf.map((branch) => branch.properties.type)).toEqual([
      { const: 'demo.started' },
      { const: 'demo.delta' },
      { not: { enum: ['demo.started', 'demo.delta'] } },
    ]);
  });

  test('closes no object and publishes open enums as strings with their known values', () => {
    const closed: unknown[] = [];
    const known: unknown[] = [];
    collect(published, (object) => {
      if (object.additionalProperties === false) closed.push(object);
      if ('x-cohorte-known' in object) known.push(object);
    });
    expect(closed).toEqual([]);
    expect(known).toContainEqual({ type: 'string', 'x-cohorte-known': ['plain', 'salted'] });
  });

  test('opens an object that its author closed inside a tuple', () => {
    const open = toOpenSchema(TUPLES['demo.pair'].payload);
    const closed: unknown[] = [];
    collect(open, (object) => {
      if (object.additionalProperties === false) closed.push(object);
    });
    expect(closed).toEqual([]);
    const value = {
      pair: [
        { y: 1, z: 2 },
        { w: 'a', more: true },
      ],
    };
    expect(compileOpen(TUPLES['demo.pair'].payload)(value)).toEqual({ ok: true, value });
    expect(compileOpen(TUPLES['demo.pair'].payload)({ pair: [{ y: 'one' }, { w: 'a' }] }).ok).toBe(false);
  });

  test.for([
    ['the writer form', envelope()],
    [
      'a future event type',
      envelope({ type: 'demo.invented', durability: 'ephemeral', payload: { anything: [1, 2] } }),
    ],
    ['a future open-enum value', envelope({ payload: { flavour: 'peppered', count: 1 } })],
    ['an extra payload field', envelope({ payload: { flavour: 'plain', count: 1, extra: true } })],
    ['an extra nested field', envelope({ payload: { flavour: 'plain', count: 1, nested: { label: 'x', more: 1 } } })],
    [
      'an extra field where the author closed the object',
      envelope({ type: 'demo.delta', durability: 'ephemeral', payload: { text: 'x', more: 1 } }),
    ],
    ['an extra envelope field', envelope({ traceId: 'abc' })],
  ] as const)('accepts %s', ([, value]) => {
    expect(check(value)).toEqual({ ok: true, value });
  });

  test.for([
    ['a known type whose payload has the wrong type', envelope({ payload: { flavour: 'plain', count: 'one' } })],
    ['a known type that lacks a required payload field', envelope({ payload: { flavour: 'plain' } })],
    ['an envelope without a type', without(envelope(), 'type')],
    ['an envelope without a sub', without(envelope(), 'sub')],
    ['a future type without a durability', without(envelope({ type: 'demo.invented' }), 'durability')],
  ] as const)('still rejects %s', ([, value]) => {
    expect(check(value).ok).toBe(false);
  });

  test('durability is part of the type: it cannot differ between the strict and the open schema', () => {
    const schema = published as {
      oneOf: { properties: { type: { const?: keyof typeof MINI }; durability?: { const: string } } }[];
    };
    for (const branch of schema.oneOf) {
      const type = branch.properties.type.const;
      if (type !== undefined) expect(branch.properties.durability).toEqual({ const: MINI[type].durability });
    }
    for (const type of ['demo.started', 'demo.delta'] as const) {
      const payload = type === 'demo.started' ? { flavour: 'plain', count: 1 } : { text: 'x' };
      for (const durability of ['durable', 'ephemeral'] as const) {
        const value = envelope({ type, durability, payload });
        const expected = durability === MINI[type].durability;
        expect(compileStrictEnvelope(MINI, type)(value).ok).toBe(expected);
        expect(check(value).ok).toBe(expected);
      }
    }
  });

  test('the two transforms leave the authored schema untouched', () => {
    const authored = JSON.stringify(EnvelopeBase);
    toOpenSchema(EnvelopeBase);
    toStrictSchema(EnvelopeBase);
    expect(JSON.stringify(EnvelopeBase)).toBe(authored);
  });

  test('a property that is NAMED like a keyword is a property, not a keyword', () => {
    const schema = Type.Object({
      enum: Type.Object({ additionalProperties: Type.Boolean() }),
      const: OpenEnum(['a']),
    });
    expect(compileOpen(schema)({ enum: { additionalProperties: false, x: 1 }, const: 'b' }).ok).toBe(true);
    expect(compileOpen(schema)({ enum: { additionalProperties: 'no' }, const: 'a' }).ok).toBe(false);
    expect(compileStrictEnvelope(MINI, 'demo.delta')).toBeTypeOf('function');
  });
});

// DESIGN 2.3.2 / AC-07: a schema-only client compiles the PUBLISHED document with its own validator. TypeBox inlines a
// Type.Cyclic (`$defs.X` carrying `$id: 'X'`) at every use; two of them in one document are two schemas with one `$id`.
describe('a published schema compiles under an independent validator (ajv 2020-12)', () => {
  const CYCLIC = {
    'demo.json': {
      durability: 'durable',
      payload: Type.Object({ a: JsonValueSchema, b: JsonValueSchema, flavour: OpenEnum(['plain']) }),
    },
    'demo.failed': {
      durability: 'durable',
      // ErrorInfo is cyclic itself AND embeds JsonValue inside its own definition
      payload: Type.Object({ error: ErrorInfo, input: Type.Optional(JsonValueSchema) }),
    },
  } as const;
  // what the schema-compat job runs: strict, with the ONE custom keyword declared and the standard formats loaded
  const ajv = () => addFormats(new Ajv2020({ strict: true, keywords: [OPEN_ENUM_KEYWORD] }));
  const nested = { list: [1, 'two', null, { deep: [true, { deeper: 1.5 }] }] };

  test('a table that embeds JsonValue several times: one root $defs entry, no nested $id, pointer refs', () => {
    const open = toOpenJsonSchema(CYCLIC);
    const ids: unknown[] = [];
    const refs = new Set<unknown>();
    let defs = 0;
    collect(open, (node) => {
      if ('$id' in node) ids.push(node.$id);
      if (typeof node.$ref === 'string') refs.add(node.$ref);
      if ('$defs' in node) defs += 1;
    });
    expect(ids).toEqual([EVENTS_SCHEMA_ID]);
    expect(defs).toBe(1);
    expect(Object.keys((open as { $defs: object }).$defs).sort()).toEqual(['ErrorInfo', 'JsonValue']);
    expect([...refs].sort()).toEqual(['#/$defs/ErrorInfo', '#/$defs/JsonValue']);
  });

  test('ajv compiles it, validates a nested JSON value, and agrees with compileOpen', () => {
    const open = toOpenJsonSchema(CYCLIC);
    const validate = ajv().compile(open as SchemaObject);
    const check = compileOpen(open);
    const good = envelope({ type: 'demo.json', payload: { a: nested, b: [nested], flavour: 'later', extra: 1 } });
    const bad = envelope({ type: 'demo.json', payload: { a: nested } });
    const failure = {
      code: 'validation/demo',
      class: 'validation',
      message: 'boom',
      impact: 'none',
      retryable: false,
      remediation: 'retry',
    };
    const failed = envelope({
      type: 'demo.failed',
      payload: {
        error: { ...failure, cause: { ...failure, details: { at: nested } } },
        input: nested,
      },
    });
    const wrong = envelope({ type: 'demo.failed', payload: { error: { ...failure, cause: { code: 1 } } } });
    const future = envelope({ type: 'demo.later', payload: 12 });
    for (const [value, expected] of [
      [good, true],
      [bad, false],
      [failed, true],
      [wrong, false],
      [future, true],
    ] as const) {
      expect(validate(value), JSON.stringify(validate.errors)).toBe(expected);
      expect(check(value).ok).toBe(expected);
    }
  });

  test('a single authored schema: the root keeps its definitions, and publishing twice changes nothing', () => {
    const open = toOpenSchema(Type.Object({ a: JsonValueSchema, b: Type.Array(JsonValueSchema) }));
    expect(toOpenSchema(open)).toEqual(open);
    const validate = ajv().compile(open as SchemaObject);
    expect(validate({ a: nested, b: [nested, 1], more: true })).toBe(true);
    expect(validate({ a: nested, b: 1 })).toBe(false);
    expect(compileOpen(open)({ a: nested, b: [nested, 1], more: true }).ok).toBe(true);
    expect(ajv().compile(toOpenSchema(JsonValueSchema) as SchemaObject)(nested)).toBe(true);
  });

  test('two DIFFERENT definitions under one name are refused, not merged', () => {
    const one = { $defs: { Leaf: { $id: 'Leaf', type: 'string' } }, $ref: 'Leaf' };
    const two = { $defs: { Leaf: { $id: 'Leaf', type: 'number' } }, $ref: 'Leaf' };
    expect(() => toOpenSchema({ type: 'object', properties: { one, two } })).toThrow(/Leaf/);
  });
});
