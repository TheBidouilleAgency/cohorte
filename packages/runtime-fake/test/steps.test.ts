// One test per FakeStep kind (DESIGN 3.10), then cancellation and incarnation matching.
import { readFileSync } from 'node:fs';
import type { AgentId, QuotaInfo } from '@cohorte/base';
import { describe, expect } from 'vitest';
import { step } from '../src/script/index.ts';
import { script, test, textResult } from './bench.ts';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('FakeStep kinds', () => {
  test('say: one assistant message, streamed in `chunks` deltas, recorded in the transcript', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.say('hello world!', 3)]));
    const handle = await runtime.spawn(rig.request());
    const exit = await handle.exit;

    expect(exit).toMatchObject({ outcome: 'completed', stop: 'model-stop' });
    const deltas = rig.eventsOf('agent.message.delta');
    expect(deltas.map((event) => event.data.channel)).toEqual(['text', 'text', 'text']);
    expect(deltas.map((event) => event.data.delta).join('')).toBe('hello world!');
    const [completed] = rig.eventsOf('agent.message.completed');
    expect(completed?.data).toMatchObject({ role: 'assistant', preview: 'hello world!', textBytes: 12, stop: 'stop' });
    expect(handle.session.transcript.format).toBe('fake-ndjson-v1');
    expect(readFileSync(handle.session.transcript.path, 'utf8')).toContain('hello world!');
  });

  test('think: a delta on the thinking channel, never part of the assistant text', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.think('let me see'), step.say('done')]));
    await rig.complete(runtime, rig.request());

    const thinking = rig.eventsOf('agent.message.delta').filter((event) => event.data.channel === 'thinking');
    expect(thinking.map((event) => event.data.delta)).toEqual(['let me see']);
    expect(rig.eventsOf('agent.message.completed').map((event) => event.data.preview)).toEqual(['done']);
    expect(rig.eventsOf('model.requested')).toHaveLength(1);
  });

  test('tool: goes through the REAL ToolHost, even for a tool that was never granted (C1)', async ({ rig }) => {
    const { runtime, provider } = await rig.open(
      script([step.tool('write_file', { path: 'a.txt' }), step.tool('rm_rf', { path: '/' }), step.say('done')]),
    );
    const request = rig.request();
    const exit = await rig.run(runtime, request);

    expect(exit.outcome).toBe('completed');
    expect(rig.calls.map((call) => [call.tool, call.toolCallId, call.ordinal])).toEqual([
      ['write_file', 'tc_1_1', 1],
      ['rm_rf', 'tc_1_2', 2],
    ]);
    expect(rig.eventsOf('tool.call.rejected')).toEqual([]);
    expect(rig.eventsOf('tool.call.delivered')).toHaveLength(2);
    expect(exit.usage).toMatchObject({ toolCalls: 2, turns: 2, modelRequests: 2 });
    // the say after the tool calls is a new model request, which sees both results
    const inputs = provider.modelInputs(request);
    expect(inputs[1]?.messages.filter((message) => message.role === 'tool-result').map((m) => m.text)).toEqual([
      'ok:tc_1_1',
      'ok:tc_1_2',
    ]);
  });

  test('tool.onDenied runs when the host answers with an error, and only then', async ({ rig }) => {
    rig.handler = async (call) =>
      call.tool === 'forbidden'
        ? textResult('denied: permission/tool-not-granted', { isError: true })
        : textResult('ok');
    const denied = { onDenied: [step.say('I will do without')] };
    const { runtime } = await rig.open(
      script([step.tool('forbidden', {}, denied), step.tool('write_file', {}, { onDenied: [step.say('never said')] })]),
    );
    await rig.complete(runtime, rig.request());

    expect(rig.eventsOf('agent.message.completed').map((event) => event.data.preview)).toContain('I will do without');
    expect(rig.eventsOf('agent.message.completed').map((event) => event.data.preview)).not.toContain('never said');
  });

  test('a tool after an onDenied say belongs to the turn that say opened: its response stops on tool-use', async ({
    rig,
  }) => {
    rig.handler = async (call) =>
      call.tool === 'forbidden' ? textResult('denied', { isError: true }) : textResult('ok');
    const { runtime } = await rig.open(
      script([step.tool('forbidden', {}, { onDenied: [step.say('I will do without')] }), step.tool('write_file', {})]),
    );
    await rig.complete(runtime, rig.request());

    expect(rig.eventsOf('model.responded').map((event) => event.data.stop)).toEqual(['tool-use', 'tool-use']);
    expect(rig.eventsOf('agent.message.completed').map((event) => event.data.stop)).toEqual(['tool-use', 'tool-use']);
    expect(rig.eventsOf('agent.turn.completed').map((event) => event.data.toolCalls)).toEqual([1, 1]);
  });

  test('tool.expect: a result that is not the scripted one fails the agent loudly', async ({ rig }) => {
    const { runtime } = await rig.open(
      script([
        step.tool('write_file', {}, { expect: { isError: true, textIncludes: 'denied' } }),
        step.say('unreached'),
      ]),
    );
    const exit = await rig.run(runtime, rig.request());

    expect(exit).toMatchObject({ outcome: 'failed', stop: 'engine-error' });
    expect(exit.error?.code).toBe('configuration/unexpected');
    expect(exit.error?.message).toContain('tc_1_1');
  });

  test('submit: calls the terminal tool; the host terminates the loop', async ({ rig }) => {
    rig.handler = async () => textResult('accepted', { terminate: true });
    const { runtime } = await rig.open(script([step.submit({ status: 'done' }), step.say('unreached')]));
    const exit = await rig.run(runtime, rig.request());

    expect(rig.calls.map((call) => [call.tool, call.input])).toEqual([['submit_result', { status: 'done' }]]);
    expect(exit).toMatchObject({ outcome: 'completed', stop: 'host-terminated' });
    expect(rig.eventsOf('tool.call.delivered')[0]?.data.terminate).toBe(true);
    expect(rig.eventsOf('agent.message.completed').map((event) => event.data.preview)).not.toContain('unreached');
  });

  test('usage: sets the tokens of the next model request; defaults.usagePerTurn fills the others', async ({ rig }) => {
    const perTurn = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
    const { runtime } = await rig.open({
      version: 1,
      defaults: { usagePerTurn: perTurn, model: 'scripted-large' },
      agents: [
        {
          match: {},
          steps: [step.usage({ input: 100, output: 20 }), step.say('one'), step.modelRequest(), step.say('two')],
        },
      ],
    });
    const exit = await rig.run(runtime, rig.request());

    const responded = rig.eventsOf('model.responded');
    expect(responded.map((event) => event.data.usage)).toEqual([
      { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
      perTurn,
    ]);
    expect(responded[0]?.data.effectiveModel.model).toBe('scripted-large');
    expect(exit.usage.tokens).toEqual({ input: 110, output: 25, cacheRead: 0, cacheWrite: 0, total: 135 });
  });

  test('usage: defaults.usagePerTurn is reported as written, total included', async ({ rig }) => {
    const perTurn = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 40 };
    const { runtime } = await rig.open({
      version: 1,
      defaults: { usagePerTurn: perTurn },
      agents: [
        { match: {}, steps: [step.say('one'), step.modelRequest(), step.usage({ output: 7 }), step.say('two')] },
      ],
    });
    const exit = await rig.run(runtime, rig.request());

    expect(rig.eventsOf('model.responded').map((event) => event.data.usage)).toEqual([
      perTurn,
      { input: 10, output: 7, cacheRead: 0, cacheWrite: 0, total: 17 },
    ]);
    expect(exit.usage.tokens.total).toBe(57);
  });

  test('await-message: waits for send(), and the next model request sees the message', async ({ rig }) => {
    const { runtime, provider } = await rig.open(script([step.say('ready'), step.awaitMessage(), step.say('got it')]));
    const request = rig.request();
    const handle = await runtime.spawn(request);
    await settle();
    expect((await runtime.inspect(request.agentId)).state).toBe('running');
    expect(rig.eventsOf('model.requested')).toHaveLength(1);

    await runtime.send(request.agentId, { kind: 'host-note', messageId: 'm1', text: 'go on', delivery: 'follow-up' });
    const exit = await handle.exit;

    expect(exit.outcome).toBe('completed');
    expect(rig.eventsOf('agent.message.accepted').map((event) => event.data.messageId)).toEqual(['m1']);
    expect(provider.modelInputs(request)[1]?.messages.at(-1)).toEqual({ role: 'user', text: '[cohorte] go on' });
  });

  test('await-message: gives up after timeoutMs on the INJECTED clock', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.awaitMessage(60_000), step.say('nobody wrote')]));
    const handle = await runtime.spawn(rig.request());
    await settle();
    expect(rig.clock.pendingSleeps()).toBe(1);
    rig.clock.advance(60_000);
    const exit = await handle.exit;

    expect(exit.outcome).toBe('completed');
    expect(exit.usage.wallClockMs).toBe(60_000);
  });

  test('fail: the model request fails with the scripted error', async ({ rig }) => {
    const error = { class: 'provider-transient', code: 'provider-transient/rate-limited', retryable: true } as const;
    const { runtime } = await rig.open(
      script([step.modelRequest({ status: 429 }), step.fail({ ...error, retryAfterMs: 1500 }), step.say('unreached')]),
    );
    const exit = await rig.run(runtime, rig.request());

    expect(exit).toMatchObject({ outcome: 'failed', stop: 'engine-error' });
    expect(exit.error).toMatchObject({ ...error, retryAfterMs: 1500 });
    const responded = rig.eventsOf('model.responded');
    expect(responded).toHaveLength(1);
    expect(responded[0]?.data).toMatchObject({ httpStatus: 429, stop: 'error', error: { code: error.code } });
  });

  test('fail: a code outside the catalogue is still a complete ErrorInfo', async ({ rig }) => {
    const { runtime } = await rig.open(
      script([step.fail({ class: 'provider-terminal', code: 'provider-terminal/made-up', retryable: false })]),
    );
    const exit = await rig.run(runtime, rig.request());

    expect(exit.error).toMatchObject({ class: 'provider-terminal', code: 'provider-terminal/made-up' });
    expect(exit.error?.impact).not.toBe('');
    expect(exit.error?.remediation).not.toBe('');
  });

  test('hang: sleeps on the injected clock, then goes on', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.hang(5_000), step.say('awake')]));
    const handle = await runtime.spawn(rig.request());
    await settle();
    expect(rig.eventsOf('model.requested')).toHaveLength(0);
    rig.clock.advance(5_000);

    const exit = await handle.exit;
    expect(exit.outcome).toBe('completed');
  });

  test('crash before-next-step: the agent is gone, nothing after it happens', async ({ rig }) => {
    const { runtime } = await rig.open(
      script([step.tool('write_file', {}), step.crash('before-next-step'), step.say('x')]),
    );
    const exit = await rig.run(runtime, rig.request());

    expect(exit).toMatchObject({ outcome: 'crashed', stop: 'process-exit' });
    expect(exit.error?.code).toBe('tool-transient/agent-process-exit');
    expect(rig.eventsOf('tool.call.delivered')).toHaveLength(1);
    expect(rig.types().at(-1)).toBe('agent.exited');
  });

  test('crash during-tool: the host is called, its signal aborts, and no result is ever delivered', async ({ rig }) => {
    rig.handler = (_call, ctx) =>
      new Promise((resolve) =>
        ctx.signal.addEventListener('abort', () => resolve(textResult('aborted', { isError: true })), { once: true }),
      );
    const { runtime } = await rig.open(script([step.crash('during-tool'), step.tool('write_file', {}), step.say('x')]));
    const exit = await rig.run(runtime, rig.request());

    expect(exit).toMatchObject({ outcome: 'crashed', stop: 'process-exit' });
    expect(rig.calls).toHaveLength(1);
    expect(rig.signals[0]?.aborted).toBe(true);
    expect(rig.eventsOf('tool.call.requested')).toHaveLength(1);
    expect(rig.eventsOf('tool.call.delivered')).toHaveLength(0);
  });

  test('stop-without-result: the model stops, nothing was submitted', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.say('I am done'), step.stopWithoutResult(), step.submit({})]));
    const exit = await rig.run(runtime, rig.request());

    expect(exit).toMatchObject({ outcome: 'completed', stop: 'model-stop' });
    expect(rig.calls).toEqual([]);
  });

  test('model-request: drives authSource, baseUrl, status and quota of model.responded', async ({ rig }) => {
    const quota: QuotaInfo = {
      known: true,
      source: 'response-headers',
      provider: 'fake',
      windows: [{ name: '5h', usedPercent: 93 }],
      observedAt: rig.clock.now(),
    };
    const { runtime } = await rig.open(
      script([
        step.modelRequest({ authSource: 'api-key', baseUrl: 'https://metered.example/v1', status: 200, quota }),
        step.say('billed'),
        step.modelRequest(),
        step.say('default'),
      ]),
    );
    await rig.complete(runtime, rig.request());

    const [scripted, plain] = rig.eventsOf('model.responded');
    expect(scripted?.data).toMatchObject({
      authSource: 'api-key',
      authMode: 'subscription',
      httpStatus: 200,
      quota,
      effectiveModel: { provider: 'fake', model: 'scripted', baseUrl: 'https://metered.example/v1' },
    });
    // unscripted: the fake holds no credential and reports the mode and endpoint its plan requested
    expect(plain?.data).toMatchObject({ authSource: 'none', authMode: 'subscription', quota: { known: false } });
    expect(plain?.data.effectiveModel.baseUrl).toBe(rig.request().auth.baseUrl);
    expect(plain?.data.httpStatus).toBeUndefined();
  });
});

describe('cancel', () => {
  test('hang forever honours cancel, with no timer at all', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.hang('forever'), step.say('unreached')]));
    const request = rig.request();
    const handle = await runtime.spawn(request);
    await settle();
    expect(rig.clock.pendingSleeps()).toBe(0);
    await runtime.cancel(request.agentId, 'test');

    const exit = await handle.exit;
    expect(exit).toMatchObject({ outcome: 'cancelled', stop: 'cancelled' });
  });

  test('a timed hang honours cancel and leaves no sleeper behind', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.hang(3_600_000)]));
    const request = rig.request();
    const handle = await runtime.spawn(request);
    await settle();
    expect(rig.clock.pendingSleeps()).toBe(1);
    await runtime.cancel(request.agentId);

    const exit = await handle.exit;
    expect(exit.outcome).toBe('cancelled');
    expect(rig.clock.pendingSleeps()).toBe(0);
  });

  test('crash honours cancel: an agent cancelled before its crash step exits cancelled, not crashed', async ({
    rig,
  }) => {
    rig.handler = (_call, ctx) =>
      new Promise((resolve) =>
        ctx.signal.addEventListener('abort', () => resolve(textResult('aborted', { isError: true })), { once: true }),
      );
    const { runtime } = await rig.open(script([step.tool('write_file', {}), step.crash('before-next-step')]));
    const request = rig.request();
    const handle = await runtime.spawn(request);
    await rig.handlerCalled(1);
    await runtime.cancel(request.agentId);

    const exit = await handle.exit;
    expect(exit.outcome).toBe('cancelled');
    expect(rig.signals[0]?.aborted).toBe(true);
  });

  test('a paused agent requests no tool call: cancelled while paused, it leaves no orphan request', async ({ rig }) => {
    let release: () => void = () => {};
    rig.handler = (call) =>
      new Promise((resolve) => {
        release = () => resolve(textResult(`ok:${call.toolCallId}`));
      });
    const { runtime } = await rig.open(script([step.tool('write_file', {}), step.tool('write_file', {})]));
    const request = rig.request();
    const handle = await runtime.spawn(request);
    await rig.handlerCalled(1);
    await runtime.pause(request.agentId);
    release();
    await settle();
    await runtime.cancel(request.agentId);

    const exit = await handle.exit;
    expect(exit).toMatchObject({ outcome: 'cancelled', stop: 'cancelled' });
    expect(rig.eventsOf('tool.call.requested').map((event) => event.data.call.toolCallId)).toEqual(['tc_1_1']);
    expect(rig.calls.map((call) => call.toolCallId)).toEqual(['tc_1_1']);
    expect(exit.usage.toolCalls).toBe(1);
  });

  test('a paused agent requests its next tool call once resumed', async ({ rig }) => {
    let release: () => void = () => {};
    rig.handler = (call) =>
      call.ordinal === 1
        ? new Promise((resolve) => {
            release = () => resolve(textResult('ok'));
          })
        : Promise.resolve(textResult('ok'));
    const { runtime } = await rig.open(script([step.tool('write_file', {}), step.tool('write_file', {})]));
    const request = rig.request();
    const handle = await runtime.spawn(request);
    await rig.handlerCalled(1);
    await runtime.pause(request.agentId);
    release();
    await settle();
    expect(rig.eventsOf('tool.call.requested')).toHaveLength(1);
    await runtime.resume(request.agentId);

    const exit = await handle.exit;
    expect(exit.outcome).toBe('completed');
    expect(rig.calls.map((call) => call.toolCallId)).toEqual(['tc_1_1', 'tc_1_2']);
    expect(exit.usage.toolCalls).toBe(2);
  });

  test('await-message honours cancel', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.awaitMessage(10_000)]));
    const request = rig.request();
    const handle = await runtime.spawn(request);
    await settle();
    await runtime.cancel(request.agentId);

    const exit = await handle.exit;
    expect(exit.outcome).toBe('cancelled');
    expect(rig.clock.pendingSleeps()).toBe(0);
  });
});

describe('matching', () => {
  test('first incarnation crashes after two writes, second finishes', async ({ rig }) => {
    const write = (path: string) => step.tool('write_file', { path });
    const { runtime } = await rig.open({
      version: 1,
      agents: [
        {
          match: { role: 'implementer', incarnation: 1 },
          steps: [write('a'), write('b'), step.crash('before-next-step')],
        },
        { match: { role: 'implementer', incarnation: 2 }, steps: [write('c'), step.submit({ status: 'done' })] },
      ],
    });
    rig.handler = async (call) => textResult('ok', { terminate: call.tool === 'submit_result' });

    const first = await rig.run(runtime, rig.request());
    const second = await rig.run(
      runtime,
      rig.request({ incarnation: 2, continuation: { fromIncarnation: 1, note: rig.note } }),
    );

    expect(first.outcome).toBe('crashed');
    expect(first.usage.toolCalls).toBe(2);
    expect(second).toMatchObject({ outcome: 'completed', stop: 'host-terminated' });
    expect(rig.calls.map((call) => call.toolCallId)).toEqual(['tc_1_1', 'tc_1_2', 'tc_2_1', 'tc_2_2']);
  });

  test('an unmatched spawn fails loudly with configuration/fake-script-unmatched', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.say('hi')], { role: 'reviewer' }));

    await expect(runtime.spawn(rig.request())).rejects.toMatchObject({
      info: { code: 'configuration/fake-script-unmatched' },
    });
    expect(rig.events).toEqual([]);
  });

  test('attempt is derived from the requests seen: a spawn without continuation opens an attempt', async ({ rig }) => {
    const { runtime } = await rig.open({
      version: 1,
      agents: [
        {
          match: { agentId: 'agt_implementer_*', attempt: 1 },
          steps: [step.fail({ class: 'provider-transient', code: 'provider-transient/overloaded', retryable: true })],
        },
        { match: { agentId: 'agt_implementer_*', attempt: 2 }, steps: [step.say('second attempt')] },
      ],
    });
    const agentId = 'agt_implementer_api' as AgentId;
    const first = await rig.run(runtime, rig.request({ agentId }));
    const retry = await rig.run(runtime, rig.request({ agentId, incarnation: 2 }));

    expect(first.outcome).toBe('failed');
    expect(retry.outcome).toBe('completed');
  });
});

describe('budget', () => {
  test('maxToolCalls stops before the call that would exceed it', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.tool('write_file', {}), step.tool('write_file', {})]));
    const exit = await rig.run(runtime, rig.request({ budget: { maxToolCalls: 1, maxEngineRetries: 0 } }));

    expect(exit.stop).toBe('budget');
    expect(rig.calls).toHaveLength(1);
  });

  test('maxTotalTokens stops after the response that exceeds it', async ({ rig }) => {
    const { runtime } = await rig.open(
      script([step.usage({ input: 900, output: 200 }), step.say('big'), step.modelRequest(), step.say('x')]),
    );
    const exit = await rig.run(runtime, rig.request({ budget: { maxTotalTokens: 1000, maxEngineRetries: 0 } }));

    expect(exit.stop).toBe('budget');
    expect(rig.eventsOf('model.requested')).toHaveLength(1);
  });
});
