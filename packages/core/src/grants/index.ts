import { type AgentId, canonicalJson, type JsonValue, sha256Hex } from '@cohorte/base';
import { type AgentGrant, DEFAULT_DENY_GLOBS } from '@cohorte/security/contract';
import type { AgentGrantRequest } from '../contract/types.ts';

export interface GrantComputer {
  compute(request: AgentGrantRequest): AgentGrant;
}
export type GrantsDeps = Record<string, never>;

export function createGrantComputer(_deps: GrantsDeps): GrantComputer {
  return {
    compute(request): AgentGrant {
      const digest = sha256Hex(canonicalJson(request as unknown as JsonValue));
      const include = request.ownedPaths.map((path) => (path.endsWith('/**') ? path : `${path}/**`));
      const reviewer = request.role === 'reviewer' || request.role.endsWith('/reviewer');
      const tools = [
        ...new Set(
          reviewer
            ? request.tools.filter((tool) => !['write_file', 'patch_file', 'run_command'].includes(tool))
            : request.tools,
        ),
      ].sort();
      const perTool = Object.fromEntries(
        tools.map((tool) => [tool, { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 }]),
      );
      return {
        agentId: `agt_${digest.slice(0, 24)}` as AgentId,
        role: request.role,
        digest,
        tools,
        roots: { workspace: null, readOnly: [] },
        read: { include: [...include], exclude: [] },
        write: reviewer ? { include: [], exclude: [] } : { include: [...include], exclude: [] },
        denyRead: { include: [...DEFAULT_DENY_GLOBS], exclude: [] },
        denyWrite: { include: [...DEFAULT_DENY_GLOBS, ...(reviewer ? ['**'] : [])], exclude: [] },
        commands: { default: 'deny', rules: [] },
        secrets: [...(request.secrets ?? [])],
        temporary: [],
        limits: {
          maxToolCalls: request.limits?.maxToolCalls ?? 100,
          maxCallsPerMinute: request.limits?.maxCallsPerMinute ?? 60,
          perTool,
        },
      };
    },
  };
}
