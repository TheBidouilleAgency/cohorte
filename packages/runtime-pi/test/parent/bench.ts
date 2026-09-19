// The bench of the parent's own tests: a temp root with the three host-rendered files, a recording ToolHost and
// logger, and a provider wired to the engine-free fake brain. Not a test file: nothing here is collected.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentId,
  CohorteError,
  createUuidV7IdSource,
  type JsonValue,
  type RunId,
  type Sha256,
  systemClock,
} from '@cohorte/base';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeHostBindings,
  RuntimeToolCall,
  RuntimeToolResult,
  SpawnRequest,
  TaskInput,
  ToolCallContext,
} from '@cohorte/runtime-contract';
import { FAKE_BRAIN_ENTRY, type FakeBrainScript, writeFakeBrainScript } from '@cohorte/testkit/fake-brain/scripts';
// The area, not the barrel: `harness/host.ts` runs this file as a plain Node process, where the barrel's vitest-bound
// areas cannot load.
import { fakeRedactor, sealedText } from '@cohorte/testkit/fake-redactor';
import { createPiRuntimeProvider, type PiRuntimeProviderOptions } from '../../src/parent/index.ts';
import { WIRE_LOG_FILE } from '../../src/parent/session.ts';

export const SYSTEM_PROMPT = 'You are a probe.\n\nÉtape 1 : répondre.\n';
export const TASK = '# Task\n\nDo it, «exactly».\n  \n';
export const NOTE = '# Continuation\n\nTwo writes were done.\t\n';
export const ENDPOINT = 'https://provider.invalid/v1';

export const FAST = { heartbeatMs: 150, abortGraceMs: 300, termGraceMs: 300, exitGraceMs: 1_000, responseMs: 2_000 };

const sha256Of = (text: string): Sha256 => createHash('sha256').update(text, 'utf8').digest('hex') as Sha256;

export interface LogLine {
  level: string;
  text: string;
  fields: Record<string, JsonValue> | undefined;
}

export interface WireEntry {
  dir: 'in' | 'out';
  frame?: { t: string; [member: string]: JsonValue };
  rejected?: string;
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function until(what: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function codeOf(promise: Promise<unknown>): Promise<string> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (thrown === undefined) return 'resolved';
  return thrown instanceof CohorteError ? thrown.info.code : `not a CohorteError: ${String(thrown)}`;
}

export class Bench {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-pi-parent-')));
  readonly runId: RunId = createUuidV7IdSource().next<'RunId'>('run');
  readonly redactor = fakeRedactor();
  readonly logs: LogLine[] = [];
  readonly events: RuntimeEvent[] = [];
  readonly calls: RuntimeToolCall[] = [];
  readonly runtimes: AgentRuntime[] = [];
  script: FakeBrainScript = {};
  handler: (call: RuntimeToolCall, ctx: ToolCallContext) => Promise<RuntimeToolResult> = async (call) =>
    this.result(`echo:${call.toolCallId}`);
  readonly #files: { prompt: TaskInput; task: TaskInput; note: TaskInput };

  constructor() {
    this.#files = {
      prompt: this.#write('prompt.md', SYSTEM_PROMPT),
      task: this.#write('task.md', TASK),
      note: this.#write('note.md', NOTE),
    };
  }

  get note(): TaskInput {
    return this.#files.note;
  }

  result(text: string, extra: Partial<RuntimeToolResult> = {}): RuntimeToolResult {
    return { isError: false, content: [{ type: 'text', text: sealedText(text) }], ...extra };
  }

  stateDir(agentId: string, incarnation = 1): string {
    return join(this.root, 'state', this.runId, agentId, String(incarnation));
  }

  bindings(): RuntimeHostBindings {
    return {
      toolHost: {
        handleToolCall: (call, ctx) => {
          this.calls.push(call);
          return this.handler(call, ctx);
        },
      },
      stateDir: (runId, agentId, incarnation) => {
        const dir = join(this.root, 'state', runId, agentId, String(incarnation));
        mkdirSync(dir, { recursive: true });
        writeFakeBrainScript(dir, { endpoint: ENDPOINT, ...this.script });
        return dir;
      },
      clock: systemClock,
      ids: createUuidV7IdSource(),
      log: (level, text, fields) => void this.logs.push({ level, text, fields }),
    };
  }

  provider(options: PiRuntimeProviderOptions = {}) {
    return createPiRuntimeProvider({
      entryOverride: FAKE_BRAIN_ENTRY,
      redactor: this.redactor,
      engine: { agentDir: join(this.root, 'pi-agent'), authPath: join(this.root, 'auth.json') },
      ...options,
      timings: { ...FAST, ...options.timings },
    });
  }

  async runtime(options: PiRuntimeProviderOptions = {}): Promise<AgentRuntime> {
    const provider = this.provider(options);
    const runtime = await provider.create(this.bindings(), await provider.pin());
    runtime.subscribe((event) => void this.events.push(event));
    this.runtimes.push(runtime);
    return runtime;
  }

  request(name: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
    const flat: JsonValue = { type: 'object', properties: { text: { type: 'string' } } };
    return {
      runId: this.runId,
      agentId: `agt_probe_${name}` as AgentId,
      role: 'probe',
      model: { provider: 'fake-provider', model: 'scripted' },
      systemPrompt: { id: 'probe', ...this.#files.prompt },
      context: {
        manifestSha256: sha256Of('manifest'),
        tokenLimit: 1_000,
        tokenEstimate: 10,
        entries: [],
        reductions: [],
        exclusions: [],
      },
      tools: [
        { tool: 'probe_echo', description: 'Answers.', inputSchema: flat, effect: 'read', terminal: false },
        { tool: 'probe_hold', description: 'Waits.', inputSchema: flat, effect: 'read', terminal: false },
      ],
      sandbox: {
        require: 'process',
        filesystem: { readOnly: [this.root], readWrite: [join(this.root, 'state')], denyRead: [] },
        network: { mode: 'none', allowHosts: [] },
        env: { allow: ['PATH'], set: {} },
        limits: {},
      },
      budget: { maxEngineRetries: 0 },
      workingDirectory: join(this.root, 'work'),
      incarnation: 1,
      thinking: 'off',
      auth: { mode: 'subscription', provider: 'fake-provider', baseUrl: ENDPOINT, allowApiKey: false },
      task: this.#files.task,
      continuation: null,
      ...overrides,
    };
  }

  wire(agentId: string, incarnation = 1): WireEntry[] {
    const path = join(this.stateDir(agentId, incarnation), WIRE_LOG_FILE);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as WireEntry);
  }

  /** The pid the child announced, for a spawn that was REFUSED and therefore returned no handle. */
  helloPid(agentId: string): number {
    const hello = this.wire(agentId).find((entry) => entry.frame?.t === 'hello');
    return Number(hello?.frame?.pid ?? 0);
  }

  /** The env var NAMES the child attested in its `ready` frame. */
  attestedEnvKeys(agentId: string): string[] {
    const ready = this.wire(agentId).find((entry) => entry.frame?.t === 'ready')?.frame;
    const attestation = ready?.attestation;
    const keys =
      typeof attestation === 'object' && attestation !== null && !Array.isArray(attestation) ? attestation.envKeys : [];
    return Array.isArray(keys) ? keys.map(String) : [];
  }

  eventsOf<T extends RuntimeEvent['type']>(type: T): Extract<RuntimeEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.runtimes.map((runtime) => runtime.close()));
    rmSync(this.root, { recursive: true, force: true });
  }

  #write(name: string, text: string): TaskInput {
    const path = join(this.root, name);
    writeFileSync(path, text, 'utf8');
    return { path, sha256: sha256Of(text), bytes: Buffer.byteLength(text, 'utf8') };
  }
}
