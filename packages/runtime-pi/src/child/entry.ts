#!/usr/bin/env node
// packages/runtime-pi/src/child/entry.ts — DESIGN 1.4 step 3's "agent-host" bundle entry, and the packaging-path
// deliverable of PLAN U0.10 ("--selftest imports the three Pi packages, asserts equal versions, prints the Pi
// version"). This file, and no other outside `packages/runtime-pi/src/child/**`, may import `@earendil-works/*`
// (layers.json rule b) — this file is the Cohorte RPC child (DESIGN §9 "runRpcMode host variant").
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { errorOf, type IsoInstant, type JsonValue, sha256Hex } from '@cohorte/base';
import type { ProviderAuthStatus } from '@cohorte/runtime-contract';
import { CONTINUATION_NOTE_SEPARATOR } from '@cohorte/runtime-contract';
import {
  type ChildFrame,
  decodeFrame,
  type ErrorSignal,
  encodeFrame,
  type HostEvent,
  type ParentFrame,
} from '../protocol.ts';
import {
  type AuthEvent,
  type AuthPrompt,
  createAgentSession,
  DefaultResourceLoader,
  lazyStream,
  ModelRuntime,
  ModelsError,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type TSchema,
  Type,
} from './load-pi.ts';

const PI_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-coding-agent',
] as const;

function piPackageVersion(name: (typeof PI_PACKAGES)[number]): string {
  const path = findPackageJSON(name, import.meta.url);
  if (!path) throw new Error(`agent-host: cannot locate an installed package.json for ${name}`);
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error(`agent-host: ${name}'s package.json has no "version"`);
  return pkg.version;
}

export interface SelfTestResult {
  readonly versions: Readonly<Record<string, string>>;
  readonly version: string;
}

/** F-6: `pnpm-workspace.yaml` pins the three packages to one exact version so pnpm never installs two copies of
 * `pi-ai` (which would break `instanceof ModelsError`); this is the runtime side of that invariant. */
export function selfTest(): SelfTestResult {
  const entries = PI_PACKAGES.map((name) => [name, piPackageVersion(name)] as const);
  const versions: Record<string, string> = Object.fromEntries(entries);
  const distinct = new Set(entries.map(([, version]) => version));
  if (distinct.size !== 1) {
    throw new Error(`agent-host: Pi package versions disagree: ${JSON.stringify(versions)}`);
  }
  const [version] = distinct;
  if (!version) throw new Error('agent-host: no Pi package version found');
  return { versions, version };
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    const result = selfTest();
    process.stdout.write(`agent-host selftest ok, pi=${result.version}\n`);
    return;
  }
  await runHost();
}

type Send = (frame: ChildFrame) => void;

function nonceArg(): string {
  const value = process.argv.find((arg) => arg.startsWith('--cohorte-nonce='));
  if (!value) throw new Error('agent-host: missing Cohorte nonce');
  return value.slice('--cohorte-nonce='.length);
}

function sendTransport(): { send: Send; on: (listener: (frame: ParentFrame) => void) => void } {
  if (typeof process.send === 'function') {
    return {
      send: (frame) => process.send?.(encodeFrame(frame, 'ipc') as object),
      on: (listener) =>
        process.on('message', (raw) => {
          const decoded = decodeFrame('parent', raw, 'ipc');
          if (decoded.ok) listener(decoded.value);
        }),
    };
  }
  const input = createReadStream(null as never, { fd: 3 });
  const output = createWriteStream(null as never, { fd: 4 });
  let buffer = '';
  return {
    send: (frame) => output.write(encodeFrame(frame, 'lf')),
    on: (listener) => {
      input.setEncoding('utf8');
      input.on('data', (chunk: string | Buffer) => {
        buffer += chunk.toString();
        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const decoded = decodeFrame('parent', line, 'lf');
          if (decoded.ok) listener(decoded.value);
        }
      });
    },
  };
}

const isoNow = (): IsoInstant => new Date().toISOString() as IsoInstant;

function authStatus(runtime: ModelRuntime, provider: string): ProviderAuthStatus {
  const status = runtime.getProviderAuthStatus(provider);
  const configured = status.configured;
  const oauth = configured && runtime.isUsingOAuth(provider);
  const subscription = oauth && runtime.isUsingSubscription(provider);
  return {
    provider,
    state: !configured ? 'absent' : oauth ? 'oauth' : 'api-key',
    subscription,
    checkedAt: isoNow(),
    ...(status.source || status.label ? { source: status.label ?? status.source } : {}),
    billing: subscription ? 'plan-limits' : configured ? 'metered' : 'unknown',
  };
}

function jsonEvent(event: AuthEvent): JsonValue {
  if (event.type === 'auth_url')
    return { kind: 'open-url', url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) };
  if (event.type === 'device_code')
    return { kind: 'device-code', userCode: event.userCode, verificationUri: event.verificationUri };
  return { kind: event.type === 'progress' ? 'progress' : 'info', message: event.message };
}

function jsonPrompt(prompt: AuthPrompt): JsonValue {
  if (prompt.type === 'select')
    return {
      kind: 'select',
      message: prompt.message,
      options: prompt.options.map((item) => ({ id: item.id, label: item.label })),
    };
  return {
    kind: prompt.type === 'manual_code' ? 'manual-code' : prompt.type === 'text' ? 'text' : 'secret',
    message: prompt.message,
  };
}

function signalOf(error: unknown, origin: ErrorSignal['origin']): ErrorSignal {
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
  const modelsErrorCode =
    error instanceof ModelsError ? error.code : typeof value.code === 'string' ? value.code : undefined;
  const status =
    typeof value.status === 'number'
      ? value.status
      : typeof value.statusCode === 'number'
        ? value.statusCode
        : undefined;
  let cause: unknown = value.cause;
  let causeCode: string | undefined;
  for (let depth = 0; depth < 8 && cause !== undefined; depth += 1) {
    const candidate = cause as { code?: unknown; cause?: unknown };
    if (causeCode === undefined && typeof candidate.code === 'string') causeCode = candidate.code;
    cause = candidate.cause;
  }
  const text =
    error instanceof Error ? error.message : typeof value.message === 'string' ? value.message : String(error);
  return {
    ...(modelsErrorCode === undefined ? {} : { modelsErrorCode }),
    ...(causeCode === undefined ? {} : { causeCode }),
    ...(status === undefined ? {} : { httpStatus: status }),
    text,
    origin,
  };
}

async function runHost(): Promise<void> {
  const nonce = nonceArg();
  const transport = sendTransport();
  const send: Send = (frame) => transport.send(frame);
  send({ t: 'hello', v: 1, pid: process.pid, nonce });
  let runtime: ModelRuntime | undefined;
  const answerWaiters = new Map<string, (value: string) => void>();
  const toolWaiters = new Map<string, (frame: Extract<ParentFrame, { t: 'tool.result' }>) => void>();
  let agentListener: ((frame: ParentFrame) => void) | undefined;
  const shutdownController = new AbortController();
  transport.on((frame) => {
    if (frame.t === 'auth.answer') {
      const waiter = answerWaiters.get(frame.id);
      answerWaiters.delete(frame.id);
      waiter?.(frame.value);
    }
    if (frame.t === 'tool.result') toolWaiters.get(frame.toolCallId)?.(frame);
    if (agentListener && frame.t !== 'init' && frame.t !== 'auth.answer' && frame.t !== 'tool.result') {
      agentListener(frame);
      return;
    }
    if (frame.t === 'shutdown') {
      shutdownController.abort();
      process.exitCode = 0;
    }
    if (frame.t === 'init')
      void handleInit(
        frame,
        send,
        (value) => {
          runtime = value;
        },
        () => runtime,
        answerWaiters,
        toolWaiters,
        (listener) => {
          agentListener = listener;
        },
        shutdownController.signal,
      );
  });
}

async function handleInit(
  frame: Extract<ParentFrame, { t: 'init' }>,
  send: Send,
  setRuntime: (runtime: ModelRuntime) => void,
  getRuntime: () => ModelRuntime | undefined,
  answerWaiters: Map<string, (value: string) => void>,
  toolWaiters: Map<string, (frame: Extract<ParentFrame, { t: 'tool.result' }>) => void>,
  setAgentListener: (listener: (frame: ParentFrame) => void) => void,
  shutdownSignal: AbortSignal,
): Promise<void> {
  try {
    if (frame.mode === 'agent') {
      await runAgent(frame, send, toolWaiters, setAgentListener);
      return;
    }
    const runtime =
      getRuntime() ??
      (await ModelRuntime.create({
        authPath: frame.engine.authPath,
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: true,
      }));
    setRuntime(runtime);
    if (frame.mode === 'auth-status') {
      send({ t: 'auth.status', statuses: frame.providers.map((provider) => authStatus(runtime, provider)) });
      return;
    }
    if (frame.mode === 'auth-logout') {
      await runtime.logout(frame.provider);
      send({ t: 'auth.done', status: authStatus(runtime, frame.provider) });
      return;
    }
    const provider = frame.provider;
    const providerDefinition = runtime.getProvider(provider);
    const authType = providerDefinition?.auth.oauth ? 'oauth' : 'api_key';
    const status = await runtime.login(provider, authType, {
      signal: shutdownSignal,
      notify: (event) => send({ t: 'auth.show', event: jsonEvent(event) }),
      prompt: (prompt) =>
        new Promise<string>((resolve) => {
          const id = `auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          answerWaiters.set(id, resolve);
          send({ t: 'auth.ask', id, prompt: jsonPrompt(prompt) });
        }),
    });
    void status;
    send({ t: 'auth.done', status: authStatus(runtime, provider) });
  } catch (error) {
    const origin = frame.mode === 'agent' ? 'auth-check' : frame.mode === 'auth-login' ? 'login' : 'engine';
    send({
      t: 'fatal',
      error: errorOf('configuration/engine-init', error instanceof Error ? error.message : String(error)),
      signal: signalOf(error, origin),
    });
  }
}

async function runAgent(
  frame: Extract<ParentFrame, { t: 'init'; mode: 'agent' }>,
  send: Send,
  toolWaiters: Map<string, (frame: Extract<ParentFrame, { t: 'tool.result' }>) => void>,
  setAgentListener: (listener: (frame: ParentFrame) => void) => void,
): Promise<void> {
  const { request, engine } = frame;
  const promptBytes = readFileSync(request.systemPrompt.path);
  if (promptBytes.byteLength !== request.systemPrompt.bytes || sha256Hex(promptBytes) !== request.systemPrompt.sha256)
    throw new Error('agent-host: system prompt asset verification failed');
  const effectivePrompt = `${promptBytes.toString('utf8')}\nCurrent working directory: ${request.workingDirectory}\n`;
  const runtime = await ModelRuntime.create({
    authPath: engine.authPath,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: true,
  });
  const catalogModel = runtime.getModel(request.model.provider, request.model.model);
  if (!catalogModel)
    throw new Error(`agent-host: model ${request.model.provider}/${request.model.model} is unavailable`);
  const model = { ...catalogModel, baseUrl: request.auth.baseUrl };
  await runtime.refresh({
    providers: [request.model.provider],
    allowNetwork: false,
    signal: AbortSignal.timeout(15_000),
  });
  const liveAuth = await runtime.checkAuth(request.model.provider, { signal: AbortSignal.timeout(15_000) });
  const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) });
  const provider = runtime.getProvider(request.model.provider);
  const storedOAuth = credentials.some(
    (credential) => credential.providerId === request.model.provider && credential.type === 'oauth',
  );
  const subscriptionAuth =
    liveAuth?.type === 'oauth' &&
    storedOAuth &&
    provider?.auth.apiKey === undefined &&
    runtime.isUsingSubscription(request.model.provider);
  const apiAuth = liveAuth?.type === 'api_key' && request.auth.allowApiKey;
  if (request.auth.mode === 'subscription' ? !subscriptionAuth : !apiAuth)
    throw new Error(`agent-host: provider ${request.auth.provider} is not authenticated for the requested mode`);
  const versions = selfTest().versions;
  const oauth = liveAuth?.type === 'oauth';
  const subscription = subscriptionAuth;
  const baseUrl = request.auth.baseUrl;
  let sequence = 0;
  let ordinal = 0;
  let turn = 0;
  let requestId = '';
  let responseStatus: number | undefined;
  let parked = false;
  let heartbeatState = 'running';
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const heartbeat = setInterval(() => {
    send({ t: 'heartbeat', rssMb: process.memoryUsage().rss / 1024 / 1024, state: heartbeatState });
  }, 1000);
  const originalFetch = globalThis.fetch;
  if (!originalFetch) throw new Error('agent-host: fetch is unavailable');
  const guardFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const pinned = new URL(request.auth.baseUrl);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const authorization = headers.get('authorization');
    const authScheme = oauth
      ? authorization?.toLowerCase().startsWith('bearer ')
        ? 'bearer-jwt'
        : 'none'
      : headers.has('x-api-key') || headers.has('api-key')
        ? 'api-key-header'
        : authorization?.toLowerCase().startsWith('bearer ')
          ? 'bearer-opaque'
          : 'none';
    const refused = url.origin !== pinned.origin;
    send({ t: 'provider.request', requestId, origin: url.origin, authScheme, refused });
    if (refused) throw new Error('agent-host: provider request left the pinned origin');
    return originalFetch(input, init);
  };
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = ((streamModel, context, options) =>
    lazyStream(streamModel, async () =>
      streamSimple(streamModel, context, {
        ...options,
        fetch: guardFetch,
        onResponse: async (response, responseModel) => {
          responseStatus = response.status;
          const allowed = Object.fromEntries(
            [...Object.entries(response.headers)].filter(([name]) =>
              engine.responseHeaderAllowlist.some((pattern) => {
                const normalized = pattern.toLowerCase();
                return normalized.endsWith('*') ? name.startsWith(normalized.slice(0, -1)) : name === normalized;
              }),
            ),
          );
          send({ t: 'provider.response', requestId, status: response.status, headers: allowed });
          await options?.onResponse?.(response, responseModel);
        },
      }),
    )) as typeof runtime.streamSimple;
  const sendEvent = (event: HostEvent): void => send({ t: 'event', seq: sequence++, event });
  const tools: ToolDefinition[] = request.tools.map((grant) => ({
    name: grant.tool,
    label: grant.tool,
    description: grant.description,
    executionMode: 'sequential',
    parameters: Type.Unsafe(grant.inputSchema as TSchema),
    execute: async (engineToolCallId, input, signal) => {
      const ordinalForCall = ++ordinal;
      const toolCallId = `tc_${request.incarnation}_${ordinalForCall}`;
      const resultPromise = new Promise<Extract<ParentFrame, { t: 'tool.result' }>>((resolve, reject) => {
        toolWaiters.set(toolCallId, resolve);
        signal?.addEventListener('abort', () => reject(new Error('tool call aborted')), { once: true });
      });
      send({
        t: 'tool.call',
        seq: sequence++,
        ordinal: ordinalForCall,
        engineToolCallId,
        tool: grant.tool,
        input: input as JsonValue,
      });
      const result = await resultPromise;
      toolWaiters.delete(toolCallId);
      return {
        content: result.content.map((content) =>
          content.type === 'text'
            ? { type: 'text' as const, text: content.text }
            : { type: 'image' as const, data: content.dataBase64, mimeType: content.mediaType },
        ),
        details: {},
        ...(result.terminate ? { terminate: true } : {}),
      };
    },
  }));
  const settingsManager = SettingsManager.inMemory(
    { transport: 'sse', compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: 'never' },
    { projectTrusted: false },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd: request.workingDirectory,
    agentDir: engine.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: effectivePrompt,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: request.workingDirectory,
    agentDir: engine.agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: request.thinking,
    noTools: 'all',
    customTools: tools,
    sessionManager: SessionManager.inMemory(request.workingDirectory),
    settingsManager,
    resourceLoader,
  });
  // The SDK keeps this field private because interactive modes normally own it. The host has already verified the
  // rendered asset and must install exactly that byte sequence as the model system prompt.
  (session as unknown as { _systemPromptOverride: string })._systemPromptOverride = effectivePrompt;
  session.agent.state.systemPrompt = effectivePrompt;
  let stopAfterTurn = false;
  let lastEngineError: unknown;
  let lastEngineErrorOrigin: ErrorSignal['origin'] = 'model-response';
  session.agent.shouldStopAfterTurn = () => stopAfterTurn;
  session.subscribe((event) => {
    const at = isoNow();
    if (event.type === 'turn_start') {
      turn += 1;
      requestId = `mr_${request.incarnation}_${turn}`;
      responseStatus = undefined;
      sendEvent({ type: 'agent.turn.started', at, data: { turn } });
      sendEvent({ type: 'model.requested', at, data: { requestId, model: request.model, attempt: 1 } });
    } else if (event.type === 'message_start' && (event.message as { role?: string }).role === 'assistant') {
      sendEvent({ type: 'agent.message.started', at, data: { messageId: requestId, role: 'assistant' } });
    } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      sendEvent({
        type: 'agent.message.delta',
        at,
        data: {
          messageId: requestId,
          channel: 'text',
          contentIndex: event.assistantMessageEvent.contentIndex,
          delta: event.assistantMessageEvent.delta,
        },
      });
    } else if (event.type === 'message_end' && (event.message as { role?: string }).role === 'assistant') {
      const message = event.message as {
        content?: Array<{ type: string; text?: string }>;
        stopReason?: string;
        usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
      };
      const text = (message.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
      const usage = message.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
      usageTotals.input += usage.input;
      usageTotals.output += usage.output;
      usageTotals.cacheRead += usage.cacheRead;
      usageTotals.cacheWrite += usage.cacheWrite;
      usageTotals.total += usage.totalTokens;
      const rawStop = String(message.stopReason ?? 'stop');
      const stop: 'stop' | 'length' | 'tool-use' | 'error' | 'aborted' =
        rawStop === 'pending' || rawStop === 'deferred'
          ? 'error'
          : rawStop === 'length' || rawStop === 'toolUse' || rawStop === 'aborted' || rawStop === 'error'
            ? rawStop === 'toolUse'
              ? 'tool-use'
              : rawStop
            : 'stop';
      if (rawStop === 'pending' || rawStop === 'deferred') {
        sendEvent({
          type: 'runtime.warning',
          at,
          data: {
            code: 'engine-stop-reason-unmapped',
            message: `Pi stop reason ${rawStop} was normalized to error`,
          },
        });
      }
      sendEvent({
        type: 'agent.message.completed',
        at,
        data: {
          messageId: requestId,
          role: 'assistant',
          textSha256: sha256Hex(text),
          textBytes: Buffer.byteLength(text),
          preview: text.slice(0, 512),
          stop,
        },
      });
      sendEvent({
        type: 'model.responded',
        at,
        data: {
          requestId,
          requestedModel: request.model,
          effectiveModel: { provider: model.provider, model: model.id, api: model.api, baseUrl },
          authMode: request.auth.mode,
          authSource: oauth ? 'oauth' : 'api-key',
          durationMs: 0,
          ...(responseStatus === undefined ? {} : { httpStatus: responseStatus }),
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            total: usage.totalTokens,
          },
          attempt: 1,
          stop,
          quota: { known: false },
        },
      });
    } else if (event.type === 'turn_end') {
      sendEvent({ type: 'agent.turn.completed', at, data: { turn, toolCalls: ordinal } });
    } else if (event.type === 'agent_settled') {
      if (stopAfterTurn) {
        stopAfterTurn = false;
        parked = true;
        heartbeatState = 'parked';
        send({ t: 'parked', at: 'model-boundary' });
        return;
      }
      clearInterval(heartbeat);
      const engineError = session.agent.state.errorMessage;
      const failed = lastEngineError !== undefined || (typeof engineError === 'string' && engineError.length > 0);
      const signal = failed
        ? signalOf(
            lastEngineError ?? new Error(engineError ?? 'agent session failed'),
            lastEngineError === undefined ? 'model-response' : lastEngineErrorOrigin,
          )
        : undefined;
      send({
        t: 'settled',
        exit: {
          outcome: failed ? 'failed' : 'completed',
          stop: failed ? 'engine-error' : 'model-stop',
          usage: {
            tokens: usageTotals,
            modelRequests: turn,
            toolCalls: ordinal,
            turns: turn,
            wallClockMs: 0,
          },
          lastSeq: sequence,
        },
        ...(signal === undefined ? {} : { signal }),
      });
    }
  });
  send({
    t: 'ready',
    attestation: {
      engine: {
        name: 'pi',
        version: versions['@earendil-works/pi-coding-agent'] ?? engine.expectedEngineVersion,
        packageVersions: versions,
      },
      activeTools: request.tools.map((grant) => grant.tool),
      effectiveSystemPromptSha256: sha256Hex(effectivePrompt),
      systemPromptPrefixOk: true,
      auth: { provider: request.auth.provider, type: oauth ? 'oauth' : 'api_key', source: 'stored', subscription },
      effective: { provider: model.provider, model: model.id, api: model.api, baseUrl },
      hooks: {
        streamWrapperInstalled: true,
        guardFetchInstalled: true,
        onResponseChained: true,
        shouldStopAfterTurn: true,
      },
      sessionFile: engine.sessionFile,
      sessionId: session.sessionId,
      envKeys: Object.keys(process.env),
      platform: process.platform,
      hostProtocol: 1,
      extensionsLoaded: 0,
      extensionErrors: 0,
      modelFallback: false,
      settings: { compaction: false, agentRetry: false, providerMaxRetries: 0, transport: 'sse' },
    },
  });
  setAgentListener((parent) => {
    if (parent.t === 'prompt')
      void session
        .prompt(parent.note ? `${parent.text}${CONTINUATION_NOTE_SEPARATOR}${parent.note.text}` : parent.text)
        .catch((error: unknown) => {
          lastEngineError = error;
          lastEngineErrorOrigin = 'prompt-preflight';
        });
    else if (parent.t === 'send') {
      void (parent.delivery === 'steer' ? session.steer(parent.text) : session.followUp(parent.text)).then(
        () => send({ t: 'response', id: parent.id, ok: true }),
        (error: unknown) =>
          send({
            t: 'response',
            id: parent.id,
            ok: false,
            error: errorOf('tool-transient/agent-process-exit', error instanceof Error ? error.message : String(error)),
          }),
      );
    } else if (parent.t === 'abort') void session.abort();
    else if (parent.t === 'pause' || parent.t === 'stop-after-turn') stopAfterTurn = true;
    else if (parent.t === 'resume' && parked) {
      parked = false;
      heartbeatState = 'running';
      void session.prompt('[cohorte] continue').catch((error: unknown) => {
        lastEngineError = error;
        lastEngineErrorOrigin = 'prompt-preflight';
      });
    } else if (parent.t === 'inspect')
      send({
        t: 'response',
        id: parent.id,
        ok: true,
        data: { state: session.isStreaming ? 'running' : 'idle', turn, pendingToolCalls: [] },
      });
    else if (parent.t === 'shutdown') session.dispose();
  });
}

// `import.meta.main` (node >= 24.2), not a hand-rolled `import.meta.url === `file://${argv[1]}``: the latter is
// false whenever the file is reached through a symlink (how npm installs a `bin`) and breaks on any path
// carrying a space or a non-ASCII character (`import.meta.url` is percent-encoded, `argv[1]` is not).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `agent-host fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
