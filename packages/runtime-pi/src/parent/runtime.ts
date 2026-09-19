// The parent side of PiRuntime: an `AgentRuntime` that imports NO engine (ADR-0001). It verifies what it is about to
// run (pin, prompt, task, note), builds the child's environment, and hands each incarnation to an `AgentSession`.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CohorteError, errorOf, type Sha256, sha256Hex } from '@cohorte/base';
import {
  type AgentRuntime,
  type IsolationReport,
  type RuntimeAgentHandle,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeHostBindings,
  type RuntimeMessage,
  type RuntimePin,
  type RuntimeSnapshot,
  type SpawnRequest,
  toolGrantProblems,
  type Unsubscribe,
} from '@cohorte/runtime-contract';
import { ADAPTER_VERSION, type PinVerifier, RUNTIME_ID } from '../pin/pin.ts';
import type { EngineSettings } from '../protocol.ts';
import { type ModelBoundaryMode, piCapabilities } from './capabilities.ts';
import { childEnv, fixedChildEnv } from './env.ts';
import { AgentSession, NONCE_ARG, type ParentTimings, type Sealer, type SpawnPlan } from './session.ts';
import type { TransportKind } from './transport.ts';

export const SESSION_FILE = 'session.jsonl';

/** What the engine makes of Cohorte's prompt: it appends ONE line (DESIGN 3.3; the date line is gone since 0.80.7). */
export const effectiveSystemPrompt = (prompt: string, workingDirectory: string): string =>
  `${prompt}\nCurrent working directory: ${workingDirectory}\n`;

export type SandboxWrap = (
  policy: SpawnRequest['sandbox'],
  command: { file: string; args: readonly string[] },
) => { file: string; args: string[]; isolation: IsolationReport } | null;

export interface PiRuntimeSettings {
  bindings: RuntimeHostBindings;
  pin: RuntimePin;
  verifier: PinVerifier;
  seal: Sealer;
  /** the child's entry: `<install>/dist/agent-host.mjs`, or the tests' override */
  entry: string;
  engine: Omit<EngineSettings, 'sessionFile'>;
  sandboxWrapper: SandboxWrap | undefined;
  transport: TransportKind;
  timings: ParentTimings;
  modelBoundary: ModelBoundaryMode;
  diagnostics: Readonly<Record<string, string>>;
}

const PROCESS_ISOLATION: IsolationReport = {
  level: 'process',
  filesystem: 'advisory',
  network: 'none',
  backend: 'none',
};

async function readVerified(what: string, ref: { path: string; sha256: Sha256; bytes: number }): Promise<string> {
  const mismatch = (detail: string): CohorteError =>
    new CohorteError(errorOf('security/asset-hash-mismatch', `${what} is not the file that was rendered: ${detail}`));
  const content = await readFile(ref.path).catch(() => undefined);
  if (!content) throw mismatch('it cannot be read');
  if (sha256Hex(content) !== ref.sha256) throw mismatch('its sha256 differs');
  if (content.byteLength !== ref.bytes) throw mismatch('its size differs');
  return content.toString('utf8');
}

export class PiRuntime implements AgentRuntime {
  readonly id = RUNTIME_ID;
  readonly version: string;
  readonly #settings: PiRuntimeSettings;
  readonly #capabilities: RuntimeCapabilities;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  /** `(runId, agentId, incarnation)` that ever reached a process: spawn is idempotent on it (spec 6). */
  readonly #incarnations = new Set<string>();
  readonly #starting = new Set<Promise<unknown>>();
  /** the latest incarnation of each agent, live or exited: what `send`/`cancel`/`pause`/`inspect` address */
  readonly #agents = new Map<string, AgentSession>();
  /**
   * EVERY incarnation that reached a process and has not ended yet. A second incarnation of one agent may be started
   * while the first is still live (the contract's `spawn` carries the number), and each child is its own detached
   * process group: without this set, `close()` would reach only the newest and leave the older one orphaned.
   */
  readonly #live = new Set<AgentSession>();
  #closed = false;

  constructor(settings: PiRuntimeSettings) {
    this.#settings = settings;
    this.version = `${ADAPTER_VERSION}+pi.${settings.pin.engine?.version ?? settings.engine.expectedEngineVersion}`;
    this.#capabilities = piCapabilities(settings.modelBoundary);
  }

  capabilities(): RuntimeCapabilities {
    return structuredClone(this.#capabilities);
  }

  subscribe(listener: (event: RuntimeEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  async spawn(request: SpawnRequest): Promise<RuntimeAgentHandle> {
    if (this.#closed) throw new CohorteError(errorOf('conflict/not-running', 'this runtime is closed'));
    const key = `${request.runId}\n${request.agentId}\n${request.incarnation}`;
    if (this.#incarnations.has(key))
      throw new CohorteError(
        errorOf(
          'conflict/incarnation-exists',
          `incarnation ${request.incarnation} of ${request.agentId} was already spawned`,
        ),
      );
    // Reserved before the first await: two concurrent spawns of one incarnation cannot both pass.
    this.#incarnations.add(key);
    let reachedAProcess = false;
    const starting = (async () => {
      const plan = await this.#plan(request);
      reachedAProcess = true;
      return AgentSession.start(this.#context(), plan);
    })();
    this.#starting.add(starting);
    try {
      const session = await starting;
      this.#live.add(session);
      void session.done.then(() => void this.#live.delete(session));
      this.#agents.set(request.agentId, session);
      return session.handle;
    } catch (thrown) {
      // Refused before anything ran (a hash, the pin, the env): the incarnation number was not used.
      if (!reachedAProcess) this.#incarnations.delete(key);
      throw thrown;
    } finally {
      this.#starting.delete(starting);
    }
  }

  async send(agentId: string, message: RuntimeMessage): Promise<void> {
    await this.#agent(agentId).send(message);
  }

  async cancel(agentId: string, reason = 'cancelled by the host'): Promise<void> {
    await this.#agent(agentId).cancel(reason);
  }

  pause(agentId: string): Promise<void> {
    this.#agent(agentId).pause();
    return Promise.resolve();
  }

  resume(agentId: string): Promise<void> {
    this.#agent(agentId).resume();
    return Promise.resolve();
  }

  inspect(agentId: string): Promise<RuntimeSnapshot> {
    return this.#agent(agentId).inspect();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#starting]);
    await Promise.all([...this.#live].map((session) => session.cancel('the runtime was closed')));
    this.#listeners.clear();
  }

  #agent(agentId: string): AgentSession {
    const session = this.#agents.get(agentId);
    if (!session) throw new CohorteError(errorOf('conflict/not-running', `no agent ${agentId} on this runtime`));
    return session;
  }

  #context() {
    const { bindings, seal, timings, transport, modelBoundary, diagnostics } = this.#settings;
    return {
      bindings,
      seal,
      timings,
      transport,
      modelBoundary,
      diagnostics,
      runtimeId: RUNTIME_ID,
      emit: (event: RuntimeEvent): void => {
        for (const listener of [...this.#listeners]) {
          try {
            listener(event);
          } catch (thrown) {
            bindings.log('error', seal.text(`a runtime event listener threw: ${String(thrown)}`), { type: event.type });
          }
        }
      },
    };
  }

  /** Everything that can refuse a spawn BEFORE a process exists. */
  async #plan(request: SpawnRequest): Promise<SpawnPlan> {
    const { bindings, verifier, pin, entry, engine, sandboxWrapper } = this.#settings;
    const problems = toolGrantProblems(request.tools);
    if (problems.length > 0) throw new CohorteError(errorOf('validation/unexpected', problems.join('; ')));
    await verifier.verify(pin);

    const prompt = await readVerified('the system prompt', request.systemPrompt);
    const taskText = await readVerified('the task', request.task);
    const noteText = request.continuation
      ? await readVerified('the continuation note', request.continuation.note)
      : undefined;

    const stateDir = bindings.stateDir(request.runId, request.agentId, request.incarnation);
    await mkdir(stateDir, { recursive: true });
    // DESIGN 3.7 layer 2: the engine's agent dir is Cohorte-owned and 0700. It is created HERE, before the child is
    // pointed at it, so that the engine never creates it itself with the umask's permissions.
    await mkdir(engine.agentDir, { recursive: true, mode: 0o700 });
    const { env, attested } = childEnv(
      request.sandbox.env,
      fixedChildEnv(engine.agentDir, request.sandbox.limits.maxOldSpaceMb),
    );

    const nonce = randomBytes(16).toString('hex');
    const bare = { file: pin.node.execPath, args: [entry, `${NONCE_ARG}${nonce}`] };
    const wrapped = sandboxWrapper?.(request.sandbox, bare) ?? null;
    if (!wrapped && request.sandbox.require === 'os')
      throw new CohorteError(
        errorOf(
          'security/sandbox-unavailable',
          'the request requires an OS sandbox around the agent process and no backend is available',
        ),
      );
    return {
      request,
      stateDir,
      command: wrapped ? { file: wrapped.file, args: wrapped.args } : bare,
      nonce,
      env,
      attestedRequest: { ...request, sandbox: { ...request.sandbox, env: attested } },
      engine: { ...engine, sessionFile: join(stateDir, SESSION_FILE) },
      expectedEffectivePromptSha256: sha256Hex(effectiveSystemPrompt(prompt, request.workingDirectory)),
      isolation: wrapped?.isolation ?? PROCESS_ISOLATION,
      taskText,
      noteText,
    };
  }
}
