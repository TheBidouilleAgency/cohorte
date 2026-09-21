// The three auth modes of the child (DESIGN 3.3): status, login, logout, all on the ENGINE's credential store (R7).
// This side never sees a token: statuses are secret-free by schema, every text is sealed, and the child's stdout and
// stderr go line by line through the SAME sealed logger as an agent's (DESIGN 3.2, I7) — login is exactly the path
// where the engine prints refresh or login error bodies that hold token material. `AgentRuntimeProvider.login` /
// `authStatus` / `logout` get no `RuntimeHostBindings`, so the log port is an option of the provider and the pipes are
// drained (and dropped) when the composition root binds none (docs/v3/requests/U1.07.md R1).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { CohorteError, type ErrorInfo, errorOf, type JsonValue, toErrorInfo } from '@cohorte/base';
import type { LoginInteraction, ProviderAuthStatus, RuntimeHostBindings } from '@cohorte/runtime-contract';
import { processExitError, protocolViolation } from '../classify/host.ts';
import { classify } from '../classify/index.ts';
import type { ChildFrame, ParentFrame } from '../protocol.ts';
import { childEnv, fixedChildEnv } from './env.ts';
import { drainChildOutput, newOutputBudget } from './output.ts';
import { NONCE_ARG, type ParentTimings, type Sealer } from './session.ts';
import { stdioFor, type TransportKind, transportFor } from './transport.ts';

export interface AuthChildSettings {
  node: string;
  entry: string;
  engine: { authPath: string; agentDir: string };
  timings: ParentTimings;
  transport: TransportKind;
  seal: Sealer;
  /** where the child's stdout and stderr go, sealed. Absent: the pipes are drained and dropped. */
  log?: RuntimeHostBindings['log'];
}

const AUTH_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];

type Step<T> = { done: T } | { reply: ParentFrame } | undefined;

async function exchange<T>(
  settings: AuthChildSettings,
  init: (nonce: string) => ParentFrame,
  onFrame: (frame: ChildFrame) => Step<T> | Promise<Step<T>>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { engine, seal, timings } = settings;
  await mkdir(engine.agentDir, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString('hex');
  const { env } = childEnv({ allow: AUTH_ENV_ALLOW, set: {} }, fixedChildEnv(engine.agentDir, undefined));
  const child = spawn(settings.node, [settings.entry, `${NONCE_ARG}${nonce}`], {
    cwd: engine.agentDir,
    env,
    stdio: stdioFor(settings.transport),
    serialization: 'json',
    detached: true,
  });
  const budget = newOutputBudget();
  const write = (line: string, stream: 'stdout' | 'stderr'): void =>
    settings.log?.(stream === 'stderr' ? 'warn' : 'info', seal.text(line), { stream, source: 'auth-child' });
  // Attached whether or not a log port is bound: an undrained pipe would block the child (DESIGN 3.2).
  if (child.stdout) drainChildOutput(child.stdout, 'stdout', budget, write);
  if (child.stderr) drainChildOutput(child.stderr, 'stderr', budget, write);
  const transport = transportFor(settings.transport, child);
  const sealedError = (info: ErrorInfo): ErrorInfo =>
    toErrorInfo(new CohorteError(seal.json(info as unknown as JsonValue) as unknown as ErrorInfo), {
      code: 'configuration/engine-init',
      class: 'configuration',
    });

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      const fail = (info: ErrorInfo): void => reject(new CohorteError(info));
      let greeted = false;
      timer = setTimeout(
        () => fail(protocolViolation('handshake-timeout', 'the auth child did not answer in time')),
        options.timeoutMs ?? timings.helloMs,
      );
      options.signal?.addEventListener('abort', () => fail(errorOf('tool-transient/cancelled', 'cancelled')), {
        once: true,
      });
      child.once('error', (error) => fail(processExitError('spawn-failed', error.name)));
      transport.onClose(() => fail(processExitError('exit-without-settled')));
      transport.onFrame((decoded) => {
        if (!decoded.ok)
          return fail(protocolViolation('frame-schema', `${decoded.error.reason}: ${decoded.error.detail}`));
        const frame = decoded.value;
        if (frame.t === 'heartbeat') return;
        if (frame.t === 'fatal')
          return fail(
            frame.signal ? classify({ ...frame.signal, text: seal.text(frame.signal.text) }) : sealedError(frame.error),
          );
        if (!greeted) {
          if (frame.t !== 'hello' || frame.nonce !== nonce)
            return fail(protocolViolation('nonce-mismatch', 'the first frame is not the hello of this spawn'));
          greeted = true;
          if (options.timeoutMs === undefined) clearTimeout(timer);
          void transport.send(init(nonce));
          return;
        }
        void Promise.resolve(onFrame(frame)).then((step) => {
          if (step && 'done' in step) resolve(step.done);
          else if (step) void transport.send(step.reply);
        }, reject);
      });
    });
  } finally {
    clearTimeout(timer);
    void transport.send({ t: 'shutdown' });
    const pid = child.pid;
    const goneWithin = (ms: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve(true);
        const timer = setTimeout(() => resolve(false), ms);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, signal);
      } catch {
        // The leader or its process group already exited.
      }
    };

    // Auth providers may leave a localhost callback server behind after a failed login. Reap the
    // detached process group, not only the leader, so a later provider login cannot hit EADDRINUSE.
    if (!(await goneWithin(timings.exitGraceMs))) {
      signalGroup('SIGTERM');
      if (!(await goneWithin(timings.termGraceMs))) signalGroup('SIGKILL');
    }
    transport.close();
  }
}

const unexpected = (frame: ChildFrame): never => {
  throw new CohorteError(protocolViolation('unexpected-frame', `'${frame.t}' in an auth exchange`));
};

export function authStatus(settings: AuthChildSettings, providers: string[]): Promise<ProviderAuthStatus[]> {
  const { authPath, agentDir } = settings.engine;
  return exchange<ProviderAuthStatus[]>(
    settings,
    (nonce) => ({ t: 'init', v: 1, nonce, mode: 'auth-status', providers, engine: { authPath, agentDir } }),
    (frame) => (frame.t === 'auth.status' ? { done: settings.seal.json(frame.statuses) } : unexpected(frame)),
    { timeoutMs: settings.timings.readyMs },
  );
}

type ShowEvent = Parameters<LoginInteraction['show']>[0];
type AskPrompt = Parameters<LoginInteraction['ask']>[0];
const isRecord = (value: JsonValue): value is { [member: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '');

function showEvent(raw: JsonValue): ShowEvent {
  if (isRecord(raw) && raw.kind === 'open-url') {
    const instructions = text(raw.instructions);
    return { kind: 'open-url', url: text(raw.url), ...(instructions ? { instructions } : {}) };
  }
  if (isRecord(raw) && raw.kind === 'device-code')
    return { kind: 'device-code', userCode: text(raw.userCode), verificationUri: text(raw.verificationUri) };
  return { kind: 'info', message: isRecord(raw) ? text(raw.message) : '' };
}

function askPrompt(raw: JsonValue): AskPrompt {
  const message = isRecord(raw) ? text(raw.message) : '';
  if (isRecord(raw) && raw.kind === 'select' && Array.isArray(raw.options))
    return {
      kind: 'select',
      message,
      options: raw.options.filter(isRecord).map((option) => ({ id: text(option.id), label: text(option.label) })),
    };
  const kind = isRecord(raw) && (raw.kind === 'secret' || raw.kind === 'manual-code') ? raw.kind : 'text';
  return { kind, message };
}

export function authLogin(
  settings: AuthChildSettings,
  provider: string,
  ui: LoginInteraction,
  signal: AbortSignal,
): Promise<ProviderAuthStatus> {
  const { authPath, agentDir } = settings.engine;
  return exchange<ProviderAuthStatus>(
    settings,
    (nonce) => ({ t: 'init', v: 1, nonce, mode: 'auth-login', provider, engine: { authPath, agentDir } }),
    async (frame) => {
      if (frame.t === 'auth.show') {
        ui.show(showEvent(settings.seal.json(frame.event)));
        return undefined;
      }
      if (frame.t === 'auth.ask') {
        const value = await ui.ask(askPrompt(settings.seal.json(frame.prompt)));
        return { reply: { t: 'auth.answer', id: frame.id, value } };
      }
      return frame.t === 'auth.done' ? { done: settings.seal.json(frame.status) } : unexpected(frame);
    },
    { signal },
  );
}

export async function authLogout(settings: AuthChildSettings, provider: string): Promise<void> {
  const { authPath, agentDir } = settings.engine;
  await exchange<true>(
    settings,
    (nonce) => ({ t: 'init', v: 1, nonce, mode: 'auth-logout', provider, engine: { authPath, agentDir } }),
    (frame) => (frame.t === 'auth.done' ? { done: true } : unexpected(frame)),
    { timeoutMs: settings.timings.readyMs },
  );
}
