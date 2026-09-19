import type { ErrorInfo, Result, Sha256 } from '@cohorte/base';
import type { ExecRequest, Executor } from '@cohorte/security/contract';
import type { Provisioner } from '../contract/internal.ts';

export interface ProvisionImplementationDeps {
  executor: Executor;
  requestFor(slot: string): Promise<{ key: string; request: ExecRequest; manifestSha256: Sha256 }>;
}

export function createProvisionerImpl(deps: ProvisionImplementationDeps): Provisioner {
  const markers = new Map<string, { key: string; manifestSha256: Sha256 }>();
  return {
    async ensure(slot) {
      const prepared = await deps.requestFor(slot);
      const previous = markers.get(slot);
      if (previous?.key === prepared.key && previous.manifestSha256 === prepared.manifestSha256) return 'reused';
      const result = await deps.executor.run(prepared.request, new AbortController().signal);
      if (result.outcome !== 'ok' || result.exitCode !== 0) throw new Error(`provision/command-failed: ${slot}`);
      markers.set(slot, { key: prepared.key, manifestSha256: prepared.manifestSha256 });
      return 'fresh';
    },

    async verifyDependencies(slot): Promise<Result<true, ErrorInfo>> {
      const prepared = await deps.requestFor(slot);
      const previous = markers.get(slot);
      if (!previous || previous.manifestSha256 !== prepared.manifestSha256) {
        return {
          ok: false,
          error: {
            code: 'security/deps-tampered',
            class: 'security',
            message: `dependency manifest changed for ${slot}`,
            impact: 'the worktree dependencies are not the pinned dependencies',
            remediation: 'run provisioning again before executing checks',
            retryable: false,
          },
        };
      }
      return { ok: true, value: true };
    },
  };
}
