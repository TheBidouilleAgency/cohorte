// Executor and sandbox levels (DESIGN 2.6.6, ADR-0003).
import type { SealedText, Sha256 } from '@cohorte/base';
import { type TUnsafe, Type } from 'typebox';
import type { CanonicalPath } from './paths.ts';

export interface ExecRequest {
  /** resolved program; NEVER a shell line */
  file: CanonicalPath;
  args: readonly string[];
  cwd: CanonicalPath;
  /** complete; the executor never reads process.env */
  env: Readonly<Record<string, string>>;
  fs: { readWrite: CanonicalPath[]; readOnly: CanonicalPath[]; denyRead: CanonicalPath[] };
  /** 'unrestricted' is legal ONLY for Cohorte-run provisioning effects (DESIGN 5.7), never for an agent call */
  network: 'none' | 'unrestricted';
  timeoutMs: number;
  maxOutputBytes: number;
  stdin: 'ignore';
  limits: { cpuSeconds?: number; fileSizeBytes?: number; openFiles?: number; processes?: number; memoryBytes?: number };
  require: 'native' | 'best-effort';
  onChunk?: (c: { stream: 'stdout' | 'stderr'; bytes: number; text: SealedText }) => void;
}

export interface ExecResult {
  exitCode: number | null;
  signal?: string;
  outcome: 'ok' | 'error' | 'timed-out' | 'killed' | 'output-capped' | 'sandbox-denied';
  tail: SealedText;
  outputSha256: Sha256;
  outputBytes: number;
  truncated: boolean;
  fullOutputPath?: string;
  durationMs: number;
  pgid: number;
  startToken: string;
  /** processes that left the group, found by the post-run sweep */
  escapees: number;
  guarantees: SandboxCapabilities;
}

/** argv only: there is no `run(commandLine: string)` and there never will be (I3). */
export interface Executor {
  capabilities(): SandboxCapabilities;
  run(req: ExecRequest, signal: AbortSignal): Promise<ExecResult>;
}

export interface SandboxBackend {
  readonly id: 'seatbelt' | 'bubblewrap' | 'none';
  probe(): Promise<SandboxCapabilities>;
  /** pure */
  wrap(file: CanonicalPath, args: readonly string[], req: ExecRequest): { file: CanonicalPath; args: string[] };
}

/**
 * Exactly what `cohorte doctor --json` prints under "sandbox" (spec 9 "garanties réellement actives").
 * 'partial': the backend is active but its escape self-test (S-28 on macOS, S-29 on Linux) has not passed here.
 */
export interface SandboxCapabilities {
  level: 'L0-process' | 'L1-os';
  backend: 'none' | 'seatbelt' | 'bubblewrap';
  filesystem: 'enforced' | 'partial' | 'advisory';
  network: 'enforced-off' | 'partial' | 'unenforced';
  /** LaunchServices / AppleEvents / job creation / signalling other processes / host Unix sockets */
  processEscape: 'denied' | 'partial' | 'possible';
  envFiltering: 'enforced';
  timeout: 'enforced';
  outputCap: 'enforced';
  cpuTime: 'enforced' | 'unavailable';
  memory: 'enforced' | 'node-only' | 'unavailable';
  processes: 'enforced' | 'unavailable';
  killTree: 'pid-namespace' | 'process-group-with-sweep';
  /** e.g. ["bwrap"], ["kernel.apparmor_restrict_unprivileged_userns=1"] */
  missing: string[];
  notes: string[];
}

const oneOf = <const V extends readonly string[]>(values: V): TUnsafe<V[number]> =>
  Type.Unsafe<V[number]>({ type: 'string', enum: [...values] });

/** [S]. Annotated so that Biome never infers it (docs/v3/requests/U0.02.md R1). */
export const SandboxCapabilities: TUnsafe<SandboxCapabilities> = Type.Unsafe<SandboxCapabilities>(
  Type.Object(
    {
      level: oneOf(['L0-process', 'L1-os']),
      backend: oneOf(['none', 'seatbelt', 'bubblewrap']),
      filesystem: oneOf(['enforced', 'partial', 'advisory']),
      network: oneOf(['enforced-off', 'partial', 'unenforced']),
      processEscape: oneOf(['denied', 'partial', 'possible']),
      envFiltering: Type.Literal('enforced'),
      timeout: Type.Literal('enforced'),
      outputCap: Type.Literal('enforced'),
      cpuTime: oneOf(['enforced', 'unavailable']),
      memory: oneOf(['enforced', 'node-only', 'unavailable']),
      processes: oneOf(['enforced', 'unavailable']),
      killTree: oneOf(['pid-namespace', 'process-group-with-sweep']),
      missing: Type.Array(Type.String()),
      notes: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
);

/** Where the L0 executor records what it spawned, so the post-run sweep and the Resumer can find processes that left the group. */
export interface PidRegistry {
  record(entry: { pgid: number; startToken: string; label: string }): void;
  remove(pgid: number): void;
}
