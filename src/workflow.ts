import { assign, createActor, setup } from 'xstate';
import type { AgentRuntime, CheckRunner, Phase, Run, Verdict } from './contracts.ts';
import type { Store } from './store.ts';

export interface StepContext {
  run: Run;
  signal: AbortSignal;
  agents: AgentRuntime;
  checks: CheckRunner;
  store: Store;
}
export interface StepDefinition {
  execute(ctx: StepContext): Promise<Verdict>;
}
const agentStep = (phase: 'build' | 'review' | 'fix'): StepDefinition => ({
  async execute({ run, signal, agents, store }) {
    return agents.execute({
      run,
      phase,
      signal,
      onThread: (id) => {
        run.threadIds.push(id);
        store.save(run, 'agent.started', phase);
      },
      onEvent: (kind, detail) => store.event(run.id, kind, detail),
    });
  },
});
export const defaultSteps: Record<Phase, StepDefinition> = {
  build: agentStep('build'),
  review: agentStep('review'),
  fix: agentStep('fix'),
  test: {
    async execute({ run, signal, checks }) {
      run.checks = await checks.execute(run, signal);
      const failed = run.checks.filter((c) => c.exitCode !== 0);
      if (!run.checks.length) throw new Error('No checks executed');
      return {
        verdict: failed.length ? 'fix' : 'pass',
        summary: `${run.checks.length - failed.length}/${run.checks.length} checks passed`,
        findings: failed.map((c) => `${JSON.stringify(c.argv)} exited ${c.exitCode}: ${c.output}`),
      };
    },
  },
};

function workflow(run: Run) {
  return setup({
    types: {
      context: {} as { round: number; maxRounds: number },
      events: {} as { type: 'PASS' | 'FIX' | 'BLOCK' | 'STOP' },
    },
    guards: { canFix: ({ context }) => context.round < context.maxRounds },
    actions: { nextRound: assign({ round: ({ context }) => context.round + 1 }) },
  }).createMachine({
    id: 'cohorte',
    initial: run.phase,
    context: { round: run.round, maxRounds: run.config.maxRounds },
    on: { STOP: '.interrupted', BLOCK: '.blocked' },
    states: {
      build: { on: { PASS: 'test', FIX: 'blocked' } },
      test: {
        on: { PASS: 'review', FIX: [{ guard: 'canFix', target: 'fix', actions: 'nextRound' }, { target: 'blocked' }] },
      },
      review: {
        on: {
          PASS: 'completed',
          FIX: [{ guard: 'canFix', target: 'fix', actions: 'nextRound' }, { target: 'blocked' }],
        },
      },
      fix: { on: { PASS: 'test', FIX: 'blocked' } },
      completed: { type: 'final' },
      blocked: { type: 'final' },
      interrupted: { type: 'final' },
    },
  });
}

/** Each phase is recorded BEFORE work starts; interrupted work is never auto-replayed. */
export async function executeRun(
  run: Run,
  store: Store,
  agents: AgentRuntime,
  checks: CheckRunner,
  signal: AbortSignal,
  steps: Record<Phase, StepDefinition> = defaultSteps,
) {
  if (run.status === 'completed' || run.status === 'cancelled') throw new Error('Run is terminal');
  const actor = createActor(workflow(run));
  actor.start();
  try {
    while (actor.getSnapshot().status !== 'done') {
      run.phase = actor.getSnapshot().value as Phase;
      run.round = actor.getSnapshot().context.round;
      run.status = 'running';
      store.save(run, 'phase.started', `${run.phase} round ${run.round}`);
      try {
        signal.throwIfAborted();
        const result = await steps[run.phase].execute({ run, signal, store, agents, checks });
        signal.throwIfAborted();
        run.summary = result.summary;
        run.feedback = result.findings.join('\n');
        store.save(run, 'phase.finished', result.verdict);
        actor.send({ type: result.verdict === 'pass' ? 'PASS' : 'FIX' });
      } catch (error) {
        run.summary = error instanceof Error ? error.message : 'Phase failed';
        run.feedback = run.summary;
        actor.send({ type: signal.aborted ? 'STOP' : 'BLOCK' });
      }
      const state = actor.getSnapshot();
      run.round = state.context.round;
      if (state.status === 'done') {
        run.status = state.value as 'completed' | 'blocked' | 'interrupted';
        store.save(run, `run.${run.status}`, run.summary);
      } else {
        run.phase = state.value as Phase;
        run.status = 'pending';
        store.save(run, 'phase.ready', run.phase);
      }
    }
    return run;
  } finally {
    actor.stop();
  }
}
