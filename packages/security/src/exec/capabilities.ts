// What the L0 executor honestly guarantees, and detection of the L1 binaries this unit does not yet wrap
// (DESIGN 2.6.6, ADR-0003: "L1 backends are U4.07"). `computeCapabilities` is the ONE function behind both
// `Executor.run()`'s `ExecResult.guarantees` and the top-level `probeSandbox()`, so the two can never disagree.
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { type ErrorInfo, errorOf } from '@cohorte/base';
import type { SandboxBackend, SandboxCapabilities } from '../contract/index.ts';

/**
 * The fixed L0-process report (every OS, the built-in `none` backend). `memory` stays `unavailable`: the ulimit
 * wrapper never attempts `-v` (toolchain.md §8: it fails outright on macOS, and this unit applies only `-t/-f/-n/-u`
 * on every platform alike, per DESIGN 2.6.6's own list of flags). `missing`/`notes` report what `probeSandbox`
 * observed about L1 binaries on this machine; the level stays `L0-process` regardless, since no backend besides
 * `none` is implemented here.
 *
 * `cpuTime` and `processes` say `enforced` because the wrapper FAILS CLOSED (ulimit.ts): a limit the kernel
 * refuses aborts the run instead of letting the program start without it, so the word is never a claim about a
 * limit that was silently dropped.
 */
export function l0Capabilities(missing: readonly string[] = [], notes: readonly string[] = []): SandboxCapabilities {
  return {
    level: 'L0-process',
    backend: 'none',
    filesystem: 'advisory',
    network: 'unenforced',
    processEscape: 'possible',
    envFiltering: 'enforced',
    timeout: 'enforced',
    outputCap: 'enforced',
    cpuTime: 'enforced',
    memory: 'unavailable',
    processes: 'enforced',
    killTree: 'process-group-with-sweep',
    missing: [...missing],
    notes: [...notes],
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `name` an executable on the host's PATH? Scanned directly rather than through `which`, which is not part of
 * coreutils and is simply absent from many minimal Linux images and containers: there, a spawned `which` fails,
 * `bwrap` is reported missing although it is installed, and `doctor` — the report ADR-0003 makes load-bearing for
 * the `native` / `best-effort` decision — states a false negative. A `stat` per PATH entry also costs no fork.
 *
 * This is the one place the executor reads `process.env`, and it reads the HOST's PATH to answer a question about
 * the host. Nothing here ever reaches a child: the environment of a spawned command is built from `ExecRequest.env`
 * alone (S-20, executor.ts).
 */
function isOnPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && isExecutable(join(dir, name))) return true;
  }
  return false;
}

const settledDetection = new Map<string, readonly string[]>();

/**
 * Informational only (DESIGN 2.6.6 `missing` example: `["bwrap"]`): this unit never wraps a command in Seatbelt or
 * bubblewrap (that is U4.07's job), so detecting them changes nothing about the reported `level`/`backend` — it
 * only tells `doctor` what is absent.
 *
 * SYNCHRONOUS, because `Executor.capabilities()` is: DESIGN 2.6.6 marks `SandboxCapabilities` `[S]` and
 * `capabilities()` returns it without awaiting anything. Priming an asynchronous detection at construction was not
 * enough — a `capabilities()` called in the same tick still read an unsettled memo and answered `missing: []` while
 * `probeSandbox()` answered `['bwrap']`, i.e. `doctor` contradicted itself depending on when it was called. A
 * handful of `stat`s is all the answer needs.
 *
 * MEMOISED per platform: DESIGN 2.6.6 says `probe()` is "cached per Cohorte version + OS build", and the answer is
 * a property of the machine, not of the command; without the memo it would be recomputed on every `run()`.
 */
export function detectMissingL1Binaries(platform: string): readonly string[] {
  const settled = settledDetection.get(platform);
  if (settled !== undefined) return settled;
  const missing: string[] = [];
  if (platform === 'darwin' && !isExecutable('/usr/bin/sandbox-exec')) missing.push('sandbox-exec');
  if (platform === 'linux' && !isOnPath('bwrap')) missing.push('bwrap');
  settledDetection.set(platform, missing);
  return missing;
}

/** The backend that produced `capabilities`, if any — `undefined` means "nothing usable: the honest L0 report". */
export interface ResolvedSandbox {
  backend?: SandboxBackend;
  capabilities: SandboxCapabilities;
}

/**
 * Tries every non-`none` backend in order and returns the FIRST one whose probe reports `L1-os`, together with its
 * report; falls back to the honest L0 report (with L1-binary detection folded into `missing`) when none is usable —
 * which, until U4.07 lands, is always, since no L1 `SandboxBackend` is constructed by this unit.
 *
 * Returning the backend and its report together is what keeps `ExecResult.guarantees` honest: the executor wraps
 * the command with exactly the backend that earned the report, so it can never claim an isolation that the argv it
 * spawned does not carry.
 */
export async function resolveSandbox(backends: readonly SandboxBackend[], platform: string): Promise<ResolvedSandbox> {
  for (const backend of backends) {
    if (backend.id === 'none') continue;
    try {
      const probed = await backend.probe();
      if (probed.level === 'L1-os') return { backend, capabilities: probed };
    } catch {
      // Not implemented yet, or failed to probe: fall through to the honest L0 report.
    }
  }
  return { capabilities: l0Capabilities(detectMissingL1Binaries(platform)) };
}

/** The escape self-test that gates the word `enforced` on this platform (DESIGN 2.6.6, ADR-0003 §2b). */
function escapeSelfTest(platform: string): string {
  if (platform === 'darwin') return 'escape self-test S-28';
  if (platform === 'linux') return 'escape self-test S-29';
  return 'the platform escape self-test';
}

/**
 * One sentence per axis on which `guarantees` falls short of `require: 'native'`; empty exactly when it satisfies
 * it. DESIGN 2.6.6 requires the refusal to NAME the failing self-test rather than hand the caller a bare enum, so
 * these strings are what the executor appends to `guarantees.notes` on a `sandbox-denied` result and what
 * `sandboxUnavailable()` (exec/index.ts) turns into the catalogued error's message.
 *
 * `level: 'L1-os'` alone is never enough: a backend whose escape self-test has not passed here reports `partial` on
 * the axes that matter, and `native` is satisfied only by `enforced` (ADR-0003 §2b).
 */
export function nativeShortfalls(
  guarantees: SandboxCapabilities,
  platform: string = process.platform,
): readonly string[] {
  if (guarantees.level !== 'L1-os') {
    const missing = guarantees.missing.length > 0 ? ` (missing: ${guarantees.missing.join(', ')})` : '';
    return [
      `sandbox: no OS sandbox backend is active${missing} — level is '${guarantees.level}', backend '${guarantees.backend}', ` +
        `so filesystem isolation is '${guarantees.filesystem}' and network '${guarantees.network}'`,
    ];
  }
  const test = escapeSelfTest(platform);
  const shortfalls: string[] = [];
  if (guarantees.filesystem !== 'enforced') {
    shortfalls.push(`sandbox: filesystem is '${guarantees.filesystem}' (${test} has not passed on this machine)`);
  }
  if (guarantees.network !== 'enforced-off') {
    shortfalls.push(`sandbox: network is '${guarantees.network}' (${test} has not passed on this machine)`);
  }
  if (guarantees.processEscape !== 'denied') {
    shortfalls.push(`sandbox: processEscape is '${guarantees.processEscape}' (${test} has not passed on this machine)`);
  }
  return shortfalls;
}

/** `resolveSandbox`'s report alone, for callers that only want to know what is guaranteed (`probeSandbox`). */
export async function computeCapabilities(
  backends: readonly SandboxBackend[],
  platform: string,
): Promise<SandboxCapabilities> {
  return (await resolveSandbox(backends, platform)).capabilities;
}

/**
 * DESIGN 2.6.6: "`require: 'native'` with no usable backend => `security/sandbox-unavailable` with the `doctor`
 * remediation." Minted HERE, once, from the same `nativeShortfalls` the executor already put in `guarantees.notes`
 * on the `sandbox-denied` result, so the catalogued error and the reported notes can never say different things.
 */
export function sandboxUnavailable(guarantees: SandboxCapabilities, platform: string = process.platform): ErrorInfo {
  const shortfalls = nativeShortfalls(guarantees, platform);
  const message = shortfalls.length > 0 ? shortfalls.join(' ') : 'no OS sandbox backend is active';
  return errorOf('security/sandbox-unavailable', message, { details: { guarantees: { ...guarantees } } });
}
