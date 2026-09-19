// The twelve numbered rules of DESIGN 2.2. Each one opens its own Lab, checks ONE concern and nothing else, so that
// a defect fails the rule that names it. Capability-dependent rules branch on `capabilities()`.
import { canonicalJson } from '@cohorte/base';
import { Compile } from 'typebox/compile';
import { RuntimeCapabilities } from '../capabilities.ts';
import { RuntimeEvent } from '../events.ts';
import { CONTINUATION_NOTE_SEPARATOR } from '../spawn.ts';
import {
  type BrainScript,
  CONTEXT_CANARIES,
  type ConformanceOptions,
  ECHO_TOOL,
  ensure,
  HOLD_TOOL,
  Lab,
  latch,
  type ModelInput,
  NOTE_TEXT,
  type RuntimeFactory,
  rejectionCode,
  SYSTEM_PROMPT_TEXT,
  sha256Of,
  sleep,
  TASK_TEXT,
  UNGRANTED_TOOL,
  violation,
} from './lab.ts';

export type RuleVerdict = { applies: true } | { applies: false; why: string };
export interface ConformanceRule {
  /** The number of the rule in DESIGN 2.2. */
  id: number;
  title: string;
  run(factory: RuntimeFactory, options: ConformanceOptions): Promise<RuleVerdict>;
}

const APPLIES: RuleVerdict = { applies: true };

const echo = (text: string) => ({ tool: ECHO_TOOL, input: { text } });
const hold = (text: string) => ({ tool: HOLD_TOOL, input: { text } });

async function withLab<T>(
  factory: RuntimeFactory,
  options: ConformanceOptions,
  script: BrainScript,
  body: (lab: Lab) => Promise<T>,
): Promise<T> {
  const lab = new Lab(options);
  try {
    await lab.open(factory, script);
    return await body(lab);
  } finally {
    await lab.dispose();
  }
}

const rule1: ConformanceRule = {
  id: 1,
  title: 'every requested tool call reaches the ToolHost exactly once, and only the ToolHost answers it',
  run: (factory, options) =>
    withLab(
      factory,
      options,
      {
        turns: [
          { toolCalls: [echo('a'), echo('b')] },
          { toolCalls: [{ tool: UNGRANTED_TOOL, input: { text: 'x' } }] },
          { toolCalls: [echo('c')] },
          { text: 'done' },
        ],
      },
      async (lab) => {
        const request = lab.request('one');
        await lab.complete(request, 'rule 1');

        const requestedAt = new Map<string, number>();
        const startedAt = new Map<string, number>();
        const endedAt = new Map<string, number>();
        const deliveredAt = new Map<string, number>();
        let rejectedUngranted = 0;
        lab.timeline.forEach((item, index) => {
          if (item.kind === 'handler-start') {
            const id = item.call.toolCallId;
            ensure(!startedAt.has(id), `handleToolCall ran twice for ${id}`);
            ensure(requestedAt.has(id), `handleToolCall(${id}) ran before its tool.call.requested was emitted`);
            startedAt.set(id, index);
          } else if (item.kind === 'handler-end') {
            endedAt.set(item.toolCallId, index);
          } else if (item.event.type === 'tool.call.requested') {
            const id = item.event.data.call.toolCallId;
            ensure(!requestedAt.has(id), `tool.call.requested emitted twice for ${id}`);
            requestedAt.set(id, index);
          } else if (item.event.type === 'tool.call.delivered') {
            const id = item.event.data.toolCallId;
            ensure(!deliveredAt.has(id), `tool.call.delivered emitted twice for ${id}`);
            ensure(endedAt.has(id), `tool.call.delivered for ${id} without a settled handleToolCall`);
            deliveredAt.set(id, index);
          } else if (item.event.type === 'tool.call.rejected' && item.event.data.tool === UNGRANTED_TOOL) {
            rejectedUngranted += 1;
          }
        });

        for (const id of requestedAt.keys()) {
          ensure(startedAt.has(id), `tool.call.requested for ${id} was never followed by handleToolCall`);
          ensure(deliveredAt.has(id), `the result of ${id} was never delivered`);
        }

        const starts = lab.handlerStarts();
        starts.forEach(({ call }, index) => {
          const ordinal = index + 1;
          ensure(
            call.ordinal === ordinal,
            `ordinals are 1-based and gapless: call #${ordinal} has ordinal ${call.ordinal}`,
          );
          ensure(
            call.toolCallId === `tc_${request.incarnation}_${ordinal}`,
            `toolCallId is tc_<incarnation>_<ordinal>: got ${call.toolCallId} for ordinal ${ordinal}`,
          );
          ensure(
            call.runId === request.runId &&
              call.agentId === request.agentId &&
              call.incarnation === request.incarnation,
            `call ${call.toolCallId} does not carry the agent it belongs to`,
          );
        });

        const granted = starts.filter(({ call }) => call.tool === ECHO_TOOL).map(({ call }) => call.input);
        ensure(
          canonicalJson(granted) === canonicalJson([{ text: 'a' }, { text: 'b' }, { text: 'c' }]),
          `the three granted calls reach the host once each, in emission order; got ${canonicalJson(granted)}`,
        );
        const hostedUngranted = starts.filter(({ call }) => call.tool === UNGRANTED_TOOL).length;
        ensure(
          rejectedUngranted + hostedUngranted === 1,
          `a call to a tool that was not granted is EITHER refused by the engine (tool.call.rejected, no handler) OR handed to the host: got ${rejectedUngranted} rejection(s) and ${hostedUngranted} handler call(s)`,
        );
        return APPLIES;
      },
    ),
};

const rule2: ConformanceRule = {
  id: 2,
  title: 'seq strictly increases, and exit settles after the last event',
  run: (factory, options) =>
    withLab(
      factory,
      options,
      { turns: [{ text: 'working', toolCalls: [echo('a')] }, { text: 'done' }] },
      async (lab) => {
        const request = lab.request('two');
        const handle = await lab.runtime.spawn(request);
        let itemsAtExit = -1;
        const settled = handle.exit.then((exit) => {
          itemsAtExit = lab.timeline.length;
          return exit;
        });
        const exit = await lab.exitOf({ ...handle, exit: settled }, 'rule 2');
        await sleep(lab.quietMs);

        const events = lab.events(request.agentId);
        ensure(events.length > 0, 'no event was delivered to the subscriber');
        const check = Compile(RuntimeEvent);
        let previous = Number.NEGATIVE_INFINITY;
        for (const event of events) {
          const [problem] = check.Errors(event);
          if (problem)
            violation(
              `${event.type} (seq ${event.seq}) is not a RuntimeEvent: ${problem.instancePath} ${problem.message}`,
            );
          ensure(event.seq > previous, `seq must strictly increase: ${event.type} has ${event.seq} after ${previous}`);
          ensure(
            event.runId === request.runId && event.incarnation === request.incarnation,
            `${event.type} does not carry the run and incarnation of its agent`,
          );
          previous = event.seq;
        }
        const last = events.at(-1);
        ensure(last?.type === 'agent.exited', `the last event is agent.exited, got ${last?.type}`);
        ensure(exit.lastSeq === last.seq, `exit.lastSeq (${exit.lastSeq}) is the seq of the last event (${last.seq})`);
        ensure(last.data.outcome === exit.outcome, 'agent.exited carries the exit the handle settles with');
        ensure(
          lab.events(request.agentId).length === events.length && itemsAtExit === lab.timeline.length,
          'an event was delivered AFTER exit settled',
        );
        return APPLIES;
      },
    ),
};

const rule3: ConformanceRule = {
  id: 3,
  title: 'a second spawn of the same (runId, agentId, incarnation) rejects with conflict/incarnation-exists',
  run: (factory, options) =>
    withLab(factory, options, { turns: [{ toolCalls: [hold('a')] }, { text: 'done' }] }, async (lab) => {
      const release = latch();
      lab.handler = async (call) => {
        await release.opened;
        return lab.result(`held:${call.toolCallId}`);
      };
      const request = lab.request('three');
      const handle = await lab.runtime.spawn(request);
      try {
        await lab.waitForHandlerStart('rule 3: the first incarnation reaches its tool call');
        const code = await rejectionCode(lab.runtime.spawn(request), 'rule 3: second spawn of a live incarnation');
        ensure(code === 'conflict/incarnation-exists', `expected conflict/incarnation-exists, got ${code}`);
      } finally {
        release.open();
      }
      const exit = await lab.exitOf(handle, 'rule 3');
      ensure(
        exit.outcome === 'completed',
        `the first incarnation is not disturbed by the refused one: ${exit.outcome}`,
      );
      return APPLIES;
    }),
};

const rule4: ConformanceRule = {
  id: 4,
  title: 'cancel during a pending handleToolCall aborts ctx.signal and the agent exits cancelled within the bound',
  run: (factory, options) =>
    withLab(factory, options, { turns: [{ toolCalls: [hold('a')] }, { text: 'done' }] }, async (lab) => {
      const caps = lab.runtime.capabilities();
      if (caps.cancelCooperative.value === 'no' && caps.cancelHard.value === 'no')
        return { applies: false, why: 'the runtime declares that it cannot cancel' };
      lab.handler = (_call, ctx) =>
        new Promise((resolve) => {
          const settle = (): void => resolve(lab.result('aborted by the host', true));
          if (ctx.signal.aborted) settle();
          else ctx.signal.addEventListener('abort', settle, { once: true });
        });
      const request = lab.request('four');
      const handle = await lab.runtime.spawn(request);
      const { signal } = await lab.waitForHandlerStart('rule 4: the agent reaches its tool call');
      const started = Date.now();
      await lab.runtime.cancel(request.agentId, 'conformance rule 4');
      const exit = await lab.exitOf(handle, 'rule 4: cancel');
      ensure(signal.aborted, 'ctx.signal of the pending handleToolCall was not aborted');
      ensure(exit.outcome === 'cancelled', `exit.outcome is 'cancelled', got '${exit.outcome}'`);
      ensure(Date.now() - started <= lab.boundMs, `cancel took longer than ${lab.boundMs} ms`);
      return APPLIES;
    }),
};

const rule5: ConformanceRule = {
  id: 5,
  title: 'pause lets a pending tool result through and starts no further handleToolCall until resume',
  run: (factory, options) =>
    withLab(
      factory,
      options,
      { turns: [{ toolCalls: [hold('a')] }, { toolCalls: [echo('b')] }, { text: 'done' }] },
      async (lab) => {
        const caps = lab.runtime.capabilities();
        if (caps.pause.toolBoundary.value === 'no') return { applies: false, why: caps.pause.toolBoundary.why };
        const release = latch();
        lab.handler = async (call) => {
          if (call.tool === HOLD_TOOL) await release.opened;
          return lab.result(`answered:${call.toolCallId}`);
        };
        const request = lab.request('five');
        const handle = await lab.runtime.spawn(request);
        try {
          const first = await lab.waitForHandlerStart('rule 5: the agent reaches its first tool call');
          await lab.runtime.pause(request.agentId);
          const pausedFrom = lab.timeline.length;
          release.open();
          await lab.waitFor(
            'rule 5: the pending result is delivered while paused',
            (item): item is typeof item =>
              item.kind === 'event' &&
              item.event.type === 'tool.call.delivered' &&
              item.event.data.toolCallId === first.call.toolCallId,
          );
          await sleep(lab.quietMs);
          const whilePaused = lab.timeline.slice(pausedFrom);
          ensure(
            !whilePaused.some((item) => item.kind === 'handler-start'),
            'a handleToolCall started while the agent was paused',
          );
          if (caps.pause.modelBoundary.value === 'yes')
            ensure(
              !whilePaused.some((item) => item.kind === 'event' && item.event.type === 'model.requested'),
              'model.requested was emitted while the agent was paused (pause.modelBoundary is yes)',
            );
          const resumedFrom = lab.timeline.length;
          await lab.runtime.resume(request.agentId);
          await lab.waitForHandlerStart('rule 5: the next tool call starts after resume', resumedFrom);
        } finally {
          release.open();
        }
        const exit = await lab.exitOf(handle, 'rule 5');
        ensure(exit.outcome === 'completed', `a paused and resumed agent completes: ${exit.outcome}`);
        return APPLIES;
      },
    ),
};

const rule6: ConformanceRule = {
  id: 6,
  title: 'a PromptRef or TaskInput whose file hash differs rejects spawn with security/asset-hash-mismatch',
  run: (factory, options) =>
    withLab(factory, options, { turns: [{ text: 'done' }] }, async (lab) => {
      const wrong = sha256Of('not the content of that file');
      const base = lab.request('six');
      const cases = [
        ['systemPrompt', lab.request('six_a', { systemPrompt: { ...base.systemPrompt, sha256: wrong } })],
        ['task', lab.request('six_b', { task: { ...base.task, sha256: wrong } })],
        [
          'continuation.note',
          lab.request('six_c', {
            incarnation: 2,
            continuation: { fromIncarnation: 1, note: { ...lab.note, sha256: wrong } },
          }),
        ],
      ] as const;
      for (const [what, request] of cases) {
        const code = await rejectionCode(lab.runtime.spawn(request), `rule 6: spawn with a wrong ${what} hash`);
        ensure(code === 'security/asset-hash-mismatch', `${what}: expected security/asset-hash-mismatch, got ${code}`);
        ensure(
          lab.eventsOf(request.agentId, 'model.requested').length === 0,
          `${what}: a model request was made with an unverified asset`,
        );
      }
      return APPLIES;
    }),
};

const rule7: ConformanceRule = {
  id: 7,
  title: "maxTurns: 1 stops the agent with stop 'budget'; maxModelRequests: 1 allows one model request",
  run: (factory, options) =>
    withLab(
      factory,
      options,
      { turns: [{ toolCalls: [echo('a')] }, { toolCalls: [echo('b')] }, { text: 'done' }] },
      async (lab) => {
        const turns = lab.request('seven_a', { budget: { maxTurns: 1, maxEngineRetries: 0 } });
        const exit = await lab.run(turns, 'rule 7: maxTurns');
        ensure(exit.stop === 'budget', `maxTurns: 1 yields exit.stop 'budget', got '${exit.stop}'`);

        if (lab.runtime.capabilities().budgetEnforcement.modelRequests.value === 'yes') {
          const requests = lab.request('seven_b', { budget: { maxModelRequests: 1, maxEngineRetries: 0 } });
          const limited = await lab.run(requests, 'rule 7: maxModelRequests');
          ensure(limited.outcome !== 'crashed', 'a budget stop is not a crash');
          const made = lab.eventsOf(requests.agentId, 'model.requested').length;
          ensure(made <= 1, `maxModelRequests: 1 allows at most one model.requested, got ${made}`);
        }
        return APPLIES;
      },
    ),
};

const rule8: ConformanceRule = {
  id: 8,
  title: 'capabilities() is a pure, schema-valid value',
  run: (factory, options) =>
    withLab(factory, options, { turns: [{ text: 'done' }] }, async (lab) => {
      const before = lab.runtime.capabilities();
      const [problem] = Compile(RuntimeCapabilities).Errors(before);
      if (problem) violation(`capabilities() is not a RuntimeCapabilities: ${problem.instancePath} ${problem.message}`);
      const snapshot = canonicalJson(before);
      ensure(canonicalJson(lab.runtime.capabilities()) === snapshot, 'two calls of capabilities() differ');
      const request = lab.request('eight');
      await lab.complete(request, 'rule 8');
      ensure(canonicalJson(lab.runtime.capabilities()) === snapshot, 'capabilities() changed after an agent ran');
      return APPLIES;
    }),
};

const WATCHED_RESOURCES = ['Timeout', 'ProcessWrap'] as const;
const liveResources = (): Record<(typeof WATCHED_RESOURCES)[number], number> => {
  const live = process.getActiveResourcesInfo();
  return {
    Timeout: live.filter((r) => r === 'Timeout').length,
    ProcessWrap: live.filter((r) => r === 'ProcessWrap').length,
  };
};
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const rule9: ConformanceRule = {
  id: 9,
  title: 'after close() no child process or timer survives',
  run: async (factory, options) => {
    const lab = new Lab(options);
    // Counted with no timer of the suite's own pending: the comparison is relative to this moment.
    const before = liveResources();
    let pid: number | undefined;
    try {
      await lab.open(factory, { turns: [{ toolCalls: [hold('a')] }, { text: 'done' }] });
      lab.handler = (_call, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(lab.result('closed', true)), { once: true });
        });
      const handle = await lab.runtime.spawn(lab.request('nine'));
      pid = handle.process?.pid;
      await lab.waitForHandlerStart('rule 9: the agent is busy when the runtime is closed');
      await lab.runtime.close();
      await lab.exitOf(handle, 'rule 9: close() settles every agent');
    } finally {
      await lab.dispose();
    }
    const deadline = Date.now() + lab.boundMs;
    for (;;) {
      const after = liveResources();
      const left = WATCHED_RESOURCES.filter((name) => after[name] > before[name]);
      const orphan = pid !== undefined && pid !== process.pid && isAlive(pid);
      if (left.length === 0 && !orphan) return APPLIES;
      if (Date.now() >= deadline)
        violation(
          orphan
            ? `the agent process ${pid} survives close()`
            : `resources survive close(): ${left.map((name) => `${name} ${before[name]} -> ${after[name]}`).join(', ')}`,
        );
      await sleep(25);
    }
  },
};

// Everything an engine-side "clean-up" would touch: outer blanks, CRLF, tabs, NBSP, quotes, markup, JSON, U+2028.
const RESULT_TEXT =
  '  result \r\n\ttab nbsp "quoted" \\back\\ <tag attr="1"> &amp; é ü 漢字   {"json":[true,null]}\n\n';

const rule10: ConformanceRule = {
  id: 10,
  title: 'a tool result text is delivered to the model byte-identical',
  run: (factory, options) =>
    withLab(factory, options, { turns: [{ toolCalls: [echo('a')] }, { text: 'done' }] }, async (lab) => {
      lab.handler = async () => lab.result(RESULT_TEXT);
      const request = lab.request('ten');
      await lab.complete(request, 'rule 10');
      const inputs = await lab.modelInputs(lab.key(request.agentId));
      const results = inputs.flatMap((input) => input.messages.filter((message) => message.role === 'tool-result'));
      ensure(results.length > 0, 'modelProbe() recorded no tool-result message: the model never saw the result');
      ensure(
        results.some((message) => message.text === RESULT_TEXT),
        `the model saw a rewritten tool result: ${JSON.stringify(results[0]?.text)} instead of ${JSON.stringify(RESULT_TEXT)}`,
      );
      return APPLIES;
    }),
};

const rule11: ConformanceRule = {
  id: 11,
  title:
    "an AuthRequirement.baseUrl that is not the engine's endpoint rejects spawn with security/auth-endpoint-mismatch",
  run: (factory, options) =>
    withLab(factory, options, { turns: [{ text: 'done' }] }, async (lab) => {
      const base = lab.request('eleven');
      const request = { ...base, auth: { ...base.auth, baseUrl: 'https://endpoint-mismatch.conformance.invalid/v1' } };
      const code = await rejectionCode(lab.runtime.spawn(request), 'rule 11: spawn against another endpoint');
      ensure(code === 'security/auth-endpoint-mismatch', `expected security/auth-endpoint-mismatch, got ${code}`);
      ensure(
        lab.eventsOf(request.agentId, 'model.requested').length === 0,
        'a model request left for a refused endpoint',
      );
      return APPLIES;
    }),
};

const everyText = (inputs: ModelInput[]): string[] =>
  inputs.flatMap((input) => [input.systemPrompt, ...input.messages.map((message) => message.text)]);

const rule12: ConformanceRule = {
  id: 12,
  title: 'context installation: systemPrompt, then task, then the continuation note, byte-identical, and nothing else',
  run: async (factory, options) => {
    for (const continued of [false, true]) {
      const what = continued ? 'rule 12 (continuation)' : 'rule 12';
      await withLab(factory, options, { turns: [{ text: 'done' }] }, async (lab) => {
        const request = continued
          ? lab.request('twelve', { incarnation: 2, continuation: { fromIncarnation: 1, note: lab.note } })
          : lab.request('twelve');
        await lab.complete(request, what);
        const inputs = await lab.modelInputs(lab.key(request.agentId, request.incarnation));
        const [first] = inputs;
        if (!first) violation(`${what}: modelProbe() recorded no model input`);
        ensure(lab.eventsOf(request.agentId, 'model.requested').length >= 1, `${what}: no model.requested was emitted`);

        ensure(
          first.systemPrompt.startsWith(SYSTEM_PROMPT_TEXT),
          `${what}: the system prompt the model saw does not start with the byte-identical systemPrompt file`,
        );
        const [spawned] = lab.eventsOf(request.agentId, 'agent.spawned');
        if (!spawned) violation(`${what}: no agent.spawned event`);
        ensure(
          spawned.data.systemPromptSha256 === request.systemPrompt.sha256,
          `${what}: agent.spawned.systemPromptSha256 is not the hash of the PromptRef`,
        );
        ensure(
          spawned.data.effectiveSystemPromptSha256 === sha256Of(first.systemPrompt),
          `${what}: effectiveSystemPromptSha256 is not the hash of the system prompt the model saw`,
        );

        const firstAssistant = first.messages.findIndex((message) => message.role === 'assistant');
        const users = first.messages
          .slice(0, firstAssistant === -1 ? undefined : firstAssistant)
          .filter((message) => message.role === 'user');
        const [opening, second] = users;
        if (!opening?.text.startsWith(TASK_TEXT))
          violation(`${what}: the first user message does not start with the byte-identical task`);
        if (continued) {
          // DESIGN 2.2.3: a second user message, or the first one continued after the FIXED separator line
          const appended = opening.text.startsWith(TASK_TEXT + CONTINUATION_NOTE_SEPARATOR + NOTE_TEXT);
          const separate = second?.text.startsWith(NOTE_TEXT) === true;
          ensure(
            appended || separate,
            `${what}: the continuation note must follow the task as a byte-identical span, in a second user message or after ${JSON.stringify(CONTINUATION_NOTE_SEPARATOR)}`,
          );
        } else {
          ensure(
            !everyText(inputs).some((text) => text.includes(NOTE_TEXT)),
            `${what}: a note reached the model without a continuation`,
          );
        }
        for (const canary of CONTEXT_CANARIES)
          ensure(
            !everyText(inputs).some((text) => text.includes(canary)),
            `${what}: ${canary} reached the model: a runtime installs systemPrompt, task and note, and NOTHING else from context`,
          );
      });
    }
    return APPLIES;
  },
};

export const CONFORMANCE_RULES: readonly ConformanceRule[] = Object.freeze([
  rule1,
  rule2,
  rule3,
  rule4,
  rule5,
  rule6,
  rule7,
  rule8,
  rule9,
  rule10,
  rule11,
  rule12,
]);
