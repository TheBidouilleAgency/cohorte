// L1 backend adapters. They report conservative capabilities until the platform self-test is available.
import { access } from 'node:fs/promises';
import type { SandboxPolicy } from '@cohorte/runtime-contract';
import type { ExecRequest, SandboxBackend, SandboxCapabilities } from '../contract/index.ts';

export interface SandboxBackendOptions {
  /** the pinned absolute path of `sandbox-exec` / `bwrap` */
  binary: string;
  /** Cohorte version + OS build: the key under which the escape self-test result is cached */
  cacheKey: string;
}

const l0 = (backend: SandboxCapabilities['backend'], missing: string[] = []): SandboxCapabilities => ({
  level: 'L1-os',
  backend,
  filesystem: 'partial',
  network: 'partial',
  processEscape: 'partial',
  envFiltering: 'enforced',
  timeout: 'enforced',
  outputCap: 'enforced',
  cpuTime: 'unavailable',
  memory: 'unavailable',
  processes: 'unavailable',
  killTree: 'process-group-with-sweep',
  missing,
  notes: ['platform self-test has not passed; guarantees are partial'],
});

function backendOf(id: 'seatbelt' | 'bubblewrap', options: SandboxBackendOptions): SandboxBackend {
  return {
    id,
    async probe(): Promise<SandboxCapabilities> {
      try {
        await access(options.binary);
        return l0(id);
      } catch {
        return l0(id, [options.binary]);
      }
    },
    wrap(file, args, req: ExecRequest) {
      if (id === 'seatbelt') {
        const profile = `(version 1)(deny default)(allow process*)`;
        return { file: options.binary as typeof file, args: ['-p', profile, file, ...args] };
      }
      const bwrap = ['--die-with-parent', '--new-session', '--ro-bind', '/', '/'];
      for (const root of req.fs.readWrite) bwrap.push('--bind', root, root);
      return { file: options.binary as typeof file, args: [...bwrap, '--', file, ...args] };
    },
  };
}

export function createSeatbeltBackend(options: SandboxBackendOptions): SandboxBackend {
  return backendOf('seatbelt', options);
}

export function createBubblewrapBackend(options: SandboxBackendOptions): SandboxBackend {
  return backendOf('bubblewrap', options);
}

/**
 * The BRAIN profile (DESIGN 3.6). Pure. `null` = no backend on this machine. The composition root adapts it to the
 * `SandboxWrapper` that runtime-pi takes, since runtime-pi may not import this package.
 */
export function wrapForPolicy(
  policy: SandboxPolicy,
  command: { file: string; args: readonly string[] },
): { file: string; args: string[] } | null {
  if (policy?.require !== 'process') return null;
  return { file: command.file, args: [...command.args] };
}
