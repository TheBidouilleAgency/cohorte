// `createPiRuntimeProvider` — how a host obtains PiRuntime (DESIGN 2.2.1, 3.2). This side imports NO engine: the
// engine lives in the per-agent child, reached through AgentHostProtocol only.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CohorteError, errorOf, type JsonValue, type Redactor } from '@cohorte/base';
import type {
  AgentRuntimeProvider,
  IsolationReport,
  RuntimeHostBindings,
  SandboxPolicy,
} from '@cohorte/runtime-contract';
import { createPinVerifier, type PinOptions, pinWithDiagnostics } from '../pin/pin.ts';
import { authLogin, authLogout, authStatus } from './auth.ts';
import type { ModelBoundaryMode } from './capabilities.ts';

import { AGENT_HOST_ENTRY, PI_ENGINE_VERSION, RESPONSE_HEADER_ALLOWLIST } from './defaults.ts';
import { PiRuntime } from './runtime.ts';
import { DEFAULT_TIMINGS, type ParentTimings, type Sealer } from './session.ts';
import type { TransportKind } from './transport.ts';

export type { ModelBoundaryMode } from './capabilities.ts';
export type { ParentTimings } from './session.ts';
export type { FrameTransport, TransportKind } from './transport.ts';

export interface BrainCommand {
  file: string;
  args: readonly string[];
}

/**
 * Wraps the child's command line in an OS sandbox (DESIGN 3.6) and says what that enforces; `null` = no backend on
 * this machine, and the parent then applies `SandboxPolicy.require`. Pure. Injected by the composition root: this
 * package may not import `security`.
 */
export type SandboxWrapper = (
  policy: SandboxPolicy,
  command: BrainCommand,
) => { file: string; args: string[]; isolation: IsolationReport } | null;

export interface PiEngineOptions {
  /** the ENGINE's credential store, shared with the user's own login (R7). Never read by this side. */
  authPath: string;
  /** Cohorte-owned, no models.json, no settings, no extensions (DESIGN 3.7 layer 2) */
  agentDir: string;
  loadFrom: 'package' | 'bundle';
  expectedEngineVersion: string;
  responseHeaderAllowlist: string[];
}

export interface PiRuntimeProviderOptions {
  /** TESTS ONLY: another child entry than the pinned one (the fake brain). `apps/cli` never passes it. */
  entryOverride?: string;
  sandboxWrapper?: SandboxWrapper;
  /**
   * Seals every text that comes out of the child before it becomes an event, an error or a log line (I7). Injected
   * by the composition root (this package may not import `security`); `create()` refuses to run without it.
   */
  redactor?: Pick<Redactor, 'sealText' | 'sealJson'>;
  /** the install whose `dist/` holds `agent-host.mjs`. Default: the directory above the running bundle. */
  installDir?: string;
  engine?: Partial<PiEngineOptions>;
  /** 'ipc' (default, what the spike executed) or LF-delimited JSON over fd 3/4 */
  transport?: TransportKind;
  /** 'park' only once assumption A-1 is proven; default: the executed `stop-after-turn` fallback */
  modelBoundary?: ModelBoundaryMode;
  timings?: Partial<ParentTimings>;
  /**
   * Where the AUTH child's stdout and stderr go, sealed (DESIGN 3.2: the engine prints login and refresh error bodies
   * that can hold token material). An agent's output uses `RuntimeHostBindings.log`, which `create()` receives;
   * `authStatus`/`login`/`logout` receive no bindings, so the host binds the port once, here. Absent: drained and
   * dropped, as before (docs/v3/requests/U1.07.md R1).
   */
  log?: RuntimeHostBindings['log'];
}

export function createPiRuntimeProvider(options: PiRuntimeProviderOptions = {}): AgentRuntimeProvider {
  const installDir = options.installDir ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const engine: PiEngineOptions = {
    authPath: join(homedir(), '.pi', 'agent', 'auth.json'),
    agentDir: join(homedir(), '.cohorte', 'pi-agent'),
    loadFrom: 'package',
    expectedEngineVersion: PI_ENGINE_VERSION,
    responseHeaderAllowlist: [...RESPONSE_HEADER_ALLOWLIST],
    ...options.engine,
  };
  const pinOptions: PinOptions = {
    installDir,
    loadFrom: engine.loadFrom,
    ...(options.entryOverride === undefined ? {} : { entryOverride: options.entryOverride }),
  };
  const entry = options.entryOverride ?? join(installDir, AGENT_HOST_ENTRY);
  const timings = { ...DEFAULT_TIMINGS, ...options.timings };
  const transport = options.transport ?? 'ipc';

  const sealer = (): Sealer => {
    const { redactor } = options;
    if (!redactor)
      throw new CohorteError(
        errorOf(
          'configuration/engine-init',
          'no redactor is bound to the runtime provider: child output cannot be sealed',
        ),
      );
    return {
      text: (text) => redactor.sealText(text).text,
      json: <T extends JsonValue>(value: T): T => redactor.sealJson(value).value,
    };
  };
  const authChild = () => ({
    node: process.execPath,
    entry,
    engine,
    timings,
    transport,
    seal: sealer(),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  return {
    id: 'pi',
    async pin() {
      const { pin: value } = await pinWithDiagnostics(pinOptions);
      return value;
    },
    async create(bindings, pinned) {
      const seal = sealer();
      const verifier = createPinVerifier(pinOptions);
      await verifier.verify(pinned);
      const { diagnostics } = await pinWithDiagnostics(pinOptions);
      if (diagnostics.installLock?.startsWith('absent'))
        bindings.log(
          'warn',
          seal.text(`runtime pin: no install lock evidence (${diagnostics.installLock})`),
          diagnostics,
        );
      return new PiRuntime({
        bindings,
        pin: pinned,
        verifier,
        seal,
        entry,
        engine: pinned.engine ? { ...engine, expectedEngineVersion: pinned.engine.version } : engine,
        sandboxWrapper: options.sandboxWrapper,
        transport,
        timings,
        modelBoundary: options.modelBoundary ?? 'stop-after-turn',
        diagnostics,
      });
    },
    authStatus: (providers) => authStatus(authChild(), providers),
    login: (provider, ui, signal) => authLogin(authChild(), provider, ui, signal),
    logout: (provider) => authLogout(authChild(), provider),
  };
}
