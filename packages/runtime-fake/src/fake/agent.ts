// One scripted incarnation: a step interpreter. It arms no timer and draws no random number of its own: time is the
// injected Clock, ids come from the injected IdSource, and every tool step is answered by the real ToolHost (C1).
//
// How a flat step list becomes turns: a turn is ONE model request, the assistant message (`say` / `think`), then its
// tool calls. `model-request` opens a turn explicitly; otherwise one opens before the first content step, and again
// when text follows a tool call (a model only speaks again after it was given the results).
import { appendFileSync } from 'node:fs';
import {
  type ErrorInfo,
  errorOf,
  isErrorCode,
  sha256Hex,
  type TokenUsage,
  type ToolCallId,
  toErrorInfo,
} from '@cohorte/base';
import {
  type AgentExit,
  type AgentStopCause,
  type EffectiveModel,
  PREVIEW_MAX_LENGTH,
  RUNTIME_EVENT_TYPES,
  type RuntimeEvent,
  type RuntimeEventOf,
  type RuntimeEventType,
  type RuntimeHostBindings,
  type RuntimeMessage,
  type RuntimeSessionRef,
  type RuntimeSnapshot,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type SpawnRequest,
  type ToolProgress,
  type UsageTotals,
} from '@cohorte/runtime-contract';
import type { FakeAgentRule, FakeScript, FakeStep, FakeStepOf } from '../script/index.ts';

export interface FakeModelInputMessage {
  role: 'user' | 'assistant' | 'tool-result';
  text: string;
}
/** What the scripted model was given for ONE request (the conformance suite's `ModelInput`, structurally). */
export interface FakeModelInput {
  systemPrompt: string;
  messages: FakeModelInputMessage[];
}

/** The tool a `submit` step calls when the request grants no terminal tool (DESIGN 2.7). */
export const DEFAULT_RESULT_TOOL = 'submit_result';
export const HOST_NOTE_PREFIX = '[cohorte] ';

export interface FakeAgentInit {
  request: SpawnRequest;
  rule: FakeAgentRule;
  defaults: FakeScript['defaults'];
  texts: { systemPrompt: string; task: string; note: string | null };
  session: RuntimeSessionRef;
  bindings: RuntimeHostBindings;
  publish(event: RuntimeEvent): void;
  /** Where the recorded model inputs of this incarnation go (the provider's probe). */
  inputs: FakeModelInput[];
}

type ModelRequestOptions = Omit<FakeStepOf<'model-request'>, 'do'>;

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function completeUsage(base: TokenUsage, tokens: Partial<TokenUsage>): TokenUsage {
  const merged = { ...base, ...tokens };
  // Untouched defaults are reported as written; a `usage` step that gives parts and no total means their sum.
  const sum = merged.input + merged.output + merged.cacheRead + merged.cacheWrite;
  const total = tokens.total ?? (Object.keys(tokens).length === 0 ? base.total : sum);
  return { ...merged, total };
}

function scriptedError(scripted: FakeStepOf<'fail'>['error'], message: string): ErrorInfo {
  const extra = scripted.retryAfterMs === undefined ? {} : { retryAfterMs: scripted.retryAfterMs };
  if (isErrorCode(scripted.code)) {
    const info = errorOf(scripted.code, message, extra);
    if (info.class === scripted.class) return { ...info, retryable: scripted.retryable };
  }
  return {
    code: scripted.code,
    class: scripted.class,
    message,
    impact: 'The fake runtime script made this model request fail.',
    retryable: scripted.retryable,
    ...extra,
    remediation: 'Nothing to do in a scripted run; edit the fake runtime script if the failure is not intended.',
  };
}

/** Awaited as a statement, so it must resolve with nothing: Biome 2.5.14 overflows otherwise (requests/U0.03.md R1). */
const settled = (promise: Promise<unknown>): Promise<void> =>
  promise.then(
    () => undefined,
    () => undefined,
  );

const textOf = (result: RuntimeToolResult): string =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

export class FakeAgent {
  readonly request: SpawnRequest;
  readonly session: RuntimeSessionRef;
  readonly #init: FakeAgentInit;
  readonly #conversation: FakeModelInputMessage[];
  readonly #pending = new Map<ToolCallId, AbortController>();
  readonly #inbox: RuntimeMessage[] = [];
  readonly #cancelled = new AbortController();
  readonly #startedMs: number;

  #seq = 0;
  #turns = 0;
  #modelRequests = 0;
  #toolCalls = 0;
  #tokens: TokenUsage = ZERO;
  #exit: AgentExit | null = null;
  #effectiveModel: EffectiveModel | undefined;

  #paused: { at: 'tool-boundary' | 'model-boundary'; resumed: Promise<void>; resume: () => void } | null = null;
  #inboxWaiter: (() => void) | null = null;

  #turnOpen = false;
  #turnToolCalls = 0;
  #turnStop: 'stop' | 'tool-use' = 'stop';
  #message: { id: string; text: string; parts: number } | null = null;
  #pendingRequest: ModelRequestOptions | null = null;
  #nextUsage: Partial<TokenUsage> | null = null;
  #crashDuringNextTool = false;

  constructor(init: FakeAgentInit) {
    this.#init = init;
    this.request = init.request;
    this.session = init.session;
    this.#startedMs = init.bindings.clock.monotonicMs();
    this.#conversation = [{ role: 'user', text: init.texts.task }];
    if (init.texts.note !== null) this.#conversation.push({ role: 'user', text: init.texts.note });
    for (const message of this.#conversation) this.#transcribe(message);
  }

  get exited(): boolean {
    return this.#exit !== null;
  }

  emitSpawned(): void {
    const { request, session, texts } = this.#init;
    this.#emit('agent.spawned', {
      session,
      requestedModel: request.model,
      tools: request.tools.map((grant) => grant.tool),
      systemPromptSha256: request.systemPrompt.sha256,
      // the fake appends no engine suffix: what the model sees IS the PromptRef
      effectiveSystemPromptSha256: sha256Hex(texts.systemPrompt),
      isolation: { level: 'none', filesystem: 'advisory', network: 'none', backend: 'in-process' },
    });
  }

  /** Never rejects: whatever goes wrong inside the interpreter is the exit of this agent. */
  async run(): Promise<AgentExit> {
    try {
      this.#emit('agent.started', { taskSha256: this.request.task.sha256 });
      // Every awaited AgentExit is bound to a name: Biome 2.5.14 overflows its stack otherwise (requests/U0.03.md R1).
      const stopped = await this.#runSteps(this.#init.rule.steps);
      if (stopped) return stopped;
      const ended = await this.#endOfScript();
      return ended;
    } catch (thrown) {
      if (this.#exit) return this.#exit;
      const error = toErrorInfo(thrown, { code: 'configuration/unexpected', class: 'configuration' });
      return this.#finish('failed', 'engine-error', error);
    }
  }

  cancel(): void {
    if (this.exited || this.#cancelled.signal.aborted) return;
    this.#cancelled.abort();
    for (const controller of this.#pending.values()) controller.abort();
    this.#paused?.resume();
    this.#inboxWaiter?.();
  }

  pause(): void {
    if (this.exited || this.#paused) return;
    let resume: () => void = () => {};
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const at = this.#pending.size > 0 ? 'tool-boundary' : 'model-boundary';
    this.#paused = { at, resumed, resume };
    this.#emit('agent.paused', { at });
  }

  resume(): void {
    if (this.exited || !this.#paused) return;
    const { resume } = this.#paused;
    this.#paused = null;
    this.#emit('agent.resumed', {});
    resume();
  }

  accept(message: RuntimeMessage): void {
    this.#inbox.push(message);
    this.#emit('agent.message.accepted', { messageId: message.messageId, delivery: message.delivery });
    this.#inboxWaiter?.();
  }

  snapshot(): RuntimeSnapshot {
    const { runId, agentId, incarnation, model, auth } = this.request;
    const state = this.exited
      ? 'exited'
      : this.#paused
        ? 'paused'
        : this.#pending.size > 0
          ? 'awaiting-tool'
          : 'running';
    return {
      runId,
      agentId,
      incarnation,
      state,
      ...(this.#paused && !this.exited ? { pausedAt: this.#paused.at } : {}),
      turn: this.#turns,
      pendingToolCalls: [...this.#pending.keys()],
      requestedModel: model,
      ...(this.#effectiveModel ? { effectiveModel: this.#effectiveModel } : {}),
      authMode: auth.mode,
      usage: this.#usage(),
      session: this.session,
      lastSeq: this.#seq,
      diagnostics: { inProcess: true, queuedMessages: this.#inbox.length },
    };
  }

  // ── interpreter ─────────────────────────────────────────────────────────────────────

  /**
   * The exit when a step ended the agent, `null` when the list ran to its end. `tail` is what the parent list runs
   * after a nested `onDenied` list: the look-ahead of a turn opened in the nested list must see it.
   */
  async #runSteps(steps: readonly FakeStep[], tail: readonly FakeStep[] = []): Promise<AgentExit | null> {
    const ahead = tail.length === 0 ? steps : [...steps, ...tail];
    for (const [index, current] of steps.entries()) {
      if (this.#isCancelled) return this.#finishCancelled();
      const over = this.#wallClockExceeded();
      if (over) return over;
      const exit = await this.#runStep(current, ahead, index);
      if (exit) return exit;
    }
    return null;
  }

  async #runStep(current: FakeStep, steps: readonly FakeStep[], index: number): Promise<AgentExit | null> {
    switch (current.do) {
      case 'model-request': {
        const exit = await this.#flushPendingRequest();
        if (exit) return exit;
        this.#closeTurn();
        const { do: _do, ...options } = current;
        this.#pendingRequest = options;
        return null;
      }
      case 'say':
      case 'think': {
        const exit = await this.#ensureTurn(steps, index, this.#turnToolCalls > 0);
        if (exit) return exit;
        this.#speak(current);
        return null;
      }
      case 'tool':
        return this.#callTool(current.tool, current.input, current, steps, index);
      case 'submit': {
        const terminal = this.request.tools.find((grant) => grant.terminal)?.tool ?? DEFAULT_RESULT_TOOL;
        return this.#callTool(terminal, current.output, null, steps, index);
      }
      case 'usage':
        this.#nextUsage = { ...this.#nextUsage, ...current.tokens };
        return null;
      case 'await-message':
        return this.#awaitMessage(current.timeoutMs);
      case 'fail': {
        const options = this.#pendingRequest ?? {};
        this.#pendingRequest = null;
        this.#closeTurn();
        const error = scriptedError(current.error, `scripted failure of model request ${this.#modelRequests + 1}`);
        const refused = await this.#modelRequest(options, 'stop', error);
        return refused ?? this.#finish('failed', 'engine-error', error);
      }
      case 'hang':
        if (current.ms === 'forever') await this.#untilCancelled();
        else await this.#sleep(current.ms);
        return this.#isCancelled ? this.#finishCancelled() : null;
      case 'crash':
        if (current.at === 'during-tool') {
          this.#crashDuringNextTool = true;
          return null;
        }
        return this.#crash('the scripted agent crashed between two steps');
      case 'stop-without-result':
        return this.#endOfScript();
    }
  }

  async #endOfScript(): Promise<AgentExit> {
    if (this.#crashDuringNextTool) return this.#crash('the scripted agent crashed before any further tool call');
    const exit = await this.#flushPendingRequest();
    if (exit) return exit;
    this.#closeTurn();
    if (this.#isCancelled) return this.#finishCancelled();
    return this.#finish('completed', 'model-stop');
  }

  // ── turns and model requests ────────────────────────────────────────────────────────

  /** Does the turn that starts at `steps[from]` call a tool? That is the `stop` of its model response. */
  #stopOfTurn(steps: readonly FakeStep[], from: number): 'stop' | 'tool-use' {
    for (const next of steps.slice(from)) {
      if (next.do === 'tool' || next.do === 'submit') return 'tool-use';
      if (next.do === 'model-request' || next.do === 'await-message' || next.do === 'fail') return 'stop';
      if (next.do === 'stop-without-result' || (next.do === 'crash' && next.at === 'before-next-step')) return 'stop';
    }
    return 'stop';
  }

  /**
   * A scripted `model-request` is only sent when the next step needs it, so that a `fail` right after it IS it.
   * Flushed by a step that closes the turn, the request had no content: its response is an empty final message.
   */
  async #flushPendingRequest(): Promise<AgentExit | null> {
    if (!this.#pendingRequest) return null;
    const options = this.#pendingRequest;
    this.#pendingRequest = null;
    return this.#modelRequest(options, 'stop');
  }

  async #ensureTurn(steps: readonly FakeStep[], index: number, startNew: boolean): Promise<AgentExit | null> {
    if (this.#pendingRequest) {
      const options = this.#pendingRequest;
      this.#pendingRequest = null;
      return this.#modelRequest(options, this.#stopOfTurn(steps, index));
    }
    if (this.#turnOpen && !startNew) return null;
    this.#closeTurn();
    return this.#modelRequest({}, this.#stopOfTurn(steps, index));
  }

  async #modelRequest(
    options: ModelRequestOptions,
    stop: 'stop' | 'tool-use',
    failure?: ErrorInfo,
  ): Promise<AgentExit | null> {
    const { request } = this;
    const { budget } = request;
    if (budget.maxTurns !== undefined && this.#turns >= budget.maxTurns) return this.#finish('completed', 'budget');
    if (budget.maxModelRequests !== undefined && this.#modelRequests >= budget.maxModelRequests)
      return this.#finish('completed', 'budget');
    if (await this.#gate()) return this.#finishCancelled();

    this.#modelRequests += 1;
    const requestId = `req_${request.incarnation}_${this.#modelRequests}`;
    if (!failure) this.#emit('agent.turn.started', { turn: this.#turns + 1 });
    for (const message of this.#inbox.splice(0)) {
      const text = message.kind === 'host-note' ? `${HOST_NOTE_PREFIX}${message.text}` : message.text;
      this.#remember({ role: 'user', text });
    }
    this.#init.inputs.push({
      systemPrompt: this.#init.texts.systemPrompt,
      messages: this.#conversation.map((message) => ({ ...message })),
    });
    this.#emit('model.requested', {
      requestId,
      model: request.model,
      contextSha256: request.context.manifestSha256,
      attempt: 1,
    });

    const usage = completeUsage(this.#init.defaults?.usagePerTurn ?? ZERO, this.#nextUsage ?? {});
    this.#nextUsage = null;
    this.#tokens = {
      input: this.#tokens.input + usage.input,
      output: this.#tokens.output + usage.output,
      cacheRead: this.#tokens.cacheRead + usage.cacheRead,
      cacheWrite: this.#tokens.cacheWrite + usage.cacheWrite,
      total: this.#tokens.total + usage.total,
    };
    this.#effectiveModel = {
      provider: request.model.provider,
      model: this.#init.defaults?.model ?? request.model.model,
      baseUrl: options.baseUrl ?? request.auth.baseUrl,
    };
    this.#emit('model.responded', {
      requestId,
      requestedModel: request.model,
      effectiveModel: this.#effectiveModel,
      // DESIGN 2.2.5: a fake run reports the authMode its plan requested
      authMode: request.auth.mode,
      authSource: options.authSource ?? 'none',
      durationMs: 0,
      usage,
      ...(options.status === undefined ? {} : { httpStatus: options.status }),
      attempt: 1,
      stop: failure ? 'error' : stop,
      quota: options.quota ?? { known: false },
      ...(failure ? { error: failure } : {}),
    });
    if (failure) return null;

    this.#turnOpen = true;
    this.#turnToolCalls = 0;
    this.#turnStop = stop;
    const { maxInputTokens, maxOutputTokens, maxTotalTokens } = budget;
    const spent =
      (maxInputTokens !== undefined && this.#tokens.input > maxInputTokens) ||
      (maxOutputTokens !== undefined && this.#tokens.output > maxOutputTokens) ||
      (maxTotalTokens !== undefined && this.#tokens.total > maxTotalTokens);
    if (!spent) return null;
    this.#closeTurn();
    return this.#finish('completed', 'budget');
  }

  #closeTurn(): void {
    if (!this.#turnOpen) return;
    this.#completeMessage();
    this.#turnOpen = false;
    this.#turns += 1;
    this.#emit('agent.turn.completed', { turn: this.#turns, toolCalls: this.#turnToolCalls });
    this.#turnToolCalls = 0;
  }

  // ── the assistant message of a turn ─────────────────────────────────────────────────

  #openMessage(): { id: string; text: string; parts: number } {
    if (!this.#message) {
      this.#message = { id: `msg_${this.request.incarnation}_${this.#modelRequests}`, text: '', parts: 0 };
      this.#emit('agent.message.started', { messageId: this.#message.id, role: 'assistant' });
    }
    return this.#message;
  }

  #speak(current: FakeStepOf<'say'> | FakeStepOf<'think'>): void {
    const message = this.#openMessage();
    const contentIndex = message.parts;
    message.parts += 1;
    if (current.do === 'think') {
      this.#emit('agent.message.delta', {
        messageId: message.id,
        channel: 'thinking',
        contentIndex,
        delta: current.text,
      });
      return;
    }
    const characters = [...current.text];
    const chunks = Math.min(current.chunks ?? 1, Math.max(characters.length, 1));
    const size = Math.ceil(characters.length / chunks);
    for (let at = 0; at < chunks; at += 1) {
      const delta = characters.slice(at * size, (at + 1) * size).join('');
      if (delta === '' && at > 0) break;
      this.#emit('agent.message.delta', { messageId: message.id, channel: 'text', contentIndex, delta });
    }
    message.text += current.text;
  }

  /** Every model response is exactly one assistant message, empty when the script said nothing. */
  #completeMessage(): void {
    if (!this.#turnOpen) return;
    if (this.#message === null && this.#turnToolCalls > 0) return;
    const { id, text } = this.#openMessage();
    this.#message = null;
    this.#remember({ role: 'assistant', text });
    this.#emit('agent.message.completed', {
      messageId: id,
      role: 'assistant',
      textSha256: sha256Hex(text),
      textBytes: Buffer.byteLength(text, 'utf8'),
      preview: [...text].slice(0, PREVIEW_MAX_LENGTH).join(''),
      stop: this.#turnStop,
    });
  }

  // ── tool calls: ALWAYS through the ToolHost ─────────────────────────────────────────

  async #callTool(
    tool: string,
    input: RuntimeToolCall['input'],
    scripted: FakeStepOf<'tool'> | null,
    steps: readonly FakeStep[],
    index: number,
  ): Promise<AgentExit | null> {
    const opened = await this.#ensureTurn(steps, index, false);
    if (opened) return opened;
    const { maxToolCalls } = this.request.budget;
    if (maxToolCalls !== undefined && this.#toolCalls >= maxToolCalls) {
      this.#closeTurn();
      return this.#finish('completed', 'budget');
    }
    // Before anything is counted or emitted: `tool.call.requested` promises that the ToolHost WILL be called.
    if (await this.#gate()) return this.#finishCancelled();
    if (this.#turnToolCalls === 0) this.#completeMessage();

    this.#toolCalls += 1;
    this.#turnToolCalls += 1;
    const { runId, agentId, incarnation } = this.request;
    const ordinal = this.#toolCalls;
    const toolCallId = `tc_${incarnation}_${ordinal}` as ToolCallId;
    const call: RuntimeToolCall = { runId, agentId, incarnation, toolCallId, ordinal, tool, input };
    this.#emit('tool.call.requested', { call });

    const controller = new AbortController();
    this.#pending.set(toolCallId, controller);
    const askedAt = this.#init.bindings.clock.monotonicMs();
    const progress = (update: ToolProgress): void => {
      if (this.#pending.has(toolCallId)) this.#emit('tool.call.progress', { toolCallId, update });
    };
    let result: RuntimeToolResult;
    let hostBug: unknown;
    try {
      const answer = this.#init.bindings.toolHost.handleToolCall(call, { signal: controller.signal, progress });
      if (this.#crashDuringNextTool) {
        // The brain dies while the host works: the call is abandoned, its result is never delivered.
        controller.abort();
        await settled(answer);
        this.#pending.delete(toolCallId);
        return this.#crash(`the scripted agent crashed during ${toolCallId}`);
      }
      result = await answer;
    } catch (thrown) {
      // DESIGN 2.2.2: a rejection is a host bug; the runtime treats it as isError + agent failure.
      hostBug = thrown;
      result = { isError: true, content: [] };
    }
    this.#pending.delete(toolCallId);
    const waitedMs = Math.max(0, Math.round(this.#init.bindings.clock.monotonicMs() - askedAt));
    this.#emit('tool.call.delivered', {
      toolCallId,
      isError: result.isError,
      terminate: result.terminate === true,
      waitedMs,
    });
    // Byte-identical (conformance rule 10): the sealed text is what the model is given.
    this.#remember({ role: 'tool-result', text: textOf(result) });

    if (hostBug !== undefined) {
      const error = toErrorInfo(hostBug, { code: 'tool-terminal/unexpected', class: 'tool-terminal' });
      return this.#finish('failed', 'engine-error', error);
    }
    if (this.#isCancelled) return this.#finishCancelled();
    if (result.terminate === true) {
      this.#closeTurn();
      return this.#finish('completed', 'host-terminated');
    }
    const unexpected = scripted?.expect ? this.#unexpected(scripted.expect, result, toolCallId) : null;
    if (unexpected) return this.#finish('failed', 'engine-error', unexpected);
    if (result.isError && scripted?.onDenied) return this.#runSteps(scripted.onDenied, steps.slice(index + 1));
    return null;
  }

  #unexpected(
    expected: NonNullable<FakeStepOf<'tool'>['expect']>,
    result: RuntimeToolResult,
    toolCallId: ToolCallId,
  ): ErrorInfo | null {
    const problems: string[] = [];
    if (expected.isError !== undefined && expected.isError !== result.isError)
      problems.push(`isError is ${result.isError}, the script expects ${expected.isError}`);
    if (expected.textIncludes !== undefined && !textOf(result).includes(expected.textIncludes))
      problems.push(`the result text does not include ${JSON.stringify(expected.textIncludes)}`);
    if (problems.length === 0) return null;
    return errorOf(
      'configuration/unexpected',
      `fake script expectation failed for ${toolCallId}: ${problems.join('; ')}`,
    );
  }

  // ── waiting: only on the injected clock, on the host, or on cancel ──────────────────

  get #isCancelled(): boolean {
    return this.#cancelled.signal.aborted;
  }

  #untilCancelled(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#isCancelled) resolve();
      else this.#cancelled.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /** `clock.sleep` rejects when its signal aborts; both ways out are fine here. */
  async #sleep(ms: number, signal: AbortSignal = this.#cancelled.signal): Promise<void> {
    try {
      await this.#init.bindings.clock.sleep(ms, signal);
    } catch {
      // aborted: the caller looks at what woke it
    }
  }

  /** Holds the agent while it is paused. True when it was cancelled meanwhile. */
  async #gate(): Promise<boolean> {
    while (this.#paused && !this.#isCancelled) await this.#paused.resumed;
    return this.#isCancelled;
  }

  async #awaitMessage(timeoutMs: number | undefined): Promise<AgentExit | null> {
    const exit = await this.#flushPendingRequest();
    if (exit) return exit;
    this.#closeTurn();
    if (this.#inbox.length === 0 && !this.#isCancelled) {
      const woken = new AbortController();
      const onCancel = (): void => woken.abort();
      this.#cancelled.signal.addEventListener('abort', onCancel, { once: true });
      const arrived = new Promise<void>((resolve) => {
        this.#inboxWaiter = resolve;
      });
      const waits = [arrived];
      if (timeoutMs !== undefined) waits.push(this.#sleep(timeoutMs, woken.signal));
      await Promise.race(waits);
      this.#inboxWaiter = null;
      this.#cancelled.signal.removeEventListener('abort', onCancel);
      // takes the sleeper off the clock when the message (or the cancel) came first
      woken.abort();
    }
    return this.#isCancelled ? this.#finishCancelled() : null;
  }

  #wallClockExceeded(): AgentExit | null {
    const { maxWallClockMs } = this.request.budget;
    if (maxWallClockMs === undefined || this.#usage().wallClockMs <= maxWallClockMs) return null;
    this.#closeTurn();
    return this.#finish('completed', 'budget');
  }

  // ── exits and events ────────────────────────────────────────────────────────────────

  #crash(message: string): AgentExit {
    if (this.#isCancelled) return this.#finishCancelled();
    this.#pendingRequest = null;
    return this.#finish('crashed', 'process-exit', errorOf('tool-transient/agent-process-exit', message));
  }

  #finishCancelled(): AgentExit {
    return this.#finish('cancelled', 'cancelled');
  }

  #finish(outcome: AgentExit['outcome'], stop: AgentStopCause, error?: ErrorInfo): AgentExit {
    const exit: AgentExit = {
      outcome,
      stop,
      ...(error ? { error } : {}),
      usage: this.#usage(),
      lastSeq: this.#seq + 1,
    };
    this.#emit('agent.exited', exit);
    this.#exit = exit;
    return exit;
  }

  #usage(): UsageTotals {
    return {
      tokens: this.#tokens,
      modelRequests: this.#modelRequests,
      toolCalls: this.#toolCalls,
      turns: this.#turns,
      wallClockMs: Math.max(0, Math.round(this.#init.bindings.clock.monotonicMs() - this.#startedMs)),
    };
  }

  #remember(message: FakeModelInputMessage): void {
    this.#conversation.push(message);
    this.#transcribe(message);
  }

  #transcribe(message: FakeModelInputMessage): void {
    appendFileSync(this.session.transcript.path, `${JSON.stringify(message)}\n`, 'utf8');
  }

  #emit<T extends RuntimeEventType>(type: T, data: RuntimeEventOf<T>['data']): void {
    if (this.exited) return;
    this.#seq += 1;
    const { runId, agentId, incarnation } = this.request;
    const event = {
      type,
      durability: RUNTIME_EVENT_TYPES[type].durability,
      runId,
      agentId,
      incarnation,
      seq: this.#seq,
      at: this.#init.bindings.clock.now(),
      data,
    } as RuntimeEvent;
    this.#init.publish(event);
  }
}
