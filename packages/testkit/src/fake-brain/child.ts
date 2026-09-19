// The fake brain: an engine-free CHILD PROCESS that speaks AgentHostProtocol v1 (DESIGN 7.2). It is what keeps the
// private contract honest: the parent of `@cohorte/runtime-pi` is built and tested against it, without the engine.
// It holds no tool, reads its script from its cwd (the agent state dir) and imports neither the testkit barrel nor
// vitest. Run by Node as TypeScript: erasable syntax only.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { errorOf, type IsoInstant, type JsonValue, type Sha256, toIsoInstant } from '@cohorte/base';
import {
  type AttestationClaim,
  type ChildFrame,
  decodeFrame,
  type ErrorSignal,
  encodeFrame,
  type HostEvent,
  type ParentFrame,
} from './frames.ts';
import type { FakeBrainScript } from './scripts/index.ts';

type InitAgent = Extract<ParentFrame, { t: 'init'; mode: 'agent' }>;
type ToolResult = Extract<ParentFrame, { t: 'tool.result' }>;
type Message = { role: 'user' | 'assistant' | 'tool-result'; text: string };

const SCRIPT_FILE = 'fake-brain.script.json';
const MODEL_INPUTS_FILE = 'fake-brain.model-inputs.ndjson';
const GRANDCHILD_FILE = 'fake-brain.grandchild.pid';

const script: FakeBrainScript = existsSync(SCRIPT_FILE) ? JSON.parse(readFileSync(SCRIPT_FILE, 'utf8')) : {};
const nonce = process.argv.find((arg) => arg.startsWith('--cohorte-nonce='))?.slice('--cohorte-nonce='.length) ?? '';
const sha256 = (text: string): Sha256 => createHash('sha256').update(text, 'utf8').digest('hex') as Sha256;
const now = (): IsoInstant => toIsoInstant(Date.now());

// ── transport: the Node 'ipc' channel when there is one, LF-delimited JSON over fd 3 (in) / fd 4 (out) otherwise ──
const useIpc = typeof process.send === 'function';
const outbound = useIpc ? undefined : new Socket({ fd: 4, readable: false, writable: true });
let flushed: Promise<void> = Promise.resolve();

function send(frame: ChildFrame | JsonValue): void {
  flushed = flushed.then(
    () =>
      new Promise<void>((resolve) => {
        if (useIpc) {
          if (!process.connected) return resolve();
          process.send?.(encodeFrame(frame as ChildFrame, 'ipc'), undefined, undefined, () => resolve());
        } else outbound?.write(encodeFrame(frame as ChildFrame, 'lf'), () => resolve());
      }),
  );
}

function peerGone(): void {
  // No brain survives its host (DESIGN 3.2).
  process.exit(1);
}

function listen(onFrame: (frame: ParentFrame) => void): void {
  const accept = (raw: unknown, wire: 'ipc' | 'lf'): void => {
    const decoded = decodeFrame('parent', raw, wire);
    if (decoded.ok) onFrame(decoded.value);
  };
  if (useIpc) {
    process.on('message', (raw) => accept(raw, 'ipc'));
    process.on('disconnect', peerGone);
    return;
  }
  const inbound = new Socket({ fd: 3, readable: true, writable: false });
  let buffer = '';
  inbound.setEncoding('utf8');
  inbound.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.length > 0) accept(line, 'lf');
    }
  });
  inbound.on('end', peerGone);
  inbound.on('error', peerGone);
  outbound?.on('error', peerGone);
}

// ── state ──
let init: InitAgent | undefined;
let systemPrompt = '';
let seq = 0;
let turn = 0;
let requests = 0;
let ordinal = 0;
let state = 'starting';
let aborted = false;
let paused = false;
let stopAfterTurn = false;
let settledSent = false;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
let toolCalls = 0;
const startedAt = Date.now();
const messages: Message[] = [];
const waitingResults = new Map<
  string,
  { engineToolCallId: string; release: (result: ToolResult | undefined) => void }
>();
let wake: (() => void) | undefined;

const emit = (event: HostEvent): void => send({ t: 'event', seq: seq++, event });

function merge(base: JsonValue, over: JsonValue | undefined): JsonValue {
  if (over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  if (typeof over !== 'object' || over === null || Array.isArray(over)) return over;
  const out: { [k: string]: JsonValue } = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = merge(out[key] ?? null, value);
  return out;
}

function exitUsage() {
  return { tokens: { ...usage }, modelRequests: requests, toolCalls, turns: turn, wallClockMs: Date.now() - startedAt };
}

async function settle(
  outcome: 'completed' | 'failed' | 'cancelled',
  stop: string,
  signal?: ErrorSignal,
): Promise<void> {
  if (settledSent) return;
  settledSent = true;
  state = 'exited';
  for (const { engineToolCallId, release } of waitingResults.values()) {
    send({ t: 'tool.call.abandoned', engineToolCallId, reason: 'aborted' });
    release(undefined);
  }
  waitingResults.clear();
  send({
    t: 'settled',
    exit: { outcome, stop, usage: exitUsage(), lastSeq: Math.max(0, seq - 1) } as Extract<
      ChildFrame,
      { t: 'settled' }
    >['exit'],
    ...(signal ? { signal } : {}),
  });
  await flushed;
  process.exit(0);
}

function readVerified(ref: { path: string; sha256: string }): string {
  const text = readFileSync(ref.path, 'utf8');
  if (sha256(text) !== ref.sha256) {
    send({
      t: 'fatal',
      error: errorOf('security/asset-hash-mismatch', `${ref.path} is not the file that was rendered`),
    });
    throw new Error('asset hash mismatch');
  }
  return text;
}

function attest(frame: InitAgent): AttestationClaim {
  const { request, engine } = frame;
  const version = engine.expectedEngineVersion;
  const subscription = request.auth.mode === 'subscription';
  const honest: AttestationClaim = {
    engine: {
      name: 'fake-brain',
      version,
      packageVersions: { 'fake-a': version, 'fake-b': version, 'fake-c': version },
    },
    hostProtocol: 1,
    activeTools: request.tools.map((grant) => grant.tool),
    effectiveSystemPromptSha256: sha256(systemPrompt),
    systemPromptPrefixOk: true,
    extensionsLoaded: 0,
    extensionErrors: 0,
    modelFallback: false,
    auth: { provider: request.auth.provider, type: subscription ? 'oauth' : 'api_key', source: 'stored', subscription },
    effective: {
      provider: request.model.provider,
      model: request.model.model,
      api: 'fake-brain',
      baseUrl: script.endpoint ?? request.auth.baseUrl,
    },
    settings: { compaction: false, agentRetry: false, providerMaxRetries: 0, transport: 'sse' },
    hooks: {
      streamWrapperInstalled: true,
      guardFetchInstalled: true,
      onResponseChained: true,
      shouldStopAfterTurn: true,
    },
    sessionFile: engine.sessionFile,
    sessionId: `fake-session-${process.pid}`,
    envKeys: [...Object.keys(process.env), ...(script.extraEnvKeys ?? [])],
    platform: process.platform,
  };
  return merge(honest as unknown as JsonValue, script.attestation) as unknown as AttestationClaim;
}

function crashNow(how: 'disconnect' | 'exit'): void {
  if (how === 'exit' || !useIpc) process.exit(3);
  process.removeListener('disconnect', peerGone);
  process.disconnect();
  // Stays alive on purpose: the parent must notice the closed channel by itself and reap the process.
  setInterval(() => {}, 1_000);
}

async function parkUntilWoken(): Promise<void> {
  state = 'paused';
  send({ t: 'parked', at: 'model-boundary' });
  await new Promise<void>((resolve) => {
    wake = resolve;
  });
  wake = undefined;
  state = 'running';
}

async function modelRequest(frame: InitAgent): Promise<'stopped' | 'continue' | 'terminated'> {
  const { request } = frame;
  turn += 1;
  requests += 1;
  emit({ type: 'agent.turn.started', at: now(), data: { turn } });
  const requestId = `req_${requests}`;
  if (requests === 1 && script.rawFrameOnFirstRequest !== undefined) send(script.rawFrameOnFirstRequest);
  if (requests === 1 && script.crash?.at === 'first-request') {
    await flushed;
    crashNow(script.crash.how);
  }
  appendFileSync(MODEL_INPUTS_FILE, `${JSON.stringify({ systemPrompt, messages })}\n`, 'utf8');
  emit({ type: 'model.requested', at: now(), data: { requestId, model: request.model, attempt: 1 } });
  const origin = new URL(script.endpoint ?? request.auth.baseUrl).origin;
  if (script.providerRequest !== 'omit')
    send({
      t: 'provider.request',
      requestId,
      origin,
      authScheme: 'bearer-jwt',
      refused: false,
      ...script.providerRequest,
    });

  if (script.failRequest?.request === requests) {
    const signal = { text: 'scripted failure', origin: 'model-response', ...script.failRequest.signal } as ErrorSignal;
    if (signal.httpStatus !== undefined)
      send({ t: 'provider.response', requestId, status: signal.httpStatus, headers: {} });
    await settle('failed', 'engine-error', signal);
    return 'stopped';
  }

  send({ t: 'provider.response', requestId, status: 200, headers: {} });
  const scripted = script.turns?.[requests - 1] ?? {};
  const text = scripted.text ?? '';
  const calls = scripted.toolCalls ?? [];
  const spent = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
  for (const key of Object.keys(usage) as (keyof typeof usage)[]) usage[key] += spent[key];
  emit({
    type: 'model.responded',
    at: now(),
    data: {
      requestId,
      requestedModel: request.model,
      effectiveModel: { provider: request.model.provider, model: script.responded?.model ?? request.model.model },
      authMode: request.auth.mode,
      authSource: script.responded?.authSource ?? (request.auth.mode === 'subscription' ? 'oauth' : 'api-key'),
      durationMs: 1,
      usage: spent,
      httpStatus: 200,
      attempt: 1,
      stop: calls.length > 0 ? 'tool-use' : 'stop',
      quota: { known: false },
    },
  });
  const messageId = `msg_${requests}`;
  emit({ type: 'agent.message.started', at: now(), data: { messageId, role: 'assistant' } });
  if (text)
    emit({
      type: 'agent.message.delta',
      at: now(),
      data: { messageId, channel: 'text', contentIndex: 0, delta: text },
    });
  emit({
    type: 'agent.message.completed',
    at: now(),
    data: {
      messageId,
      role: 'assistant',
      textSha256: sha256(text),
      textBytes: Buffer.byteLength(text, 'utf8'),
      preview: text.slice(0, 200),
      stop: calls.length > 0 ? 'tool-use' : 'stop',
    },
  });
  messages.push({ role: 'assistant', text });

  let terminate = false;
  const granted = new Set(request.tools.map((grant) => grant.tool));
  for (const call of calls) {
    if (aborted) break;
    const engineToolCallId = `call_${requests}_${calls.indexOf(call) + 1}`;
    if (!granted.has(call.tool) && !script.forwardUngranted) {
      // What the engine does with a name outside its registry: the model is told, the host never hears of a call.
      const message = `Tool ${call.tool} not found`;
      emit({
        type: 'tool.call.rejected',
        at: now(),
        data: { engineToolCallId, tool: call.tool, cause: 'unknown-tool', message },
      });
      messages.push({ role: 'tool-result', text: message });
      continue;
    }
    ordinal += 1;
    toolCalls += 1;
    state = 'awaiting-tool';
    send({ t: 'tool.call', seq: seq++, ordinal, engineToolCallId, tool: call.tool, input: call.input });
    if (script.crash?.at === 'first-tool-call') {
      await flushed;
      crashNow(script.crash.how);
    }
    // The host's id is deterministic (DESIGN 3.5), so this side can name the result it waits for.
    const toolCallId = `tc_${request.incarnation}_${ordinal}`;
    const result = await new Promise<ToolResult | undefined>((release) =>
      waitingResults.set(toolCallId, { engineToolCallId, release }),
    );
    waitingResults.delete(toolCallId);
    state = 'running';
    if (!result) break;
    messages.push({
      role: 'tool-result',
      text: result.content.map((part) => (part.type === 'text' ? part.text : `[image ${part.mediaType}]`)).join(''),
    });
    terminate ||= result.terminate;
  }
  emit({ type: 'agent.turn.completed', at: now(), data: { turn, toolCalls: calls.length } });
  if (terminate) return 'terminated';
  return calls.length === 0 ? 'stopped' : 'continue';
}

async function run(frame: InitAgent): Promise<void> {
  const { budget } = frame.request;
  state = 'running';
  for (;;) {
    if (aborted) return script.stubborn ? undefined : settle('cancelled', 'cancelled');
    if (paused) await parkUntilWoken();
    if (budget.maxModelRequests !== undefined && requests >= budget.maxModelRequests) return settle('failed', 'budget');
    const outcome = await modelRequest(frame);
    if (settledSent) return;
    if (aborted) continue;
    if (outcome === 'terminated') return settle('completed', 'host-terminated');
    if (outcome === 'stopped') return settle('completed', 'model-stop');
    if (budget.maxTurns !== undefined && turn >= budget.maxTurns) return settle('failed', 'budget');
    if (stopAfterTurn) {
      // The executed fallback of the model-boundary pause: the loop stops at the end of the turn, and `resume`
      // re-prompts with a host note (DESIGN 3.5).
      await parkUntilWoken();
      messages.push({ role: 'user', text: '[cohorte] continue' });
    }
  }
}

// The three auth modes, as scripted as the rest: nothing is stored, no credential exists.
let loginProvider = '';
const authStatusOf = (provider: string, state: 'oauth' | 'absent') => ({
  provider,
  state,
  subscription: state === 'oauth',
  checkedAt: now(),
  billing: state === 'oauth' ? ('plan-limits' as const) : ('unknown' as const),
});

function onAuthInit(frame: Exclude<Extract<ParentFrame, { t: 'init' }>, InitAgent>): void {
  if (frame.mode === 'auth-status') {
    send({ t: 'auth.status', statuses: frame.providers.map((provider) => authStatusOf(provider, 'absent')) });
  } else if (frame.mode === 'auth-logout') {
    send({ t: 'auth.done', status: authStatusOf(frame.provider, 'absent') });
  } else {
    loginProvider = frame.provider;
    send({ t: 'auth.show', event: { kind: 'open-url', url: 'https://login.invalid/device' } });
    send({ t: 'auth.ask', id: 'ask_1', prompt: { kind: 'manual-code', message: 'Paste the code' } });
  }
}

function onFrame(frame: ParentFrame): void {
  switch (frame.t) {
    case 'init': {
      if (frame.nonce === nonce && frame.mode !== 'agent') {
        onAuthInit(frame);
        return;
      }
      if (frame.mode !== 'agent' || frame.nonce !== nonce) {
        send({ t: 'fatal', error: errorOf('security/unexpected', 'init does not answer this hello') });
        return;
      }
      init = frame;
      try {
        systemPrompt = `${readVerified(frame.request.systemPrompt)}\nCurrent working directory: ${frame.request.workingDirectory}\n`;
      } catch {
        return;
      }
      if (script.fatalBeforeReady) {
        // What the real child does when its layer-3 check or its prompt preflight fails: an engine signal, no `ready`.
        const signal = {
          text: 'scripted handshake failure',
          origin: 'auth-check',
          ...script.fatalBeforeReady.signal,
        } as ErrorSignal;
        send({ t: 'fatal', error: errorOf('configuration/engine-init', 'the engine refused before ready'), signal });
        return;
      }
      send({ t: 'ready', attestation: attest(frame) });
      return;
    }
    case 'prompt': {
      if (!init) return;
      messages.push({ role: 'user', text: frame.text });
      if (frame.note) messages.push({ role: 'user', text: frame.note.text });
      void run(init);
      return;
    }
    case 'send':
      messages.push({ role: 'user', text: frame.text });
      emit({
        type: 'agent.message.accepted',
        at: now(),
        data: { messageId: frame.messageId, delivery: frame.delivery },
      });
      send({ t: 'response', id: frame.id, ok: true });
      return;
    case 'auth.answer':
      send({ t: 'auth.done', status: authStatusOf(loginProvider, frame.value.length > 0 ? 'oauth' : 'absent') });
      return;
    case 'tool.result':
      waitingResults.get(frame.toolCallId)?.release(frame);
      return;
    case 'pause':
      paused = true;
      return;
    case 'stop-after-turn':
      stopAfterTurn = true;
      return;
    case 'resume':
      paused = false;
      stopAfterTurn = false;
      wake?.();
      return;
    case 'abort':
      if (script.stubborn) return;
      aborted = true;
      wake?.();
      void settle('cancelled', 'cancelled');
      return;
    case 'inspect':
      send({ t: 'response', id: frame.id, ok: true, data: { state, turn, requests, pid: process.pid } });
      return;
    case 'shutdown':
      if (!script.stubborn) process.exit(0);
      return;
    default:
      return;
  }
}

// ── start ──
for (const line of script.stderr ?? []) process.stderr.write(`${line}\n`);
if (script.stderrFloodBytes) {
  const line = `${'x'.repeat(1023)}\n`;
  for (let written = 0; written < script.stderrFloodBytes; written += line.length) process.stderr.write(line);
  // Gate G0: a write to a pipe is asynchronous, so the flood was still QUEUED here and the whole turn
  // (hello -> spawn -> one text turn -> exit) could finish before the parent had read past its 1 MiB
  // incarnation cap — the truncation notice then never existed and the assertion that it does failed about
  // one whole-tree run in three. The child now waits until the OS has taken the flood off its hands, which
  // is the parent reading it: everything after this line happens with the cap already crossed.
  //
  // The wait is BOUNDED (fix round 1). A parent that never drains stderr — or one whose own cap makes it stop
  // reading — would otherwise wedge the child here, before `listen()` is installed and before `hello` is sent, and
  // the test would fail as an opaque timeout instead of the assertion it is really about.
  const floodDeadline = Date.now() + 5_000;
  while (process.stderr.writableLength > 0 && Date.now() < floodDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
if (script.stubborn) process.on('SIGTERM', () => {});
if (script.grandchild) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(GRANDCHILD_FILE, String(grandchild.pid), 'utf8');
}
listen(onFrame);
send({ t: 'hello', v: 1, pid: process.pid, nonce });
if (!script.suppressHeartbeat) {
  const beat = (): void => send({ t: 'heartbeat', rssMb: Math.round(process.memoryUsage.rss() / 1_048_576), state });
  setInterval(beat, script.heartbeatMs ?? 5_000);
} else setInterval(() => {}, 60_000);
