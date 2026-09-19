// DESIGN 3.9 — what PiRuntime reports for Pi 0.85.1 in this embedding. `doctor` prints these values verbatim.
import type { Cap, RuntimeCapabilities } from '@cohorte/runtime-contract';

const yes: Cap = { value: 'yes' };
const no = (why: string): Cap => ({ value: 'no', why });
const partial = (why: string): Cap => ({ value: 'partial', why });

/** 'park' only once assumption A-1 is proven by its tripwire; until then the executed fallback (DESIGN 3.5). */
export type ModelBoundaryMode = 'stop-after-turn' | 'park';

function brainSandbox(platform: string): Cap {
  if (platform === 'darwin') return partial('Seatbelt, port-level network filter, deprecated tool');
  if (platform === 'linux') return partial('bwrap read-only bind; probe pending');
  return no('no sandbox backend on this platform');
}

export function piCapabilities(
  modelBoundary: ModelBoundaryMode,
  platform: string = process.platform,
): RuntimeCapabilities {
  const a1 = (fallback: string): Cap => (modelBoundary === 'park' ? yes : partial(fallback));
  return {
    contractVersion: '1',
    toolExecution: 'host-delegated',
    streaming: yes,
    thinkingStream: yes,
    send: { steer: yes, followUp: yes },
    cancelCooperative: yes,
    cancelHard: yes,
    pause: { toolBoundary: yes, modelBoundary: a1('stop-after-turn + continue note') },
    continuationFromTranscript: no('V3.0 resumes with a fresh incarnation and a reconciliation note'),
    processIsolation: yes,
    envFiltering: yes,
    brainSandbox: brainSandbox(platform),
    resourceLimits: partial('--max-old-space-size only'),
    budgetEnforcement: {
      turns: yes,
      modelRequests: a1('parent-side count + abort'),
      tokens: yes,
      context: a1('parent-side count + abort'),
      wallClock: yes,
      outputTokensPerRequest: no('ignored on openai-codex'),
    },
    hiddenModelCalls: no('compaction, agent retry and provider retries are off'),
    usageReporting: yes,
    effectiveModelReporting: yes,
    quotaReporting: partial(
      'HTTP status + allowlisted headers, SSE transport, openai-codex-responses only; header names provider-specific; no remaining-quota API in Pi',
    ),
    authStatusWithoutSecret: partial(
      'state, type, source and billing without a secret; the non-secret account label is not exposed by the engine: Pi 0.85.1 has no metadata-only accessor, D-24',
    ),
    subscriptionModeAssertion: yes,
    systemPromptExact: partial(
      'Pi appends one `Current working directory` line, recorded as effectiveSystemPromptSha256; under Anthropic OAuth pi-ai injects an identity block',
    ),
    runtimePinning: partial('agent-host bundle + Pi package trees hashed; transitive deps by lock evidence'),
    platforms: { darwin: yes, linux: yes, win32: no('kill-tree, sandbox and worktree path limits unvalidated') },
    hints: { memoryPerAgentMb: 200, coldStartMs: 330, maxConcurrentAgents: 3 },
  };
}
