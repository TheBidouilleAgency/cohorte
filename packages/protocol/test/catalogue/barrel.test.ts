import { expect, test } from 'vitest';
import * as protocol from '../../src/index.ts';

// The barrel is frozen at G0 (PLAN §3 rule 3): every later wave imports these names from `@cohorte/protocol`.
const FROZEN = [
  // envelope + authoring
  'PROTOCOL_VERSION',
  'EnvelopeBase',
  'OpenEnum',
  'ClosedEnum',
  'compareOrder',
  'compileSchema',
  'compileOpen',
  'compileStrict',
  'compileStrictEnvelope',
  'toOpenJsonSchema',
  'toOpenSchema',
  'toStrictSchema',
  'bindCatalogue',
  // vocabulary + refs
  'PipelineState',
  'PIPELINE_STATES',
  'StopRecord',
  'BudgetCounters',
  'Actor',
  'ArtifactRef',
  'PhaseRef',
  'AgentRef',
  'RunPlan',
  'ApprovalRequest',
  'ResumeReport',
  // catalogue
  'EVENTS',
  'EVENT_TYPES',
  'DURABLE_EVENT_TYPES',
  'isDurableEventType',
  'catalogue',
  // commands
  'COMMANDS',
  'COMMAND_TYPES',
  'compileCommand',
  'canonicalCommandBody',
  'toOpenCommandsJsonSchema',
  // documents
  'DOCUMENTS',
  'DOCUMENT_NAMES',
  'RunSnapshotDocument',
  'ProjectStatusDocument',
  'InspectDocument',
  'RunDiffDocument',
  'CommandResultDocument',
  'DoctorReport',
  'AuthStatusDocument',
  'toOpenDocumentJsonSchema',
  // agent output + ndjson
  'AgentOutput',
  'Finding',
  'ReviewResult',
];

test('the barrel exports the whole frontier', () => {
  expect(FROZEN.filter((name) => !Object.hasOwn(protocol, name))).toEqual([]);
});

test('the barrel binds the catalogue to EVENTS', () => {
  expect(protocol.catalogue.compileStrict('heartbeat')({ hostAlive: true, lastSequence: 3 }).ok).toBe(true);
  expect(protocol.EVENT_TYPES).toContain('pipeline.started');
});
