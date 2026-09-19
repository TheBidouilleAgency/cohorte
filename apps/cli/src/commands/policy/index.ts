// apps/cli/src/commands/policy/index.ts — DESIGN §9 verb `policy` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/policy/**`.
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CohorteError, canonicalJson, errorOf, sha256Hex } from '@cohorte/base';
import { loadConfig, resolveConfig } from '@cohorte/config';
import {
  buildPolicySnapshot,
  createCommandPolicy,
  createGlobMatcher,
  createPathResolver,
  createPolicyEngine,
  createProgramResolver,
  explainPolicy,
} from '@cohorte/security';
import { createKeyStore, createTrustStore } from '@cohorte/security/auth';
import type { AgentGrant, GateCall, PolicyPorts } from '@cohorte/security/contract';
import { toolIntrospection } from '@cohorte/tools/catalogue';
import type { CommandModule } from '../../contract/index.ts';

function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function grantFor(root: string, argv: readonly string[]): AgentGrant {
  const tools = ['run_command'];
  const digest = sha256Hex(canonicalJson({ root, argv: [...argv] }));
  return {
    agentId: 'agt_policy_explain' as AgentGrant['agentId'],
    role: 'policy-explain',
    digest,
    tools,
    roots: { workspace: root as AgentGrant['roots']['workspace'], readOnly: [] },
    read: { include: ['**'], exclude: [] },
    write: { include: ['**'], exclude: [] },
    denyRead: { include: ['**/.cohorte/**', '**/.git/**'], exclude: [] },
    denyWrite: { include: ['**/.cohorte/**', '**/.git/**'], exclude: [] },
    commands: { default: 'deny', rules: [] },
    secrets: [],
    temporary: [],
    limits: {
      maxToolCalls: 1,
      maxCallsPerMinute: 1,
      perTool: { run_command: { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 } },
    },
  };
}

const policy: CommandModule = {
  verb: 'policy',
  async run(ctx, args) {
    if (args.subVerb !== 'explain') return 2;
    const argv = args.positionals.filter((value) => value !== '--');
    if (argv.length === 0) return 2;

    const home = ctx.env.HOME ?? ctx.cwd;
    const projectKeyId = sha256Hex(ctx.cwd).slice(0, 24);
    const keys = createKeyStore({ directory: join(home, '.cohorte', 'keys') });
    const trustStore = createTrustStore({ directory: join(home, '.cohorte', 'trust'), keys });
    const loaded = await loadConfig({ cwd: ctx.cwd, home });
    const resolved = await resolveConfig(loaded, { trustStore, projectKeyId });
    if (resolved.status === 'untrusted') {
      throw new CohorteError(
        errorOf(
          'security/project-policy-untrusted',
          `project policy is untrusted (${resolved.loosenedKeys.join(', ') || 'unknown key'})`,
        ),
      );
    }

    const root = canonical(loaded.projectRoot);
    const pathResolver = createPathResolver({
      roots: [root as never],
      protectedRoots: [canonical(join(root, '.cohorte')) as never],
      symlinks: resolved.config.policy.symlinks,
    });
    const pathDirs = (ctx.env.PATH ?? '').split(':').filter(Boolean).map(canonical);
    const programs = createProgramResolver({ pathDirs });
    const branches: PolicyPorts['branches'] = {
      branchOf: () => ({ kind: 'detached-or-unknown', protected: true }),
    };
    const commands = createCommandPolicy({ programs, branches });
    const engine = createPolicyEngine({ tools: toolIntrospection, globs: createGlobMatcher(), commands });
    const policySnapshot = buildPolicySnapshot(resolved.config, loaded.ownership, { sandboxLevel: 'L0-process' });
    const ports: PolicyPorts = {
      paths: pathResolver,
      branches,
      budgets: { remaining: () => ({}), callsInLastMinute: () => 0 },
      programs,
      clock: ctx.clock,
    };
    const call: GateCall = {
      runId: 'run_policy_explain' as GateCall['runId'],
      agentId: 'agt_policy_explain' as GateCall['agentId'],
      incarnation: 1,
      toolCallId: 'tool_policy_explain' as GateCall['toolCallId'],
      tool: 'run_command',
      input: { argv, cwd: root, timeoutMs: 120_000 },
      phase: 'PREFLIGHT',
      role: 'policy-explain',
    };
    const verdict = explainPolicy(engine, call, grantFor(root, argv), policySnapshot, ports);
    ctx.stdio.stdout.write(`${JSON.stringify(verdict)}\n`);
    return 0;
  },
};

export default policy;
