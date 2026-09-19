// Five pure gate stages and policy explanation (PLAN U2.01).

import type { JsonValue } from '@cohorte/base';
import { canonicalJson, sha256Hex } from '@cohorte/base';
import { type CohorteConfig, DEFAULT_NETWORK_POLICY, type Ownership } from '@cohorte/config/schema';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type {
  AgentGrant,
  GateCall,
  GlobMatcher,
  PolicyEngine,
  PolicyPorts,
  PolicySnapshot,
  PolicyVerdict,
  ToolIntrospection,
} from '../../contract/index.ts';
import type { CommandPolicyEvaluator } from '../commands/index.ts';

const deny = (
  stage: PolicyVerdict['stage'],
  ruleId: string,
  reason: string,
  code = 'permission/tool-not-granted',
  securityViolation = false,
): PolicyVerdict => ({
  decision: 'deny',
  stage,
  ruleId,
  reason: `${code}: ${reason}`,
  modelFacingReason: `${reason}. Do not retry.`,
  overridable: !securityViolation,
  securityViolation,
  asks: [],
  evaluatedRules: [ruleId],
  normalized: null,
});

const invalidPolicy = (message: string): never => {
  throw new Error(`configuration/policy-invalid: ${message}`);
};

const cloneFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) cloneFreeze(child);
  }
  return value;
};

export interface PolicyEngineOptions {
  tools: ToolIntrospection;
  globs: GlobMatcher;
  commands: CommandPolicyEvaluator;
}

export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  if (!options?.tools || !options.globs || !options.commands) invalidPolicy('policy engine ports are incomplete');
  return {
    evaluate(call, grant, policy, ports) {
      try {
        const schema = options.tools.schemaOf(call.tool);
        if (schema === undefined)
          return deny('schema', 'builtin/unknown-tool', `unknown tool "${call.tool}"`, 'validation/tool-input', true);
        const validation = Compile(schema as TSchema);
        if (!validation.Check(call.input))
          return deny(
            'schema',
            'builtin/tool-schema',
            `input for "${call.tool}" does not match its strict schema`,
            'validation/tool-input',
          );

        const evaluatedRules: string[] = ['builtin/tool-schema'];
        if (!grant.tools.includes(call.tool))
          return {
            ...deny('capability', 'grant/tool-not-granted', `tool "${call.tool}" is not granted to this agent`),
            evaluatedRules,
          };

        const normalizedPaths: NonNullable<PolicyVerdict['normalized']>['paths'] = [];
        const base = grant.roots.workspace ?? grant.roots.readOnly[0];
        if (base === undefined)
          return deny(
            'path',
            'grant/no-root',
            'the agent has no workspace or read-only root',
            'permission/path-outside-grant',
          );
        for (const arg of options.tools.pathArgsOf(call.tool, call.input)) {
          const resolved = ports.paths.resolve(arg.value, base, arg.intent);
          if (!resolved.ok)
            return deny(
              'path',
              `path/${resolved.error.code}`,
              `path argument "${arg.arg}" was refused: ${resolved.error.detail}`,
              resolved.error.security ? `security/${resolved.error.code}` : 'permission/path-outside-grant',
              resolved.error.security,
            );
          if (
            options.globs.isDenied(
              resolved.value.relative,
              grant,
              arg.intent === 'read' || arg.intent === 'list' ? 'read' : 'write',
            )
          )
            return deny('path', 'grant/deny-glob', `path argument "${arg.arg}" is denied by the grant`);
          normalizedPaths.push({ arg: arg.arg, resolved: resolved.value, intent: arg.intent });
        }

        let command: NonNullable<NonNullable<PolicyVerdict['normalized']>['command']> | undefined;
        if (call.tool === 'network_request')
          return deny(
            'network',
            'builtin/network-denied',
            'network requests are disabled in V3.0',
            'permission/network-denied',
          );
        if (call.tool === 'run_command') {
          const input = call.input as { argv?: JsonValue; cwd?: JsonValue };
          const argv =
            Array.isArray(input.argv) && input.argv.every((v) => typeof v === 'string') ? (input.argv as string[]) : [];
          const cwd = typeof input.cwd === 'string' ? input.cwd : '';
          const cwdResult = ports.paths.resolve(cwd, base, 'exec-cwd');
          if (!cwdResult.ok)
            return deny(
              'command',
              'command/cwd',
              'command cwd is outside the grant',
              'permission/command-not-allowed',
              true,
            );
          const evaluation = options.commands.evaluate({ argv, cwd }, grant.commands, {
            worktree: grant.roots.workspace ?? cwdResult.value.root,
            cwd: cwdResult.value.canonical,
            role: grant.role,
            phase: call.phase,
            sandboxLevel: policy.sandboxLevel,
            defaultTimeoutMs: grant.limits.perTool.run_command?.timeoutMs ?? 60_000,
          });
          evaluatedRules.push(...evaluation.evaluatedRules);
          if (evaluation.decision === 'deny' || evaluation.command === undefined)
            return deny('command', evaluation.ruleId, evaluation.reason, evaluation.code, evaluation.securityViolation);
          command = evaluation.command;
        }

        const limit = grant.limits.perTool[call.tool];
        const levels = [
          ['run', call.runId],
          ['phase', call.phase],
          ['agent', call.agentId],
          ['tool', call.tool],
        ] as const;
        for (const [level, id] of levels) {
          const remaining = ports.budgets.remaining(level, id);
          if ((remaining.toolCalls ?? 1) <= 0 || (remaining.wallClockMs ?? 1) <= 0)
            return deny('budget', `budget/${level}`, `${level} budget is exhausted`, 'budget/exhausted');
        }
        if (ports.budgets.callsInLastMinute(call.agentId, call.tool) >= grant.limits.maxCallsPerMinute)
          return deny('budget', 'budget/rate-limit', 'tool rate limit is exhausted', 'budget/rate-limit');
        const timeoutMs = Math.max(
          1,
          Math.min(
            limit?.timeoutMs ?? 60_000,
            command?.timeoutMs ?? Number.MAX_SAFE_INTEGER,
            ports.budgets.remaining('agent', call.agentId).wallClockMs ?? Number.MAX_SAFE_INTEGER,
          ),
        );
        return {
          decision: 'allow',
          stage: 'budget',
          ruleId: command?.ruleId ?? 'grant/tool',
          reason: 'allowed by the policy',
          modelFacingReason: '',
          overridable: true,
          securityViolation: false,
          asks: [],
          evaluatedRules,
          normalized: {
            tool: call.tool,
            paths: normalizedPaths,
            ...(command ? { command: { ...command, timeoutMs } } : {}),
            input: call.input,
            grantKeyMaterial: { tool: call.tool, input: call.input },
          },
        };
      } catch (error) {
        return deny(
          'schema',
          'security/gate-internal-error',
          error instanceof Error ? error.message : 'gate failed closed',
          'security/gate-internal-error',
          true,
        );
      }
    },
  };
}

/** Missing, unparseable or empty policy => `configuration/policy-invalid`: no tool ever executes. */
export function buildPolicySnapshot(
  config: CohorteConfig,
  ownership: Ownership,
  options: { sandboxLevel: PolicySnapshot['sandboxLevel'] },
): PolicySnapshot {
  if (!config || config.policy === undefined || !ownership || options?.sandboxLevel === undefined)
    invalidPolicy('missing policy or ownership');
  const commands = [
    ...config.policy.commands.deny,
    ...config.policy.commands.ask,
    ...config.policy.commands.allow,
    ...config.policy.dangerousCommands,
  ];
  if (commands.some((rule) => rule.origin !== 'project-config' && rule.origin !== 'project-checks'))
    invalidPolicy('policy command origin is invalid');
  const snapshot = {
    commands: Object.freeze({ default: 'deny' as const, rules: commands.map((rule) => ({ ...rule })) }),
    symlinks: { ...config.policy.symlinks },
    network: { ...DEFAULT_NETWORK_POLICY },
    protectedBranches: [...config.project.protectedBranches],
    ownership: cloneFreeze(structuredClone(ownership)),
    sandboxLevel: options.sandboxLevel,
  } satisfies Omit<PolicySnapshot, 'digest'>;
  return Object.freeze({ ...snapshot, digest: sha256Hex(canonicalJson(snapshot as unknown as JsonValue)) });
}

/** `cohorte policy explain -- <argv…>`: stages 1-5, offline, nothing executes. */
export function explainPolicy(
  engine: PolicyEngine,
  call: GateCall,
  grant: AgentGrant,
  policy: PolicySnapshot,
  ports: PolicyPorts,
): PolicyVerdict {
  if (!engine || !call || !grant || !policy || !ports)
    invalidPolicy('policy explain requires a complete call, grant, snapshot and ports');
  return engine.evaluate(call, grant, policy, ports);
}
