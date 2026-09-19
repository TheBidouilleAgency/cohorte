// DESIGN 2.2.1 — the runtime, spec 5.1 VERBATIM, and how a host obtains one.
import type { AgentId, Clock, IdSource, JsonValue, RunId, SealedText } from '@cohorte/base';
import type { RuntimeCapabilities } from './capabilities.ts';
import type { RuntimeEvent } from './events.ts';
import type { ProviderAuthStatus, RuntimePin } from './pin.ts';
import type { RuntimeAgentHandle, RuntimeMessage, RuntimeSnapshot } from './session.ts';
import type { SpawnRequest } from './spawn.ts';
import type { ToolHost } from './tools.ts';

export const RUNTIME_CONTRACT_VERSION = '1';

export type Unsubscribe = () => void;

export interface AgentRuntime {
  /** 'pi' | 'fake' | a future engine */
  readonly id: string;
  /** "<adapter semver>+<engine>.<engine version>", e.g. "3.0.0+pi.0.85.1" */
  readonly version: string;
  capabilities(): RuntimeCapabilities;
  spawn(request: SpawnRequest): Promise<RuntimeAgentHandle>;
  send(agentId: string, message: RuntimeMessage): Promise<void>;
  cancel(agentId: string, reason?: string): Promise<void>;
  pause(agentId: string): Promise<void>;
  resume(agentId: string): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): Unsubscribe;
  inspect(agentId: string): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}

/** How a host obtains a runtime. Pinning (spec 16), auth status and login live HERE so the spec interface stays verbatim. */
export interface AgentRuntimeProvider {
  readonly id: string;
  /** identity of the runtime code as installed NOW; called once at run start */
  pin(): Promise<RuntimePin>;
  /** fails security/runtime-pin-mismatch if artifacts differ from `pin` */
  create(bindings: RuntimeHostBindings, pin: RuntimePin): Promise<AgentRuntime>;
  /** WITHOUT reading a token (spec 10.1) */
  authStatus(providers: string[]): Promise<ProviderAuthStatus[]>;
  /** operates on the ENGINE's credential store (R7) */
  login(provider: string, ui: LoginInteraction, signal: AbortSignal): Promise<ProviderAuthStatus>;
  logout(provider: string): Promise<void>;
}

/** implemented by the CLI; all text is sealed before it is shown or logged */
export interface LoginInteraction {
  show(
    event:
      | { kind: 'open-url'; url: string; instructions?: string }
      | { kind: 'device-code'; userCode: string; verificationUri: string }
      | { kind: 'info'; message: string },
  ): void;
  ask(
    prompt:
      | { kind: 'text' | 'secret' | 'manual-code'; message: string }
      | { kind: 'select'; message: string; options: { id: string; label: string }[] },
  ): Promise<string>;
}

export interface RuntimeHostBindings {
  /** rule C1 — and NOTHING that can execute */
  toolHost: ToolHost;
  /** absolute dir for transcript + wire log */
  stateDir: (runId: RunId, agentId: AgentId, incarnation: number) => string;
  clock: Clock;
  ids: IdSource;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: SealedText, fields?: Record<string, JsonValue>) => void;
}
