// The L0 isolated executor and the sandbox capability probe (PLAN U1.04, DESIGN 2.6.6, ADR-0003).
import type { SandboxBackend, SandboxCapabilities } from '../contract/index.ts';
import { computeCapabilities } from './capabilities.ts';

export { nativeShortfalls, sandboxUnavailable } from './capabilities.ts';
export { createExecutor, createNoneBackend, type ExecutorOptions } from './executor.ts';
export { processStartToken, type SweepByTokenOptions, type SweepByTokenResult, sweepGroupByToken } from './identity.ts';
export {
  isWrappableProgramPath,
  type UlimitLimits,
  type WrappedCommand,
  wrapWithUlimit,
} from './ulimit.ts';

export interface ProbeSandboxOptions {
  /** the L1 backends to probe, in order of preference; none usable = L0 is reported, honestly */
  backends?: readonly SandboxBackend[];
  platform?: string;
}

/**
 * `cohorte doctor --json`'s "sandbox" section (spec 9 "garanties réellement actives"). Until U4.07 constructs a
 * real Seatbelt/bubblewrap `SandboxBackend`, this always reports the honest L0 level: the L1 binaries this machine
 * happens to have installed are detected only for `missing`/`notes`, never used to widen the claimed guarantees.
 */
export function probeSandbox(options: ProbeSandboxOptions = {}): Promise<SandboxCapabilities> {
  return computeCapabilities(options.backends ?? [], options.platform ?? process.platform);
}
