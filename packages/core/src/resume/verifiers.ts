// DESIGN 4.1 (the effect-kind table) — the nine BUILT-IN `EffectVerifier`s this unit's plan entry lists as a
// deliverable ("Built-in verifiers that need only ports"): `git.branch.create`, `git.ref.create`,
// `git.worktree.add`, `git.commit` (trailer), `git.merge` (CAS head), `git.worktree.reset`, `provision.command`
// (marker), `agent.spawn` (nonce sweep), `fs.snapshot.materialize`.
//
// DEVIATION (docs/v3/requests/U1.10.md, item D3): DESIGN 4.1's per-kind table names the DATA a verifier reads at
// intent ("target sha", "path, branch, base sha", "marker path", "host nonce", "manifest digest") but the actual
// `perform()` that WRITES `EffectIntent.verify` for each of these kinds belongs to a LATER unit (worktrees/git
// effects: Wave 2/3; provisioning: Wave 2; agent spawn: Wave 3's supervisor) that has not run yet — there is no
// existing producer to read the exact wire shape from. This file freezes the smallest consistent JSON shape for
// each kind's `verify` payload (documented per verifier below) and reads it directly off `EffectRecord.verify`
// (already `SealedJson`, i.e. `JsonValue`-shaped — reading a field off an already-sealed value mints nothing, so
// check-layers rule f, "only the redactor mints Sealed<T>", does not apply). The request file asks the units that
// eventually author these `perform()` bodies to match this shape, or to tell the integrator why not.
//
// DEVIATION (D4): `GitPort` (frozen, `@cohorte/git/contract`, U1.05) has no generic "read a ref" primitive — only
// `facts()` (per-worktree HEAD + branch), `findCommitByTrailer()` and CAS/create operations. `git.branch.create`
// and `git.ref.create` can therefore only be READ when the ref happens to be a worktree's own branch (through
// `facts()`). Absence of the ref from `facts().worktrees` proves nothing — a bare ref (a review ref, say) is simply
// invisible to this port — so that case is `in-doubt`, never `not-done`: `not-done` would make the resume
// orchestration mark the effect `failed(interrupted)` and the ref-create would be blindly re-executed. This
// verifier therefore never answers `not-done`; DESIGN 4.1's row has no "not-done" column for these two kinds
// either ("ref at sha ⇒ done; elsewhere ⇒ conflict ⇒ BLOCKED"), and an `EffectVerifier` cannot itself raise the
// BLOCKED — only 'done' | 'not-done' | 'in-doubt' — so the conflict is surfaced as `in-doubt` for a human.

import type { EffectId, Sha256 } from '@cohorte/base';
import type { CanonicalPath, GitPort } from '@cohorte/git/contract';
import type { EffectKind, EffectRecord } from '@cohorte/persistence/contract';
import type { Provisioner } from '../contract/internal.ts';
import type { EffectVerifier, EffectVerifierRegistry, ProcessSweeper } from '../contract/ports.ts';

export interface BuiltinVerifierDeps {
  git: GitPort;
  provisioner: Provisioner;
  sweeper: ProcessSweeper;
  /** The run's OWN stored snapshot digest (`RunRecord.snapshotDigest`, written by the T04 transaction), supplied by
   * whoever builds this registry — `fs.snapshot.materialize`'s verifier compares the intent's recorded
   * `manifestDigest` against it. Absent (or `undefined`) ⇒ that verifier can decide nothing and answers `in-doubt`:
   * comparing two fields of the same sealed intent payload would verify nothing about the world. */
  runSnapshotDigest?: () => Sha256 | undefined;
}

/** What `createBuiltinEffectVerifiers` reports ON TOP of the frozen `EffectVerifierRegistry`: the effects whose
 * VERIFICATION was itself the re-execution DESIGN 4.1 prescribes. `provision.command`'s probe IS
 * `Provisioner.ensure(slot)`, which re-provisions when the marker is missing — so by the time the verifier answers
 * `'done'`, the work has either been found in place (`reused`) or just been redone (`fresh`). The verdict is the
 * same (`done`: nothing must re-execute afterwards); only the REPORT differs, and `ResumeReport.effects[].verdict`
 * distinguishes them as `'done'` vs `'re-executed'`. The resume orchestration reads this through a duck-typed
 * narrowing, so a registry that does not implement it (any composed or foreign registry) simply reports `'done'`. */
export interface ReExecutionLog {
  reExecuted(effectId: EffectId): boolean;
}

export type BuiltinEffectVerifiers = EffectVerifierRegistry & ReExecutionLog;

type Verdict = 'done' | 'not-done' | 'in-doubt';

function asJson(sealed: EffectRecord['verify']): Record<string, unknown> {
  const value = sealed as unknown;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

/** `git.branch.create` / `git.ref.create` — `verify: { repo: string; ref: string; targetSha: string }`. `ref` is
 * read only when it names a worktree's own branch (the only case `facts()` can answer): at the target sha ⇒ `done`,
 * elsewhere ⇒ the DESIGN table's "conflict", surfaced as `in-doubt`. A ref NO worktree carries cannot be read
 * through this port at all — absence from `facts()` is not proof of absence in the repository — so it is `in-doubt`
 * too, never `not-done` (D4: `not-done` would have the caller re-execute the ref-create blindly). */
function refVerifier(git: GitPort): EffectVerifier {
  return {
    async verify(record: EffectRecord): Promise<Verdict> {
      const payload = asJson(record.verify);
      const repo = str(payload, 'repo');
      const ref = str(payload, 'ref');
      const targetSha = str(payload, 'targetSha');
      if (!repo || !ref || !targetSha) return 'in-doubt';
      const facts = await git.facts(repo as CanonicalPath);
      const branch = facts.worktrees.find((w) => w.branch === ref);
      if (!branch) return 'in-doubt';
      return branch.head === targetSha ? 'done' : 'in-doubt';
    },
  };
}

/** `git.worktree.add` — `verify: { repo: string; path: string; branch: string; baseSha: string }`. DESIGN: "exact
 * whole-line match in `worktree list --porcelain -z` ⇒ done; dir without registration ⇒ remove dir + prune, redo" —
 * the remove+prune half is a re-execution this verifier cannot itself perform (it only reports a verdict); the
 * caller (the reconciliation step) redoes it by marking the effect `failed(interrupted)` so the next incarnation
 * reissues `git.worktree.add` under the same key. */
function worktreeAddVerifier(git: GitPort): EffectVerifier {
  return {
    async verify(record: EffectRecord): Promise<Verdict> {
      const payload = asJson(record.verify);
      const repo = str(payload, 'repo');
      const path = str(payload, 'path');
      const branch = str(payload, 'branch');
      if (!repo || !path || !branch) return 'in-doubt';
      const facts = await git.facts(repo as CanonicalPath);
      const registered = facts.worktrees.find((w) => w.path === path);
      if (!registered) return 'not-done';
      return registered.branch === branch ? 'done' : 'in-doubt';
    },
  };
}

/** `git.commit` — `verify: { repo: string; branch: string; key: string }`. DESIGN: "findCommitByTrailer
 * (Cohorte-Effect: <key>) ⇒ done; else redo (add + commit is content-idempotent)". */
function commitVerifier(git: GitPort): EffectVerifier {
  return {
    async verify(record: EffectRecord): Promise<Verdict> {
      const payload = asJson(record.verify);
      const repo = str(payload, 'repo');
      const branch = str(payload, 'branch');
      const key = str(payload, 'key');
      if (!repo || !branch || !key) return 'in-doubt';
      const sha = await git.findCommitByTrailer(repo as CanonicalPath, branch, 'Cohorte-Effect', key);
      return sha ? 'done' : 'not-done';
    },
  };
}

/** `git.merge` — `verify: { repo: string; into: string; key: string; expectedOldHead: string }`. DESIGN: "CAS
 * already applied (head carries the trailer) ⇒ done; head == old ⇒ redo; anything else ⇒ unexpected-repo-change" —
 * the trailer check reuses `git.commit`'s mechanism (merges are committed with the same `Cohorte-Effect` trailer,
 * DESIGN 4.1's own `git.commit` row: "add + commit is content-idempotent"); the "anything else" branch (a THIRD
 * party moved the ref) is reported `in-doubt` rather than a verdict this port can turn into `unexpected-repo-change`
 * itself — the ledger audit of step 8 (`WorktreeService.audit`) is what actually raises that stop. */
function mergeVerifier(git: GitPort): EffectVerifier {
  return {
    async verify(record: EffectRecord): Promise<Verdict> {
      const payload = asJson(record.verify);
      const repo = str(payload, 'repo');
      const into = str(payload, 'into');
      const key = str(payload, 'key');
      const expectedOldHead = str(payload, 'expectedOldHead');
      if (!repo || !into || !key) return 'in-doubt';
      const sha = await git.findCommitByTrailer(repo as CanonicalPath, into, 'Cohorte-Effect', key);
      if (sha) return 'done';
      if (!expectedOldHead) return 'in-doubt';
      const facts = await git.facts(repo as CanonicalPath);
      const worktree = facts.worktrees.find((w) => w.branch === into);
      if (worktree?.head === expectedOldHead) return 'not-done';
      return 'in-doubt';
    },
  };
}

/** `git.worktree.reset` — `verify: { repo: string; path: string; checkpointSha: string }`. DESIGN: "HEAD ==
 * checkpoint and clean ⇒ done; else redo". */
function worktreeResetVerifier(git: GitPort): EffectVerifier {
  return {
    async verify(record: EffectRecord): Promise<Verdict> {
      const payload = asJson(record.verify);
      const repo = str(payload, 'repo');
      const path = str(payload, 'path');
      const checkpointSha = str(payload, 'checkpointSha');
      if (!repo || !path || !checkpointSha) return 'in-doubt';
      const facts = await git.facts(repo as CanonicalPath);
      const worktree = facts.worktrees.find((w) => w.path === path);
      if (!worktree || worktree.head !== checkpointSha) return 'not-done';
      const changed = await git.changedPaths(path as CanonicalPath);
      return changed.length === 0 ? 'done' : 'not-done';
    },
  };
}

/** `provision.command` — `verify: { slot: string }`. DESIGN: "marker `<gitdir>/cohorte-provision-<key>` present ⇒
 * done; else re-run". `Provisioner.ensure(slot)` IS both halves at once: `'reused'` means the marker was found and
 * nothing re-ran (the effect had completed before the crash); `'fresh'` means `ensure` just re-provisioned — which
 * is exactly the "re-run" DESIGN asks for, already performed. Either way the effect is now done in the world, so
 * the verdict is `'done'` in both cases; answering `'not-done'` for `'fresh'` would have the caller record
 * `failed(interrupted)` and provision a THIRD time. Which of the two happened is reported through `ReExecutionLog`
 * (`'fresh'` ⇒ `ResumeReport.effects[].verdict === 're-executed'`, `'reused'` ⇒ `'done'`). */
function provisionVerifier(provisioner: Provisioner, markReExecuted: (id: EffectId) => void): EffectVerifier {
  return {
    async verify(record: EffectRecord): Promise<Verdict> {
      const payload = asJson(record.verify);
      const slot = str(payload, 'slot') ?? record.slot;
      if (!slot) return 'in-doubt';
      const outcome = await provisioner.ensure(slot);
      if (outcome === 'fresh') markReExecuted(record.effectId);
      return 'done';
    },
  };
}

/** `agent.spawn` — `verify: { pid: number; startToken: string; nonce: string }`. DESIGN: "child already dead (IPC
 * disconnect); sweep (pid, startToken) and the nonce in its argv; mark orphaned; plan incarnation+1 of the same
 * attempt." `nonce` is recorded for the orphan-sweep step (5) to match against `argv`, which this port cannot read
 * (`ProcessSweeper` only takes `(pid, startToken)`, DESIGN 4.4 step 5's own wording): this verifier reports whether
 * the child is alive; step 5 (not this verifier) is what actually sweeps and records the nonce match in the report. */
function agentSpawnVerifier(sweeper: ProcessSweeper): EffectVerifier {
  return {
    verify(record: EffectRecord): Promise<Verdict> {
      const payload = asJson(record.verify);
      const pid = num(payload, 'pid');
      const startToken = str(payload, 'startToken');
      if (pid === undefined || !startToken) return Promise.resolve('in-doubt');
      return Promise.resolve(sweeper.isAlive(pid, startToken) ? 'done' : 'not-done');
    },
  };
}

/** `fs.snapshot.materialize` — `verify: { manifestDigest: string }`. DESIGN: "content-addressed: re-put missing
 * blobs, compare digest; mismatch ⇒ refuse (`corruption/snapshot-hash`)". This port set has no `BlobStore` to re-put
 * missing blobs with (D3), so the check this verifier really performs is the digest comparison alone: the intent's
 * recorded `manifestDigest` against the digest the RUN itself stores (`RunRecord.snapshotDigest`, written by the
 * T04 transaction), handed in by whoever builds the registry through `BuiltinVerifierDeps.runSnapshotDigest`. A
 * match is the content-addressed proof DESIGN asks for; a mismatch, and every case where the run's digest is not
 * available, is `in-doubt` rather than a guessed `corruption/*` throw (only the caller, which is mid-recovery and
 * can refuse the whole run, should turn that into a stop). Both operands must come from DIFFERENT producers or the
 * comparison proves nothing — which is why the run's digest is a dependency and not a second field of `verify`. */
function snapshotVerifier(runSnapshotDigest: (() => Sha256 | undefined) | undefined): EffectVerifier {
  return {
    verify(record: EffectRecord, _signal: AbortSignal): Promise<Verdict> {
      void _signal;
      const payload = asJson(record.verify);
      const digest = str(payload, 'manifestDigest');
      const stored = runSnapshotDigest?.();
      if (!digest || stored === undefined) return Promise.resolve('in-doubt');
      return Promise.resolve(digest === stored ? 'done' : 'in-doubt');
    },
  };
}

const BUILTIN_KINDS = [
  'git.branch.create',
  'git.ref.create',
  'git.worktree.add',
  'git.commit',
  'git.merge',
  'git.worktree.reset',
  'provision.command',
  'agent.spawn',
  'fs.snapshot.materialize',
] as const satisfies readonly EffectKind[];

/** Registers the nine built-in verifiers DESIGN 4.1 lists as needing "only ports". Any OTHER kind (the tool
 * effects: `tool.write_file`, `tool.patch_file`, `tool.run_command`, `check.command`, ...) is registered by whoever
 * owns that kind's `perform()` (Wave 2's tools/toolhost units) — this registry answers `undefined` for them, and
 * the resume orchestration treats an unregistered kind as `in-doubt` (never a blind re-execution). A caller that
 * owns more kinds composes them with `{ get: (kind) => builtin.get(kind) ?? theirs.get(kind) }` (and forwards
 * `reExecuted` if it wants `'re-executed'` verdicts to survive the composition). */
export function createBuiltinEffectVerifiers(deps: BuiltinVerifierDeps): BuiltinEffectVerifiers {
  const reExecuted = new Set<EffectId>();
  const table: Readonly<Record<(typeof BUILTIN_KINDS)[number], EffectVerifier>> = {
    'git.branch.create': refVerifier(deps.git),
    'git.ref.create': refVerifier(deps.git),
    'git.worktree.add': worktreeAddVerifier(deps.git),
    'git.commit': commitVerifier(deps.git),
    'git.merge': mergeVerifier(deps.git),
    'git.worktree.reset': worktreeResetVerifier(deps.git),
    'provision.command': provisionVerifier(deps.provisioner, (id) => reExecuted.add(id)),
    'agent.spawn': agentSpawnVerifier(deps.sweeper),
    'fs.snapshot.materialize': snapshotVerifier(deps.runSnapshotDigest),
  };
  return {
    get(kind: EffectKind): EffectVerifier | undefined {
      return (table as Readonly<Record<string, EffectVerifier>>)[kind];
    },
    reExecuted(effectId: EffectId): boolean {
      return reExecuted.has(effectId);
    },
  };
}
