import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  catalogue,
  DURABLE_EVENT_TYPES,
  type DurableEventType,
  type Envelope,
  EVENT_TYPES,
  EVENTS,
  type EventType,
  isDurableEventType,
  type Payload,
} from '../../src/catalogue.ts';
import { compileOpen, EVENTS_SCHEMA_ID } from '../../src/compile.ts';
import { asRecord, goldenFiles, goldenOf } from './golden.ts';

/** DESIGN 2.3.3, the literal D/E column, row by row. Changing the durability of a type is a MAJOR (2.3.2). */
const PINNED_DURABILITY: Record<string, 'D' | 'E'> = {
  'pipeline.started': 'D',
  'pipeline.completed': 'D',
  'pipeline.failed': 'D',
  'run.state.changed': 'D',
  'run.paused': 'D',
  'run.resumed': 'D',
  'run.cancelled': 'D',
  'run.host.attached': 'D',
  'run.host.detached': 'D',
  'phase.started': 'D',
  'phase.completed': 'D',
  'agent.declared': 'D',
  'agent.spawned': 'D',
  'agent.started': 'D',
  'agent.state.changed': 'D',
  'agent.completed': 'D',
  'agent.failed': 'D',
  'agent.turn.started': 'E',
  'agent.turn.completed': 'D',
  'agent.message.started': 'E',
  'agent.message.delta': 'E',
  'agent.message.completed': 'D',
  'agent.message.accepted': 'D',
  'runtime.warning': 'D',
  'model.requested': 'D',
  'model.responded': 'D',
  'context.built': 'D',
  'tool.requested': 'D',
  'tool.denied': 'D',
  'tool.rejected': 'D',
  'tool.started': 'D',
  'tool.progress': 'E',
  'tool.completed': 'D',
  'file.read': 'D',
  'file.written': 'D',
  'file.changed': 'D',
  'check.started': 'D',
  'check.completed': 'D',
  'review.started': 'D',
  'review.finding': 'D',
  'review.completed': 'D',
  'review.approved': 'D',
  'approval.requested': 'D',
  'approval.resolved': 'D',
  'budget.updated': 'D',
  'budget.exceeded': 'D',
  'quota.updated': 'D',
  'auth.required': 'D',
  'retry.scheduled': 'D',
  'escalation.applied': 'D',
  'git.worktree.created': 'D',
  'git.worktree.provisioned': 'D',
  'git.worktree.quarantined': 'D',
  'git.worktree.removed': 'D',
  'git.commit.created': 'D',
  'git.merge.completed': 'D',
  'git.merge.conflicted': 'D',
  'repo.change.detected': 'D',
  'lock.acquired': 'D',
  'lock.released': 'D',
  'lock.stolen': 'D',
  'command.accepted': 'D',
  'command.completed': 'D',
  'command.rejected': 'D',
  error: 'D',
  'checkpoint.created': 'D',
  snapshot: 'E',
  heartbeat: 'E',
};

/** SPEC 17.1 "Events minimum", expanded. */
const SPEC_17_1_MINIMUM = [
  'pipeline.started',
  'pipeline.completed',
  'pipeline.failed',
  'phase.started',
  'phase.completed',
  'agent.declared',
  'agent.spawned',
  'agent.started',
  'agent.completed',
  'agent.failed',
  'tool.requested',
  'tool.started',
  'tool.completed',
  'tool.denied',
  'model.requested',
  'model.responded',
  'context.built',
  'file.read',
  'file.written',
  'file.changed',
  'review.started',
  'review.finding',
  'review.approved',
  'approval.requested',
  'approval.resolved',
  'budget.updated',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'error',
  'checkpoint.created',
];

const propertiesOf = (type: EventType): Record<string, unknown> =>
  asRecord(asRecord(JSON.parse(JSON.stringify(EVENTS[type].payload))).properties);

describe('the catalogue is the EVENTS table', () => {
  test('durability per row equals the D/E column of DESIGN 2.3.3, and no row is missing or extra', () => {
    const actual = Object.fromEntries(
      EVENT_TYPES.map((type) => [type, EVENTS[type].durability === 'durable' ? 'D' : 'E']),
    );
    expect(actual).toEqual(PINNED_DURABILITY);
  });

  test('the spec-17.1 minimum list is a subset of EVENTS', () => {
    expect(SPEC_17_1_MINIMUM.filter((type) => !Object.hasOwn(EVENTS, type))).toEqual([]);
  });

  test('effect-journal rows are not events', () => {
    expect(EVENT_TYPES.filter((type) => type.startsWith('effect'))).toEqual([]);
  });

  test('DURABLE_EVENT_TYPES and isDurableEventType follow the table', () => {
    const durable = Object.keys(PINNED_DURABILITY).filter((type) => PINNED_DURABILITY[type] === 'D');
    expect([...DURABLE_EVENT_TYPES].sort()).toEqual(durable.sort());
    expect(isDurableEventType('tool.completed')).toBe(true);
    expect(isDurableEventType('tool.progress')).toBe(false);
    expect(isDurableEventType('tool.invented')).toBe(false);
  });

  test('types: a reducer can only name durable types, and an envelope narrows its payload', () => {
    expectTypeOf<'tool.progress'>().not.toExtend<DurableEventType>();
    expectTypeOf<'tool.completed'>().toExtend<DurableEventType>();
    expectTypeOf<Envelope<'heartbeat'>['durability']>().toEqualTypeOf<'ephemeral'>();
    expectTypeOf<Envelope<'heartbeat'>['payload']>().toEqualTypeOf<Payload<'heartbeat'>>();
    expectTypeOf<Payload<'agent.turn.completed'>>().toEqualTypeOf<{ turn: number; toolCalls: number }>();
  });
});

describe('golden fixtures', () => {
  test('every fixture file maps to a known kind and a known type', () => {
    const unknown = goldenFiles().filter(
      ({ kind, name }) => !['event', 'command', 'document'].includes(kind) || name.length === 0,
    );
    expect(unknown.map(({ file }) => file)).toEqual([]);
    expect(
      goldenOf('event')
        .filter(({ name }) => !Object.hasOwn(EVENTS, name))
        .map(({ file }) => file),
    ).toEqual([]);
  });

  test('every event type has at least one fixture', () => {
    const covered = new Set(goldenOf('event').map(({ name }) => name));
    expect(EVENT_TYPES.filter((type) => !covered.has(type))).toEqual([]);
  });

  test.for(EVENT_TYPES.map((type) => [type] as const))('%s: payload and envelope validate strictly', ([type]) => {
    const fixtures = goldenOf('event').filter(({ name }) => name === type);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const { value } of fixtures) {
      const envelope = asRecord(value);
      expect(envelope.type).toBe(type);
      expect(catalogue.compileStrict(type)(envelope.payload)).toEqual({ ok: true, value: envelope.payload });
      expect(catalogue.compileStrictEnvelope(type)(envelope)).toEqual({ ok: true, value: envelope });
    }
  });

  test('a strict payload refuses an unknown key, in every event type', () => {
    for (const { name, value } of goldenOf('event')) {
      const payload = { ...asRecord(asRecord(value).payload), addedByALaterMinor: 1 };
      const result = catalogue.compileStrict(name as EventType)(payload);
      expect(result.ok, name).toBe(false);
    }
  });

  test('the fixtures of the ephemeral types carry sub >= 1, the durable ones sub 0', () => {
    for (const { name, value } of goldenOf('event')) {
      const { sub, durability } = asRecord(value);
      expect(durability, name).toBe(EVENTS[name as EventType].durability);
      if (durability === 'durable') expect(sub, name).toBe(0);
      else expect(sub, name).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the rows added by the design revision', () => {
  test('tool.rejected is not a tool.denied: no toolCallId, no rule ids', () => {
    const rejected = propertiesOf('tool.rejected');
    expect(Object.keys(rejected).sort()).toEqual(['cause', 'engineToolCallId', 'message', 'tool']);
    expect(EVENTS['tool.rejected'].payload.required).toEqual(['tool', 'cause', 'message']);
    expect(Object.keys(propertiesOf('tool.denied'))).toEqual(expect.arrayContaining(['toolCallId', 'ruleId']));
  });

  test('agent.state.changed.reason is open and knows recovery, park and pause-expiry', () => {
    const { reason, attemptConsumed } = propertiesOf('agent.state.changed');
    expect(asRecord(reason)['x-cohorte-known']).toEqual(expect.arrayContaining(['recovery', 'park', 'pause-expiry']));
    expect(attemptConsumed).toEqual({ type: 'boolean' });
    expect(EVENTS['agent.state.changed'].payload.required).toContain('attemptConsumed');
  });

  test('tool.completed.waitedMs is required, filteredPaths and tool.started.replayOfApproval are optional', () => {
    expect(EVENTS['tool.completed'].payload.required).toContain('waitedMs');
    expect(EVENTS['tool.completed'].payload.required).not.toContain('filteredPaths');
    expect(Object.keys(propertiesOf('tool.completed'))).toContain('filteredPaths');
    expect(EVENTS['tool.started'].payload.required).not.toContain('replayOfApproval');
    expect(Object.keys(propertiesOf('tool.started'))).toContain('replayOfApproval');
  });

  test('approval.resolved carries commandAuth { scheme, value } and answer; command.accepted says authVerified', () => {
    const resolved = propertiesOf('approval.resolved');
    expect(Object.keys(asRecord(asRecord(resolved.commandAuth).properties)).sort()).toEqual(['scheme', 'value']);
    expect(Object.keys(resolved)).toContain('answer');
    const accepted = propertiesOf('command.accepted');
    expect(asRecord(accepted.authVerified).const).toBe(true);
    expect(asRecord(accepted.scheme)['x-cohorte-known']).toEqual(['hmac-sha256']);
  });

  test.for([['agent.message.accepted'], ['runtime.warning'], ['tool.rejected']] as const)('%s is durable', ([type]) => {
    expect(EVENTS[type].durability).toBe('durable');
  });
});

describe('the published events schema', () => {
  const published = asRecord(catalogue.toOpenJsonSchema());
  const branches = (published.oneOf as unknown[]).map(asRecord);

  test('$id is stable', () => {
    expect(published.$id).toBe('https://cohorte.dev/schemas/3/events.schema.json');
    expect(published.$id).toBe(EVENTS_SCHEMA_ID);
  });

  test('oneOf over `type`: one branch per known type, then a catch-all', () => {
    expect(branches).toHaveLength(EVENT_TYPES.length + 1);
    const known = branches.slice(0, -1).map((branch) => asRecord(asRecord(branch.properties).type).const);
    expect(known).toEqual([...EVENT_TYPES]);
    const catchAll = asRecord(asRecord(branches.at(-1)?.properties).type);
    expect(asRecord(catchAll.not).enum).toEqual([...EVENT_TYPES]);
  });

  test('every golden envelope validates, and so does a type, a field and an enum value of a later minor', () => {
    const open = compileOpen(catalogue.toOpenJsonSchema());
    for (const { file, value } of goldenOf('event')) expect(open(value).ok, file).toBe(true);
    const denied = asRecord(goldenOf('event').find(({ name }) => name === 'tool.denied')?.value);
    expect(open({ ...denied, type: 'tool.quarantined', payload: { anything: true } }).ok).toBe(true);
    expect(open({ ...denied, payload: { ...asRecord(denied.payload), stage: 'a-later-stage', extra: 1 } }).ok).toBe(
      true,
    );
    expect(open({ ...denied, durability: 'ephemeral' }).ok).toBe(false);
  });
});
