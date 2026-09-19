// The L0 isolated executor (DESIGN 2.6.6, ADR-0003). Every OS, pure Node: a verified cwd, an env built ONLY from
// `ExecRequest.env`, a detached process-group kill tree with a post-run sweep, wall-clock and output-cap kills, and
// the constant `ulimit` wrapper (I3). `fs`/`network` are recorded but not enforced here — that is L1 (U4.07); L0
// is advisory filesystem isolation and no network isolation (DESIGN 0.3), which is exactly what `l0Capabilities`
// reports.
//
// `ExecResult.outcome` describes how the EXECUTOR ended the process, never how the program judged itself: a
// program that ran to completion is `'ok'` whatever its exit code (a non-zero exit is the caller's
// `tool-terminal/nonzero-exit`, not this layer's business), and `'error'` is reserved for a run that produced no
// usable process at all — an unverifiable cwd, a spawn failure, a rlimit the kernel refused.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { type Clock, type Redactor, sha256Hex } from '@cohorte/base';
import type {
  ExecRequest,
  ExecResult,
  Executor,
  PidRegistry,
  SandboxBackend,
  SandboxCapabilities,
} from '../contract/index.ts';
import { detectMissingL1Binaries, l0Capabilities, nativeShortfalls, resolveSandbox } from './capabilities.ts';
import {
  killGroup,
  killGroupMembers,
  processStartToken,
  sweepTracked,
  type TrackedDescendants,
  type TrackInterval,
  trackDescendants,
} from './identity.ts';
import {
  isWrappableProgramPath,
  requestsAnyRlimit,
  ULIMIT_REFUSED_EXIT_CODE,
  unwrappableProgramNote,
  wrapWithUlimit,
} from './ulimit.ts';

/** Verified (toolchain.md §8: "detached: true + negative-pid kill... put a timeout on stream draining as well"). */
const GRACE_MS = 300;
const STREAM_DRAIN_TIMEOUT_MS = 500;
/** 40 ms while the leader is young (an escapee must be seen before it is reaped), backing off after one second. */
const TRACK_INTERVAL: TrackInterval = { initialMs: 40, maxMs: 500, rampAfterMs: 1_000 };
const TAIL_MAX_CHARS = 64 * 1024;

export interface ExecutorOptions {
  /** chunks and the tail are sealed before they leave the executor (I7) */
  redactor: Redactor;
  pids: PidRegistry;
  clock: Clock;
  /** default: the `none` backend (L0). The L1 backends are injected by the composition root (U4.07). */
  backend?: SandboxBackend;
}

/** The built-in `none` `SandboxBackend`: wraps nothing, always reports the honest L0 level. */
export function createNoneBackend(): SandboxBackend {
  return {
    id: 'none',
    probe: () => Promise.resolve(l0Capabilities()),
    wrap: (file, args) => ({ file, args: [...args] }),
  };
}

/** The identity wrapper used whenever no L1 backend earned the reported guarantees. */
const NONE_BACKEND = createNoneBackend();

function backendsFor(backend: SandboxBackend): readonly SandboxBackend[] {
  return backend.id === 'none' ? [] : [backend];
}

/**
 * DESIGN 2.6.6 / ADR-0003 §2b: "`sandbox.require: native` is satisfied only by `enforced`: with a `partial`
 * backend the run refuses to start". `level: 'L1-os'` alone is not enough — a backend whose escape self-test
 * (S-28 on macOS, S-29 on Linux) has not passed here reports `partial` on the axes that matter.
 */
function satisfiesNative(guarantees: SandboxCapabilities): boolean {
  return (
    guarantees.level === 'L1-os' &&
    guarantees.filesystem === 'enforced' &&
    guarantees.network === 'enforced-off' &&
    guarantees.processEscape === 'denied'
  );
}

/**
 * DESIGN 2.6.6 L0 row: "Filesystem and network isolation are advisory." The plan makes that explicit for the roots
 * a caller asked to be protected — `fs.readOnly` (the slot's dependency directories, DESIGN 5.7) and `fs.denyRead`
 * — by RECORDING them on the result rather than silently ignoring them: at L0 nothing enforces them, and U4.07 is
 * where these same roots become real. A request that asks for neither adds no note, so `ExecResult.guarantees`
 * still equals `probeSandbox()` for it.
 */
function advisoryFsNotes(req: ExecRequest, guarantees: SandboxCapabilities): readonly string[] {
  if (guarantees.filesystem === 'enforced') return [];
  const parts: string[] = [];
  if (req.fs.readOnly.length > 0) parts.push(`readOnly: ${req.fs.readOnly.join(', ')}`);
  if (req.fs.denyRead.length > 0) parts.push(`denyRead: ${req.fs.denyRead.join(', ')}`);
  if (parts.length === 0) return [];
  return [
    `filesystem is '${guarantees.filesystem}' at this level: the requested roots are recorded but NOT enforced ` +
      `(${parts.join('; ')}) — an OS sandbox backend is what enforces them`,
  ];
}

/** `guarantees` plus the notes that describe THIS request; never the report cached for `capabilities()`. */
function withNotes(guarantees: SandboxCapabilities, notes: readonly string[]): SandboxCapabilities {
  return notes.length === 0 ? guarantees : { ...guarantees, notes: [...guarantees.notes, ...notes] };
}

/** `req.cwd` must still refer to exactly what it claims to (defence against a TOCTOU swap between resolve and spawn). */
function cwdVerifies(cwd: string): boolean {
  try {
    return realpathSync.native(cwd) === cwd;
  } catch {
    return false;
  }
}

type EarlyOutcome = Extract<ExecResult['outcome'], 'sandbox-denied' | 'error' | 'killed'>;

export function createExecutor(options: ExecutorOptions): Executor {
  const backend = options.backend ?? NONE_BACKEND;
  const platform = process.platform;
  // What the last run observed about THIS MACHINE — `resolveSandbox`'s own report, never the per-request copy the
  // result carries (a `sandbox-denied` refusal or an advisory-filesystem record describes one call, not the
  // machine, and `capabilities()` is what `cohorte doctor --json` prints under "sandbox", DESIGN 2.6.6 [S]).
  let lastGuarantees: SandboxCapabilities | undefined;

  return {
    capabilities(): SandboxCapabilities {
      // Detection is synchronous and memoised (capabilities.ts), so a COLD `capabilities()` — called before any
      // `run()` or `probeSandbox()` — already reports the same `missing` as the probe, in the same tick.
      return lastGuarantees ?? l0Capabilities(detectMissingL1Binaries(platform));
    },
    run: async (req: ExecRequest, signal: AbortSignal): Promise<ExecResult> => {
      const run = await runOnce(options, backend, req, signal);
      lastGuarantees = run.observed;
      return run.result;
    },
  };
}

/**
 * `pgid: 0` is the "nothing was spawned" sentinel of every early return, NOT a process group: on POSIX `kill(-0)`
 * addresses the caller's own group, so `sweepGroupByToken`, `killGroup` and `killGroupMembers` all refuse a pgid
 * of 0 or 1 outright (identity.ts). A dependant must read it as "no group", never as one to sweep.
 */
function emptyResult(
  outcome: EarlyOutcome,
  guarantees: SandboxCapabilities,
  redactor: Redactor,
  startedMonoMs: number,
  clock: Clock,
): ExecResult {
  return {
    exitCode: null,
    outcome,
    tail: redactor.sealText('').text,
    outputSha256: sha256Hex(''),
    outputBytes: 0,
    truncated: false,
    durationMs: clock.monotonicMs() - startedMonoMs,
    pgid: 0,
    startToken: '',
    escapees: 0,
    guarantees,
  };
}

/** What one call produced: the result handed to the caller, and what it OBSERVED about the machine (`capabilities()`). */
interface RunOutput {
  result: ExecResult;
  observed: SandboxCapabilities;
}

async function runOnce(
  options: ExecutorOptions,
  backend: SandboxBackend,
  req: ExecRequest,
  signal: AbortSignal,
): Promise<RunOutput> {
  const platform = process.platform;
  const startedMonoMs = options.clock.monotonicMs();
  const resolved = await resolveSandbox(backendsFor(backend), platform);
  const observed = resolved.capabilities;
  // Everything below reports on THIS REQUEST; `observed` stays the untouched machine report.
  const guarantees = withNotes(observed, advisoryFsNotes(req, observed));
  const early = (outcome: EarlyOutcome, notes: readonly string[] = []): RunOutput => ({
    result: emptyResult(outcome, withNotes(guarantees, notes), options.redactor, startedMonoMs, options.clock),
    observed,
  });

  if (req.require === 'native' && !satisfiesNative(observed)) {
    // DESIGN 2.6.6: the refusal NAMES the failing axes rather than handing the caller a bare enum; minted from the
    // same `nativeShortfalls` that `sandboxUnavailable()` (exec/index.ts) turns into the catalogued error's message.
    return early('sandbox-denied', nativeShortfalls(observed, platform));
  }
  // A signal aborted BEFORE the spawn is a cancellation ('killed'), never `error` — `error` is reserved for a run
  // that could not produce a usable process (an unverifiable cwd, a spawn failure, a refused rlimit; R3).
  if (signal.aborted) return early('killed');
  if (!cwdVerifies(req.cwd)) return early('error');

  // The sandbox seam, applied by the backend that ACTUALLY earned `guarantees` (a backend whose probe failed is
  // used for neither). The `ulimit` wrapper goes OUTSIDE it, so the rlimits also cover the sandbox helper process
  // itself — a `sandbox-exec`/`bwrap` that forked without bound would otherwise escape `processes` before the real
  // program ever starts. DESIGN 2.6.6 does not fix the order; this is the choice, and `wrap()` is pure, so it is
  // free to be composed either way.
  const outer = (resolved.backend ?? NONE_BACKEND).wrap(req.file, req.args, req);
  // The `ulimit` wrapper exists to APPLY rlimits; a request that asks for none has nothing for it to do, and going
  // through it anyway would buy a shell process and its `/usr/bin/env` operand hazard for no guarantee at all. A
  // direct spawn is not a weaker path: there is still no shell, so I3 holds by construction, and with no shell
  // there is nothing to re-export `PWD`/`SHLVL` either, so S-20 holds trivially instead of by countermeasure.
  const wrapping = requestsAnyRlimit(req.limits);
  // Fail closed (I2) on the one program path the wrapper cannot carry: `/usr/bin/env` would read a path containing
  // `=` as a variable assignment and exec the next argv element — model-influenced text (I3) — in its place. The
  // refusal is scoped to the requests that actually need the wrapper: without it there is no `env` to be fooled,
  // and a worktree whose path contains `=` is not a reason to refuse every command (U1.04 request R4).
  if (wrapping && !isWrappableProgramPath(outer.file)) return early('error', [unwrappableProgramNote(outer.file)]);
  const launch = wrapping
    ? wrapWithUlimit(outer.file, outer.args, req.limits)
    : { file: outer.file, args: [...outer.args] };
  const child = spawn(launch.file, launch.args, {
    cwd: req.cwd,
    // Built ONLY from `req.env`: `process.env` is never read, never merged (S-20).
    env: { ...req.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // `child.pid` is set synchronously when the spawn succeeded, and `undefined` when it did not.
  const leaderPid = child.pid;

  // ---------------------------------------------------------------------------------------------------------
  // Everything the child can emit is wired HERE, before the first `await`. That is not style, it is correctness:
  // Node delivers `'exit'` once, to whoever is listening when the child is reaped, and a `stdout` that was never
  // resumed is thrown away when the process ends. A program faster than the `ps` fork of `processStartToken` below
  // — `/usr/bin/env`, `true`, anything tiny — is already gone by the time a listener added after an `await` exists:
  // measured on this machine, wiring the streams after that fork loses ALL of a fast program's output, and wiring
  // `'exit'` after it makes `await exited` wait for something that has already happened (the run then ends at its
  // own wall-clock timeout, or never, if the injected Clock ignores the timer's abort).
  // ---------------------------------------------------------------------------------------------------------
  let outcome: ExecResult['outcome'] = 'ok';
  let truncated = false;
  let totalBytes = 0;
  let rawTail = '';
  const chunks: Buffer[] = [];

  // One decoder per stream, kept across reads: a multi-byte UTF-8 sequence that straddles a pipe-read boundary
  // would otherwise be destroyed (U+FFFD) in both the text handed to the model and the accumulated tail. `chunks`
  // and `outputSha256` stay byte-based and are unaffected. A read that ends mid-sequence decodes to '' and is
  // still reported, so `bytes` stays an exact account of what was read.
  const decoders: Record<'stdout' | 'stderr', StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  const sealChunk = (stream: 'stdout' | 'stderr', bytes: Buffer): void => {
    const text = decoders[stream].write(bytes);
    rawTail = (rawTail + text).slice(-TAIL_MAX_CHARS);
    req.onChunk?.({ stream, bytes: bytes.length, text: options.redactor.sealText(text).text });
  };

  let escalation: Promise<void> | undefined;
  const escalate = (why: ExecResult['outcome']): void => {
    // No pid means the spawn failed; the early return below is that call's whole story.
    if (escalation !== undefined || leaderPid === undefined) return;
    outcome = why;
    escalation = killGroup(leaderPid, (ms) => options.clock.sleep(ms), GRACE_MS);
  };

  const onData =
    (stream: 'stdout' | 'stderr') =>
    (chunk: Buffer): void => {
      if (truncated) return;
      let bytes = chunk;
      if (totalBytes + bytes.length > req.maxOutputBytes) {
        const room = Math.max(0, req.maxOutputBytes - totalBytes);
        bytes = bytes.subarray(0, room);
        truncated = true;
      }
      if (bytes.length > 0) {
        totalBytes += bytes.length;
        chunks.push(Buffer.from(bytes));
        sealChunk(stream, bytes);
      }
      if (truncated) escalate('output-capped');
    };
  child.stdout?.on('data', onData('stdout'));
  child.stderr?.on('data', onData('stderr'));

  let exitCode: number | null = null;
  let exitSignal: string | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig ?? undefined;
      resolve();
    });
  });

  const spawnOutcome = await new Promise<'spawned' | 'error'>((resolve) => {
    child.once('spawn', () => resolve('spawned'));
    child.once('error', () => resolve('error'));
  });
  if (spawnOutcome === 'error' || leaderPid === undefined) return early('error');
  // A later 'error' (e.g. an EPIPE after the child is gone) would otherwise throw, unhandled, once the `once`
  // listener above has fired and been removed.
  child.on('error', () => {});
  // Computed and recorded NOW, while the leader is still alive: `ps -o lstart=` (or /proc/.../stat) needs a live
  // pid, and a crash between here and exit must still leave a recoverable (pgid, startToken) trace (DESIGN 4.4).
  // A program that beat this fork to its own exit simply has no token: `unknown:<pid>` says so rather than
  // inventing one, and `sweepGroupByToken` verifies nothing against it (identity.ts).
  const startToken = (await processStartToken(leaderPid, platform)) ?? `unknown:${leaderPid}`;
  options.pids.record({ pgid: leaderPid, startToken, label: req.file });

  // `pid -> start time as first seen`: the sweep signals a tracked pid only while it is still that same process.
  const escapeesSeen: TrackedDescendants = new Map<number, string>();
  const trackingTask = trackDescendants(
    leaderPid,
    escapeesSeen,
    exited,
    (ms) => options.clock.sleep(ms),
    TRACK_INTERVAL,
  );

  // `outcome` may never depend on a Clock honouring an OPTIONAL argument: `Clock.sleep(ms, signal?)` (@cohorte/base
  // ports.ts) leaves the signal optional, so a perfectly conforming clock that ignores it would otherwise make every
  // run report `timed-out` for a program that exited in milliseconds. `finished` is the correctness condition; the
  // abort below stays what it always was — the optimisation that stops the timer early.
  let finished = false;
  const timeoutAbort = new AbortController();
  const timeoutTask = options.clock
    .sleep(req.timeoutMs, timeoutAbort.signal)
    .then(() => {
      if (!finished) escalate('timed-out');
    })
    .catch(() => {
      // Aborted because the process already ended, or the caller cancelled: nothing to do.
    });

  const onExternalAbort = (): void => escalate('killed');
  if (!signal.aborted) signal.addEventListener('abort', onExternalAbort, { once: true });

  await exited;
  finished = true;
  timeoutAbort.abort();
  signal.removeEventListener('abort', onExternalAbort);
  await timeoutTask;
  await trackingTask;
  if (escalation) await escalation;
  // Safety net: whatever ended the wait, make sure nothing of the group is left running. The leader has been
  // reaped by now, so `kill(-leaderPid)` is no longer addressable to a group we can prove is ours — this walks
  // the process table and signals only the pids still IN the group (DESIGN 4.4 step 5). `GRACE_MS`, like every
  // other kill path here: DESIGN 2.6.6 says TERM -> grace -> KILL, and a leftover grandchild of a command that
  // ended NORMALLY is the case that most deserves its chance to flush and exit on the TERM. It costs nothing when
  // the group is already empty — the grace is only waited when something was actually signalled (identity.ts).
  await killGroupMembers(leaderPid, (ms) => options.clock.sleep(ms), GRACE_MS);

  await drainStreams(child, (ms) => options.clock.sleep(ms).catch(() => {}));
  // Flush whatever incomplete sequence the decoders still hold; only the tail can still take it.
  const flushed = decoders.stdout.end() + decoders.stderr.end();
  if (flushed !== '') rawTail = (rawTail + flushed).slice(-TAIL_MAX_CHARS);

  const escapees = await sweepTracked(escapeesSeen, leaderPid, (ms) => options.clock.sleep(ms), GRACE_MS);
  options.pids.remove(leaderPid);

  // A rlimit the kernel refused: the wrapper aborted before `exec`, so no program ever ran. It is the ONE exit
  // code the wrapper mints itself, and it always comes with no output at all (the shell's own diagnostics are
  // discarded, and its `exec` failures write to stderr first), so this cannot swallow a program's own 126.
  if (outcome === 'ok' && exitCode === ULIMIT_REFUSED_EXIT_CODE && totalBytes === 0 && requestsAnyRlimit(req.limits)) {
    outcome = 'error';
  }

  const output = Buffer.concat(chunks);
  const sealedTail = options.redactor.sealText(rawTail).text;
  const durationMs = options.clock.monotonicMs() - startedMonoMs;

  return {
    result: {
      exitCode,
      outcome,
      tail: sealedTail,
      outputSha256: sha256Hex(output),
      outputBytes: totalBytes,
      truncated,
      durationMs,
      pgid: leaderPid,
      startToken,
      escapees,
      guarantees,
      ...(exitSignal !== undefined ? { signal: exitSignal } : {}),
    },
    observed,
  };
}

async function drainStreams(child: ReturnType<typeof spawn>, wait: (ms: number) => Promise<void>): Promise<void> {
  const closed = Promise.all(
    [child.stdout, child.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (!stream || stream.destroyed) {
            resolve();
            return;
          }
          stream.once('close', () => resolve());
        }),
    ),
  );
  let timedOut = false;
  await Promise.race([
    closed.then(() => {}),
    wait(STREAM_DRAIN_TIMEOUT_MS).then(() => {
      timedOut = true;
    }),
  ]);
  if (timedOut) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
