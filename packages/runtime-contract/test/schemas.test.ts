import { sealedText } from '@cohorte/testkit';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { describe, expect, test } from 'vitest';
import {
  AgentExit,
  AgentStopCause,
  AuthRequirement,
  Budget,
  Cap,
  ContextEntry,
  ContextManifest,
  Continuation,
  EffectiveModel,
  IsolationReport,
  ModelStop,
  PromptRef,
  ProviderAuthStatus,
  RUNTIME_EVENT_TYPE_NAMES,
  RUNTIME_EVENT_TYPES,
  RuntimeCapabilities,
  RuntimeEvent,
  type RuntimeEventType,
  RuntimeMessage,
  RuntimePin,
  RuntimeSessionRef,
  RuntimeSnapshot,
  RuntimeToolCall,
  RuntimeToolResult,
  SandboxPolicy,
  SpawnRequest,
  TaskInput,
  ToolContent,
  ToolGrant,
  ToolProgress,
  TranscriptRef,
  UsageTotals,
} from '../src/index.ts';
import {
  AGENT_ID,
  agentExit,
  capabilities,
  contextManifest,
  HEX64,
  INSTANT,
  RUN_ID,
  sandbox,
  sessionRef,
  spawnRequest,
  TOOL_CALL_ID,
  toolCall,
  toolGrant,
  usageTotals,
} from './samples.ts';

type Case = readonly [name: string, schema: TSchema, value: unknown];

const snapshot = {
  runId: RUN_ID,
  agentId: AGENT_ID,
  incarnation: 2,
  state: 'paused',
  pausedAt: 'tool-boundary',
  turn: 3,
  pendingToolCalls: [TOOL_CALL_ID],
  requestedModel: spawnRequest.model,
  effectiveModel: { provider: 'openai-codex', model: 'gpt-5.5-codex', api: 'openai-codex-responses' },
  authMode: 'subscription',
  usage: usageTotals,
  contextTokens: 9_000,
  contextWindow: 200_000,
  session: sessionRef,
  lastSeq: 40,
  diagnostics: { pid: 4242, rssMb: 180.5, flags: ['a'] },
};

const pin = {
  runtimeId: 'echo',
  adapterVersion: '3.0.0',
  engine: null,
  node: { version: 'v24.21.0', execPath: '/usr/local/bin/node' },
  artifacts: [{ role: 'agent-host-bundle', path: 'dist/agent-host.mjs', sha256: HEX64, bytes: 1_000 }],
  digest: HEX64,
};

const authStatus = {
  provider: 'openai-codex',
  state: 'oauth',
  subscription: true,
  source: 'engine credential store',
  checkedAt: INSTANT,
  billing: 'plan-limits',
};

const textContent = { type: 'text', text: sealedText('hello') };

const accepted: readonly Case[] = [
  ['RuntimeToolCall', RuntimeToolCall, toolCall],
  ['RuntimeToolCall without an engine id', RuntimeToolCall, { ...toolCall, engineToolCallId: undefined }],
  ['ToolProgress empty', ToolProgress, {}],
  ['ToolProgress', ToolProgress, { text: 'reading', bytes: 10 }],
  ['ToolContent text', ToolContent, textContent],
  ['ToolContent image', ToolContent, { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }],
  ['RuntimeToolResult', RuntimeToolResult, { isError: false, content: [textContent] }],
  ['RuntimeToolResult full', RuntimeToolResult, { isError: true, content: [], terminate: true, resultRef: 'audit_1' }],
  ['ToolGrant', ToolGrant, toolGrant],
  ['SpawnRequest', SpawnRequest, spawnRequest],
  [
    'SpawnRequest with a continuation',
    SpawnRequest,
    {
      ...spawnRequest,
      incarnation: 2,
      continuation: { fromIncarnation: 1, note: { path: '/snapshot/note.md', sha256: HEX64, bytes: 12 } },
    },
  ],
  ['AuthRequirement', AuthRequirement, spawnRequest.auth],
  ['TaskInput', TaskInput, spawnRequest.task],
  [
    'Continuation with a transcript',
    Continuation,
    { fromIncarnation: 1, note: spawnRequest.task, transcript: sessionRef.transcript },
  ],
  ['PromptRef', PromptRef, spawnRequest.systemPrompt],
  ['ContextManifest', ContextManifest, contextManifest],
  ['ContextEntry', ContextEntry, contextManifest.entries[0]],
  ['SandboxPolicy', SandboxPolicy, sandbox],
  ['Budget minimal', Budget, { maxEngineRetries: 0 }],
  ['Budget full', Budget, { ...spawnRequest.budget, maxModelRequests: 1, maxWallClockMs: 60_000 }],
  ['TranscriptRef', TranscriptRef, sessionRef.transcript],
  ['RuntimeSessionRef', RuntimeSessionRef, sessionRef],
  ['UsageTotals', UsageTotals, usageTotals],
  ['EffectiveModel', EffectiveModel, { provider: 'p', model: 'm' }],
  ['AgentStopCause', AgentStopCause, 'process-exit'],
  ['AgentExit', AgentExit, agentExit],
  ['RuntimeMessage user', RuntimeMessage, { kind: 'user', messageId: 'm1', text: 'go on', delivery: 'steer' }],
  [
    'RuntimeMessage host-note',
    RuntimeMessage,
    { kind: 'host-note', messageId: 'm2', text: 'x', delivery: 'follow-up' },
  ],
  ['RuntimeSnapshot', RuntimeSnapshot, snapshot],
  [
    'IsolationReport',
    IsolationReport,
    { level: 'os', filesystem: 'enforced', network: 'partial', backend: 'seatbelt' },
  ],
  ['ModelStop', ModelStop, 'tool-use'],
  ['Cap yes', Cap, { value: 'yes' }],
  ['Cap partial', Cap, { value: 'partial', why: 'because' }],
  ['RuntimeCapabilities', RuntimeCapabilities, capabilities],
  ['RuntimePin', RuntimePin, pin],
  ['RuntimePin with an engine', RuntimePin, { ...pin, engine: { name: 'engine', version: '0.85.1' } }],
  ['ProviderAuthStatus', ProviderAuthStatus, authStatus],
];

const rejected: readonly Case[] = [
  ['RuntimeToolCall: ordinal 0', RuntimeToolCall, { ...toolCall, ordinal: 0 }],
  ['RuntimeToolCall: a malformed toolCallId', RuntimeToolCall, { ...toolCall, toolCallId: 'call-1' }],
  ['RuntimeToolCall: an unknown key', RuntimeToolCall, { ...toolCall, executor: 'sh' }],
  ['ToolProgress: negative bytes', ToolProgress, { bytes: -1 }],
  ['ToolContent: an unknown type', ToolContent, { type: 'audio', data: '' }],
  ['RuntimeToolResult: content missing', RuntimeToolResult, { isError: false }],
  ['ToolGrant: an unknown effect', ToolGrant, { ...toolGrant, effect: 'delete' }],
  ['SpawnRequest: no incarnation', SpawnRequest, { ...spawnRequest, incarnation: undefined }],
  ['SpawnRequest: continuation left out', SpawnRequest, { ...spawnRequest, continuation: undefined }],
  ['SpawnRequest: a malformed runId', SpawnRequest, { ...spawnRequest, runId: 'run-1' }],
  ['SpawnRequest: an executor', SpawnRequest, { ...spawnRequest, executor: {} }],
  ['AuthRequirement: a third mode', AuthRequirement, { ...spawnRequest.auth, mode: 'free' }],
  ['TaskInput: an uppercase digest', TaskInput, { ...spawnRequest.task, sha256: HEX64.toUpperCase() }],
  ['Continuation: no note', Continuation, { fromIncarnation: 1 }],
  ['PromptRef: no id', PromptRef, { ...spawnRequest.systemPrompt, id: undefined }],
  [
    'ContextManifest: an unknown reduction strategy',
    ContextManifest,
    {
      ...contextManifest,
      reductions: [{ entryId: 'spec', strategy: 'guess', fromBytes: 1, toBytes: 1 }],
    },
  ],
  ['ContextEntry: an unknown tier', ContextEntry, { ...contextManifest.entries[0], tier: 'secret' }],
  ['SandboxPolicy: an unknown requirement', SandboxPolicy, { ...sandbox, require: 'none' }],
  ['SandboxPolicy: env.set holding a number', SandboxPolicy, { ...sandbox, env: { allow: [], set: { A: 1 } } }],
  ['Budget: maxEngineRetries missing', Budget, { maxTurns: 1 }],
  ['Budget: a negative ceiling', Budget, { maxTurns: -1, maxEngineRetries: 0 }],
  ['TranscriptRef: no format', TranscriptRef, { path: '/x' }],
  ['RuntimeSessionRef: no transcript', RuntimeSessionRef, { ...sessionRef, transcript: undefined }],
  ['UsageTotals: fractional turns', UsageTotals, { ...usageTotals, turns: 1.5 }],
  ['EffectiveModel: no model', EffectiveModel, { provider: 'p' }],
  ['AgentStopCause: an engine stop reason', AgentStopCause, 'end_turn'],
  ['AgentExit: an unknown outcome', AgentExit, { ...agentExit, outcome: 'killed' }],
  ['RuntimeMessage: an unknown delivery', RuntimeMessage, { kind: 'user', messageId: 'm', text: 't', delivery: 'now' }],
  ['RuntimeSnapshot: an unknown state', RuntimeSnapshot, { ...snapshot, state: 'thinking' }],
  [
    'IsolationReport: an unknown level',
    IsolationReport,
    { level: 'vm', filesystem: 'enforced', network: 'none', backend: 'x' },
  ],
  ['ModelStop: a sixth value', ModelStop, 'pending'],
  ['Cap: no without a reason', Cap, { value: 'no' }],
  ['Cap: yes with a reason', Cap, { value: 'yes', why: 'x' }],
  [
    'RuntimeCapabilities: in-runtime tool execution',
    RuntimeCapabilities,
    { ...capabilities, toolExecution: 'in-runtime' },
  ],
  ['RuntimeCapabilities: another contract version', RuntimeCapabilities, { ...capabilities, contractVersion: '2' }],
  [
    'RuntimePin: an unknown artifact role',
    RuntimePin,
    { ...pin, artifacts: [{ ...pin.artifacts[0], role: 'binary' }] },
  ],
  ['ProviderAuthStatus: a token', ProviderAuthStatus, { ...authStatus, token: 'secret' }],
  ['ProviderAuthStatus: an unknown state', ProviderAuthStatus, { ...authStatus, state: 'expired' }],
];

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('[S] schemas of runtime-contract', () => {
  test.for(accepted)('%s accepts a valid sample, also after a JSON round trip', ([, schema, value]) => {
    const check = Compile(schema);
    const wire = roundTrip(value);
    expect([...check.Errors(wire)]).toEqual([]);
    expect(roundTrip(wire)).toEqual(wire);
  });

  test.for(rejected)('%s is refused', ([, schema, value]) => {
    expect(Compile(schema).Check(roundTrip(value))).toBe(false);
  });
});

const envelope = { runId: RUN_ID, agentId: AGENT_ID, incarnation: 1, seq: 7, at: INSTANT };
const model = spawnRequest.model;
const eventData: { [T in RuntimeEventType]: unknown } = {
  'agent.spawned': {
    session: sessionRef,
    requestedModel: model,
    tools: ['read_file'],
    systemPromptSha256: HEX64,
    effectiveSystemPromptSha256: HEX64,
    isolation: { level: 'process', filesystem: 'advisory', network: 'none', backend: 'none' },
  },
  'agent.started': { taskSha256: HEX64 },
  'agent.turn.started': { turn: 1 },
  'agent.turn.completed': { turn: 1, toolCalls: 2 },
  'agent.message.started': { messageId: 'm1', role: 'assistant' },
  'agent.message.delta': { messageId: 'm1', channel: 'text', contentIndex: 0, delta: 'he' },
  'agent.message.completed': {
    messageId: 'm1',
    role: 'assistant',
    textSha256: HEX64,
    textBytes: 5,
    preview: 'hello',
    stop: 'stop',
  },
  'model.requested': { requestId: 'r1', model, contextSha256: HEX64, attempt: 1 },
  'model.responded': {
    requestId: 'r1',
    requestedModel: model,
    effectiveModel: { provider: model.provider, model: model.model },
    authMode: 'subscription',
    authSource: 'oauth',
    durationMs: 120,
    usage: usageTotals.tokens,
    httpStatus: 200,
    attempt: 1,
    stop: 'tool-use',
    quota: { known: false },
  },
  'tool.call.requested': { call: toolCall },
  'tool.call.rejected': { tool: 'bash', cause: 'unknown-tool', message: 'Tool bash not found' },
  'tool.call.progress': { toolCallId: TOOL_CALL_ID, update: { bytes: 10 } },
  'tool.call.delivered': { toolCallId: TOOL_CALL_ID, isError: false, terminate: false, waitedMs: 3 },
  'agent.paused': { at: 'model-boundary' },
  'agent.resumed': {},
  'agent.message.accepted': { messageId: 'm9', delivery: 'steer' },
  'agent.exited': agentExit,
  'runtime.warning': { code: 'engine-stop-reason-unmapped', message: 'pending' },
};

describe('RuntimeEvent', () => {
  const check = Compile(RuntimeEvent);

  test.for(RUNTIME_EVENT_TYPE_NAMES)('%s round-trips with the durability its type declares', (type) => {
    const event = { type, durability: RUNTIME_EVENT_TYPES[type].durability, ...envelope, data: eventData[type] };
    const wire = roundTrip(event);
    expect([...check.Errors(wire)]).toEqual([]);
    const flipped = { ...event, durability: event.durability === 'durable' ? 'ephemeral' : 'durable' };
    expect(check.Check(roundTrip(flipped))).toBe(false);
  });

  test('has the eighteen types of DESIGN 2.2.5, four of them ephemeral', () => {
    expect(RUNTIME_EVENT_TYPE_NAMES).toHaveLength(18);
    const ephemeral = RUNTIME_EVENT_TYPE_NAMES.filter((type) => RUNTIME_EVENT_TYPES[type].durability === 'ephemeral');
    expect(ephemeral).toEqual([
      'agent.turn.started',
      'agent.message.started',
      'agent.message.delta',
      'tool.call.progress',
    ]);
  });

  test.for([
    ['an unknown type', { type: 'agent.thinking', durability: 'durable', ...envelope, data: {} }],
    ['a payload of another type', { type: 'agent.started', durability: 'durable', ...envelope, data: { turn: 1 } }],
    ['a missing seq', { type: 'agent.resumed', durability: 'durable', ...envelope, seq: undefined, data: {} }],
    ['agent.resumed with data', { type: 'agent.resumed', durability: 'durable', ...envelope, data: { x: 1 } }],
    [
      'a sixth stop value',
      {
        type: 'agent.message.completed',
        durability: 'durable',
        ...envelope,
        data: { ...(eventData['agent.message.completed'] as object), stop: 'deferred' },
      },
    ],
    [
      'a preview longer than 512',
      {
        type: 'agent.message.completed',
        durability: 'durable',
        ...envelope,
        data: { ...(eventData['agent.message.completed'] as object), preview: 'x'.repeat(513) },
      },
    ],
  ] as const)('refuses %s', ([, event]) => {
    expect(check.Check(roundTrip(event))).toBe(false);
  });
});
