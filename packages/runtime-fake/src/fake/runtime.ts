import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CohorteError, errorOf, sha256Hex } from '@cohorte/base';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeHostBindings,
  RuntimeSessionRef,
  SpawnRequest,
  TaskInput,
} from '@cohorte/runtime-contract';
import { type FakeScript, matchFakeRule } from '../script/index.ts';
import { FakeAgent, type FakeModelInput } from './agent.ts';
import { FAKE_CAPABILITIES } from './capabilities.ts';

export const FAKE_RUNTIME_ID = 'fake';
export const FAKE_ADAPTER_VERSION = '3.0.0';
/** "<adapter semver>+<engine>.<engine version>" (DESIGN 2.2.1); the engine is the step interpreter, version 1. */
export const FAKE_RUNTIME_VERSION = `${FAKE_ADAPTER_VERSION}+fake.1`;
export const FAKE_TRANSCRIPT_FORMAT = 'fake-ndjson-v1';

/** What outlives one runtime: the provider's ledger, its model probe and the attempts it has seen. */
export interface FakeRuntimeShared {
  script: FakeScript;
  baseUrl: string | undefined;
  inputs: Map<string, FakeModelInput[]>;
  /** `<runId>/<agentId>` -> attempts opened so far (a spawn without `continuation` opens one). */
  attempts: Map<string, number>;
  record(request: SpawnRequest): void;
}

const keyOf = (request: Pick<SpawnRequest, 'runId' | 'agentId' | 'incarnation'>): string =>
  `${request.runId}/${request.agentId}/${request.incarnation}`;

function readVerified(ref: TaskInput, what: string): string {
  let text: string;
  try {
    text = readFileSync(ref.path, 'utf8');
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new CohorteError(errorOf('security/asset-hash-mismatch', `${what} ${ref.path} cannot be read: ${reason}`));
  }
  if (sha256Hex(text) !== ref.sha256)
    throw new CohorteError(
      errorOf('security/asset-hash-mismatch', `the content of ${what} ${ref.path} does not match its reference`),
    );
  return text;
}

export function createFakeRuntime(bindings: RuntimeHostBindings, shared: FakeRuntimeShared): AgentRuntime {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const agents = new Map<string, FakeAgent>();
  const exits: Promise<unknown>[] = [];
  let closed = false;

  const publish = (event: RuntimeEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber's bug is not the agent's: the event was emitted, the others still get it.
      }
    }
  };

  const latest = (agentId: string): FakeAgent => {
    const found = [...agents.values()].findLast((agent) => agent.request.agentId === agentId);
    if (!found) throw new CohorteError(errorOf('validation/unexpected', `the fake runtime has no agent ${agentId}`));
    return found;
  };

  return {
    id: FAKE_RUNTIME_ID,
    version: FAKE_RUNTIME_VERSION,
    capabilities: () => structuredClone(FAKE_CAPABILITIES),

    async spawn(request) {
      shared.record(request);
      if (closed) throw new CohorteError(errorOf('conflict/unexpected', 'the fake runtime is closed'));
      const key = keyOf(request);
      if (agents.has(key)) throw new CohorteError(errorOf('conflict/incarnation-exists', `${key} was already spawned`));

      const attemptKey = `${request.runId}/${request.agentId}`;
      const opened = shared.attempts.get(attemptKey) ?? 0;
      const attempt = Math.max(1, request.continuation === null ? opened + 1 : opened);
      const { role, agentId, incarnation } = request;
      const rule = matchFakeRule(shared.script, { role, agentId, incarnation, attempt });
      if (!rule)
        throw new CohorteError(
          errorOf('configuration/fake-script-unmatched', `no script rule matches the spawn of ${agentId}`, {
            details: { role, agentId, incarnation, attempt },
          }),
        );
      if (shared.baseUrl !== undefined && request.auth.baseUrl !== shared.baseUrl)
        throw new CohorteError(
          errorOf(
            'security/auth-endpoint-mismatch',
            `the request is pinned to ${request.auth.baseUrl}, this fake runtime answers for ${shared.baseUrl}`,
          ),
        );
      const texts = {
        systemPrompt: readVerified(request.systemPrompt, 'system prompt'),
        task: readVerified(request.task, 'task'),
        note: request.continuation ? readVerified(request.continuation.note, 'continuation note') : null,
      };

      const stateDir = bindings.stateDir(request.runId, agentId, incarnation);
      const session: RuntimeSessionRef = {
        runtime: FAKE_RUNTIME_ID,
        engineVersion: FAKE_RUNTIME_VERSION,
        sessionId: bindings.ids.next<'SessionId'>('ses'),
        transcript: { path: join(stateDir, 'transcript.ndjson'), format: FAKE_TRANSCRIPT_FORMAT },
      };
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(session.transcript.path, '', 'utf8');
      } catch (thrown) {
        const reason = thrown instanceof Error ? thrown.message : String(thrown);
        throw new CohorteError(errorOf('configuration/engine-init', `the transcript cannot be created: ${reason}`));
      }

      const inputs: FakeModelInput[] = [];
      shared.inputs.set(key, inputs);
      shared.attempts.set(attemptKey, attempt);
      // A private copy: the agent keeps reading its request long after the caller got its handle back.
      const owned = structuredClone(request);
      const agent = new FakeAgent({
        request: owned,
        rule,
        defaults: shared.script.defaults,
        texts,
        session,
        bindings,
        publish,
        inputs,
      });
      agents.set(key, agent);
      agent.emitSpawned();
      // A microtask hop, not a timer: the caller holds its handle before the first model request.
      const exit = Promise.resolve().then(() => agent.run());
      exits.push(exit);
      return {
        runId: owned.runId,
        agentId: owned.agentId,
        incarnation,
        session,
        startedAt: bindings.clock.now(),
        process: null,
        exit,
      };
    },

    async send(agentId, message) {
      const agent = latest(agentId);
      if (agent.exited)
        throw new CohorteError(errorOf('conflict/unexpected', `agent ${agentId} has exited: nobody reads a message`));
      agent.accept(message);
    },

    // cancel, pause and resume race with the exit by nature: on an agent that is gone they do nothing.
    async cancel(agentId) {
      latest(agentId).cancel();
    },
    async pause(agentId) {
      latest(agentId).pause();
    },
    async resume(agentId) {
      latest(agentId).resume();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    inspect: async (agentId) => latest(agentId).snapshot(),

    async close() {
      closed = true;
      for (const agent of agents.values()) agent.cancel();
      await Promise.all(exits);
    },
  };
}
