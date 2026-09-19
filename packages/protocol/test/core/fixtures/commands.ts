import type { CommandType } from '../../../src/commands.ts';

const RUN = `run_${'1'.repeat(32)}`;
const APPROVAL = `apr_${'2'.repeat(32)}`;
const ARTIFACT = `art_${'3'.repeat(32)}`;
const HEX64 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

export interface CommandFixture {
  protocolVersion: string;
  commandId: string;
  type: CommandType;
  runId: string;
  issuedAt: string;
  actor: { kind: string; id: string; transport: string };
  payload: Record<string, unknown>;
  expectedSequence?: number;
  auth?: { scheme: string; value: string };
}

let ordinal = 0;
const command = (
  type: CommandType,
  payload: Record<string, unknown>,
  more: Pick<CommandFixture, 'expectedSequence' | 'auth'> = {},
): CommandFixture => {
  ordinal += 1;
  return {
    protocolVersion: '1.0',
    commandId: `cmd_${ordinal.toString(16).padStart(32, '0')}`,
    type,
    runId: RUN,
    issuedAt: '2026-09-18T10:00:00.000Z',
    actor: { kind: 'human', id: 'enzo', transport: 'cli' },
    payload,
    ...more,
  };
};

const signed = { auth: { scheme: 'hmac-sha256', value: HEX64 } };

/** One complete envelope per command type, as plain JSON: what a client would write. */
export const COMMAND_FIXTURES: Record<CommandType, CommandFixture> = {
  start: command(
    'start',
    {
      profile: 'feature',
      spec: { id: 'checkout-flow' },
      withFix: true,
      phases: ['BUILD', 'TEST'],
      modelOverrides: { reviewer: { provider: 'openai-codex', model: 'gpt-5.5-codex', capability: 'reasoning' } },
      runtime: 'fake',
      fakeScript: 'scripts/happy-path.json',
      unattended: false,
      budgets: { tokens: 2_000_000, fixRounds: 3 },
      sandboxRequire: 'best-effort',
      consent: { policySha256: HEX64, via: 'cli-flag' },
    },
    signed,
  ),
  status: command('status', {}),
  inspect: command('inspect', { target: { kind: 'artifact', artifactId: ARTIFACT, maxBytes: 65_536, offset: 0 } }),
  tail: command('tail', { sinceSequence: 41, follow: true, ephemeral: false }),
  pause: command('pause', { reason: 'lunch' }, signed),
  resume: command('resume', { acknowledge: 'blocked-inspected', raiseBudgets: { tokens: 3_000_000 } }, signed),
  cancel: command('cancel', { keepWorktrees: true }, signed),
  approve: command('approve', { approvalId: APPROVAL, scope: 'once', answer: 'rebase', note: 'ok' }, signed),
  deny: command('deny', { approvalId: APPROVAL }, signed),
  retry: command('retry', { target: { kind: 'phase', state: 'TEST' } }, { ...signed, expectedSequence: 42 }),
  skip: command('skip', { phase: 'BRAINSTORM', justification: 'spec already frozen' }, signed),
  'run-tool': command(
    'run-tool',
    { tool: 'read', input: { path: 'README.md', lines: [1, 20] }, justification: 'debugging a gate' },
    signed,
  ),
  reconcile: command('reconcile', { mode: 'plan' }),
  shutdown: command('shutdown', { graceMs: 5000 }, signed),
  'agent.send': command(
    'agent.send',
    { agentId: 'agt_implementer_backend', text: 'prefer the existing helper', delivery: 'steer' },
    signed,
  ),
};

/** Every other shape of the unions above, keyed by what it shows. */
export const COMMAND_PAYLOAD_VARIANTS: readonly (readonly [string, CommandType, Record<string, unknown>])[] = [
  [
    'start with a spec path and a ref to review',
    'start',
    { profile: 'review', spec: { path: 'specs/x.md' }, reviewTarget: { ref: 'HEAD~3' }, unattended: true },
  ],
  [
    'start reviewing a range',
    'start',
    { profile: 'review', reviewTarget: { base: 'main', head: 'feat/x' }, unattended: true },
  ],
  ['start reviewing a run', 'start', { profile: 'review', reviewTarget: { runId: RUN }, unattended: false }],
  ['status of one run', 'status', { runId: RUN }],
  ['inspect an agent', 'inspect', { target: { kind: 'agent', agentId: 'agt_tester_main' } }],
  ['inspect a context', 'inspect', { target: { kind: 'context', agentId: 'agt_tester_main', incarnation: 2 } }],
  ['inspect an approval', 'inspect', { target: { kind: 'approval', approvalId: APPROVAL } }],
  ['inspect an effect', 'inspect', { target: { kind: 'effect', effectId: `eff_${'4'.repeat(32)}` } }],
  ['inspect the snapshot', 'inspect', { target: { kind: 'snapshot' } }],
  ['inspect the locks', 'inspect', { target: { kind: 'locks' } }],
  ['inspect the whole diff', 'inspect', { target: { kind: 'diff' } }],
  ['inspect the diff of one surface', 'inspect', { target: { kind: 'diff', surface: 'backend' } }],
  ['inspect an artifact with the default cap', 'inspect', { target: { kind: 'artifact', artifactId: ARTIFACT } }],
  ['tail a replay', 'tail', { replay: 100, follow: false, ephemeral: true }],
  ['resume with a takeover', 'resume', { takeover: true }],
  ['approve for the run', 'approve', { approvalId: APPROVAL, scope: 'run' }],
  ['retry an agent', 'retry', { target: { kind: 'agent', agentId: 'agt_fixer_main_2' } }],
  ['run-tool for an agent', 'run-tool', { agentId: 'agt_fixer_main', tool: 'search', input: null, justification: 'x' }],
  ['reconcile apply', 'reconcile', { mode: 'apply' }],
  ['agent.send as a follow-up', 'agent.send', { agentId: 'agt_fixer_main', text: 'x', delivery: 'follow-up' }],
];

export const REJECTED_COMMAND_PAYLOADS: readonly (readonly [string, CommandType, Record<string, unknown>])[] = [
  ['start without `unattended`', 'start', { profile: 'feature' }],
  [
    'start whose consent came from somewhere else than the CLI flag',
    'start',
    { profile: 'feature', unattended: true, consent: { policySha256: HEX64, via: 'env' } },
  ],
  [
    'start with a consent that is not a digest',
    'start',
    { profile: 'feature', unattended: true, consent: { policySha256: 'yes', via: 'cli-flag' } },
  ],
  ['start with a suspended state as a phase', 'start', { profile: 'feature', unattended: true, phases: ['PAUSED'] }],
  ['inspect an unknown target', 'inspect', { target: { kind: 'secrets' } }],
  [
    'inspect an artifact above the 3 MiB cap',
    'inspect',
    { target: { kind: 'artifact', artifactId: ARTIFACT, maxBytes: 3 * 1024 * 1024 + 1 } },
  ],
  [
    'inspect an artifact at a negative offset',
    'inspect',
    { target: { kind: 'artifact', artifactId: ARTIFACT, offset: -1 } },
  ],
  ['inspect a diff with a field of another target', 'inspect', { target: { kind: 'diff', artifactId: ARTIFACT } }],
  ['tail without `follow`', 'tail', { ephemeral: false }],
  ['cancel without `keepWorktrees`', 'cancel', {}],
  ['approve with an unknown scope', 'approve', { approvalId: APPROVAL, scope: 'forever' }],
  ['approve with a malformed approval id', 'approve', { approvalId: 'apr_1', scope: 'once' }],
  ['skip without a justification', 'skip', { phase: 'TEST' }],
  ['run-tool without a justification', 'run-tool', { tool: 'read', input: {} }],
  ['shutdown with a negative grace', 'shutdown', { graceMs: -1 }],
  ['agent.send with an unknown delivery', 'agent.send', { agentId: 'agt_fixer_main', text: 'x', delivery: 'shout' }],
  ['pause with an unknown key', 'pause', { reason: 'x', force: true }],
];
