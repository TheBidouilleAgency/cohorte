// One valid sample per frame variant. Not collected (no test suffix).
import { type AgentId, errorOf, type IsoInstant, type RunId, type Sha256 } from '@cohorte/base';
import type { SpawnRequest } from '@cohorte/runtime-contract';
import { sealedText } from '@cohorte/testkit';
import type { Attestation, ChildFrame, EngineSettings, ParentFrame } from '../../src/protocol.ts';

export const HEX64 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' as Sha256;
const INSTANT = '2026-09-18T10:20:30.123Z' as IsoInstant;
const BASE_URL = 'https://chatgpt.com/backend-api';

export const request: SpawnRequest = {
  runId: 'run_0123456789abcdef0123456789abcdef' as RunId,
  agentId: 'agt_builder_main' as AgentId,
  role: 'builder',
  model: { provider: 'openai-codex', model: 'gpt-5.5-codex' },
  systemPrompt: { id: 'builder', path: '/snapshot/prompts/builder.md', sha256: HEX64, bytes: 1_024 },
  context: {
    manifestSha256: HEX64,
    tokenLimit: 100_000,
    tokenEstimate: 10,
    entries: [],
    reductions: [],
    exclusions: [],
  },
  tools: [
    { tool: 'read_file', description: 'Reads.', inputSchema: { type: 'object' }, effect: 'read', terminal: false },
    { tool: 'submit_result', description: 'Ends.', inputSchema: { type: 'object' }, effect: 'control', terminal: true },
  ],
  sandbox: {
    require: 'os-if-available',
    filesystem: { readOnly: ['/snapshot'], readWrite: ['/state'], denyRead: [] },
    network: { mode: 'provider-only', allowHosts: ['chatgpt.com'] },
    env: { allow: ['PATH'], set: { TZ: 'UTC' } },
    limits: {},
  },
  budget: { maxTurns: 40, maxEngineRetries: 0 },
  workingDirectory: '/work/tree',
  incarnation: 1,
  thinking: 'medium',
  auth: { mode: 'subscription', provider: 'openai-codex', baseUrl: BASE_URL, allowApiKey: false },
  task: { path: '/snapshot/task.md', sha256: HEX64, bytes: 300 },
  continuation: null,
};

export const engine: EngineSettings = {
  authPath: '/home/u/.pi/agent/auth.json',
  agentDir: '/home/u/.cohorte/pi-agent',
  sessionFile: '/state/session.jsonl',
  loadFrom: 'package',
  expectedEngineVersion: '0.85.1',
  responseHeaderAllowlist: ['retry-after', 'x-ratelimit-remaining-requests'],
};
const authEngine = { authPath: engine.authPath, agentDir: engine.agentDir };

export const attestation: Attestation = {
  engine: { name: 'engine', version: '0.85.1', packageVersions: { a: '0.85.1', b: '0.85.1', c: '0.85.1' } },
  hostProtocol: 1,
  activeTools: ['read_file', 'submit_result'],
  effectiveSystemPromptSha256: HEX64,
  systemPromptPrefixOk: true,
  extensionsLoaded: 0,
  extensionErrors: 0,
  modelFallback: false,
  auth: { provider: 'openai-codex', type: 'oauth', source: 'auth.json', subscription: true },
  effective: { provider: 'openai-codex', model: 'gpt-5.5-codex', api: 'openai-codex-responses', baseUrl: BASE_URL },
  settings: { compaction: false, agentRetry: false, providerMaxRetries: 0, transport: 'sse' },
  hooks: {
    streamWrapperInstalled: true,
    guardFetchInstalled: true,
    onResponseChained: true,
    shouldStopAfterTurn: true,
  },
  sessionFile: engine.sessionFile,
  sessionId: 'ses_1',
  envKeys: ['PATH', 'TZ'],
  platform: 'linux',
};

const authStatus = {
  provider: 'openai-codex',
  state: 'oauth',
  subscription: true,
  checkedAt: INSTANT,
  billing: 'plan-limits',
} as const;
const usage = {
  tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
  modelRequests: 1,
  toolCalls: 0,
  turns: 1,
  wallClockMs: 10,
};
const signal = {
  modelsErrorCode: 'auth',
  causeCode: 'ELOCKED',
  httpStatus: 401,
  text: 'locked',
  origin: 'auth-check',
} as const;
const fatalError = errorOf('security/asset-hash-mismatch', 'the prompt does not match its reference');

export const parentFrames: readonly (readonly [name: string, frame: ParentFrame])[] = [
  ['init agent', { t: 'init', v: 1, nonce: 'n-1', mode: 'agent', request, engine }],
  [
    'init auth-status',
    { t: 'init', v: 1, nonce: 'n-1', mode: 'auth-status', providers: ['openai-codex'], engine: authEngine },
  ],
  [
    'init auth-login',
    { t: 'init', v: 1, nonce: 'n-1', mode: 'auth-login', provider: 'openai-codex', engine: authEngine },
  ],
  [
    'init auth-logout',
    { t: 'init', v: 1, nonce: 'n-1', mode: 'auth-logout', provider: 'openai-codex', engine: authEngine },
  ],
  ['prompt', { t: 'prompt', id: 'p1', text: '# Task\nline two still one JSON line' }],
  ['prompt with a note', { t: 'prompt', id: 'p1', text: '# Task', note: { text: '# Continuation\n' } }],
  ['send', { t: 'send', id: 's1', messageId: 'm1', text: 'go on', delivery: 'steer' }],
  [
    'tool.result',
    {
      t: 'tool.result',
      toolCallId: 'tc_1_1',
      isError: false,
      content: [{ type: 'text', text: sealedText('ok\n') }],
      terminate: false,
      resultRef: 'audit_1',
    },
  ],
  ['pause', { t: 'pause' }],
  ['resume', { t: 'resume' }],
  ['stop-after-turn', { t: 'stop-after-turn', reason: 'pause' }],
  ['abort', { t: 'abort', id: 'a1', reason: 'cancelled by the user' }],
  ['auth.answer', { t: 'auth.answer', id: 'q1', value: '123456' }],
  ['inspect', { t: 'inspect', id: 'i1' }],
  ['shutdown', { t: 'shutdown' }],
];

export const childFrames: readonly (readonly [name: string, frame: ChildFrame])[] = [
  ['hello', { t: 'hello', v: 1, pid: 4242, nonce: 'n-1' }],
  ['ready', { t: 'ready', attestation }],
  [
    'event',
    { t: 'event', seq: 3, event: { type: 'agent.turn.completed', at: INSTANT, data: { turn: 1, toolCalls: 0 } } },
  ],
  [
    'tool.call',
    { t: 'tool.call', seq: 4, ordinal: 1, engineToolCallId: 'call_abc', tool: 'read_file', input: { path: 'a.ts' } },
  ],
  ['tool.call.abandoned', { t: 'tool.call.abandoned', engineToolCallId: 'call_abc', reason: 'aborted' }],
  ['provider.response', { t: 'provider.response', requestId: 'r1', status: 429, headers: { 'retry-after': '30' } }],
  [
    'provider.request',
    { t: 'provider.request', requestId: 'r1', origin: 'https://chatgpt.com', authScheme: 'bearer-jwt', refused: false },
  ],
  ['parked', { t: 'parked', at: 'model-boundary' }],
  ['heartbeat', { t: 'heartbeat', rssMb: 181.5, state: 'awaiting-tool' }],
  ['auth.status', { t: 'auth.status', statuses: [authStatus] }],
  ['auth.show', { t: 'auth.show', event: { kind: 'open-url', url: 'https://example.invalid/login' } }],
  ['auth.ask', { t: 'auth.ask', id: 'q1', prompt: { kind: 'manual-code', message: 'Paste the code' } }],
  ['auth.done', { t: 'auth.done', status: authStatus }],
  ['settled', { t: 'settled', exit: { outcome: 'completed', stop: 'model-stop', usage, lastSeq: 9 } }],
  [
    'settled with a signal',
    { t: 'settled', exit: { outcome: 'failed', stop: 'engine-error', usage, lastSeq: 9 }, signal },
  ],
  ['response ok', { t: 'response', id: 'i1', ok: true, data: { state: 'running' } }],
  ['response error', { t: 'response', id: 'i1', ok: false, error: fatalError }],
  ['fatal', { t: 'fatal', error: fatalError }],
  ['fatal with a signal', { t: 'fatal', error: fatalError, signal: { text: 'boom', origin: 'engine' } }],
];
