// Test-only helpers for packages/security/test/exec/**. Kept local to this unit's owned test paths.
import { realpathSync } from 'node:fs';
import type {
  CanonicalPath,
  ExecRequest,
  PidRegistry,
  SandboxBackend,
  SandboxCapabilities,
} from '../../src/contract/index.ts';

/** The test process' own realpath'd `node` binary: always a valid, canonical, executable file. */
export const NODE_BIN = realpathSync.native(process.execPath) as CanonicalPath;

/** `path as CanonicalPath`, for a path the test already knows is realpath'd (a testkit `tempDir`/`tempHome`). */
export const canonical = (path: string): CanonicalPath => path as CanonicalPath;

export interface FakePidRegistry extends PidRegistry {
  readonly entries: Map<number, { startToken: string; label: string }>;
}

/** `onRecord` is handed the registry AT the moment an entry exists — the one observation point that cannot race a
 * child which exits before the test looks (lead note L8, closed at gate G1). */
export function fakePidRegistry(
  options: { onRecord?: (entries: FakePidRegistry['entries']) => void } = {},
): FakePidRegistry {
  const entries = new Map<number, { startToken: string; label: string }>();
  return {
    entries,
    record(entry) {
      entries.set(entry.pgid, { startToken: entry.startToken, label: entry.label });
      options.onRecord?.(entries);
    },
    remove(pgid) {
      entries.delete(pgid);
    },
  };
}

/** A minimal, complete `ExecRequest`: every field DESIGN 2.6.6 requires, sane defaults, `node -e <script>` argv. */
export function nodeRequest(cwd: CanonicalPath, script: string, overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    file: NODE_BIN,
    args: ['-e', script],
    cwd,
    env: {},
    fs: { readWrite: [], readOnly: [], denyRead: [] },
    network: 'none',
    timeoutMs: 5_000,
    maxOutputBytes: 1_000_000,
    stdin: 'ignore',
    limits: {},
    require: 'best-effort',
    ...overrides,
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A full `SandboxCapabilities` report claiming a working L1 backend, so a test can exercise the paths that only
 * exist once `U4.07` injects a real Seatbelt/bubblewrap backend. `overrides` degrade one axis at a time.
 */
export function l1Capabilities(overrides: Partial<SandboxCapabilities> = {}): SandboxCapabilities {
  return {
    level: 'L1-os',
    backend: 'seatbelt',
    filesystem: 'enforced',
    network: 'enforced-off',
    processEscape: 'denied',
    envFiltering: 'enforced',
    timeout: 'enforced',
    outputCap: 'enforced',
    cpuTime: 'enforced',
    memory: 'unavailable',
    processes: 'enforced',
    killTree: 'process-group-with-sweep',
    missing: [],
    notes: [],
    ...overrides,
  };
}

/** `/usr/bin/env`, the marker program a fake backend wraps commands in: present on both supported platforms. */
export const ENV_BIN = canonical('/usr/bin/env');

/** The environment variable a `markerBackend()` injects, visible to the child only if `wrap()` reached the argv. */
export const SANDBOX_MARKER = 'COHORTE_SANDBOX_MARKER';

/**
 * A fake `SandboxBackend` that reports `capabilities` and whose `wrap()` prepends `/usr/bin/env <MARKER>=wrapped`
 * in front of the real program — so a test can prove the wrapped argv is what was actually spawned, instead of
 * only what `ExecResult.guarantees` claims.
 */
export function markerBackend(capabilities: SandboxCapabilities): SandboxBackend {
  return {
    id: 'seatbelt',
    probe: () => Promise.resolve(capabilities),
    wrap: (file, args) => ({ file: ENV_BIN, args: [`${SANDBOX_MARKER}=wrapped`, file, ...args] }),
  };
}
