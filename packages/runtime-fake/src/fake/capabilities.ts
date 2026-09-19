import type { Cap, RuntimeCapabilities } from '@cohorte/runtime-contract';

const yes: Cap = { value: 'yes' };
const no = (why: string): Cap => ({ value: 'no', why });
const partial = (why: string): Cap => ({ value: 'partial', why });
const IN_PROCESS = 'the fake brain runs inside the host process: there is no agent process';

/** What an in-process, scripted brain can honestly promise. Frozen data; `capabilities()` hands out copies. */
export const FAKE_CAPABILITIES: RuntimeCapabilities = {
  contractVersion: '1',
  toolExecution: 'host-delegated',
  streaming: yes,
  thinkingStream: yes,
  send: {
    steer: partial('a message joins the conversation at the next scripted model request, never inside one'),
    followUp: yes,
  },
  cancelCooperative: yes,
  cancelHard: no(IN_PROCESS),
  pause: { toolBoundary: yes, modelBoundary: yes },
  continuationFromTranscript: no('the script decides what a later incarnation does; the transcript is never read back'),
  processIsolation: no(IN_PROCESS),
  envFiltering: no(IN_PROCESS),
  brainSandbox: no(IN_PROCESS),
  resourceLimits: no(IN_PROCESS),
  budgetEnforcement: {
    turns: yes,
    modelRequests: yes,
    tokens: partial('token counts are scripted; the ceilings are checked after each model response'),
    context: no('a script has no context window'),
    wallClock: partial('checked between steps on the injected clock; the fake arms no timer'),
    outputTokensPerRequest: no('a scripted response is never truncated'),
  },
  hiddenModelCalls: no('every model request is a scripted step'),
  usageReporting: yes,
  effectiveModelReporting: yes,
  quotaReporting: partial('only what a model-request step scripts'),
  authStatusWithoutSecret: yes,
  subscriptionModeAssertion: no(
    'the fake holds no credential: it reports the requested auth mode with authSource none',
  ),
  systemPromptExact: yes,
  runtimePinning: partial('the pin covers the script, not the installed code'),
  platforms: { darwin: yes, linux: yes, win32: yes },
  hints: { memoryPerAgentMb: 1, coldStartMs: 0, maxConcurrentAgents: 256 },
};
