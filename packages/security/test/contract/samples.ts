import type { AgentId, ApprovalId, Sha256 } from '@cohorte/base';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type {
  AgentGrant,
  CanonicalPath,
  NormalizedCall,
  PolicyVerdict,
  SandboxCapabilities,
} from '../../src/contract/index.ts';

export const canonical = (path: string): CanonicalPath => path as CanonicalPath;
export const AGENT_ID = 'agt_implementer_frontend' as AgentId;
export const APPROVAL_ID = `apr_${'0'.repeat(32)}` as ApprovalId;
export const DIGEST = 'a'.repeat(64) as Sha256;

/** JSON pointers of every schema error; [] = valid. */
export function pathsOf(schema: TSchema, value: unknown): string[] {
  const compiled = Compile(schema);
  return compiled.Check(value) ? [] : [...compiled.Errors(value)].map((issue) => issue.instancePath);
}

export const normalizedCall = (): NormalizedCall => ({
  tool: 'run_command',
  paths: [
    {
      arg: 'cwd',
      intent: 'exec-cwd',
      resolved: {
        canonical: canonical('/w/run_1/frontend/apps/web'),
        relative: 'apps/web',
        root: canonical('/w/run_1/frontend'),
        exists: true,
        identity: { dev: 1, ino: 42, nlink: 1 },
        viaSymlink: false,
      },
    },
  ],
  command: {
    file: canonical('/opt/homebrew/bin/pnpm'),
    args: ['run', 'test'],
    cwd: canonical('/w/run_1/frontend/apps/web'),
    ruleId: 'pnpm-run-test',
    replay: 'idempotent',
    network: false,
    timeoutMs: 600_000,
  },
  input: { argv: ['pnpm', 'run', 'test'], cwd: 'apps/web' },
  grantKeyMaterial: { tool: 'run_command', argv: ['pnpm', 'run', 'test'] },
});

export const allowVerdict = (): PolicyVerdict => ({
  decision: 'allow',
  stage: 'budget',
  ruleId: 'pnpm-run-test',
  reason: 'allowed by project rule pnpm-run-test',
  modelFacingReason: '',
  overridable: true,
  securityViolation: false,
  asks: [],
  evaluatedRules: ['builtin/trampolines', 'builtin/agent-git', 'pnpm-run-test'],
  normalized: normalizedCall(),
});

export const denyVerdict = (): PolicyVerdict => ({
  decision: 'deny',
  stage: 'command',
  ruleId: 'builtin/trampolines',
  reason: 'bash is a trampoline',
  modelFacingReason: 'This command is not allowed. Do not retry.',
  overridable: false,
  securityViolation: true,
  asks: [],
  evaluatedRules: ['builtin/trampolines'],
  normalized: null,
});

export const approvedVerdict = (): PolicyVerdict => ({
  ...allowVerdict(),
  decision: 'allow-for-run',
  stage: 'approval',
  asks: [{ stage: 'path', ruleId: 'ownership/shared-path', reason: 'package.json is a shared path' }],
  approvalId: APPROVAL_ID,
  grantId: 'grant-1',
});

export const agentGrant = (): AgentGrant => ({
  agentId: AGENT_ID,
  role: 'implementer',
  digest: DIGEST,
  tools: ['read_file', 'write_file', 'run_command', 'submit_result'],
  roots: { workspace: canonical('/w/run_1/frontend'), readOnly: [canonical('/w/run_1/snapshot')] },
  read: { include: ['**'], exclude: [] },
  write: { include: ['apps/web/**'], exclude: [] },
  denyRead: { include: ['**/.env*', '**/.git/**'], exclude: [] },
  denyWrite: { include: ['**/.env*', '**/.git/**'], exclude: [] },
  commands: {
    default: 'deny',
    rules: [
      {
        id: 'pnpm-run-test',
        program: 'pnpm',
        subcommand: ['run'],
        positionals: { kind: 'enum', values: ['test'], max: 1 },
        decision: 'allow',
        replay: 'idempotent',
        network: false,
        origin: 'project-config',
      },
    ],
  },
  secrets: [{ id: 'npm-token', exposeAs: 'env', name: 'NPM_TOKEN' }],
  temporary: [{ grantId: 'grant-1', approvalId: APPROVAL_ID, grantKey: 'k', expires: 'run' }],
  limits: {
    maxToolCalls: 400,
    maxCallsPerMinute: 60,
    perTool: { run_command: { maxCalls: 50, timeoutMs: 600_000, maxOutputBytes: 1_000_000 } },
  },
});

export const l0Capabilities = (): SandboxCapabilities => ({
  level: 'L0-process',
  backend: 'none',
  filesystem: 'advisory',
  network: 'unenforced',
  processEscape: 'possible',
  envFiltering: 'enforced',
  timeout: 'enforced',
  outputCap: 'enforced',
  cpuTime: 'enforced',
  memory: 'node-only',
  processes: 'enforced',
  killTree: 'process-group-with-sweep',
  missing: ['bwrap'],
  notes: ['L0: an allowed command is arbitrary code running as you'],
});

export const partialL1Capabilities = (): SandboxCapabilities => ({
  ...l0Capabilities(),
  level: 'L1-os',
  backend: 'seatbelt',
  filesystem: 'partial',
  network: 'partial',
  processEscape: 'partial',
  missing: [],
  notes: ['escape self-test S-28 has not passed on this OS build'],
});
