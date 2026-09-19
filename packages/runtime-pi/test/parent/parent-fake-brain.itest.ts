// The parent of PiRuntime against testkit's engine-free fake brain (DESIGN 7.2): framing on both codecs, attestation,
// heartbeat, the kill ladder, disconnect, the env and stderr canaries, layer 5, the prompt frame. No engine anywhere.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CohorteError, type JsonValue } from '@cohorte/base';
import type { AgentExit, LoginInteraction } from '@cohorte/runtime-contract';
import {
  readFakeBrainGrandchildPid,
  readFakeBrainModelInputs,
  writeFakeBrainScript,
} from '@cohorte/testkit/fake-brain/scripts';
import { test as base, describe, expect } from 'vitest';
import { OUTPUT_INCARNATION_CAP } from '../../src/parent/output.ts';
import { effectiveSystemPrompt } from '../../src/parent/runtime.ts';
import { Bench, codeOf, ENDPOINT, isAlive, type LogLine, NOTE, SYSTEM_PROMPT, TASK, until } from './bench.ts';

const test = base.extend<{ lab: Bench }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest reads the fixture's dependencies from this pattern
  lab: async ({}, use) => {
    const bench = new Bench();
    await use(bench);
    await bench.dispose();
  },
});

const echo = (text: string) => ({ tool: 'probe_echo', input: { text } });
const hold = (text: string) => ({ tool: 'probe_hold', input: { text } });
const never = (): Promise<never> => new Promise(() => {});

async function exitOf(bench: Bench, name: string, options: Parameters<Bench['runtime']>[0] = {}): Promise<AgentExit> {
  const runtime = await bench.runtime(options);
  const handle = await runtime.spawn(bench.request(name));
  const exit = await handle.exit;
  return exit;
}

describe('framing', () => {
  test.for(['ipc', 'fd'] as const)(
    'a whole run travels over the %s codec, and the wire log replays it',
    async (transport, { lab: bench }) => {
      bench.script = { turns: [{ text: 'working', toolCalls: [echo('a'), echo('b')] }, { text: 'done' }] };
      const exit = await exitOf(bench, 'framing', { transport });
      expect(exit).toMatchObject({ outcome: 'completed', stop: 'model-stop' });
      expect(exit.usage).toMatchObject({ modelRequests: 2, toolCalls: 2, turns: 2 });
      expect(bench.calls.map((call) => [call.toolCallId, call.ordinal, call.input])).toEqual([
        ['tc_1_1', 1, { text: 'a' }],
        ['tc_1_2', 2, { text: 'b' }],
      ]);
      const frames = bench.wire('agt_probe_framing').map((entry) => `${entry.dir}:${entry.frame?.t}`);
      expect(frames.slice(0, 4)).toEqual(['in:hello', 'out:init', 'in:ready', 'out:prompt']);
      expect(frames).toContain('in:tool.call');
      expect(frames).toContain('out:tool.result');
      expect(frames.indexOf('in:settled')).toBeGreaterThan(frames.indexOf('out:tool.result'));
      expect(bench.events.at(-1)?.type).toBe('agent.exited');
      expect(bench.events.map((event) => event.seq)).toEqual(bench.events.map((_, index) => index));
    },
  );

  test('the child is a detached group leader in the agent state dir, started with the nonce of this spawn', async ({
    lab: bench,
  }) => {
    bench.script = { turns: [{ toolCalls: [hold('a')] }, {}] };
    let release: () => void = () => {};
    bench.handler = () => new Promise((resolve) => (release = () => resolve(bench.result('ok'))));
    const runtime = await bench.runtime();
    const handle = await runtime.spawn(bench.request('process'));
    expect(handle.process?.pgid).toBe(handle.process?.pid);
    expect(handle.process?.startToken).not.toBe('');
    await until('the tool call', () => bench.calls.length === 1);
    const snapshot = await runtime.inspect('agt_probe_process');
    expect(snapshot).toMatchObject({ state: 'awaiting-tool', pendingToolCalls: ['tc_1_1'], turn: 1 });
    expect(snapshot.diagnostics).toMatchObject({ pid: handle.process?.pid, child: { state: 'awaiting-tool' } });
    release();
    const exit = await handle.exit;
    expect(exit.outcome).toBe('completed');
    expect(isAlive(handle.process?.pid ?? 0)).toBe(false);
  });
});

describe('attestation: the spawn fails closed on ANY mismatch', () => {
  const MISMATCHES: [
    what: string,
    script: { attestation?: { [k: string]: JsonValue }; extraEnvKeys?: string[] },
    code: string,
  ][] = [
    [
      'activeTools != grant',
      { attestation: { activeTools: ['probe_echo', 'probe_hold', 'bash'] } },
      'security/unexpected',
    ],
    ['an env key outside allow ∪ OS-injected', { extraEnvKeys: ['OPENAI_API_KEY'] }, 'security/unexpected'],
    ['the prompt hash', { attestation: { effectiveSystemPromptSha256: 'a'.repeat(64) } }, 'security/unexpected'],
    ['modelFallback', { attestation: { modelFallback: true } }, 'security/unexpected'],
    [
      'baseUrl',
      { attestation: { effective: { baseUrl: 'https://elsewhere.invalid/v1' } } },
      'security/auth-endpoint-mismatch',
    ],
    ['guardFetchInstalled: false', { attestation: { hooks: { guardFetchInstalled: false } } }, 'security/unexpected'],
    [
      'an api key in subscription mode',
      { attestation: { auth: { type: 'api_key', subscription: false } } },
      'security/auth-mode-violation',
    ],
  ];

  test.for(MISMATCHES)('%s => spawn refused, child reaped, no event', async ([, script, code], { lab: bench }) => {
    bench.script = { turns: [{ text: 'never reached' }], ...script };
    const runtime = await bench.runtime();
    expect(await codeOf(runtime.spawn(bench.request('liar')))).toBe(code);
    expect(bench.events).toEqual([]);
    expect(readFakeBrainModelInputs(bench.stateDir('agt_probe_liar'))).toEqual([]);
    const pid = bench.helloPid('agt_probe_liar');
    expect(pid).toBeGreaterThan(0);
    await until('the refused child is gone', () => !isAlive(pid));
  });

  test('a CLEAN fake brain is accepted although the OS injects env names nobody allowed', async ({ lab: bench }) => {
    const exit = await exitOf(bench, 'clean');
    expect(exit.outcome).toBe('completed');
    const envKeys = bench.attestedEnvKeys('agt_probe_clean');
    expect(envKeys).toContain('PATH');
    expect(envKeys).toContain('PI_OFFLINE');
    if (process.platform === 'darwin') expect(envKeys).toContain('__CF_USER_TEXT_ENCODING');
    const [spawned] = bench.eventsOf('agent.spawned');
    expect(spawned?.data.isolation).toEqual({
      level: 'process',
      filesystem: 'advisory',
      network: 'none',
      backend: 'none',
    });
  });

  test('a fatal during the handshake refuses the spawn, and no event is emitted for an agent that never started', async ({
    lab: bench,
  }) => {
    bench.script = {
      fatalBeforeReady: { signal: { modelsErrorCode: 'auth', text: 'a brand new auth failure', origin: 'auth-check' } },
    };
    const runtime = await bench.runtime();
    expect(await codeOf(runtime.spawn(bench.request('early')))).toBe('provider-terminal/auth-required');
    expect(bench.events).toEqual([]);
    // The trace DESIGN 3.8 asks for is still left — as a log line, because no durable event may name an incarnation
    // the host was told never started.
    expect(bench.logs.filter((line) => line.fields?.code === 'error-unclassified')).toHaveLength(1);
    const pid = bench.helloPid('agt_probe_early');
    await until('the refused child is gone', () => !isAlive(pid));
  });

  test('the mismatch message carries the child’s own values SEALED, the parent’s untouched', async ({ lab: bench }) => {
    const canary = 'tok_live_9a8b7c6d5e4f3a2b1c0d';
    bench.redactor.registerSecret(canary, 'canary');
    bench.script = {
      turns: [{ text: 'never reached' }],
      attestation: { effective: { baseUrl: `https://elsewhere.invalid/v1?t=${canary}` } },
    };
    const runtime = await bench.runtime();
    const thrown = await runtime.spawn(bench.request('sealer')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CohorteError);
    const { info } = thrown as CohorteError;
    expect(info.code).toBe('security/auth-endpoint-mismatch');
    expect(info.message).not.toContain(canary);
    expect(info.message).toContain('[REDACTED:canary]');
    expect(info.message).toContain(ENDPOINT);
  });

  test('env canary: a key in the parent env never reaches the child, and cannot be allowed', async ({ lab: bench }) => {
    process.env.OPENAI_API_KEY = 'canary-sk-0123456789';
    try {
      const exit = await exitOf(bench, 'canary');
      expect(exit.outcome).toBe('completed');
      expect(bench.attestedEnvKeys('agt_probe_canary')).toContain('PATH');
      expect(bench.attestedEnvKeys('agt_probe_canary')).not.toContain('OPENAI_API_KEY');
      const runtime = await bench.runtime();
      const base = bench.request('greedy');
      const greedy = { ...base, sandbox: { ...base.sandbox, env: { allow: ['PATH', 'OPENAI_API_KEY'], set: {} } } };
      expect(await codeOf(runtime.spawn(greedy))).toBe('security/auth-mode-violation');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  test('a loader variable, and a name layer 1 does not inherit, are refused before any process exists', async ({
    lab: bench,
  }) => {
    const runtime = await bench.runtime();
    const base = bench.request('loader');
    for (const name of ['DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'NODE_REPL_EXTERNAL_MODULE', 'SSL_CERT_FILE']) {
      const greedy = { ...base, sandbox: { ...base.sandbox, env: { allow: ['PATH', name], set: {} } } };
      expect(await codeOf(runtime.spawn(greedy))).toBe('security/auth-mode-violation');
    }
    expect(bench.events).toEqual([]);
  });

  test('a credential-shaped name the policy spells otherwise is refused too', async ({ lab: bench }) => {
    process.env.GROQ_APIKEY = 'canary-gsk-0123456789';
    try {
      const runtime = await bench.runtime();
      const base = bench.request('speller');
      const greedy = { ...base, sandbox: { ...base.sandbox, env: { allow: ['PATH', 'GROQ_APIKEY'], set: {} } } };
      expect(await codeOf(runtime.spawn(greedy))).toBe('security/auth-mode-violation');
    } finally {
      delete process.env.GROQ_APIKEY;
    }
  });
});

describe('liveness', () => {
  test('heartbeat loss => the ladder, and the incarnation is crashed', async ({ lab: bench }) => {
    bench.script = { suppressHeartbeat: true, turns: [{ toolCalls: [hold('a')] }] };
    bench.handler = never;
    const exit = await exitOf(bench, 'silent');
    expect(exit).toMatchObject({ outcome: 'crashed', stop: 'process-exit' });
    expect(exit.error).toMatchObject({
      code: 'tool-transient/agent-process-exit',
      details: { reason: 'heartbeat-lost' },
    });
  });

  test('a beating heart is left alone', async ({ lab: bench }) => {
    bench.script = { heartbeatMs: 50, turns: [{ toolCalls: [hold('a')] }, {}] };
    bench.handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return bench.result('late');
    };
    const exit = await exitOf(bench, 'beating');
    expect(exit.outcome).toBe('completed');
  });

  test('a stubborn child and its grandchild are reaped by the ladder', async ({ lab: bench }) => {
    bench.script = { stubborn: true, grandchild: true, heartbeatMs: 50, turns: [{ toolCalls: [hold('a')] }] };
    let aborted = false;
    bench.handler = (_call, ctx) =>
      new Promise(() => {
        ctx.signal.addEventListener('abort', () => (aborted = true), { once: true });
      });
    const runtime = await bench.runtime();
    const handle = await runtime.spawn(bench.request('stubborn'));
    await until('the tool call', () => bench.calls.length === 1);
    const grandchild = readFakeBrainGrandchildPid(bench.stateDir('agt_probe_stubborn')) ?? 0;
    expect(isAlive(grandchild)).toBe(true);
    await runtime.cancel('agt_probe_stubborn', 'test');
    const exit = await handle.exit;
    expect(exit).toMatchObject({ outcome: 'cancelled', stop: 'cancelled' });
    expect(aborted).toBe(true);
    expect(isAlive(handle.process?.pid ?? 0)).toBe(false);
    await until('the grandchild is gone', () => !isAlive(grandchild));
    const frames = bench.wire('agt_probe_stubborn').map((entry) => `${entry.dir}:${entry.frame?.t}`);
    expect(frames).toContain('out:abort');
  });

  test.for([
    ['disconnect', 'disconnect'],
    ['exit', 'exit-without-settled'],
  ] as const)('%s without settled => crashed', async ([how, reason], { lab: bench }) => {
    bench.script = { heartbeatMs: 50, crash: { at: 'first-tool-call', how }, turns: [{ toolCalls: [hold('a')] }] };
    let aborted = false;
    bench.handler = (_call, ctx) =>
      new Promise(() => {
        ctx.signal.addEventListener('abort', () => (aborted = true), { once: true });
      });
    const runtime = await bench.runtime();
    const handle = await runtime.spawn(bench.request('crash'));
    const exit = await handle.exit;
    expect(exit).toMatchObject({ outcome: 'crashed', stop: 'process-exit' });
    expect(exit.error).toMatchObject({ code: 'tool-transient/agent-process-exit', retryable: true });
    expect(['disconnect', reason]).toContain(exit.error?.details?.reason);
    expect(isAlive(handle.process?.pid ?? 0)).toBe(false);
    await until('the pending call is released', () => aborted);
  });

  test('parent SIGKILL => the fake brain exits', { timeout: 20_000 }, async () => {
    const host = spawn(process.execPath, [fileURLToPath(new URL('./harness/host.ts', import.meta.url))], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      host.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n')) resolve(buffer.slice(0, buffer.indexOf('\n')));
      });
      host.once('exit', (code) => reject(new Error(`the harness exited early (${code})`)));
    });
    const { brain, root } = JSON.parse(line) as { brain: number; root: string };
    try {
      expect(isAlive(brain)).toBe(true);
      host.kill('SIGKILL');
      await until('the orphaned brain exits by itself', () => !isAlive(brain));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('child output (S-53 seed)', () => {
  test('a token printed on stderr never reaches the log unsealed', async ({ lab: bench }) => {
    const canary = 'tok_live_5f2c9d8e7a6b4c3d2e1f';
    bench.redactor.registerSecret(canary, 'canary');
    bench.script = { stderr: [`OAuth refresh failed: {"refresh_token":"${canary}"}`], turns: [{ text: 'done' }] };
    const exit = await exitOf(bench, 'leaky');
    expect(exit.outcome).toBe('completed');
    const lines = bench.logs.filter((line) => line.fields?.stream === 'stderr');
    expect(lines.some((line) => line.text.includes('[REDACTED:canary]'))).toBe(true);
    expect(JSON.stringify(bench.logs)).not.toContain(canary);
    expect(lines[0]?.fields).toMatchObject({ agentId: 'agt_probe_leaky', incarnation: 1 });
  });

  test('a 2 MiB stderr flood is truncated, not buffered', async ({ lab: bench }) => {
    bench.script = { stderrFloodBytes: 2 * 1024 * 1024, turns: [{ text: 'done' }] };
    const exit = await exitOf(bench, 'flood');
    expect(exit.outcome).toBe('completed');
    const lines = bench.logs.filter((line) => line.fields?.stream === 'stderr');
    const logged = lines.reduce((sum, line) => sum + line.text.length, 0);
    expect(logged).toBeLessThanOrEqual(OUTPUT_INCARNATION_CAP + 256);
    expect(logged).toBeGreaterThan(OUTPUT_INCARNATION_CAP / 2);
    expect(lines.filter((line) => line.text.includes('truncated'))).toHaveLength(1);
    expect(lines.at(-1)?.text).toContain('truncated');
  });
});

describe('layer 5: per-request evidence, asserted in the parent', () => {
  test.for([
    ['a foreign origin', { providerRequest: { origin: 'https://api.elsewhere.invalid' } }],
    ['an api-key header', { providerRequest: { authScheme: 'api-key-header' } }],
    ['a refused request', { providerRequest: { refused: true } }],
    ['NO provider.request frame at all', { providerRequest: 'omit' }],
    ['another model answering', { responded: { model: 'a-cheaper-model' } }],
    ['another auth source', { responded: { authSource: 'api-key' } }],
  ] as const)('%s => security/auth-mode-violation', async ([, script], { lab: bench }) => {
    bench.script = { turns: [{ toolCalls: [echo('a')] }, { text: 'done' }], ...script };
    const runtime = await bench.runtime();
    const handle = await runtime.spawn(bench.request('layer5'));
    const exit = await handle.exit;
    expect(exit.outcome).toBe('failed');
    expect(exit.error).toMatchObject({ code: 'security/auth-mode-violation', class: 'security', retryable: false });
    expect(bench.calls).toEqual([]);
    expect(isAlive(handle.process?.pid ?? 0)).toBe(false);
  });

  test('a matching frame per request lets the run through', async ({ lab: bench }) => {
    bench.script = { turns: [{ toolCalls: [echo('a')] }, { text: 'done' }] };
    const exit = await exitOf(bench, 'honest');
    expect(exit.outcome).toBe('completed');
    const requests = bench.wire('agt_probe_honest').filter((entry) => entry.frame?.t === 'provider.request');
    expect(requests.map((entry) => entry.frame?.origin)).toEqual([new URL(ENDPOINT).origin, new URL(ENDPOINT).origin]);
  });
});

describe('a hostile child is a security matter', () => {
  test('an ungranted tool PROPOSED to the host => security/*, and the host never hears of the call', async ({
    lab: bench,
  }) => {
    bench.script = { forwardUngranted: true, turns: [{ toolCalls: [{ tool: 'bash', input: { command: 'id' } }] }] };
    const exit = await exitOf(bench, 'proposer');
    expect(exit.error).toMatchObject({ class: 'security', details: { violation: 'unknown-tool' } });
    expect(bench.calls).toEqual([]);
    expect(bench.eventsOf('tool.call.requested')).toEqual([]);
  });

  test('an ungranted tool the engine refuses itself is an event, not a violation', async ({ lab: bench }) => {
    bench.script = { turns: [{ toolCalls: [{ tool: 'bash', input: { command: 'id' } }] }, { text: 'done' }] };
    const exit = await exitOf(bench, 'refuser');
    expect(exit.outcome).toBe('completed');
    expect(bench.eventsOf('tool.call.rejected').map((event) => event.data)).toMatchObject([
      { tool: 'bash', cause: 'unknown-tool' },
    ]);
  });

  test.for([
    [
      'a frame that violates the schema',
      { t: 'tool.call', seq: 0, ordinal: 0, engineToolCallId: 'x', tool: 'probe_echo', input: {} },
      'frame-schema',
    ],
    ['a frame nobody defined', { t: 'exec', command: 'id' }, 'frame-schema'],
    [
      'an ordinal gap',
      { t: 'tool.call', seq: 0, ordinal: 7, engineToolCallId: 'x', tool: 'probe_echo', input: {} },
      'ordinal-gap',
    ],
    ['a second hello', { t: 'hello', v: 1, pid: 1, nonce: 'x' }, 'unexpected-frame'],
  ] as const)('%s => security/*', async ([, frame, violation], { lab: bench }) => {
    bench.script = { rawFrameOnFirstRequest: frame, turns: [{ toolCalls: [echo('a')] }] };
    const exit = await exitOf(bench, 'hostile');
    expect(exit).toMatchObject({ outcome: 'failed', error: { class: 'security', details: { violation } } });
  });

  test('an event only the host may author is ignored, with a trace', async ({ lab: bench }) => {
    const forged = { type: 'agent.resumed', at: new Date().toISOString(), data: {} };
    bench.script = { rawFrameOnFirstRequest: { t: 'event', seq: 0, event: forged }, turns: [{ text: 'done' }] };
    const exit = await exitOf(bench, 'forger');
    expect(exit.outcome).toBe('completed');
    expect(bench.eventsOf('agent.resumed')).toEqual([]);
    expect(bench.eventsOf('runtime.warning').map((event) => event.data.code)).toEqual(['host-event-ignored']);
  });
});

describe('the prompt frame', () => {
  test('carries the task and, for a later incarnation, the note: the brain echoes both byte-identical, in order', async ({
    lab: bench,
  }) => {
    const runtime = await bench.runtime();
    const request = bench.request('noted', { incarnation: 2, continuation: { fromIncarnation: 1, note: bench.note } });
    const handle = await runtime.spawn(request);
    const exit = await handle.exit;
    expect(exit.outcome).toBe('completed');
    const prompt = bench.wire('agt_probe_noted', 2).find((entry) => entry.frame?.t === 'prompt')?.frame;
    expect(prompt).toMatchObject({ text: TASK, note: { text: NOTE } });
    const [input] = readFakeBrainModelInputs(bench.stateDir('agt_probe_noted', 2));
    expect(input?.messages).toEqual([
      { role: 'user', text: TASK },
      { role: 'user', text: NOTE },
    ]);
    expect(input?.systemPrompt).toBe(effectiveSystemPrompt(SYSTEM_PROMPT, request.workingDirectory));
  });

  test('without a continuation there is no note member at all', async ({ lab: bench }) => {
    await exitOf(bench, 'plain');
    const prompt = bench.wire('agt_probe_plain').find((entry) => entry.frame?.t === 'prompt')?.frame;
    expect(prompt).toMatchObject({ text: TASK });
    expect(prompt).not.toHaveProperty('note');
  });
});

describe('budget belt, pause, messages', () => {
  test('maxToolCalls: the call over the limit is answered isError + terminate and never reaches the host', async ({
    lab: bench,
  }) => {
    bench.script = { turns: [{ toolCalls: [echo('a'), echo('b')] }, { text: 'never' }] };
    const runtime = await bench.runtime();
    const handle = await runtime.spawn(bench.request('greedy', { budget: { maxToolCalls: 1, maxEngineRetries: 0 } }));
    const exit = await handle.exit;
    expect(exit).toMatchObject({ outcome: 'failed', stop: 'budget', error: { code: 'budget/tool-calls-exhausted' } });
    expect(bench.calls.map((call) => call.toolCallId)).toEqual(['tc_1_1']);
    const refused = bench
      .wire('agt_probe_greedy')
      .find((entry) => entry.frame?.t === 'tool.result' && entry.frame.toolCallId === 'tc_1_2');
    expect(refused?.frame).toMatchObject({ isError: true, terminate: true });
  });

  test('a terminal result ends the loop as host-terminated', async ({ lab: bench }) => {
    bench.script = { turns: [{ toolCalls: [echo('result')] }, { text: 'never' }] };
    bench.handler = async () => bench.result('accepted', { terminate: true });
    const exit = await exitOf(bench, 'terminal');
    expect(exit).toMatchObject({ outcome: 'completed', stop: 'host-terminated' });
    expect(exit.usage.modelRequests).toBe(1);
  });

  test("model-boundary 'park': the child parks before its next request and the capability says yes", async ({
    lab: bench,
  }) => {
    bench.script = { turns: [{ toolCalls: [hold('a')] }, { toolCalls: [echo('b')] }, { text: 'done' }] };
    let release: () => void = () => {};
    bench.handler = (call) =>
      call.tool === 'probe_hold'
        ? new Promise((resolve) => (release = () => resolve(bench.result('ok'))))
        : Promise.resolve(bench.result('ok'));
    const runtime = await bench.runtime({ modelBoundary: 'park' });
    expect(runtime.capabilities().pause.modelBoundary).toEqual({ value: 'yes' });
    const handle = await runtime.spawn(bench.request('parked'));
    await until('the first call', () => bench.calls.length === 1);
    await runtime.pause('agt_probe_parked');
    release();
    await until('the child parks', () => bench.wire('agt_probe_parked').some((entry) => entry.frame?.t === 'parked'));
    const snapshot = await runtime.inspect('agt_probe_parked');
    expect(snapshot).toMatchObject({ state: 'paused', pausedAt: 'model-boundary' });
    expect(bench.eventsOf('model.requested')).toHaveLength(1);
    await runtime.resume('agt_probe_parked');
    const exit = await handle.exit;
    expect(exit.outcome).toBe('completed');
    expect(bench.eventsOf('agent.paused')).toHaveLength(1);
    expect(bench.eventsOf('agent.resumed')).toHaveLength(1);
  });

  test('send: a host note is prefixed, acknowledged, and reaches the next model input', async ({ lab: bench }) => {
    bench.script = { turns: [{ toolCalls: [hold('a')] }, { text: 'done' }] };
    let release: () => void = () => {};
    bench.handler = () => new Promise((resolve) => (release = () => resolve(bench.result('ok'))));
    const runtime = await bench.runtime();
    const handle = await runtime.spawn(bench.request('listener'));
    await until('the first call', () => bench.calls.length === 1);
    await runtime.send('agt_probe_listener', {
      kind: 'host-note',
      messageId: 'm1',
      text: 'mind the gap',
      delivery: 'steer',
    });
    release();
    const exit = await handle.exit;
    expect(exit.outcome).toBe('completed');
    expect(bench.eventsOf('agent.message.accepted').map((event) => event.data)).toEqual([
      { messageId: 'm1', delivery: 'steer' },
    ]);
    const inputs = readFakeBrainModelInputs(bench.stateDir('agt_probe_listener'));
    expect(inputs.at(-1)?.messages.map((message) => message.text)).toContain('[cohorte] mind the gap');
  });

  test('an engine error is classified by the PARENT from the wire signal', async ({ lab: bench }) => {
    bench.script = { failRequest: { request: 1, signal: { httpStatus: 429, text: 'Too Many Requests' } } };
    const exit = await exitOf(bench, 'limited');
    expect(exit).toMatchObject({
      outcome: 'failed',
      stop: 'engine-error',
      error: { code: 'provider-transient/rate-limited' },
    });
  });

  test('an error the table has no row for warns, so that the table gets one (DESIGN 3.8)', async ({ lab: bench }) => {
    bench.script = {
      failRequest: { request: 1, signal: { modelsErrorCode: 'auth', text: 'a brand new auth failure' } },
    };
    const exit = await exitOf(bench, 'unmapped');
    expect(exit.error).toMatchObject({
      code: 'provider-terminal/auth-required',
      details: { unclassified: true },
    });
    const warnings = bench.eventsOf('runtime.warning');
    expect(warnings.map((event) => event.data.code)).toEqual(['error-unclassified']);
    expect(warnings[0]?.data.message).toContain('auth');
    expect(warnings[0]?.data.message).toContain('model-response');
  });

  test('a clean exit reports the counters the CHILD settled with, a breach the parent’s own', async ({
    lab: bench,
  }) => {
    bench.script = { turns: [{ toolCalls: [echo('a')] }, { text: 'done' }] };
    const clean = await exitOf(bench, 'counted');
    const settled = bench.wire('agt_probe_counted').find((entry) => entry.frame?.t === 'settled')?.frame;
    expect(settled?.exit).toMatchObject({ usage: clean.usage });

    bench.script = { turns: [{ toolCalls: [echo('a'), echo('b')] }, { text: 'never' }] };
    const runtime = await bench.runtime();
    const handle = await runtime.spawn(bench.request('capped', { budget: { maxToolCalls: 1, maxEngineRetries: 0 } }));
    const breached = await handle.exit;
    expect(breached.stop).toBe('budget');
    expect(breached.usage.toolCalls).toBe(2);
  });
});

describe('the provider', () => {
  test('create() refuses a pin that is not what is installed, and refuses to run without a redactor', async ({
    lab: bench,
  }) => {
    const provider = bench.provider();
    const pinned = await provider.pin();
    const other = { ...pinned, node: { ...pinned.node, version: 'v0.0.0' } };
    expect(await codeOf(provider.create(bench.bindings(), other))).toBe('security/runtime-pin-mismatch');
    const bare = bench.provider({ redactor: undefined as never });
    expect(await codeOf(bare.create(bench.bindings(), pinned))).toBe('configuration/engine-init');
  });

  test('an OS sandbox that is required and absent refuses the spawn; a wrapper is used and reported', async ({
    lab: bench,
  }) => {
    const base = bench.request('boxed');
    const strict = { ...base, sandbox: { ...base.sandbox, require: 'os' as const } };
    const bareRuntime = await bench.runtime();
    expect(await codeOf(bareRuntime.spawn(strict))).toBe('security/sandbox-unavailable');

    const isolation = { level: 'os', filesystem: 'enforced', network: 'partial', backend: 'test-wrapper' } as const;
    const wrapped = await bench.runtime({
      sandboxWrapper: (_policy, command) => ({
        file: '/usr/bin/env',
        args: [command.file, ...command.args],
        isolation,
      }),
    });
    const handle = await wrapped.spawn(strict);
    const exit = await handle.exit;
    expect(exit.outcome).toBe('completed');
    expect(bench.eventsOf('agent.spawned')[0]?.data.isolation).toEqual(isolation);
  });

  test('the Cohorte-owned engine agent dir is created 0700 before the first spawn (3.7 layer 2)', async ({
    lab: bench,
  }) => {
    const agentDir = join(bench.root, 'pi-agent');
    expect(existsSync(agentDir)).toBe(false);
    const exit = await exitOf(bench, 'owned');
    expect(exit.outcome).toBe('completed');
    expect(statSync(agentDir).mode & 0o777).toBe(0o700);
    expect(bench.attestedEnvKeys('agt_probe_owned')).toContain('PI_CODING_AGENT_DIR');
  });

  test('two live incarnations of one agent are both reaped by close()', async ({ lab: bench }) => {
    bench.script = { heartbeatMs: 50, turns: [{ toolCalls: [hold('a')] }] };
    bench.handler = never;
    const runtime = await bench.runtime();
    const first = await runtime.spawn(bench.request('twin'));
    const second = await runtime.spawn(bench.request('twin', { incarnation: 2 }));
    await until('both incarnations are in a tool call', () => bench.calls.length === 2);
    expect(isAlive(first.process?.pid ?? 0)).toBe(true);
    expect(isAlive(second.process?.pid ?? 0)).toBe(true);
    await runtime.close();
    expect(isAlive(first.process?.pid ?? 0)).toBe(false);
    expect(isAlive(second.process?.pid ?? 0)).toBe(false);
  });

  test('the auth child’s output goes through the sealed logger, never to a raw file', async ({ lab: bench }) => {
    const canary = 'tok_live_3b1a9c7e5d2f8a4b6c0e';
    bench.redactor.registerSecret(canary, 'canary');
    const agentDir = join(bench.root, 'pi-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFakeBrainScript(agentDir, { stderr: [`OAuth refresh failed: {"refresh_token":"${canary}"}`] });
    const lines: LogLine[] = [];
    const provider = bench.provider({ log: (level, text, fields) => void lines.push({ level, text, fields }) });
    await provider.authStatus(['openai-codex']);
    await until('the sealed stderr line reaches the log', () => lines.some((line) => line.fields?.stream === 'stderr'));
    expect(lines.some((line) => line.text.includes('[REDACTED:canary]'))).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(canary);
  });

  test('auth status, login and logout travel through the child, and no text comes back unsealed', async ({
    lab: bench,
  }) => {
    const provider = bench.provider();
    const statuses = await provider.authStatus(['openai-codex']);
    expect(statuses).toMatchObject([{ provider: 'openai-codex', state: 'absent', billing: 'unknown' }]);
    const shown: unknown[] = [];
    const ui: LoginInteraction = { show: (event) => void shown.push(event), ask: async () => 'code-1234' };
    const status = await provider.login('openai-codex', ui, new AbortController().signal);
    expect(status).toMatchObject({ provider: 'openai-codex', state: 'oauth', subscription: true });
    expect(shown).toEqual([{ kind: 'open-url', url: 'https://login.invalid/device' }]);
    await provider.logout('openai-codex');
  });
});
