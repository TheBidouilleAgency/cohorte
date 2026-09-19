import { canonicalJson, type JsonValue } from '@cohorte/base';
// ajv and ajv-formats are CJS: under `module: nodenext` + `verbatimModuleSyntax`
// a default import resolves to the namespace, so take the named export and unwrap
// the plugin's `default` ourselves.
import { Ajv2020, type SchemaObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  COMMAND_TYPES,
  COMMANDS,
  COMMANDS_SCHEMA_ID,
  CONTROLLER_EXIT_CODES,
  type CommandEnvelope,
  type CommandPayloads,
  type CommandType,
  canonicalCommandBody,
  compileCommand,
  compileCommandPayload,
  INSPECT_ARTIFACT_DEFAULT_BYTES,
  INSPECT_ARTIFACT_MAX_BYTES,
  toOpenCommandsJsonSchema,
} from '../../src/commands.ts';
import { compileOpen } from '../../src/compile.ts';
import { OPEN_ENUM_KEYWORD } from '../../src/open-enum.ts';
import { COMMAND_FIXTURES, COMMAND_PAYLOAD_VARIANTS, REJECTED_COMMAND_PAYLOADS } from './fixtures/commands.ts';

// ajv-formats is CJS: the plugin sits on `default` when the namespace is imported.
const addFormats = addFormatsModule.default ?? addFormatsModule;

const SPEC_17_2 = [
  'start',
  'status',
  'pause',
  'resume',
  'cancel',
  'approve',
  'deny',
  'retry',
  'skip',
  'inspect',
  'tail',
  'run-tool',
  'reconcile',
  'shutdown',
];

const reversed = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, member]) => [key, reversed(member)]),
  );
};

describe('command table', () => {
  test('the fourteen commands of spec 17.2 and agent.send: fifteen types', () => {
    expect(COMMAND_TYPES).toHaveLength(15);
    expect([...COMMAND_TYPES].sort()).toEqual([...SPEC_17_2, 'agent.send'].sort());
    expect(Object.keys(COMMANDS)).toEqual([...COMMAND_TYPES]);
    expectTypeOf<CommandType>().toEqualTypeOf<keyof CommandPayloads>();
  });

  test.for(COMMAND_TYPES)('%s has a payload schema, a route and a fixture that validates', (type) => {
    const row = COMMANDS[type];
    expect(row.payload).toBeTypeOf('object');
    expect(['direct-read', 'start', 'inbox', 'cli-local']).toContain(row.route);
    const fixture = COMMAND_FIXTURES[type];
    expect(fixture.type).toBe(type);
    expect(compileCommand(type)(fixture)).toEqual({ ok: true, value: fixture });
    expect(compileCommandPayload(type)(fixture.payload).ok).toBe(true);
  });

  test('routes are the table of DESIGN 2.3.4', () => {
    const routes = Object.fromEntries(COMMAND_TYPES.map((type) => [type, COMMANDS[type].route]));
    expect(routes).toEqual({
      start: 'start',
      status: 'direct-read',
      inspect: 'direct-read',
      tail: 'direct-read',
      pause: 'inbox',
      resume: 'inbox',
      cancel: 'inbox',
      approve: 'inbox',
      deny: 'inbox',
      retry: 'inbox',
      skip: 'inbox',
      'run-tool': 'inbox',
      reconcile: 'cli-local',
      shutdown: 'inbox',
      'agent.send': 'inbox',
    });
  });

  test('a pure reader carries no authenticator and emits no result event; everything else does both', () => {
    for (const type of COMMAND_TYPES) {
      const { route, authenticated, emitsResultEvent } = COMMANDS[type];
      const reader = route === 'direct-read' || route === 'cli-local';
      expect([type, authenticated, emitsResultEvent]).toEqual([type, !reader, !reader]);
      expect('auth' in COMMAND_FIXTURES[type]).toBe(authenticated);
    }
  });

  test('controller exit codes are data', () => {
    expect(CONTROLLER_EXIT_CODES).toEqual({ completed: 0, usage: 2, rejected: 3, pending: 4 });
  });
});

describe('payloads', () => {
  test.for(COMMAND_PAYLOAD_VARIANTS)('accepts %s', ([, type, payload]) => {
    expect(compileCommandPayload(type)(payload)).toEqual({ ok: true, value: payload });
  });

  test.for(REJECTED_COMMAND_PAYLOADS)('rejects %s', ([, type, payload]) => {
    expect(compileCommandPayload(type)(payload).ok).toBe(false);
  });

  test('the artifact byte cap keeps an inspect document under a 4 MiB one-shot client', () => {
    expect(INSPECT_ARTIFACT_DEFAULT_BYTES).toBe(1024 * 1024);
    expect(INSPECT_ARTIFACT_MAX_BYTES).toBe(3 * 1024 * 1024);
    const target = { kind: 'artifact', artifactId: `art_${'3'.repeat(32)}`, maxBytes: INSPECT_ARTIFACT_MAX_BYTES };
    expect(compileCommandPayload('inspect')({ target }).ok).toBe(true);
  });

  test('payload types follow the schemas', () => {
    expectTypeOf<CommandPayloads['approve']['answer']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NonNullable<CommandPayloads['start']['consent']>['via']>().toEqualTypeOf<'cli-flag'>();
    expectTypeOf<CommandEnvelope<'pause'>['payload']>().toEqualTypeOf<CommandPayloads['pause']>();
    expectTypeOf<CommandEnvelope<'pause'>['type']>().toEqualTypeOf<'pause'>();
  });
});

describe('envelope', () => {
  const pause = COMMAND_FIXTURES.pause;

  test.for([
    ['cmd_123', false],
    [`cmd_${'A'.repeat(32)}`, false],
    [`cmd_${'a'.repeat(31)}`, false],
    [`evt_${'a'.repeat(32)}`, false],
    [`cmd_${'0123456789abcdef'.repeat(2)}`, true],
  ] as const)('commandId %s -> %s', ([commandId, accepted]) => {
    expect(compileCommand('pause')({ ...pause, commandId }).ok).toBe(accepted);
  });

  test('the authenticator is a scheme-neutral field called `auth`, not `mac`', () => {
    const { auth, ...body } = pause;
    expect(compileCommand('pause')({ ...body, mac: auth?.value }).ok).toBe(false);
    expect(compileCommand('pause')(body).ok).toBe(true);
  });

  test('strict refuses an unknown envelope key, another protocol version and a payload of another type', () => {
    expect(compileCommand('pause')({ ...pause, extra: 1 }).ok).toBe(false);
    expect(compileCommand('pause')({ ...pause, protocolVersion: '2.0' }).ok).toBe(false);
    expect(compileCommand('pause')({ ...pause, type: 'cancel' }).ok).toBe(false);
    expect(compileCommand('cancel')({ ...pause, type: 'cancel' }).ok).toBe(false);
    expect(compileCommand('pause')({ ...pause, expectedSequence: -1 }).ok).toBe(false);
  });
});

describe('canonicalCommandBody', () => {
  const approve = COMMAND_FIXTURES.approve as unknown as CommandEnvelope<'approve'>;

  test('is the canonical JSON of the envelope MINUS `auth`', () => {
    const { auth, ...body } = COMMAND_FIXTURES.approve;
    expect(auth).toBeDefined();
    expect(canonicalCommandBody(approve)).toBe(canonicalJson(JSON.parse(JSON.stringify(body)) as JsonValue));
    expect(canonicalCommandBody(approve)).not.toContain('auth');
    expect(canonicalCommandBody(approve)).not.toContain(String(auth?.value));
  });

  test('does not depend on the authenticator at all', () => {
    const other = { ...approve, auth: { scheme: 'ed25519', value: 'ff' } };
    const { auth: _dropped, ...unsigned } = approve;
    expect(canonicalCommandBody(other)).toBe(canonicalCommandBody(approve));
    expect(canonicalCommandBody(unsigned)).toBe(canonicalCommandBody(approve));
  });

  test('is key-order independent, at every depth', () => {
    const asWritten = JSON.parse(JSON.stringify(COMMAND_FIXTURES.start)) as JsonValue;
    const shuffled = reversed(asWritten) as unknown as CommandEnvelope<'start'>;
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(COMMAND_FIXTURES.start));
    expect(canonicalCommandBody(shuffled)).toBe(
      canonicalCommandBody(COMMAND_FIXTURES.start as unknown as CommandEnvelope<'start'>),
    );
  });

  test('covers every other field: changing one changes the body', () => {
    const base = canonicalCommandBody(approve);
    expect(canonicalCommandBody({ ...approve, payload: { ...approve.payload, scope: 'run' } })).not.toBe(base);
    expect(canonicalCommandBody({ ...approve, expectedSequence: 3 })).not.toBe(base);
    expect(canonicalCommandBody({ ...approve, actor: { ...approve.actor, id: 'mallory' } })).not.toBe(base);
  });

  test('leaves its argument untouched', () => {
    const before = JSON.stringify(approve);
    canonicalCommandBody(approve);
    expect(JSON.stringify(approve)).toBe(before);
  });
});

describe('open commands schema', () => {
  const published = toOpenCommandsJsonSchema();
  const check = compileOpen(published);

  test('has a stable $id and one branch per type plus a catch-all', () => {
    const schema = published as { $id: string; oneOf: unknown[] };
    expect(schema.$id).toBe(COMMANDS_SCHEMA_ID);
    expect(COMMANDS_SCHEMA_ID).toBe('https://cohorte.dev/schemas/3/commands.schema.json');
    expect(schema.oneOf).toHaveLength(COMMAND_TYPES.length + 1);
  });

  test('compiles under ajv 2020-12 strict, which agrees on every fixture (a schema-only client, AC-07)', () => {
    const validate = addFormats(new Ajv2020({ strict: true, keywords: [OPEN_ENUM_KEYWORD] })).compile(
      published as SchemaObject,
    );
    for (const type of COMMAND_TYPES) expect(validate(COMMAND_FIXTURES[type]), type).toBe(true);
    expect(validate({ ...COMMAND_FIXTURES.pause, commandId: 7 })).toBe(false);
  });

  test.for(COMMAND_TYPES)('the %s fixture validates', (type) => {
    expect(check(COMMAND_FIXTURES[type]).ok).toBe(true);
  });

  test('an unknown auth.scheme still validates: refusing it is the job of the host', () => {
    const future = { ...COMMAND_FIXTURES.pause, auth: { scheme: 'ed25519', value: 'c2lnbmF0dXJl' } };
    expect(check(future).ok).toBe(true);
    expect(compileCommand('pause')(future).ok).toBe(false);
  });

  test('a future command, a future optional field and a future transport validate', () => {
    expect(check({ ...COMMAND_FIXTURES.pause, type: 'snooze', payload: { minutes: 5 } }).ok).toBe(true);
    expect(check({ ...COMMAND_FIXTURES.pause, payload: { reason: 'x', until: 'tomorrow' } }).ok).toBe(true);
    const viaSocket = { ...COMMAND_FIXTURES.pause, actor: { kind: 'client', id: 'francois', transport: 'socket' } };
    expect(check(viaSocket).ok).toBe(true);
    expect(compileCommand('pause')(viaSocket).ok).toBe(false);
  });

  test('a known command with a broken payload does not', () => {
    expect(check({ ...COMMAND_FIXTURES.cancel, payload: { keepWorktrees: 'yes' } }).ok).toBe(false);
    expect(check({ ...COMMAND_FIXTURES.pause, commandId: 'cmd_1' }).ok).toBe(false);
  });
});
