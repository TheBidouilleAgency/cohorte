// The scriptable, deterministic AgentRuntime of DESIGN 3.10: same contract as PiRuntime, in-process, and — because
// of rule C1 — every scripted tool call is answered by the host's REAL ToolHost.
import {
  type AgentId,
  type Clock,
  CohorteError,
  canonicalJson,
  errorOf,
  type JsonValue,
  type RunId,
  sha256Hex,
  systemClock,
} from '@cohorte/base';
import type { AgentRuntimeProvider, ProviderAuthStatus, RuntimePin, SpawnRequest } from '@cohorte/runtime-contract';
import { type FakeScript, fakeScriptSha256, validateFakeScript } from '../script/index.ts';
import type { FakeModelInput } from './agent.ts';
import { createFakeRuntime, FAKE_ADAPTER_VERSION, FAKE_RUNTIME_ID, type FakeRuntimeShared } from './runtime.ts';

export type { FakeModelInput, FakeModelInputMessage } from './agent.ts';
export { DEFAULT_RESULT_TOOL, HOST_NOTE_PREFIX } from './agent.ts';
export { FAKE_CAPABILITIES } from './capabilities.ts';
export { FAKE_ADAPTER_VERSION, FAKE_RUNTIME_ID, FAKE_RUNTIME_VERSION, FAKE_TRANSCRIPT_FORMAT } from './runtime.ts';

/** Every SpawnRequest the fake received, in order: a retry's request is byte-identical apart from `incarnation`. */
export interface FakeLedger {
  requests(): readonly SpawnRequest[];
  requestsOf(agentId: string): readonly SpawnRequest[];
}

/** The canonical JSON of a request WITHOUT `incarnation`: equal strings = the byte-identical retry of DESIGN 2.5. */
export function spawnRequestIdentity(request: SpawnRequest): string {
  const { incarnation: _incarnation, ...rest } = request;
  return canonicalJson(rest as unknown as JsonValue);
}

export interface FakeRuntimeProviderOptions {
  script: FakeScript;
  /**
   * The endpoint this fake "talks to". When set, a spawn pinned to any other `auth.baseUrl` is refused with
   * security/auth-endpoint-mismatch (conformance rule 11). When absent the fake has no endpoint of its own and
   * accepts the one its plan pinned; a `model-request` step can still REPORT another one.
   */
  baseUrl?: string;
  /** Only for `authStatus().checkedAt`, which is asked before any host bindings exist. Default: the system clock. */
  clock?: Clock;
}

export interface FakeRuntimeProvider extends AgentRuntimeProvider {
  readonly ledger: FakeLedger;
  /** Every model input recorded for that incarnation, oldest first: what the conformance `modelProbe` reads. */
  modelInputs(agent: { runId: RunId; agentId: AgentId; incarnation: number }): FakeModelInput[];
}

const SCRIPT_ENGINE = 'fake-script';

export function createFakeRuntimeProvider(options: FakeRuntimeProviderOptions): FakeRuntimeProvider {
  const validated = validateFakeScript(options.script);
  if (!validated.ok) throw new CohorteError(validated.error);
  // A private copy: the pin hashes it once, and no caller can change it under a running agent.
  const script = structuredClone(validated.value);
  const clock = options.clock ?? systemClock;
  const requests: SpawnRequest[] = [];
  const shared: FakeRuntimeShared = {
    script,
    baseUrl: options.baseUrl,
    inputs: new Map(),
    attempts: new Map(),
    record: (request) => void requests.push(structuredClone(request)),
  };

  const computePin = (): RuntimePin => {
    const body = {
      runtimeId: FAKE_RUNTIME_ID,
      adapterVersion: FAKE_ADAPTER_VERSION,
      // The fake has no engine package and no bundle: what decides its behaviour is the script, so that is what
      // the pin names. No artifact has a path to re-hash.
      engine: { name: SCRIPT_ENGINE, version: `sha256:${fakeScriptSha256(script)}` },
      node: { version: process.version, execPath: process.execPath },
      artifacts: [],
    };
    return { ...body, digest: sha256Hex(canonicalJson(body)) };
  };

  const status = (provider: string): ProviderAuthStatus => ({
    provider,
    state: 'absent',
    subscription: false,
    source: 'none',
    checkedAt: clock.now(),
    billing: 'unknown',
    caveat: 'The fake runtime holds no credential and calls no provider.',
  });

  return {
    id: FAKE_RUNTIME_ID,
    ledger: {
      requests: () => requests.map((request) => structuredClone(request)),
      requestsOf: (agentId) =>
        requests.filter((request) => request.agentId === agentId).map((request) => structuredClone(request)),
    },
    modelInputs: ({ runId, agentId, incarnation }) =>
      structuredClone(shared.inputs.get(`${runId}/${agentId}/${incarnation}`) ?? []),
    pin: async () => computePin(),
    async create(bindings, pin) {
      const now = computePin();
      if (pin.digest !== now.digest)
        throw new CohorteError(
          errorOf('security/runtime-pin-mismatch', 'the fake runtime script is not the one that was pinned', {
            details: { pinned: pin.digest, installed: now.digest },
          }),
        );
      return createFakeRuntime(bindings, shared);
    },
    authStatus: async (providers) => providers.map(status),
    async login(provider, ui) {
      ui.show({ kind: 'info', message: 'The fake runtime needs no login: it holds no credential.' });
      return status(provider);
    },
    async logout() {},
  };
}
