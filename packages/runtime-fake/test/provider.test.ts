// FakeLedger, pin(), capabilities() and the trivial auth surface.
import { canonicalJson, type JsonValue } from '@cohorte/base';
import { ProviderAuthStatus, RuntimeCapabilities, RuntimePin } from '@cohorte/runtime-contract';
import { Compile } from 'typebox/compile';
import { describe, expect } from 'vitest';
import { createFakeRuntimeProvider, spawnRequestIdentity } from '../src/fake/index.ts';
import { fakeScript, step } from '../src/script/index.ts';
import { BASE_URL, script, test } from './bench.ts';

const overloaded = { class: 'provider-transient', code: 'provider-transient/overloaded', retryable: true } as const;

describe('FakeLedger', () => {
  test("a retry's SpawnRequest minus `incarnation` is byte-identical", async ({ rig }) => {
    const { runtime, provider } = await rig.open(
      fakeScript()
        .agent({ attempt: 1 }, [step.fail(overloaded)])
        .agent({ attempt: 2 }, [step.say('done')])
        .build(),
    );
    await rig.complete(runtime, rig.request());
    // the host re-renders its request for the retry: an equal VALUE, not the same object
    await rig.complete(runtime, structuredClone(rig.request({ incarnation: 2 })));

    const [first, retry] = provider.ledger.requests();
    if (!first || !retry) throw new Error('two requests were recorded');
    expect([first.incarnation, retry.incarnation]).toEqual([1, 2]);
    expect(spawnRequestIdentity(retry)).toBe(spawnRequestIdentity(first));
    const { incarnation: _incarnation, ...rest } = first;
    expect(spawnRequestIdentity(first)).toBe(canonicalJson(rest as unknown as JsonValue));
    expect(provider.ledger.requestsOf(first.agentId)).toHaveLength(2);
    expect(provider.ledger.requestsOf('agt_nobody')).toEqual([]);
  });

  test('a request that differs by anything else than `incarnation` has another identity', ({ rig }) => {
    const base = rig.request();
    expect(spawnRequestIdentity({ ...base, thinking: 'high' })).not.toBe(spawnRequestIdentity(base));
  });

  test('records what was RECEIVED: a later mutation by the caller does not rewrite history, refused spawns count', async ({
    rig,
  }) => {
    const { runtime, provider } = await rig.open(script([step.say('hi')], { role: 'implementer' }));
    const request = rig.request();
    await rig.complete(runtime, request);
    request.role = 'mutated';
    await expect(runtime.spawn(rig.request({ role: 'reviewer', incarnation: 2 }))).rejects.toThrow(
      'fake-script-unmatched',
    );

    expect(provider.ledger.requests().map((recorded) => recorded.role)).toEqual(['implementer', 'reviewer']);
  });
});

describe('pin', () => {
  test('is a schema-valid RuntimePin that hashes the script', async () => {
    const a = createFakeRuntimeProvider({ script: script([step.say('a')]) });
    const same = createFakeRuntimeProvider({ script: script([step.say('a')]) });
    const other = createFakeRuntimeProvider({ script: script([step.say('b')]) });

    const pin = await a.pin();
    expect([...Compile(RuntimePin).Errors(pin)]).toEqual([]);
    expect(pin.runtimeId).toBe('fake');
    expect((await same.pin()).digest).toBe(pin.digest);
    expect((await other.pin()).digest).not.toBe(pin.digest);
  });

  test('create() refuses a pin taken from another script', async ({ rig }) => {
    const provider = createFakeRuntimeProvider({ script: script([step.say('a')]) });
    const foreign = await createFakeRuntimeProvider({ script: script([step.say('b')]) }).pin();

    await expect(provider.create(rig.bindings, foreign)).rejects.toMatchObject({
      info: { code: 'security/runtime-pin-mismatch' },
    });
  });

  test('an invalid script is refused when the provider is created', () => {
    const broken = { version: 1, agents: [{ match: {}, steps: [{ do: 'dance' }] }] };
    expect(() => createFakeRuntimeProvider({ script: broken as never })).toThrow('fake runtime script is invalid');
  });
});

describe('runtime surface', () => {
  test('capabilities() is schema-valid, host-delegated, and honest about what an in-process fake cannot do', async ({
    rig,
  }) => {
    const { runtime } = await rig.open(script([]));
    const caps = runtime.capabilities();

    expect([...Compile(RuntimeCapabilities).Errors(caps)]).toEqual([]);
    expect(caps.toolExecution).toBe('host-delegated');
    expect(caps.processIsolation.value).toBe('no');
    expect(caps.brainSandbox.value).toBe('no');
    expect(caps.cancelHard.value).toBe('no');
    expect(caps.subscriptionModeAssertion.value).toBe('no');
    expect(runtime.id).toBe('fake');
    expect(runtime.version).toMatch(/^\d+\.\d+\.\d+\+fake\.\d+$/);
  });

  test('spawn reports an in-process isolation level and a null process', async ({ rig }) => {
    const { runtime } = await rig.open(script([]));
    const handle = await runtime.spawn(rig.request());
    const exit = await handle.exit;
    expect(exit.outcome).toBe('completed');

    expect(handle.process).toBeNull();
    expect(rig.eventsOf('agent.spawned')[0]?.data.isolation).toEqual({
      level: 'none',
      filesystem: 'advisory',
      network: 'none',
      backend: 'in-process',
    });
  });

  test('inspect: a snapshot while a tool call is pending, and after the exit', async ({ rig }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig.handler = async () => {
      await held;
      return { isError: false, content: [] };
    };
    const { runtime } = await rig.open(script([step.tool('write_file', {})]));
    const request = rig.request();
    const handle = await runtime.spawn(request);
    await rig.handlerCalled(1);

    expect(await runtime.inspect(request.agentId)).toMatchObject({
      state: 'awaiting-tool',
      pendingToolCalls: ['tc_1_1'],
      incarnation: 1,
      authMode: 'subscription',
    });
    release();
    const exit = await handle.exit;
    expect(await runtime.inspect(request.agentId)).toMatchObject({ state: 'exited', lastSeq: exit.lastSeq });
    await expect(runtime.inspect('agt_nobody')).rejects.toThrow('agt_nobody');
  });

  test('a runtime without `baseUrl` accepts the endpoint its plan pinned; with one it refuses any other', async ({
    rig,
  }) => {
    const open = createFakeRuntimeProvider({ script: script([]), clock: rig.clock });
    const lenient = await open.create(rig.bindings, await open.pin());
    await rig.complete(lenient, rig.request({ auth: { ...rig.request().auth, baseUrl: 'https://any.invalid' } }));

    const { runtime } = await rig.open(script([]));
    expect(rig.request().auth.baseUrl).toBe(BASE_URL);
    await expect(
      runtime.spawn(rig.request({ auth: { ...rig.request().auth, baseUrl: 'https://any.invalid' } })),
    ).rejects.toMatchObject({ info: { code: 'security/auth-endpoint-mismatch' } });
  });

  test('a throwing subscriber does not disturb the agent or the other subscribers', async ({ rig }) => {
    const { runtime } = await rig.open(script([step.say('hi')]));
    runtime.subscribe(() => {
      throw new Error('subscriber bug');
    });
    const exit = await rig.run(runtime, rig.request());

    expect(exit.outcome).toBe('completed');
    expect(rig.types().at(-1)).toBe('agent.exited');
  });
});

describe('auth', () => {
  test('the fake holds no credential: status is absent, login and logout are trivial', async ({ rig }) => {
    const provider = createFakeRuntimeProvider({ script: script([]), clock: rig.clock });
    const statuses = await provider.authStatus(['openai-codex', 'anthropic']);

    expect(statuses.map((status) => [status.provider, status.state, status.subscription])).toEqual([
      ['openai-codex', 'absent', false],
      ['anthropic', 'absent', false],
    ]);
    const check = Compile(ProviderAuthStatus);
    for (const status of statuses) expect([...check.Errors(status)]).toEqual([]);
    expect(statuses[0]?.checkedAt).toBe(rig.clock.now());

    const shown: string[] = [];
    const ui = { show: (event: { kind: string }) => void shown.push(event.kind), ask: async () => '' };
    const afterLogin = await provider.login('openai-codex', ui, new AbortController().signal);
    expect(afterLogin.state).toBe('absent');
    expect(shown).toEqual(['info']);
    await expect(provider.logout('openai-codex')).resolves.toBeUndefined();
  });
});
