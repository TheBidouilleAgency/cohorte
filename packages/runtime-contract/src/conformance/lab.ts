// The bench one conformance rule runs on: a temp dir with the three host-rendered files, a controllable ToolHost,
// and ONE timeline that interleaves runtime events with handler activity, so that order can be asserted.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentId,
  CohorteError,
  createUuidV7IdSource,
  type JsonValue,
  type RunId,
  type SealedText,
  type Sha256,
  systemClock,
} from '@cohorte/base';
import type { RuntimeEvent, RuntimeEventOf, RuntimeEventType } from '../events.ts';
import type { AgentRuntime, RuntimeHostBindings } from '../runtime.ts';
import type { AgentExit, RuntimeAgentHandle } from '../session.ts';
import type { SpawnRequest, TaskInput } from '../spawn.ts';
import type { RuntimeToolCall, RuntimeToolResult, ToolCallContext, ToolGrant } from '../tools.ts';

/** What the scripted model answers to its k-th request: some text, then tool calls in order. No tool call = it stops. */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: { tool: string; input: JsonValue }[];
}
/** Request k (1-based) is answered by `turns[k - 1]`; past the end the model answers an empty final turn. */
export interface BrainScript {
  turns: ScriptedTurn[];
}

export interface ModelInputMessage {
  role: 'user' | 'assistant' | 'tool-result';
  text: string;
}
/** What the model was given for ONE request, as the engine sent it. */
export interface ModelInput {
  systemPrompt: string;
  messages: ModelInputMessage[];
}

export interface AgentKey {
  runId: RunId;
  agentId: AgentId;
  incarnation: number;
}

export interface RuntimeFactoryContext {
  /** The suite's bindings: its ToolHost is the only way a scripted tool call may be answered (rule C1). */
  bindings: RuntimeHostBindings;
  /** The runtime under test arranges for its model to follow this script, for every agent spawned on it. */
  script: BrainScript;
}
/** A FRESH runtime per call. The suite closes it. */
export type RuntimeFactory = (context: RuntimeFactoryContext) => Promise<AgentRuntime>;

export interface ConformanceOptions {
  /** Every model input recorded for that agent so far, oldest first (rules 10 and 12). */
  modelProbe(agent: AgentKey): ModelInput[] | Promise<ModelInput[]>;
  /** Mints the sealed text of the suite's tool results and log lines (testkit `sealedText`, or a real Redactor). */
  seal(text: string): SealedText;
  /** What the runtime under test needs to accept a spawn: its model, its resolved endpoint, its isolation. */
  spawn?: Partial<Pick<SpawnRequest, 'role' | 'model' | 'auth' | 'sandbox' | 'thinking'>>;
  /** How long the suite waits for something that MUST happen (also the declared cancel bound). Default 10 000. */
  boundMs?: number;
  /** How long nothing may happen where the contract says so. Default 150. */
  quietMs?: number;
  /** Appended to the describe title when one test file runs the suite more than once. */
  label?: string;
}

export class ConformanceViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceViolation';
  }
}

export function violation(message: string): never {
  throw new ConformanceViolation(message);
}

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) violation(message);
}

export const ECHO_TOOL = 'conformance_echo';
export const HOLD_TOOL = 'conformance_hold';
export const UNGRANTED_TOOL = 'conformance_not_granted';

const flatInput: JsonValue = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
export const GRANTS: ToolGrant[] = [
  { tool: ECHO_TOOL, description: 'Answers at once.', inputSchema: flatInput, effect: 'read', terminal: false },
  {
    tool: HOLD_TOOL,
    description: 'Answers when the suite says so.',
    inputSchema: flatInput,
    effect: 'read',
    terminal: false,
  },
];

// Multi-byte characters, trailing blanks and newlines: a runtime that trims or re-encodes is caught by rule 12.
export const SYSTEM_PROMPT_TEXT = 'You are a conformance probe.\n\nÉtape 1 : répondre — exactement.\n';
export const TASK_TEXT = '# Task\n\nDo the thing, «exactly».\n  \n';
export const NOTE_TEXT = '# Continuation\n\nThe previous incarnation stopped after two writes.\t\n';
export const CONTEXT_CANARIES = ['CANARY-context-entry-source-7f3a', 'CANARY-context-entry-id-91bc'] as const;

export const sha256Of = (text: string): Sha256 => createHash('sha256').update(text, 'utf8').digest('hex') as Sha256;

export type TimelineItem =
  | { kind: 'event'; event: RuntimeEvent }
  | { kind: 'handler-start'; call: RuntimeToolCall; signal: AbortSignal }
  | { kind: 'handler-end'; toolCallId: string };

export type ToolHandler = (call: RuntimeToolCall, ctx: ToolCallContext) => Promise<RuntimeToolResult>;

export interface Latch {
  readonly opened: Promise<void>;
  open(): void;
}
export function latch(): Latch {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The code of the CohorteError a promise rejects with; a violation when it resolves or rejects with anything else. */
export async function rejectionCode(promise: Promise<unknown>, what: string): Promise<string> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) violation(`${what}: expected a rejection, the call resolved`);
  if (thrown instanceof CohorteError) return thrown.info.code;
  return violation(`${what}: expected a CohorteError, got ${thrown instanceof Error ? thrown.name : typeof thrown}`);
}

export class Lab {
  readonly timeline: TimelineItem[] = [];
  readonly runId: RunId;
  readonly dir: string;
  readonly boundMs: number;
  readonly quietMs: number;
  readonly bindings: RuntimeHostBindings;
  /** Replaced by a rule that needs the host to hold, fail or answer something specific. */
  handler: ToolHandler;
  #runtime: AgentRuntime | undefined;
  #unsubscribe: (() => void) | undefined;
  #waiters = new Set<() => void>();
  readonly #options: ConformanceOptions;
  readonly #files: { prompt: TaskInput; task: TaskInput; note: TaskInput; canarySource: string };

  constructor(options: ConformanceOptions) {
    this.#options = options;
    this.boundMs = options.boundMs ?? 10_000;
    this.quietMs = options.quietMs ?? 150;
    const ids = createUuidV7IdSource();
    this.runId = ids.next<'RunId'>('run');
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-conformance-')));
    this.#files = {
      prompt: this.#write('system-prompt.md', SYSTEM_PROMPT_TEXT),
      task: this.#write('task.md', TASK_TEXT),
      note: this.#write('note.md', NOTE_TEXT),
      canarySource: this.#write('context-source.md', `never shown to the model: ${CONTEXT_CANARIES[0]}\n`).path,
    };
    this.handler = async (call) => this.result(`echo:${call.toolCallId}`);
    this.bindings = {
      toolHost: { handleToolCall: (call, ctx) => this.#handle(call, ctx) },
      stateDir: (runId, agentId, incarnation) => {
        const dir = join(this.dir, 'state', runId, agentId, String(incarnation));
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      clock: systemClock,
      ids,
      log: () => {},
    };
  }

  get runtime(): AgentRuntime {
    if (!this.#runtime) throw new Error('Lab.open() was not awaited');
    return this.#runtime;
  }

  async open(factory: RuntimeFactory, script: BrainScript): Promise<this> {
    this.#runtime = await factory({ bindings: this.bindings, script });
    this.#unsubscribe = this.#runtime.subscribe((event) => this.#push({ kind: 'event', event }));
    return this;
  }

  result(text: string, isError = false): RuntimeToolResult {
    return { isError, content: [{ type: 'text', text: this.#options.seal(text) }] };
  }

  key(agentId: AgentId, incarnation = 1): AgentKey {
    return { runId: this.runId, agentId, incarnation };
  }

  /** A complete, valid request. `name` keeps agents of one lab apart. */
  request(name: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
    const { prompt, task, canarySource } = this.#files;
    const entrySha = sha256Of(`never shown to the model: ${CONTEXT_CANARIES[0]}\n`);
    return {
      runId: this.runId,
      agentId: `agt_conformance_${name}` as AgentId,
      role: 'conformance',
      model: { provider: 'conformance', model: 'scripted' },
      systemPrompt: { id: 'conformance', ...prompt },
      context: {
        manifestSha256: sha256Of('conformance manifest'),
        tokenLimit: 100_000,
        tokenEstimate: 64,
        entries: [
          {
            id: CONTEXT_CANARIES[1],
            tier: 'data',
            trust: 'untrusted-repository',
            source: { kind: 'project-file', ref: canarySource },
            sha256: entrySha,
            bytes: Buffer.byteLength(`never shown to the model: ${CONTEXT_CANARIES[0]}\n`),
            tokenEstimate: 12,
          },
        ],
        reductions: [],
        exclusions: [],
      },
      tools: GRANTS,
      sandbox: {
        require: 'process',
        filesystem: { readOnly: [this.dir], readWrite: [join(this.dir, 'state')], denyRead: [] },
        network: { mode: 'none', allowHosts: [] },
        env: { allow: ['PATH'], set: {} },
        limits: {},
      },
      budget: { maxEngineRetries: 0 },
      workingDirectory: join(this.dir, 'work'),
      incarnation: 1,
      thinking: 'off',
      auth: {
        mode: 'subscription',
        provider: 'conformance',
        baseUrl: 'https://conformance.invalid/v1',
        allowApiKey: false,
      },
      task,
      continuation: null,
      ...this.#options.spawn,
      ...overrides,
    };
  }

  get note(): TaskInput {
    return this.#files.note;
  }

  modelInputs(agent: AgentKey): Promise<ModelInput[]> {
    return Promise.resolve(this.#options.modelProbe(agent));
  }

  eventsOf<T extends RuntimeEventType>(agentId: AgentId, type: T): RuntimeEventOf<T>[] {
    return this.events(agentId).filter((event): event is RuntimeEventOf<T> => event.type === type);
  }

  events(agentId: AgentId): RuntimeEvent[] {
    return this.timeline.flatMap((item) =>
      item.kind === 'event' && item.event.agentId === agentId ? [item.event] : [],
    );
  }

  handlerStarts(): Extract<TimelineItem, { kind: 'handler-start' }>[] {
    return this.timeline.filter((item) => item.kind === 'handler-start');
  }

  /** Resolves with the first timeline item (past or future) that matches; a violation after `boundMs`. */
  async waitFor<T extends TimelineItem>(
    what: string,
    matches: (item: TimelineItem) => item is T,
    from = 0,
  ): Promise<T> {
    const deadline = Date.now() + this.boundMs;
    let next = from;
    for (;;) {
      for (; next < this.timeline.length; next += 1) {
        const item = this.timeline[next];
        if (item && matches(item)) return item;
      }
      const left = deadline - Date.now();
      if (left <= 0) violation(`${what}: did not happen within ${this.boundMs} ms`);
      await this.#nextPush(left);
    }
  }

  waitForHandlerStart(what: string, from = 0): Promise<Extract<TimelineItem, { kind: 'handler-start' }>> {
    return this.waitFor(what, (item) => item.kind === 'handler-start', from);
  }

  /** The agent's exit; a violation when it does not settle within `boundMs`. */
  async exitOf(handle: RuntimeAgentHandle, what: string): Promise<AgentExit> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ConformanceViolation(`${what}: exit did not settle within ${this.boundMs} ms`)),
        this.boundMs,
      );
    });
    try {
      return await Promise.race([handle.exit, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Spawns and waits for the exit. */
  async run(request: SpawnRequest, what: string): Promise<AgentExit> {
    const handle = await this.runtime.spawn(request);
    return this.exitOf(handle, what);
  }

  /**
   * `run`, for a script that ends by itself. Resolves with nothing on purpose: Biome 2.5.14 overflows its stack on
   * an `await` STATEMENT whose value holds an ErrorInfo (docs/v3/requests/U0.03.md R1).
   */
  async complete(request: SpawnRequest, what: string): Promise<void> {
    const exit = await this.run(request, what);
    ensure(exit.outcome === 'completed', `${what}: the scripted agent completes, got '${exit.outcome}'`);
  }

  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    try {
      await this.#runtime?.close();
    } finally {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  async #handle(call: RuntimeToolCall, ctx: ToolCallContext): Promise<RuntimeToolResult> {
    this.#push({ kind: 'handler-start', call, signal: ctx.signal });
    try {
      return await this.handler(call, ctx);
    } finally {
      this.#push({ kind: 'handler-end', toolCallId: call.toolCallId });
    }
  }

  #push(item: TimelineItem): void {
    this.timeline.push(item);
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  #nextPush(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, maxMs);
      this.#waiters.add(wake);
    });
  }

  #write(name: string, text: string): TaskInput {
    const path = join(this.dir, name);
    writeFileSync(path, text, 'utf8');
    return { path, sha256: sha256Of(text), bytes: Buffer.byteLength(text, 'utf8') };
  }
}
