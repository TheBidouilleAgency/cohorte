import type { TSchema } from 'typebox';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { CommandAuth } from '../../src/commands.ts';
import { compileOpen, compileSchema, toOpenSchema } from '../../src/compile.ts';
import { OpenEnum, type OpenEnumOf } from '../../src/open-enum.ts';
import {
  AgentRef,
  ApprovalRequest,
  ArtifactRef,
  FileTouch,
  PhaseRef,
  ResumeReport,
  RunPlan,
  RuntimeRef,
  SandboxReport,
} from '../../src/refs.ts';
import { Actor, PipelineProfile, StopRecord } from '../../src/vocabulary.ts';

const HEX64 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const APPROVAL = `apr_${'2'.repeat(32)}`;
const EFFECT = `eff_${'4'.repeat(32)}`;

const sandbox = { level: 'L1-os', backend: 'seatbelt', filesystem: 'enforced', network: 'partial' };
const phase = { phaseRunId: 'phs_BUILD_1', state: 'BUILD', iteration: 1 };
const agent = {
  agentId: 'agt_implementer_backend',
  role: 'implementer',
  surface: 'backend',
  incarnation: 1,
  attempt: 1,
};

const runPlan = {
  profile: 'feature',
  runtime: { id: 'fake', version: '3.0.0' },
  trust: { policySha256: HEX64, loosenedKeys: ['policy.admin.runTool'], grantedBy: 'cli-flag' },
  models: [
    {
      role: 'implementer',
      requested: { provider: 'openai-codex', model: 'gpt-5.5-codex' },
      thinking: 'medium',
      authMode: 'subscription',
      billing: 'plan-limits',
      reason: 'role default',
    },
  ],
  apiBillingEnabled: false,
  meteredProviders: [],
  sandbox,
  sandboxRequire: 'best-effort',
  brainIsolation: 'os',
  budgets: { run: { tokens: 10 }, perPhase: {}, perAgent: {}, perProvider: { openai: { tokens: 5 } }, perTool: {} },
  network: { provisioning: false },
  promptOverrides: [],
  unattended: false,
};

const approvalRequest = {
  approvalId: APPROVAL,
  kind: 'tool',
  agent,
  phase,
  tool: 'approval_request',
  args: { question: 'rebase or merge?' },
  affectedPaths: ['src/cart.ts'],
  preview: { kind: 'text', text: 'rebase or merge?' },
  options: ['rebase', 'merge'],
  ruleId: 'ask/approval-request',
  reason: 'the agent asked',
  asks: [{ stage: 'policy', ruleId: 'ask/approval-request', reason: 'the agent asked' }],
  allowedDecisions: ['allow-once', 'deny'],
  preStateSha256: HEX64,
  expiresAt: '2026-09-18T11:00:00.000Z',
  unattended: 'deny',
  cli: `cohorte approve ${APPROVAL}`,
};

const resumeReport = {
  takeover: true,
  hostId: 'host-1',
  fencingToken: 3,
  locks: { rebuilt: ['run'], conflicts: [] },
  orphans: [{ agentId: 'agt_implementer_backend', incarnation: 1, pid: 4242, kind: 'brain', killed: true }],
  worktrees: [{ slot: 'backend', path: '/tmp/wt/backend', verdict: 'ledger-explained' }],
  effects: [{ effectId: EFFECT, kind: 'command', replayClass: 'at-most-once', verdict: 'in-doubt' }],
  approvalsCarried: [APPROVAL],
  commandsApplied: [`cmd_${'5'.repeat(32)}`],
  inDoubt: [EFFECT],
  approvedReplays: [{ approvalId: APPROVAL, toolCallId: 'tc_1_4', outcome: 'executed' }],
};

const KNOWN: readonly (readonly [string, TSchema, unknown])[] = [
  ['PhaseRef', PhaseRef, phase],
  ['AgentRef', AgentRef, agent],
  ['AgentRef without a surface', AgentRef, { agentId: 'agt_tester_main', role: 'tester', incarnation: 2, attempt: 1 }],
  [
    'ArtifactRef',
    ArtifactRef,
    { artifactId: `art_${'0'.repeat(32)}`, kind: 'diff', path: 'a.diff', sha256: HEX64, bytes: 1 },
  ],
  ['RuntimeRef', RuntimeRef, { runtime: 'fake', version: '1', sessionId: 's1', transcriptRef: 'transcripts/s1.jsonl' }],
  ['FileTouch', FileTouch, { path: 'src/a.ts', op: 'modify', beforeSha256: HEX64, afterSha256: HEX64, bytes: 12 }],
  ['SandboxReport', SandboxReport, sandbox],
  ['RunPlan', RunPlan, runPlan],
  ['ApprovalRequest', ApprovalRequest, approvalRequest],
  ['ResumeReport', ResumeReport, resumeReport],
];

// Annotated, like KNOWN and FUTURE: left to inference, a tuple holding a schema that embeds JsonValue overflows Biome's
// stack (docs/v3/requests/U0.02.md R1), and a crashed Biome exits 0.
const REFUSED: readonly (readonly [string, TSchema, unknown])[] = [
  ['a PhaseRef in a suspended state', PhaseRef, { ...phase, state: 'PAUSED' }],
  ['a FileTouch with an unknown op', FileTouch, { path: 'a', op: 'chmod' }],
  ['a RunPlan without its trust block', RunPlan, { ...runPlan, trust: undefined }],
  [
    'a trust block without the policy digest',
    RunPlan,
    { ...runPlan, trust: { loosenedKeys: [], grantedBy: 'none-needed' } },
  ],
  ['an ApprovalRequest whose options are not strings', ApprovalRequest, { ...approvalRequest, options: [1] }],
  [
    'an ApprovalRequest bound to something that is not a digest',
    ApprovalRequest,
    { ...approvalRequest, preStateSha256: 'tree' },
  ],
  ['a ResumeReport without approvedReplays', ResumeReport, { ...resumeReport, approvedReplays: undefined }],
];

describe('records of DESIGN 2.3.3', () => {
  test.for(KNOWN)('%s validates under the strict and under the open schema', ([, schema, value]) => {
    expect(compileSchema(schema)(value)).toEqual({ ok: true, value });
    expect(compileOpen(schema)(value)).toEqual({ ok: true, value });
  });

  test.for(REFUSED)('%s is refused by both', ([, schema, value]) => {
    const json: unknown = JSON.parse(JSON.stringify(value));
    expect(compileSchema(schema)(json).ok).toBe(false);
    expect(compileOpen(schema)(json).ok).toBe(false);
  });
});

/** A provisional ADR is never a closed wire enum (spec 32): each row is a value a later MINOR may add. */
const FUTURE: readonly (readonly [string, TSchema, unknown])[] = [
  ['a future profile', PipelineProfile, 'migration'],
  ['a future transport', Actor, { kind: 'client', id: 'francois', transport: 'socket' }],
  ['a future sandbox level', SandboxReport, { ...sandbox, level: 'L2-vm' }],
  ['a future sandbox backend', SandboxReport, { ...sandbox, backend: 'landlock' }],
  ['a future filesystem verdict', SandboxReport, { ...sandbox, filesystem: 'audited' }],
  ['a future network verdict', SandboxReport, { ...sandbox, network: 'proxied' }],
  ['a future sandbox backend inside a RunPlan', RunPlan, { ...runPlan, sandbox: { ...sandbox, backend: 'landlock' } }],
  ['a future profile inside a RunPlan', RunPlan, { ...runPlan, profile: 'migration' }],
  ['a future consent form', RunPlan, { ...runPlan, trust: { ...runPlan.trust, grantedBy: 'org-policy' } }],
  [
    'a future worktree verdict',
    ResumeReport,
    { ...resumeReport, worktrees: [{ slot: 's', path: '/p', verdict: 'rebased' }] },
  ],
  [
    'a future effect verdict',
    ResumeReport,
    { ...resumeReport, effects: [{ ...resumeReport.effects[0], verdict: 'superseded' }] },
  ],
  [
    'a future replay outcome',
    ResumeReport,
    { ...resumeReport, approvedReplays: [{ ...resumeReport.approvedReplays[0], outcome: 'expired' }] },
  ],
  ['a future auth scheme', CommandAuth, { scheme: 'ed25519', value: 'c2ln' }],
  ['a future approval kind', ApprovalRequest, { ...approvalRequest, kind: 'deploy' }],
  [
    'a future artifact kind',
    ArtifactRef,
    { artifactId: `art_${'0'.repeat(32)}`, kind: 'video', path: 'a', sha256: HEX64, bytes: 1 },
  ],
  [
    'a future resume requirement',
    StopRecord,
    { reason: 'timeout', detail: 'd', resumable: true, resumeRequires: 'coffee' },
  ],
];

describe('open on the wire', () => {
  test.for(FUTURE)(
    '%s validates under the OPEN schema and is rejected by the STRICT writer compile',
    ([, schema, value]) => {
      expect(compileOpen(schema)(value)).toEqual({ ok: true, value });
      const strict = compileSchema(schema)(value);
      expect(strict.ok).toBe(false);
      if (!strict.ok) expect(strict.error.map((issue) => issue.keyword)).toContain('enum');
    },
  );

  test('an open enum still has to be a string', () => {
    expect(compileOpen(PipelineProfile)(7).ok).toBe(false);
    expect(compileOpen(SandboxReport)({ ...sandbox, backend: null }).ok).toBe(false);
  });

  test('authoring: enum for the writer, x-cohorte-known for the reader, the known values in the type', () => {
    const schema = OpenEnum(['cli'], { description: 'how the actor reached Cohorte' });
    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      type: 'string',
      enum: ['cli'],
      'x-cohorte-known': ['cli'],
      description: 'how the actor reached Cohorte',
    });
    expect(toOpenSchema(schema)).toEqual({
      type: 'string',
      'x-cohorte-known': ['cli'],
      description: 'how the actor reached Cohorte',
    });
    expectTypeOf<'cli'>().toExtend<OpenEnumOf<'cli'>>();
    expectTypeOf<string>().toExtend<OpenEnumOf<'cli'>>();
    expect(() => OpenEnum([])).toThrow(RangeError);
    expect(() => OpenEnum(['a', 'a'])).toThrow(RangeError);
  });
});
