// One agent incarnation = one child process + the protocol engine that drives it (DESIGN 3.2, 3.5). Everything the
// child says is untrusted: frames are schema-checked by `decodeFrame`, texts are sealed before they become an event
// or a log line, and the exit cause is the one THIS side recorded before acting, never the engine's stop reason.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CohorteError,
  type ErrorInfo,
  errorOf,
  type IsoInstant,
  type JsonValue,
  type Result,
  type SealedText,
  type Sha256,
  type ToolCallId,
  toErrorInfo,
} from '@cohorte/base';
import {
  type AgentExit,
  type AgentStopCause,
  type IsolationReport,
  RUNTIME_EVENT_TYPES,
  type RuntimeAgentHandle,
  type RuntimeEvent,
  type RuntimeEventOf,
  type RuntimeEventType,
  type RuntimeHostBindings,
  type RuntimeMessage,
  type RuntimeSnapshot,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type SpawnRequest,
  type UsageTotals,
} from '@cohorte/runtime-contract';
import { attestationError, processExitError, protocolViolation } from '../classify/host.ts';
import { classify } from '../classify/index.ts';
import {
  attestationExpectation,
  type ChildFrame,
  diffAttestation,
  type EngineSettings,
  type ErrorSignal,
  type FrameRejection,
  type HostEvent,
  type ParentFrame,
} from '../protocol.ts';
import type { ModelBoundaryMode } from './capabilities.ts';
import { drainChildOutput, newOutputBudget } from './output.ts';
import { type FrameTransport, stdioFor, type TransportKind, transportFor } from './transport.ts';

export interface ParentTimings {
  /** spawn -> `hello` */
  helloMs: number;
  /** `init` -> `ready` */
  readyMs: number;
  /** the child's heartbeat period; three missed periods = a hang (DESIGN 3.2) */
  heartbeatMs: number;
  /** `abort` -> `settled`, before SIGTERM goes to the process group */
  abortGraceMs: number;
  /** SIGTERM -> SIGKILL */
  termGraceMs: number;
  /** `settled` -> the process is gone by itself */
  exitGraceMs: number;
  /** a `send` or `inspect` frame -> its `response` */
  responseMs: number;
}
export const DEFAULT_TIMINGS: ParentTimings = Object.freeze({
  helloMs: 10_000,
  readyMs: 30_000,
  heartbeatMs: 5_000,
  abortGraceMs: 5_000,
  termGraceMs: 2_000,
  exitGraceMs: 2_000,
  responseMs: 5_000,
});

export const WIRE_LOG_FILE = 'frames.ndjson';
export const NONCE_ARG = '--cohorte-nonce=';

export interface Sealer {
  text(text: string): SealedText;
  json<T extends JsonValue>(value: T): T;
}

export interface SessionContext {
  bindings: RuntimeHostBindings;
  seal: Sealer;
  timings: ParentTimings;
  transport: TransportKind;
  modelBoundary: ModelBoundaryMode;
  runtimeId: string;
  emit(event: RuntimeEvent): void;
  diagnostics: Readonly<Record<string, string>>;
}

export interface SpawnPlan {
  request: SpawnRequest;
  stateDir: string;
  command: { file: string; args: string[] };
  nonce: string;
  env: Record<string, string>;
  /** `request` with the env the child REALLY gets: what the attested names are held against. */
  attestedRequest: SpawnRequest;
  engine: EngineSettings;
  expectedEffectivePromptSha256: Sha256;
  isolation: IsolationReport;
  taskText: string;
  noteText: string | undefined;
}

type Cause = { outcome: AgentExit['outcome']; stop: AgentStopCause; error?: ErrorInfo };
type ToolCallFrame = Extract<ChildFrame, { t: 'tool.call' }>;
type ResponseFrame = Extract<ChildFrame, { t: 'response' }>;
type ProviderRequestFrame = Extract<ChildFrame, { t: 'provider.request' }>;

// Events only THIS side may author: a child that sends one is ignored, with a trace.
const PARENT_OWNED: ReadonlySet<RuntimeEventType> = new Set([
  'agent.spawned',
  'agent.started',
  'agent.paused',
  'agent.resumed',
  'agent.exited',
  'tool.call.requested',
  'tool.call.delivered',
  'tool.call.progress',
]);

const zeroUsage = (): UsageTotals => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  modelRequests: 0,
  toolCalls: 0,
  turns: 0,
  wallClockMs: 0,
});

/** The OS start time of a process: orphan recovery never trusts a bare pid (DESIGN 3.2). */
async function processStartToken(pid: number): Promise<string> {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (afterName[19]) return `jiffies:${afterName[19]}`;
  }
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2_000 }, (error, stdout) =>
      resolve(error || !stdout.trim() ? 'unknown' : stdout.trim()),
    );
  });
}

export class AgentSession {
  readonly request: SpawnRequest;
  readonly done: Promise<void>;
  readonly #exit: Promise<AgentExit>;
  #handle: RuntimeAgentHandle | undefined;
  readonly #ctx: SessionContext;
  readonly #plan: SpawnPlan;
  readonly #child: ChildProcess;
  readonly #transport: FrameTransport;
  readonly #wireLog: WriteStream;
  readonly #processGone: Promise<void>;
  #gone = false;
  #phase: 'hello' | 'ready' | 'running' | 'over' = 'hello';
  #handshake: { resolve: () => void; reject: (error: CohorteError) => void } | undefined;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #seq = 0;
  #lastOrdinal = 0;
  #requestSerial = 0;
  #cause: Cause | undefined;
  #terminated = false;
  #paused = false;
  #pausedAt: 'tool-boundary' | 'model-boundary' | undefined;
  #turn = 0;
  readonly #usage = zeroUsage();
  readonly #startedMs: number;
  #lastHeartbeatMs: number;
  #lastHeartbeatAt: IsoInstant | undefined;
  #rssMb: number | undefined;
  #effectiveModel: RuntimeSnapshot['effectiveModel'];
  #sessionId = '';
  #engineVersion = '';
  readonly #pending = new Map<
    ToolCallId,
    { controller: AbortController; engineToolCallId: string; startedMs: number }
  >();
  readonly #queued: ToolCallFrame[] = [];
  readonly #providerRequests = new Map<string, ProviderRequestFrame>();
  readonly #responseHeaders = new Map<string, Record<string, string>>();
  #lastRequestId: string | undefined;
  readonly #responses = new Map<string, (frame: ResponseFrame | undefined) => void>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #settleExit: (exit: AgentExit) => void = () => {};
  #settleDone: () => void = () => {};

  private constructor(ctx: SessionContext, plan: SpawnPlan) {
    this.#ctx = ctx;
    this.#plan = plan;
    this.request = plan.request;
    this.#startedMs = ctx.bindings.clock.monotonicMs();
    this.#lastHeartbeatMs = this.#startedMs;
    this.done = new Promise((resolve) => {
      this.#settleDone = resolve;
    });
    this.#exit = new Promise((resolve) => {
      this.#settleExit = resolve;
    });
    this.#wireLog = createWriteStream(join(plan.stateDir, WIRE_LOG_FILE), { flags: 'a' });
    this.#wireLog.on('error', () => {});
    this.#child = spawn(plan.command.file, plan.command.args, {
      cwd: plan.stateDir,
      env: plan.env,
      stdio: stdioFor(ctx.transport),
      serialization: 'json',
      // Its own process group: the ladder signals the whole tree (DESIGN 3.5).
      detached: true,
    });
    this.#processGone = new Promise((resolve) => {
      const gone = (): void => {
        this.#gone = true;
        resolve();
      };
      this.#child.once('exit', gone);
      this.#child.once('error', (error) => {
        gone();
        void this.#conclude(
          { outcome: 'crashed', stop: 'process-exit', error: processExitError('spawn-failed', error.name) },
          { clean: false },
        );
      });
    });
    const budget = newOutputBudget();
    const write = (line: string, stream: 'stdout' | 'stderr'): void =>
      this.#log(stream === 'stderr' ? 'warn' : 'info', line, { stream, source: 'agent-process' });
    if (this.#child.stdout) drainChildOutput(this.#child.stdout, 'stdout', budget, write);
    if (this.#child.stderr) drainChildOutput(this.#child.stderr, 'stderr', budget, write);
    this.#transport = transportFor(ctx.transport, this.#child);
    this.#transport.onFrame((decoded) => this.#onDecoded(decoded));
    this.#transport.onClose(() => this.#onChannelClosed());
  }

  /** Resolves once the child has attested what was asked and received its prompt; rejects (child reaped) otherwise. */
  static async start(ctx: SessionContext, plan: SpawnPlan): Promise<AgentSession> {
    const session = new AgentSession(ctx, plan);
    await session.#shakeHands();
    await session.#begin();
    return session;
  }

  get handle(): RuntimeAgentHandle {
    if (!this.#handle) throw new TypeError('AgentSession: no handle before the handshake');
    return this.#handle;
  }

  get over(): boolean {
    return this.#phase === 'over';
  }

  // ── handshake: hello(nonce) -> init -> ready(attestation) ──

  #shakeHands(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#handshake = { resolve, reject };
      this.#armHandshakeTimer(this.#ctx.timings.helloMs, 'hello');
    });
  }

  #armHandshakeTimer(ms: number, awaited: string): void {
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = setTimeout(
      () => this.#block(protocolViolation('handshake-timeout', `no ${awaited} frame within ${ms} ms`)),
      ms,
    );
  }

  async #begin(): Promise<void> {
    const { request, taskText, noteText, isolation } = this.#plan;
    const { clock } = this.#ctx.bindings;
    const pid = this.#child.pid ?? 0;
    const startToken = await processStartToken(pid);
    // The child may have died while the start token was read: there is no agent then, and the spawn says so.
    if (this.over) throw new CohorteError(this.#cause?.error ?? processExitError('exit-without-settled'));
    this.#handle = Object.freeze({
      runId: request.runId,
      agentId: request.agentId,
      incarnation: request.incarnation,
      session: {
        runtime: this.#ctx.runtimeId,
        engineVersion: this.#engineVersion,
        sessionId: this.#sessionId,
        transcript: { path: this.#plan.engine.sessionFile, format: 'jsonl-v3' },
      },
      startedAt: clock.now(),
      process: { pid, pgid: pid, startToken },
      exit: this.#exit,
    });
    this.#emit('agent.spawned', {
      session: this.#handle.session,
      requestedModel: request.model,
      tools: request.tools.map((grant) => grant.tool),
      systemPromptSha256: request.systemPrompt.sha256,
      effectiveSystemPromptSha256: this.#plan.expectedEffectivePromptSha256,
      isolation,
    });
    this.#send({
      t: 'prompt',
      id: this.#nextId('prompt'),
      text: taskText,
      ...(noteText === undefined ? {} : { note: { text: noteText } }),
    });
    this.#emit('agent.started', { taskSha256: request.task.sha256 });
    this.#startWatchdogs();
  }

  #startWatchdogs(): void {
    const { timings, bindings } = this.#ctx;
    this.#lastHeartbeatMs = bindings.clock.monotonicMs();
    const watchdog = setInterval(() => {
      if (bindings.clock.monotonicMs() - this.#lastHeartbeatMs <= 3 * timings.heartbeatMs) return;
      this.#stop({ outcome: 'crashed', stop: 'process-exit', error: processExitError('heartbeat-lost') });
    }, timings.heartbeatMs);
    this.#timers.add(watchdog);
    const { maxWallClockMs } = this.request.budget;
    if (maxWallClockMs !== undefined)
      this.#timers.add(
        setTimeout(
          () => this.#breach(errorOf('timeout/agent', `the agent ran longer than ${maxWallClockMs} ms`)),
          Math.min(maxWallClockMs, 2 ** 31 - 1),
        ),
      );
  }

  // ── inbound ──

  #onDecoded(decoded: Result<ChildFrame, FrameRejection>): void {
    if (this.over) return;
    if (!decoded.ok) {
      this.#logWire('in', { rejected: decoded.error.reason, detail: decoded.error.detail });
      this.#block(protocolViolation('frame-schema', `${decoded.error.reason}: ${decoded.error.detail}`));
      return;
    }
    const frame = decoded.value;
    this.#logWire('in', { frame: frame as unknown as JsonValue });
    if (this.#phase === 'hello' || this.#phase === 'ready') this.#onHandshakeFrame(frame);
    else this.#onFrame(frame);
  }

  #onHandshakeFrame(frame: ChildFrame): void {
    if (frame.t === 'fatal') {
      void this.#conclude(
        { outcome: 'failed', stop: 'engine-error', error: this.#errorOfFatal(frame) },
        { clean: false },
      );
      return;
    }
    if (frame.t === 'heartbeat') return;
    if (this.#phase === 'hello' && frame.t === 'hello') {
      if (frame.nonce !== this.#plan.nonce) {
        this.#block(protocolViolation('nonce-mismatch', 'hello does not carry the nonce of this spawn'));
        return;
      }
      this.#phase = 'ready';
      this.#armHandshakeTimer(this.#ctx.timings.readyMs, 'ready');
      this.#send({
        t: 'init',
        v: 1,
        nonce: this.#plan.nonce,
        mode: 'agent',
        request: this.request,
        engine: this.#plan.engine,
      });
      return;
    }
    if (this.#phase === 'ready' && frame.t === 'ready') {
      const expected = attestationExpectation(
        this.#plan.attestedRequest,
        this.#plan.engine,
        this.#plan.expectedEffectivePromptSha256,
        process.platform,
      );
      const mismatches = diffAttestation(expected, frame.attestation);
      if (mismatches.length > 0) {
        // `got` is the CHILD's text, and the error escapes this side as a thrown `CohorteError`: it is sealed here,
        // like every other child-derived text (DESIGN 3.3). `expected` is the parent's own and stays as it is.
        this.#block(attestationError(mismatches.map((m) => ({ ...m, got: this.#ctx.seal.text(m.got) }))));
        return;
      }
      clearTimeout(this.#handshakeTimer);
      this.#sessionId = frame.attestation.sessionId;
      this.#engineVersion = frame.attestation.engine.version;
      this.#phase = 'running';
      this.#handshake?.resolve();
      this.#handshake = undefined;
      return;
    }
    this.#block(protocolViolation('unexpected-frame', `'${frame.t}' during the handshake`));
  }

  #onFrame(frame: ChildFrame): void {
    switch (frame.t) {
      case 'event': {
        this.#onEvent(frame.event);
        return;
      }
      case 'tool.call': {
        this.#onToolCall(frame);
        return;
      }
      case 'tool.call.abandoned':
        for (const entry of this.#pending.values())
          if (entry.engineToolCallId === frame.engineToolCallId) entry.controller.abort(frame.reason);
        return;
      case 'provider.request':
        this.#providerRequests.set(frame.requestId, frame);
        {
          this.#assertProviderRequest(frame);
          return;
        }
      case 'provider.response':
        this.#responseHeaders.set(frame.requestId, frame.headers);
        this.#lastRequestId = frame.requestId;
        return;
      case 'parked':
        if (this.#paused) this.#pausedAt = 'model-boundary';
        return;
      case 'heartbeat':
        this.#lastHeartbeatMs = this.#ctx.bindings.clock.monotonicMs();
        this.#lastHeartbeatAt = this.#ctx.bindings.clock.now();
        this.#rssMb = frame.rssMb;
        return;
      case 'response':
        this.#responses.get(frame.id)?.(frame);
        return;
      case 'settled': {
        const { outcome, stop, usage } = frame.exit;
        const error = frame.signal
          ? this.#classified(frame.signal)
          : stop === 'budget'
            ? errorOf('budget/unexpected', 'the engine stopped the agent on one of its budget limits')
            : undefined;
        void this.#conclude({ outcome, stop, ...(error ? { error } : {}) }, { clean: true, usage });
        return;
      }
      case 'fatal':
        void this.#conclude(
          { outcome: 'failed', stop: 'engine-error', error: this.#errorOfFatal(frame) },
          { clean: false },
        );
        return;
      default:
        this.#block(protocolViolation('unexpected-frame', `'${frame.t}' while an agent runs`));
    }
  }

  #onEvent(event: HostEvent): void {
    if (PARENT_OWNED.has(event.type)) {
      this.#emit('runtime.warning', {
        code: 'host-event-ignored',
        message: `the agent process sent '${event.type}', which only the host may author`,
      });
      return;
    }
    const { budget } = this.request;
    if (event.type === 'model.requested') {
      this.#usage.modelRequests += 1;
      this.#lastRequestId = event.data.requestId;
    } else if (event.type === 'agent.turn.started') {
      this.#turn = event.data.turn;
    } else if (event.type === 'agent.turn.completed') {
      this.#usage.turns = Math.max(this.#usage.turns, event.data.turn);
    } else if (event.type === 'model.responded') {
      const violation = this.#assertResponded(event.data);
      if (violation) {
        this.#block(violation);
        return;
      }
      this.#effectiveModel = event.data.effectiveModel;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
        this.#usage.tokens[key] += event.data.usage[key];
    }
    this.#forward(event);

    // The belt (DESIGN 3.5): always on, whatever the child enforces itself.
    const { tokens } = this.#usage;
    if (budget.maxModelRequests !== undefined && this.#usage.modelRequests > budget.maxModelRequests)
      this.#breach(errorOf('budget/unexpected', `more than ${budget.maxModelRequests} model requests`));
    else if (budget.maxTurns !== undefined && this.#turn > budget.maxTurns)
      this.#breach(errorOf('budget/unexpected', `more than ${budget.maxTurns} turns`));
    else if (
      (budget.maxTotalTokens !== undefined && tokens.total > budget.maxTotalTokens) ||
      (budget.maxInputTokens !== undefined && tokens.input > budget.maxInputTokens) ||
      (budget.maxOutputTokens !== undefined && tokens.output > budget.maxOutputTokens)
    )
      this.#breach(errorOf('budget/tokens', 'the token budget of this incarnation is spent'));
  }

  #forward(event: HostEvent): void {
    // `type` and `data` travel together: the pair was validated as ONE member of the HostEvent union.
    const stamped = { ...this.#envelope(event.type, event.at), data: this.#ctx.seal.json(event.data as JsonValue) };
    this.#ctx.emit(stamped as unknown as RuntimeEvent);
  }

  // ── layer 5 (DESIGN 3.7): per-request evidence from the guard fetch, asserted HERE ──

  #assertProviderRequest(frame: ProviderRequestFrame): void {
    const { auth } = this.request;
    const problems: string[] = [];
    let pinnedOrigin = '';
    try {
      pinnedOrigin = new URL(auth.baseUrl).origin;
    } catch {
      problems.push('the pinned endpoint is not a URL');
    }
    if (frame.origin !== pinnedOrigin)
      problems.push('a model request left for another origin than the pinned endpoint');
    if (frame.refused) problems.push('the guard refused a model request');
    if (auth.mode === 'subscription' && frame.authScheme !== 'bearer-jwt')
      problems.push(`subscription mode sends a bearer token, the request carried '${frame.authScheme}'`);
    if (auth.mode === 'api' && frame.authScheme === 'none') problems.push('an api-mode request carried no credential');
    if (problems.length > 0)
      this.#block(
        errorOf('security/auth-mode-violation', problems.join('; '), { details: { requestId: frame.requestId } }),
      );
  }

  #assertResponded(data: RuntimeEventOf<'model.responded'>['data']): ErrorInfo | undefined {
    const { auth, model } = this.request;
    const mint = (message: string): ErrorInfo =>
      errorOf('security/auth-mode-violation', message, { details: { requestId: data.requestId } });
    // A request that really left the process has a status or an answer. Without the guard's frame for it, the only
    // evidence would be the child's own echo.
    const left = data.httpStatus !== undefined || data.error === undefined;
    if (left && !this.#providerRequests.has(data.requestId))
      return mint('a model request has no matching provider.request frame from the guard fetch');
    if (data.effectiveModel.provider !== model.provider || data.effectiveModel.model !== model.model)
      return mint('the model that answered is not the requested one');
    if (data.authMode !== auth.mode || data.authSource !== (auth.mode === 'subscription' ? 'oauth' : 'api-key'))
      return mint(`the request was not made in ${auth.mode} mode`);
    return undefined;
  }

  // ── tools (DESIGN 3.5) ──

  #onToolCall(frame: ToolCallFrame): void {
    if (frame.ordinal !== this.#lastOrdinal + 1) {
      this.#block(protocolViolation('ordinal-gap', `ordinal ${frame.ordinal} after ${this.#lastOrdinal}`));
      return;
    }
    this.#lastOrdinal = frame.ordinal;
    if (!this.request.tools.some((grant) => grant.tool === frame.tool)) {
      this.#block(protocolViolation('unknown-tool', 'the agent process proposed a tool that was not granted'));
      return;
    }
    this.#usage.toolCalls += 1;
    const { maxToolCalls } = this.request.budget;
    if (maxToolCalls !== undefined && this.#usage.toolCalls > maxToolCalls)
      this.#breach(errorOf('budget/tool-calls-exhausted', `more than ${maxToolCalls} tool calls`));
    if (this.#cause || this.#terminated) {
      this.#refuse(frame);
      return;
    }
    if (this.#paused) this.#queued.push(frame);
    else this.#dispatch(frame);
  }

  #toolCallId(frame: ToolCallFrame): ToolCallId {
    return `tc_${this.request.incarnation}_${frame.ordinal}` as ToolCallId;
  }

  /** A denied tool alone lets the model keep trying: the answer ends the loop, and `abort` is already on its way. */
  #refuse(frame: ToolCallFrame): void {
    this.#send({
      t: 'tool.result',
      toolCallId: this.#toolCallId(frame),
      isError: true,
      content: [{ type: 'text', text: this.#ctx.seal.text('[cohorte] this agent was stopped by its host') }],
      terminate: true,
    });
  }

  #dispatch(frame: ToolCallFrame): void {
    const { runId, agentId, incarnation } = this.request;
    const toolCallId = this.#toolCallId(frame);
    const call: RuntimeToolCall = {
      runId,
      agentId,
      incarnation,
      toolCallId,
      engineToolCallId: frame.engineToolCallId,
      ordinal: frame.ordinal,
      tool: frame.tool,
      input: frame.input,
    };
    // The event is sealed; the host gets the input as the model produced it and re-validates it strictly.
    this.#emit('tool.call.requested', { call: { ...call, input: this.#ctx.seal.json(frame.input) } });
    const controller = new AbortController();
    const startedMs = this.#ctx.bindings.clock.monotonicMs();
    this.#pending.set(toolCallId, { controller, engineToolCallId: frame.engineToolCallId, startedMs });
    const context = {
      signal: controller.signal,
      progress: (update: { text?: string; bytes?: number }): void => {
        if (this.#pending.has(toolCallId))
          this.#emit('tool.call.progress', { toolCallId, update: this.#ctx.seal.json(update) });
      },
    };
    let answer: Promise<RuntimeToolResult>;
    try {
      answer = this.#ctx.bindings.toolHost.handleToolCall(call, context);
    } catch (thrown) {
      answer = Promise.reject(thrown);
    }
    void answer.then(
      (result) => this.#deliver(toolCallId, result),
      (thrown: unknown) => {
        // A rejection is a host bug (DESIGN 2.2.2): the call is answered as an error and the agent fails.
        if (!this.#pending.delete(toolCallId) || this.over) return;
        this.#refuse(frame);
        this.#stop({
          outcome: 'failed',
          stop: 'host-terminated',
          error: toErrorInfo(thrown, { code: 'tool-terminal/unexpected', class: 'tool-terminal' }),
        });
      },
    );
  }

  #deliver(toolCallId: ToolCallId, result: RuntimeToolResult): void {
    const entry = this.#pending.get(toolCallId);
    if (!entry || this.over) return;
    this.#pending.delete(toolCallId);
    // Settled as aborted by the ladder: the child has abandoned the call, nothing is delivered.
    if (entry.controller.signal.aborted) return;
    const terminate = result.terminate === true;
    this.#send({
      t: 'tool.result',
      toolCallId,
      isError: result.isError,
      content: result.content,
      terminate,
      ...(result.resultRef === undefined ? {} : { resultRef: result.resultRef }),
    });
    // The first accepted terminal result is final, even when the model batched it with another call [X].
    this.#terminated ||= terminate;
    // Emitted in the same tick as the hand-over to the channel: nothing the child does with the result comes first.
    this.#emit('tool.call.delivered', {
      toolCallId,
      isError: result.isError,
      terminate,
      waitedMs: Math.max(0, this.#ctx.bindings.clock.monotonicMs() - entry.startedMs),
    });
  }

  #abortPending(reason: string): void {
    for (const { controller } of this.#pending.values()) controller.abort(reason);
  }

  // ── commands ──

  async send(message: RuntimeMessage): Promise<void> {
    if (this.over) throw new CohorteError(errorOf('conflict/not-running', 'the agent has exited'));
    const id = this.#nextId('send');
    const text = message.kind === 'host-note' ? `[cohorte] ${message.text}` : message.text;
    const response = await this.#ask(
      { t: 'send', id, messageId: message.messageId, text, delivery: message.delivery },
      id,
    );
    if (!response?.ok)
      throw new CohorteError(
        response?.error
          ? this.#sealedInfo(response.error)
          : errorOf('timeout/agent', 'the agent process did not acknowledge the message'),
      );
  }

  pause(): void {
    if (this.over || this.#paused) return;
    // Tool boundary, always available: from now on no `tool.call` becomes a handleToolCall. An in-flight host
    // operation completes and its result is delivered.
    this.#paused = true;
    this.#pausedAt = 'tool-boundary';
    this.#send(this.#ctx.modelBoundary === 'park' ? { t: 'pause' } : { t: 'stop-after-turn', reason: 'pause' });
    this.#emit('agent.paused', { at: 'tool-boundary' });
  }

  resume(): void {
    if (this.over || !this.#paused) return;
    this.#paused = false;
    this.#pausedAt = undefined;
    // A child parked by `stop-after-turn` re-prompts itself with the `[cohorte] continue` note (DESIGN 3.5).
    this.#send({ t: 'resume' });
    this.#emit('agent.resumed', {});
    for (const frame of this.#queued.splice(0)) this.#dispatch(frame);
  }

  /** The ladder (DESIGN 3.5). Resolves when the incarnation is over. */
  cancel(reason: string): Promise<void> {
    this.#stop({ outcome: 'cancelled', stop: 'cancelled' }, reason);
    return this.done;
  }

  async inspect(): Promise<RuntimeSnapshot> {
    const { request } = this;
    let child: JsonValue | undefined;
    if (this.#phase === 'running') {
      const id = this.#nextId('inspect');
      const response = await this.#ask({ t: 'inspect', id }, id, Math.min(this.#ctx.timings.responseMs, 1_000));
      if (response?.ok && response.data !== undefined) child = this.#ctx.seal.json(response.data);
    }
    const state: RuntimeSnapshot['state'] = this.over
      ? 'exited'
      : this.#phase !== 'running'
        ? 'starting'
        : this.#paused
          ? 'paused'
          : this.#cause
            ? 'settling'
            : this.#pending.size > 0
              ? 'awaiting-tool'
              : 'running';
    return {
      runId: request.runId,
      agentId: request.agentId,
      incarnation: request.incarnation,
      state,
      ...(this.#paused && this.#pausedAt ? { pausedAt: this.#pausedAt } : {}),
      turn: this.#turn,
      pendingToolCalls: [...this.#pending.keys()],
      requestedModel: request.model,
      ...(this.#effectiveModel ? { effectiveModel: this.#effectiveModel, authMode: request.auth.mode } : {}),
      usage: this.#usageNow(),
      session: this.handle.session,
      lastSeq: Math.max(0, this.#seq - 1),
      diagnostics: {
        ...this.#ctx.diagnostics,
        pid: this.#child.pid ?? 0,
        transport: this.#ctx.transport,
        ...(this.#rssMb === undefined ? {} : { rssMb: this.#rssMb }),
        ...(this.#lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: this.#lastHeartbeatAt }),
        ...(child === undefined ? {} : { child }),
      },
    };
  }

  // ── stopping ──

  #breach(error: ErrorInfo): void {
    this.#stop({ outcome: 'failed', stop: 'budget', error });
  }

  /** Records the typed cause BEFORE acting, settles pending calls FIRST, then walks the ladder. */
  #stop(cause: Cause, reason: string = cause.stop): void {
    if (this.over || this.#cause) return;
    this.#cause = cause;
    if (this.#phase !== 'running') {
      this.#kill();
      return;
    }
    // A gate that never releases would make the engine's abort hang: pending calls are settled as aborted first.
    this.#abortPending(reason);
    for (const frame of this.#queued.splice(0)) this.#refuse(frame);
    this.#send({ t: 'abort', id: this.#nextId('abort'), reason });
    const { abortGraceMs, termGraceMs } = this.#ctx.timings;
    this.#timers.add(
      setTimeout(() => {
        this.#signalGroup('SIGTERM');
        this.#timers.add(setTimeout(() => this.#signalGroup('SIGKILL'), termGraceMs));
      }, abortGraceMs),
    );
  }

  /** A child that broke the protocol, the attestation or the auth mode gets no courtesy. */
  #block(error: ErrorInfo): void {
    if (this.over) return;
    this.#cause = { outcome: 'failed', stop: 'host-terminated', error };
    this.#log('error', `${error.code}: ${error.message}`, { source: 'runtime-parent' });
    this.#kill();
  }

  #kill(): void {
    this.#signalGroup('SIGKILL');
    void this.#conclude(this.#cause ?? { outcome: 'crashed', stop: 'process-exit' }, { clean: false });
  }

  #signalGroup(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  }

  #onChannelClosed(): void {
    if (this.over) return;
    // `disconnect` (or fd EOF) means the peer died; a live child without a channel is of no use, and not trusted.
    void this.#conclude(
      {
        outcome: 'crashed',
        stop: 'process-exit',
        error: processExitError(this.#gone ? 'exit-without-settled' : 'disconnect'),
      },
      { clean: false },
    );
  }

  async #conclude(draft: Cause, how: { clean: boolean; usage?: UsageTotals }): Promise<void> {
    if (this.over) return;
    const startedUp = this.#phase === 'running';
    this.#phase = 'over';
    clearTimeout(this.#handshakeTimer);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#abortPending('the agent exited');
    for (const release of this.#responses.values()) release(undefined);
    const final = this.#cause ?? draft;
    // The engine's own counters are worth having only when THIS side recorded no cause of its own; a breach, a block
    // or a ladder walk makes the parent's counters the authoritative ones. Decided here, while `#cause` still means
    // "the parent had a cause": the line below assigns it in every case.
    const engineUsage = this.#cause ? undefined : how.usage;

    if (how.clean) void this.#transport.send(this.#logged({ t: 'shutdown' }));
    await this.#reap(how.clean);
    this.#transport.close();
    await new Promise<void>((resolve) => this.#wireLog.end(resolve));

    this.#cause = final;
    if (!startedUp || !this.#handle) {
      this.#handshake?.reject(new CohorteError(final.error ?? processExitError('spawn-failed')));
      this.#handshake = undefined;
      this.#settleDone();
      return;
    }
    const usage = engineUsage ?? this.#usageNow();
    const exit: AgentExit = {
      outcome: final.outcome,
      stop: final.stop,
      ...(final.error ? { error: final.error } : {}),
      usage,
      lastSeq: this.#seq,
    };
    this.#emit('agent.exited', exit);
    this.#settleExit(exit);
    this.#settleDone();
  }

  /** After `settled` the child leaves by itself; anything else, and whatever it left behind, is signalled away. */
  async #reap(clean: boolean): Promise<void> {
    const { exitGraceMs, termGraceMs } = this.#ctx.timings;
    const goneWithin = (ms: number): Promise<boolean> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        void this.#processGone.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    if (clean && (this.#gone || (await goneWithin(exitGraceMs)))) return;
    if (!this.#gone && clean) {
      this.#signalGroup('SIGTERM');
      await goneWithin(termGraceMs);
    }
    // Also the sweep of descendants that outlived the leader (the brain has none by design; a hostile one might).
    this.#signalGroup('SIGKILL');
    if (this.#child.pid !== undefined) await this.#processGone;
  }

  // ── helpers ──

  #usageNow(): UsageTotals {
    return {
      ...this.#usage,
      tokens: { ...this.#usage.tokens },
      wallClockMs: Math.max(0, Math.round(this.#ctx.bindings.clock.monotonicMs() - this.#startedMs)),
    };
  }

  #classified(signal: ErrorSignal): ErrorInfo {
    const headers = this.#lastRequestId === undefined ? undefined : this.#responseHeaders.get(this.#lastRequestId);
    const info = classify({ ...signal, text: this.#ctx.seal.text(signal.text) }, headers ? { headers } : {});
    // DESIGN 3.8, fifth row: an error the table has no row for fails towards the human AND leaves a trace, so that
    // the table gets its row. `classify` is pure, so the trace is left here, at its only call site. Before the agent
    // is running the host has been told of no incarnation (`agent.spawned` is not out, and the spawn is about to
    // reject), so the trace is a LOG line there: a durable event must never name an agent that never started.
    if (info.details?.unclassified === true) {
      const message = `the error table has no row for this signal (${signal.modelsErrorCode ?? 'no engine code'}, ${signal.origin})`;
      if (this.#phase === 'running') this.#emit('runtime.warning', { code: 'error-unclassified', message });
      else this.#log('warn', message, { source: 'runtime-parent', code: 'error-unclassified' });
    }
    return info;
  }

  #errorOfFatal(frame: Extract<ChildFrame, { t: 'fatal' }>): ErrorInfo {
    return frame.signal ? this.#classified(frame.signal) : this.#sealedInfo(frame.error);
  }

  /** The child's own typed error, re-minted: it keeps its class, its text is sealed (I2, I7). */
  #sealedInfo(info: ErrorInfo): ErrorInfo {
    const sealed = this.#ctx.seal.json(info as unknown as JsonValue) as unknown as ErrorInfo;
    return toErrorInfo(new CohorteError(sealed), { code: 'configuration/engine-init', class: 'configuration' });
  }

  #ask(frame: ParentFrame, id: string, timeoutMs = this.#ctx.timings.responseMs): Promise<ResponseFrame | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), timeoutMs);
      this.#timers.add(timer);
      const settle = (response: ResponseFrame | undefined): void => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        this.#responses.delete(id);
        resolve(response);
      };
      this.#responses.set(id, settle);
      this.#send(frame);
    });
  }

  #nextId(kind: string): string {
    this.#requestSerial += 1;
    return `${kind}_${this.#requestSerial}`;
  }

  #send(frame: ParentFrame): void {
    void this.#transport.send(this.#logged(frame));
  }

  #logged(frame: ParentFrame): ParentFrame {
    this.#logWire('out', { frame: frame as unknown as JsonValue });
    return frame;
  }

  /** The host-protocol wire log = the replay fixture of the fake brain. Sealed like everything that reaches a disk. */
  #logWire(dir: 'in' | 'out', entry: { [member: string]: JsonValue }): void {
    if (this.#wireLog.writableEnded) return;
    const line = JSON.stringify(this.#ctx.seal.json({ at: this.#ctx.bindings.clock.now(), dir, ...entry }));
    this.#wireLog.write(`${line}\n`);
  }

  #log(level: 'debug' | 'info' | 'warn' | 'error', text: string, fields: Record<string, JsonValue>): void {
    const { runId, agentId, incarnation } = this.request;
    this.#ctx.bindings.log(level, this.#ctx.seal.text(text), { runId, agentId, incarnation, ...fields });
  }

  #envelope<T extends RuntimeEventType>(type: T, at: IsoInstant = this.#ctx.bindings.clock.now()) {
    const { runId, agentId, incarnation } = this.request;
    const seq = this.#seq;
    this.#seq += 1;
    return { type, durability: RUNTIME_EVENT_TYPES[type].durability, runId, agentId, incarnation, seq, at };
  }

  #emit<T extends RuntimeEventType>(type: T, data: RuntimeEventOf<T>['data']): void {
    this.#ctx.emit({ ...this.#envelope(type), data } as unknown as RuntimeEvent);
  }
}
