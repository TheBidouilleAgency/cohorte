import { describe, expect, test } from 'vitest';
import { COMMAND_TYPES, type CommandType, compileCommand, INSPECT_ARTIFACT_MAX_BYTES } from '../../src/commands.ts';
import { compileOpen, compileSchema } from '../../src/compile.ts';
import {
  compileDocument,
  DOCUMENT_NAMES,
  DOCUMENTS,
  type DocumentName,
  documentSchemaId,
  INSPECT_ARTIFACT_MAX_CONTENT_LENGTH,
  ProjectRunSummary,
  RunSnapshotDocument,
  toOpenDocumentJsonSchema,
} from '../../src/documents.ts';
import { asRecord, golden, goldenOf } from './golden.ts';

const plain = (schema: unknown): Record<string, unknown> => asRecord(JSON.parse(JSON.stringify(schema)));

describe('document fixtures', () => {
  test('every document has at least one fixture, and every document fixture names a known document', () => {
    const names = goldenOf('document').map(({ name }) => name.split('.')[0] ?? '');
    expect(names.filter((name) => !Object.hasOwn(DOCUMENTS, name))).toEqual([]);
    expect(DOCUMENT_NAMES.filter((name) => !names.includes(name))).toEqual([]);
  });

  test.for(goldenOf('document').map(({ file, name, value }) => [file, name, value] as const))(
    '%s validates strictly, and under the published schema',
    ([, name, value]) => {
      const document = (name.split('.')[0] ?? '') as DocumentName;
      expect(compileDocument(document)(value)).toEqual({ ok: true, value });
      expect(compileOpen(toOpenDocumentJsonSchema(document))(value).ok).toBe(true);
      expect(compileDocument(document)({ ...asRecord(value), addedByALaterMinor: 1 }).ok).toBe(false);
      expect(compileOpen(toOpenDocumentJsonSchema(document))({ ...asRecord(value), addedByALaterMinor: 1 }).ok).toBe(
        true,
      );
    },
  );

  test('every inspect target of the command has a document fixture', () => {
    const kinds = goldenOf('document')
      .filter(({ name }) => name.startsWith('inspect.'))
      .map(({ value }) => asRecord(value).kind);
    expect(kinds.sort()).toEqual(['agent', 'approval', 'artifact', 'context', 'diff', 'effect', 'locks', 'snapshot']);
  });

  test('published documents carry a stable $id', () => {
    expect(documentSchemaId('run-state')).toBe('https://cohorte.dev/schemas/3/run-state.schema.json');
    expect([...DOCUMENT_NAMES].sort()).toEqual([
      'auth-status',
      'command-result',
      'doctor-report',
      'inspect',
      'project-status',
      'run-diff',
      'run-state',
    ]);
    for (const name of DOCUMENT_NAMES)
      expect(asRecord(toOpenDocumentJsonSchema(name)).$id).toBe(documentSchemaId(name));
  });
});

describe('ProjectStatusDocument.runs is a strict projection of RunSnapshotDocument.run', () => {
  const run = plain(RunSnapshotDocument.properties.run);
  const summary = plain(ProjectRunSummary);

  test('same schema for every projected property, same requiredness, nothing of its own', () => {
    const runProperties = asRecord(run.properties);
    const summaryProperties = asRecord(summary.properties);
    expect(Object.keys(summaryProperties).sort()).toEqual(
      ['endedAt', 'profile', 'runId', 'since', 'startedAt', 'state', 'status', 'stop', 'title'].sort(),
    );
    for (const [name, schema] of Object.entries(summaryProperties)) expect(schema, name).toEqual(runProperties[name]);
    const required = (run.required as string[]).filter((name) => Object.hasOwn(summaryProperties, name));
    expect([...(summary.required as string[])].sort()).toEqual(required.sort());
    expect(plain(DOCUMENTS['project-status'].properties.runs).items).toEqual(summary);
  });

  test('the projection of the run-state fixture is a valid row, the whole run is not', () => {
    const snapshot = asRecord(golden('document', 'run-state'));
    const whole = asRecord(snapshot.run);
    const keys = Object.keys(asRecord(summary.properties));
    const projected = Object.fromEntries(Object.entries(whole).filter(([name]) => keys.includes(name)));
    expect(compileSchema(ProjectRunSummary)(projected).ok).toBe(true);
    expect(compileSchema(ProjectRunSummary)(whole).ok).toBe(false);
  });
});

describe('InspectDocument', () => {
  const artifact = asRecord(golden('document', 'inspect.artifact'));
  const validate = compileDocument('inspect');

  test('artifact content above the cap is rejected, at the cap it is accepted', () => {
    expect(INSPECT_ARTIFACT_MAX_CONTENT_LENGTH).toBe(4 * Math.ceil(INSPECT_ARTIFACT_MAX_BYTES / 3));
    const atCap = { ...artifact, encoding: 'base64', content: 'A'.repeat(INSPECT_ARTIFACT_MAX_CONTENT_LENGTH) };
    expect(validate({ ...atCap, bytes: INSPECT_ARTIFACT_MAX_BYTES }).ok).toBe(true);
    // one character more is the ONLY difference with the accepted document above
    expect(validate({ ...atCap, bytes: INSPECT_ARTIFACT_MAX_BYTES, content: `${atCap.content}A` }).ok).toBe(false);
    expect(validate({ ...artifact, bytes: INSPECT_ARTIFACT_MAX_BYTES + 1 }).ok).toBe(false);
  });

  test('a variant does not accept the body of another one', () => {
    expect(validate({ ...artifact, kind: 'locks' }).ok).toBe(false);
    expect(validate({ ...artifact, kind: 'a-later-kind' }).ok).toBe(false);
  });
});

describe('DoctorReport', () => {
  const report = asRecord(golden('document', 'doctor-report'));
  const validate = compileDocument('doctor-report');

  test('sandbox and runtimeCapabilities are opaque JSON: an arbitrary object passes the STRICT validator', () => {
    const arbitrary = { anything: { nested: [1, 'two', null, { deep: true }] }, addedLater: 'yes' };
    expect(validate({ ...report, sandbox: arbitrary, runtimeCapabilities: arbitrary }).ok).toBe(true);
    expect(validate({ ...report, sandbox: 'a string is JSON too' }).ok).toBe(true);
    const { sandbox: _sandbox, ...withoutSandbox } = report;
    expect(validate(withoutSandbox).ok).toBe(false);
  });

  test('a check status of a later minor is refused by the writer, accepted by a reader', () => {
    const later = { ...report, checks: [{ id: 'node', status: 'degraded', summary: 'node is old' }] };
    expect(validate(later).ok).toBe(false);
    expect(compileOpen(toOpenDocumentJsonSchema('doctor-report'))(later).ok).toBe(true);
  });
});

describe('command fixtures', () => {
  test('one fixture per command type, no fixture for an unknown command', () => {
    const names = goldenOf('command').map(({ name }) => name);
    expect(names.filter((name) => !(COMMAND_TYPES as readonly string[]).includes(name))).toEqual([]);
    expect(COMMAND_TYPES.filter((type) => !names.includes(type))).toEqual([]);
  });

  test.for(goldenOf('command').map(({ name, value }) => [name, value] as const))(
    '%s validates strictly',
    ([name, value]) => {
      expect(asRecord(value).type).toBe(name);
      expect(compileCommand(name as CommandType)(value)).toEqual({ ok: true, value });
    },
  );
});
