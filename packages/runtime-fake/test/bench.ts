// One test's world: a temp dir with the host-rendered files, a recording ToolHost, a clock that only moves when the
// test says so, and every event the runtime emitted. Not collected (no test suffix).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, RunId, Sha256 } from '@cohorte/base';
import type {
  AgentExit,
  AgentRuntime,
  RuntimeEvent,
  RuntimeEventOf,
  RuntimeEventType,
  RuntimeHostBindings,
  RuntimeToolCall,
  RuntimeToolResult,
  SpawnRequest,
  TaskInput,
  ToolCallContext,
  ToolGrant,
} from '@cohorte/runtime-contract';
import { FixedClock, SeqIds, sealedText } from '@cohorte/testkit';
import { test as base } from 'vitest';
import { createFakeRuntimeProvider, type FakeRuntimeProvider } from '../src/fake/index.ts';
import type { FakeScript, FakeStep } from '../src/script/index.ts';

export const BASE_URL = 'https://fake.test.invalid/v1';
export const SYSTEM_PROMPT = 'You are scripted.\n';
export const TASK = '# Task\n\nWrite two files.\n';
export const NOTE = '# Continuation\n\nTwo files were already written.\n';

const sha256 = (text: string): Sha256 => createHash('sha256').update(text, 'utf8').digest('hex') as Sha256;

const flat = { type: 'object', properties: {}, additionalProperties: true };
export const GRANTS: ToolGrant[] = [
  { tool: 'write_file', description: 'Writes.', inputSchema: flat, effect: 'write', terminal: false },
  { tool: 'submit_result', description: 'Delivers the result.', inputSchema: flat, effect: 'control', terminal: true },
];

export type Handler = (call: RuntimeToolCall, ctx: ToolCallContext) => Promise<RuntimeToolResult>;

export const textResult = (text: string, extra: Partial<RuntimeToolResult> = {}): RuntimeToolResult => ({
  isError: false,
  content: [{ type: 'text', text: sealedText(text) }],
  ...extra,
});

export interface Bench {
  readonly dir: string;
  readonly runId: RunId;
  readonly clock: FixedClock;
  readonly events: RuntimeEvent[];
  readonly calls: RuntimeToolCall[];
  readonly signals: AbortSignal[];
  readonly bindings: RuntimeHostBindings;
  /** Replaced by a test that needs the host to deny, hold or terminate. Default: answers `ok:<toolCallId>`. */
  handler: Handler;
  readonly note: TaskInput;
  request(overrides?: Partial<SpawnRequest>): SpawnRequest;
  open(script: FakeScript): Promise<{ provider: FakeRuntimeProvider; runtime: AgentRuntime }>;
  eventsOf<T extends RuntimeEventType>(type: T): RuntimeEventOf<T>[];
  types(): RuntimeEventType[];
  /** Spawns and waits for the exit. */
  run(runtime: AgentRuntime, request: SpawnRequest): Promise<AgentExit>;
  /**
   * `run`, for a test that does not look at the exit. Resolves with nothing on purpose: Biome 2.5.14 overflows its
   * stack on an `await` STATEMENT whose value holds an ErrorInfo (docs/v3/requests/U0.03.md R1).
   */
  complete(runtime: AgentRuntime, request: SpawnRequest): Promise<void>;
  /** Resolves once the ToolHost has been called `count` times. */
  handlerCalled(count: number): Promise<void>;
  dispose(): Promise<void>;
}

export const script = (steps: FakeStep[], match: FakeScript['agents'][number]['match'] = {}): FakeScript => ({
  version: 1,
  agents: [{ match, steps }],
});

export function createBench(): Bench {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-runtime-fake-')));
  const write = (name: string, text: string): TaskInput => {
    const path = join(dir, name);
    writeFileSync(path, text, 'utf8');
    return { path, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') };
  };
  const prompt = write('system-prompt.md', SYSTEM_PROMPT);
  const task = write('task.md', TASK);
  const note = write('note.md', NOTE);
  const clock = new FixedClock();
  const runId = 'run_00000000000000000000000000000001' as RunId;
  const events: RuntimeEvent[] = [];
  const calls: RuntimeToolCall[] = [];
  const signals: AbortSignal[] = [];
  const runtimes: AgentRuntime[] = [];
  let waiters: { count: number; wake: () => void }[] = [];

  const bench: Bench = {
    dir,
    runId,
    clock,
    events,
    calls,
    signals,
    note,
    handler: async (call) => textResult(`ok:${call.toolCallId}`),
    bindings: {
      toolHost: {
        handleToolCall: (call, ctx) => {
          calls.push(call);
          signals.push(ctx.signal);
          const due = waiters.filter((waiter) => waiter.count <= calls.length);
          waiters = waiters.filter((waiter) => waiter.count > calls.length);
          for (const waiter of due) waiter.wake();
          return bench.handler(call, ctx);
        },
      },
      stateDir: (run, agentId, incarnation) => {
        const state = join(dir, 'state', run, agentId, String(incarnation));
        mkdirSync(state, { recursive: true });
        return state;
      },
      clock,
      ids: new SeqIds(),
      log: () => {},
    },
    request: (overrides = {}) => ({
      runId,
      agentId: 'agt_implementer_main' as AgentId,
      role: 'implementer',
      model: { provider: 'fake', model: 'scripted' },
      systemPrompt: { id: 'implementer', ...prompt },
      context: {
        manifestSha256: sha256('manifest'),
        tokenLimit: 100_000,
        tokenEstimate: 10,
        entries: [],
        reductions: [],
        exclusions: [],
      },
      tools: GRANTS,
      sandbox: {
        require: 'process',
        filesystem: { readOnly: [dir], readWrite: [], denyRead: [] },
        network: { mode: 'none', allowHosts: [] },
        env: { allow: ['PATH'], set: {} },
        limits: {},
      },
      budget: { maxEngineRetries: 0 },
      workingDirectory: join(dir, 'work'),
      incarnation: 1,
      thinking: 'off',
      auth: { mode: 'subscription', provider: 'fake', baseUrl: BASE_URL, allowApiKey: false },
      task,
      continuation: null,
      ...overrides,
    }),
    async open(fakeScript) {
      const provider = createFakeRuntimeProvider({ script: fakeScript, baseUrl: BASE_URL, clock });
      const runtime = await provider.create(bench.bindings, await provider.pin());
      runtime.subscribe((event) => events.push(event));
      runtimes.push(runtime);
      return { provider, runtime };
    },
    eventsOf: <T extends RuntimeEventType>(type: T) =>
      events.filter((event): event is RuntimeEventOf<T> => event.type === type),
    types: () => events.map((event) => event.type),
    async run(runtime, request) {
      const handle = await runtime.spawn(request);
      const exit = await handle.exit;
      return exit;
    },
    async complete(runtime, request) {
      const exit = await bench.run(runtime, request);
      if (exit.outcome === 'crashed') throw new Error(`the agent crashed: ${exit.error?.message}`);
    },
    handlerCalled: (count) =>
      calls.length >= count ? Promise.resolve() : new Promise((wake) => waiters.push({ count, wake })),
    async dispose() {
      for (const runtime of runtimes) await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return bench;
}

/** Per-test bench (`rig`: vitest's own context already has a `bench`), closed and removed afterwards: no fixture state is shared between tests. */
export const test = base.extend<{ rig: Bench }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest requires a destructured first argument for fixtures
  rig: async ({}, use) => {
    const bench = createBench();
    await use(bench);
    await bench.dispose();
  },
});
