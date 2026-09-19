// U1.10 — DESIGN 4.1's effect-kind table: the nine built-in verifiers, tested directly against the registry
// `createBuiltinEffectVerifiers` returns (no `recover()` involved: this is the "replay classes" test bullet's
// per-kind half — "idempotent re-executes, verifiable probes three ways (done / redo / in-doubt)").
import type { Sha256 } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import { createBuiltinEffectVerifiers } from '../../src/resume/verifiers.ts';
import {
  canonicalPath,
  effectId2,
  effectRecord,
  fakeGitPort,
  fakeProvisioner,
  fakeSweeper,
  sealForTest,
  sha256Of,
} from './support.ts';

const SHA_X = 'x'.repeat(40);
const SHA_Y = 'y'.repeat(40);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);
const signal = new AbortController().signal;

describe('git.commit — verifiable, trailer-based', () => {
  test('trailer found ⇒ done', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({ commits: { 'agent/x:eff_1': SHA_X } }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('1'),
      kind: 'git.commit',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', branch: 'agent/x', key: 'eff_1' }),
    });
    await expect(registry.get('git.commit')?.verify(record, signal)).resolves.toBe('done');
  });

  test('trailer absent ⇒ not-done (content-idempotent: safe to redo)', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({ commits: {} }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('2'),
      kind: 'git.commit',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', branch: 'agent/x', key: 'eff_2' }),
    });
    await expect(registry.get('git.commit')?.verify(record, signal)).resolves.toBe('not-done');
  });

  test('missing verify data ⇒ in-doubt, never a guess', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort(),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('3'),
      kind: 'git.commit',
      replayClass: 'verifiable',
      verify: sealForTest({}),
    });
    await expect(registry.get('git.commit')?.verify(record, signal)).resolves.toBe('in-doubt');
  });
});

describe('git.merge — verifiable, CAS head', () => {
  test('head carries the trailer ⇒ done', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({ commits: { 'main:eff_m1': SHA_Y } }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('m1'),
      kind: 'git.merge',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', into: 'main', key: 'eff_m1', expectedOldHead: SHA_X }),
    });
    await expect(registry.get('git.merge')?.verify(record, signal)).resolves.toBe('done');
  });

  test('head == expected old ⇒ not-done (redo)', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({
        worktrees: [{ path: canonicalPath('/repo/main'), branch: 'main', head: SHA_X, locked: false }],
      }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('m2'),
      kind: 'git.merge',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', into: 'main', key: 'eff_m2', expectedOldHead: SHA_X }),
    });
    await expect(registry.get('git.merge')?.verify(record, signal)).resolves.toBe('not-done');
  });

  test('head is neither the trailer nor the old sha ⇒ in-doubt (a third party moved the ref)', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({
        worktrees: [{ path: canonicalPath('/repo/main'), branch: 'main', head: 'z'.repeat(40), locked: false }],
      }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('m3'),
      kind: 'git.merge',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', into: 'main', key: 'eff_m3', expectedOldHead: SHA_X }),
    });
    await expect(registry.get('git.merge')?.verify(record, signal)).resolves.toBe('in-doubt');
  });
});

describe('git.worktree.add — verifiable, exact worktree-list match', () => {
  test('registered with the expected branch ⇒ done', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({
        worktrees: [{ path: canonicalPath('/repo/.cohorte/w1'), branch: 'agent/w1', head: SHA_X, locked: false }],
      }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('w1'),
      kind: 'git.worktree.add',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', path: '/repo/.cohorte/w1', branch: 'agent/w1' }),
    });
    await expect(registry.get('git.worktree.add')?.verify(record, signal)).resolves.toBe('done');
  });

  test('not registered ⇒ not-done', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({ worktrees: [] }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('w2'),
      kind: 'git.worktree.add',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', path: '/repo/.cohorte/w2', branch: 'agent/w2' }),
    });
    await expect(registry.get('git.worktree.add')?.verify(record, signal)).resolves.toBe('not-done');
  });
});

describe('git.worktree.reset — idempotent, HEAD + clean', () => {
  test('HEAD at checkpoint and clean ⇒ done', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({
        worktrees: [{ path: canonicalPath('/repo/.cohorte/w1'), branch: 'agent/w1', head: SHA_X, locked: false }],
        changedPathsBySlot: {},
      }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('r1'),
      kind: 'git.worktree.reset',
      replayClass: 'idempotent',
      verify: sealForTest({ repo: '/repo', path: '/repo/.cohorte/w1', checkpointSha: SHA_X }),
    });
    await expect(registry.get('git.worktree.reset')?.verify(record, signal)).resolves.toBe('done');
  });

  test('HEAD at checkpoint but dirty ⇒ not-done', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({
        worktrees: [{ path: canonicalPath('/repo/.cohorte/w1'), branch: 'agent/w1', head: SHA_X, locked: false }],
        changedPathsBySlot: { '/repo/.cohorte/w1': 2 },
      }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('r2'),
      kind: 'git.worktree.reset',
      replayClass: 'idempotent',
      verify: sealForTest({ repo: '/repo', path: '/repo/.cohorte/w1', checkpointSha: SHA_X }),
    });
    await expect(registry.get('git.worktree.reset')?.verify(record, signal)).resolves.toBe('not-done');
  });
});

describe('provision.command — idempotent, marker via Provisioner.ensure', () => {
  test('ensure() reused ⇒ done (marker was already there)', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort(),
      provisioner: fakeProvisioner('reused'),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('p1'),
      kind: 'provision.command',
      replayClass: 'idempotent',
      slot: 'w1',
      verify: sealForTest({ slot: 'w1' }),
    });
    await expect(registry.get('provision.command')?.verify(record, signal)).resolves.toBe('done');
  });

  test('ensure() fresh ⇒ done AND flagged re-executed: the probe itself re-provisioned', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort(),
      provisioner: fakeProvisioner('fresh'),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('p2'),
      kind: 'provision.command',
      replayClass: 'idempotent',
      slot: 'w1',
      verify: sealForTest({ slot: 'w1' }),
    });
    // `'not-done'` here would make the resume orchestration record `failed(interrupted)` and provision a THIRD
    // time: `ensure()` already did the re-run DESIGN 4.1 prescribes for an `idempotent` effect.
    await expect(registry.get('provision.command')?.verify(record, signal)).resolves.toBe('done');
    expect(registry.reExecuted(effectId2('p2'))).toBe(true);
  });

  test('ensure() reused is NOT flagged re-executed: nothing ran', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort(),
      provisioner: fakeProvisioner('reused'),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('p3'),
      kind: 'provision.command',
      replayClass: 'idempotent',
      slot: 'w1',
      verify: sealForTest({ slot: 'w1' }),
    });
    await expect(registry.get('provision.command')?.verify(record, signal)).resolves.toBe('done');
    expect(registry.reExecuted(effectId2('p3'))).toBe(false);
  });
});

describe('agent.spawn — verifiable, liveness by (pid, startToken)', () => {
  test('child alive ⇒ done', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort(),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(new Set(['100:tok'])),
    });
    const record = effectRecord({
      effectId: effectId2('s1'),
      kind: 'agent.spawn',
      replayClass: 'verifiable',
      verify: sealForTest({ pid: 100, startToken: 'tok', nonce: 'n1' }),
    });
    await expect(registry.get('agent.spawn')?.verify(record, signal)).resolves.toBe('done');
  });

  test('child dead ⇒ not-done (sweep, reincarnate)', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort(),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('s2'),
      kind: 'agent.spawn',
      replayClass: 'verifiable',
      verify: sealForTest({ pid: 100, startToken: 'tok', nonce: 'n2' }),
    });
    await expect(registry.get('agent.spawn')?.verify(record, signal)).resolves.toBe('not-done');
  });
});

describe('fs.snapshot.materialize — idempotent, content-addressed digest compare', () => {
  /** The two operands come from DIFFERENT producers on purpose: the intent's `manifestDigest` (written by whoever
   * started the materialisation) against the run row's own `snapshotDigest`, handed in as a dependency. Reading
   * both out of the same sealed intent payload would compare a value with itself and verify nothing. */
  function snapshotRegistry(runSnapshotDigest?: Sha256) {
    return createBuiltinEffectVerifiers({
      git: fakeGitPort(),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
      runSnapshotDigest: () => runSnapshotDigest,
    });
  }

  test('the intent digest equals the RUN`s stored snapshot digest ⇒ done', async () => {
    const record = effectRecord({
      effectId: effectId2('f1'),
      kind: 'fs.snapshot.materialize',
      replayClass: 'idempotent',
      verify: sealForTest({ manifestDigest: SHA_D }),
    });
    await expect(
      snapshotRegistry(sha256Of(SHA_D)).get('fs.snapshot.materialize')?.verify(record, signal),
    ).resolves.toBe('done');
  });

  test('digest mismatch ⇒ in-doubt (never guessed corrupt or fine)', async () => {
    const record = effectRecord({
      effectId: effectId2('f2'),
      kind: 'fs.snapshot.materialize',
      replayClass: 'idempotent',
      verify: sealForTest({ manifestDigest: SHA_D }),
    });
    await expect(
      snapshotRegistry(sha256Of(SHA_E)).get('fs.snapshot.materialize')?.verify(record, signal),
    ).resolves.toBe('in-doubt');
  });

  test('no run digest available ⇒ in-doubt: there is nothing to compare against', async () => {
    const record = effectRecord({
      effectId: effectId2('f3'),
      kind: 'fs.snapshot.materialize',
      replayClass: 'idempotent',
      verify: sealForTest({ manifestDigest: SHA_D }),
    });
    await expect(snapshotRegistry().get('fs.snapshot.materialize')?.verify(record, signal)).resolves.toBe('in-doubt');
  });
});

describe('git.branch.create / git.ref.create — verifiable, worktree-branch-only reads (D4)', () => {
  test('branch present at the target sha ⇒ done', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({
        worktrees: [
          { path: canonicalPath('/repo/.cohorte/w1'), branch: 'refs/cohorte/review/1', head: SHA_X, locked: false },
        ],
      }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('b1'),
      kind: 'git.branch.create',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', ref: 'refs/cohorte/review/1', targetSha: SHA_X }),
    });
    await expect(registry.get('git.branch.create')?.verify(record, signal)).resolves.toBe('done');
  });

  test('a bare ref outside any worktree cannot be read through GitPort ⇒ in-doubt, not a guess (D4)', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({ worktrees: [] }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('b2'),
      kind: 'git.ref.create',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', ref: 'refs/cohorte/r1/review/1', targetSha: SHA_X }),
    });
    // NOT `not-done`: absence from `facts().worktrees` is not proof the ref is absent from the repository, and
    // `not-done` would have the caller re-execute the ref-create blindly (DESIGN 4.1: "elsewhere ⇒ conflict").
    await expect(registry.get('git.ref.create')?.verify(record, signal)).resolves.toBe('in-doubt');
  });

  test('a worktree branch parked at another sha ⇒ in-doubt (the DESIGN table`s "conflict")', async () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort({
        worktrees: [{ path: canonicalPath('/repo/.cohorte/w1'), branch: 'agent/w1', head: SHA_Y, locked: false }],
      }),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    const record = effectRecord({
      effectId: effectId2('b3'),
      kind: 'git.branch.create',
      replayClass: 'verifiable',
      verify: sealForTest({ repo: '/repo', ref: 'agent/w1', targetSha: SHA_X }),
    });
    await expect(registry.get('git.branch.create')?.verify(record, signal)).resolves.toBe('in-doubt');
  });
});

describe('an unregistered kind is not in the built-in table', () => {
  test('get() answers undefined for a tool effect (owned by a different unit)', () => {
    const registry = createBuiltinEffectVerifiers({
      git: fakeGitPort(),
      provisioner: fakeProvisioner(),
      sweeper: fakeSweeper(),
    });
    expect(registry.get('tool.write_file')).toBeUndefined();
  });
});
