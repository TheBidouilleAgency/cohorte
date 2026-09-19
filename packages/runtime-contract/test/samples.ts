// Valid sample values shared by the schema tests and the conformance self-tests. Not collected (no test suffix).
import type { AgentId, IsoInstant, RunId, Sha256, ToolCallId } from '@cohorte/base';
import type {
  AgentExit,
  ContextManifest,
  RuntimeCapabilities,
  RuntimeSessionRef,
  RuntimeToolCall,
  SandboxPolicy,
  SpawnRequest,
  ToolGrant,
  UsageTotals,
} from '../src/index.ts';

export const HEX64 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' as Sha256;
export const INSTANT = '2026-09-18T10:20:30.123Z' as IsoInstant;
export const RUN_ID = 'run_0123456789abcdef0123456789abcdef' as RunId;
export const AGENT_ID = 'agt_builder_main' as AgentId;
export const TOOL_CALL_ID = 'tc_1_1' as ToolCallId;

export const usageTotals: UsageTotals = {
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  modelRequests: 1,
  toolCalls: 1,
  turns: 1,
  wallClockMs: 12.5,
};

export const sessionRef: RuntimeSessionRef = {
  runtime: 'echo',
  engineVersion: '0.0.0',
  sessionId: 'ses_1',
  transcript: { path: '/state/agent/1/session.jsonl', format: 'echo-ndjson-v1' },
};

export const toolGrant: ToolGrant = {
  tool: 'read_file',
  description: 'Reads one file.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  effect: 'read',
  terminal: false,
};

export const toolCall: RuntimeToolCall = {
  runId: RUN_ID,
  agentId: AGENT_ID,
  incarnation: 1,
  toolCallId: TOOL_CALL_ID,
  engineToolCallId: 'call_abc',
  ordinal: 1,
  tool: 'read_file',
  input: { path: 'src/a.ts' },
};

export const contextManifest: ContextManifest = {
  manifestSha256: HEX64,
  tokenLimit: 100_000,
  tokenEstimate: 1_200,
  entries: [
    {
      id: 'spec',
      tier: 'data',
      trust: 'untrusted-repository',
      source: { kind: 'project-file', ref: 'specs/29.md' },
      sha256: HEX64,
      bytes: 2_048,
      tokenEstimate: 600,
    },
  ],
  reductions: [{ entryId: 'spec', strategy: 'excerpt', fromBytes: 9_000, toBytes: 2_048 }],
  exclusions: [{ pattern: '**/.env', reason: 'secret' }],
};

export const sandbox: SandboxPolicy = {
  require: 'os-if-available',
  filesystem: { readOnly: ['/snapshot'], readWrite: ['/state'], denyRead: ['/home/user/.ssh'] },
  network: { mode: 'provider-only', allowHosts: ['chatgpt.com'] },
  env: { allow: ['PATH'], set: { TZ: 'UTC' } },
  limits: { maxOldSpaceMb: 512 },
};

export const spawnRequest: SpawnRequest = {
  runId: RUN_ID,
  agentId: AGENT_ID,
  role: 'builder',
  model: { provider: 'openai-codex', model: 'gpt-5.5-codex' },
  systemPrompt: { id: 'builder', path: '/snapshot/prompts/builder.md', sha256: HEX64, bytes: 1_024 },
  context: contextManifest,
  tools: [toolGrant],
  sandbox,
  budget: { maxTurns: 40, maxEngineRetries: 0 },
  workingDirectory: '/work/tree',
  incarnation: 1,
  thinking: 'medium',
  auth: {
    mode: 'subscription',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    allowApiKey: false,
  },
  task: { path: '/snapshot/task.md', sha256: HEX64, bytes: 300 },
  continuation: null,
};

export const agentExit: AgentExit = { outcome: 'completed', stop: 'model-stop', usage: usageTotals, lastSeq: 12 };

const yes = { value: 'yes' } as const;
export const capabilities: RuntimeCapabilities = {
  contractVersion: '1',
  toolExecution: 'host-delegated',
  streaming: yes,
  thinkingStream: { value: 'no', why: 'the engine does not stream thinking' },
  send: { steer: yes, followUp: yes },
  cancelCooperative: yes,
  cancelHard: { value: 'partial', why: 'in-process' },
  pause: { toolBoundary: yes, modelBoundary: yes },
  continuationFromTranscript: { value: 'no', why: 'never resumed from a transcript' },
  processIsolation: yes,
  envFiltering: yes,
  brainSandbox: yes,
  resourceLimits: yes,
  budgetEnforcement: {
    turns: yes,
    modelRequests: yes,
    tokens: yes,
    context: yes,
    wallClock: yes,
    outputTokensPerRequest: { value: 'no', why: 'not enforceable on this provider' },
  },
  hiddenModelCalls: { value: 'no', why: 'compaction and engine retries are off' },
  usageReporting: yes,
  effectiveModelReporting: yes,
  quotaReporting: { value: 'partial', why: 'response headers only' },
  authStatusWithoutSecret: yes,
  subscriptionModeAssertion: yes,
  systemPromptExact: yes,
  runtimePinning: yes,
  platforms: { darwin: yes, linux: yes, win32: { value: 'no', why: 'not supported' } },
  hints: { memoryPerAgentMb: 200, coldStartMs: 900, maxConcurrentAgents: 4 },
};
