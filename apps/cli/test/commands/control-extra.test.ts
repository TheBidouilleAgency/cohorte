import { describe, expect, it } from 'vitest';
import runTool from '../../src/commands/run-tool/index.ts';
import send from '../../src/commands/send/index.ts';
import { fakeCliContext } from '../registry/helpers.ts';

describe('additional control commands', () => {
  it('sends a signed agent message through the controller', async () => {
    let received: unknown;
    const ctx = fakeCliContext({
      controller: {
        send: async (...args: unknown[]) => {
          received = args;
          return { status: 'pending' } as never;
        },
      },
    });
    expect(
      await send.run(ctx, { positionals: ['run_1', 'agt_1', 'please', 'continue'], options: {}, json: true }),
    ).toBe(4);
    expect(received).toMatchObject([
      'agent.send',
      { agentId: 'agt_1', text: 'please continue', delivery: 'steer' },
      { runId: 'run_1' },
    ]);
  });

  it('validates the direct-tool request before enqueueing it', async () => {
    const ctx = fakeCliContext();
    expect(
      await runTool.run(ctx, { positionals: ['run_1', 'read_file', '{bad}', 'inspect'], options: {}, json: true }),
    ).toBe(2);
  });
});
