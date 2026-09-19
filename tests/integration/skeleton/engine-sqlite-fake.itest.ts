// Gate G1 — walking skeleton (a): the real `RunEngine` + `EffectJournal` + `EventWriter` + `Resumer` +
// `SqliteStateStore` (a temp FILE, not `:memory:`) + `FakeRuntime`, wired as a composition root would wire them.
//
// A toy `PhaseExecutor` spawns ONE fake agent; its single tool call is journaled by a trivial `ToolHost`. The run is
// first recorded unarmed (the golden run), then re-run once per `(crashpoint, occurrence)` the golden run hit: the
// host is killed there (FaultInjector, DESIGN 4.3) and a SECOND host resumes. Every case must reach the golden run's
// final state, with exactly ONE EXECUTION of the effect (not merely one row), a gapless event sequence, a lifecycle
// event stream identical to the golden run's, and a chain + anchors that verify.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  armedInjector,
  type CrashHit,
  effectsByKey,
  eventTypes,
  HOST_A,
  HOST_B,
  lifecycleSpine,
  lockStolenPayloads,
  openSkeleton,
  PROJECT_KEY,
  recordingInjector,
  type Skeleton,
  seedIdleRun,
  signedStart,
  WRITTEN_FILE,
  WRITTEN_TEXT,
  withInjector,
} from './support.ts';

/** The one shape every case must end in — the golden run's own, asserted the same way whether or not a crash
 * happened on the way there. */
async function expectSettled(skeleton: Skeleton): Promise<string[]> {
  const run = await skeleton.store.getRun(skeleton.runId);
  expect(run?.state).toBe('COMPLETED');

  // Exactly one effect row per idempotency key, and it is `done` (I4.1: the same key never executes twice).
  const byKey = await effectsByKey(skeleton.store, skeleton.runId);
  expect([...byKey.keys()]).toHaveLength(1);
  for (const [key, rows] of byKey) {
    expect(`${key}: ${rows.length} row(s)`).toBe(`${key}: 1 row(s)`);
    expect(rows[0]?.state).toBe('done');
  }

  // Gapless: the journal assigns sequence = last + 1, so 1..n with no hole and no duplicate.
  const events = await skeleton.store.readEvents(skeleton.runId, { afterSequence: 0, limit: 1000 });
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(run?.lastSequence).toBe(events.length);

  // The hash chain and the anchor MACs (the anchors are keyed by the project key, DESIGN 2.6.7).
  const chain = await skeleton.store.verifyChain(skeleton.runId, PROJECT_KEY);
  expect(chain).toMatchObject({ ok: true });
  expect(chain.ok && chain.events).toBe(events.length);

  return await eventTypes(skeleton.store, skeleton.runId);
}

/** The golden run, recorded ONCE: the `(point, occurrence)` pairs it hit, and the shape of the stream it left.
 * `vitest` needs the crash table before it collects, so this runs in a module-level await. */
const GOLDEN: { hits: CrashHit[]; types: string[]; spine: string[] } = await (async () => {
  const skeleton = await openSkeleton();
  try {
    await seedIdleRun(skeleton);
    await skeleton.store.enqueueCommand(signedStart(skeleton));
    const hits: CrashHit[] = [];
    await withInjector(recordingInjector(hits), () => skeleton.runHost(HOST_B));
    const types = await eventTypes(skeleton.store, skeleton.runId);
    return { hits, types, spine: lifecycleSpine(types) };
  } finally {
    await skeleton.close();
  }
})();

describe('walking skeleton (a): engine x journal x REAL SQLite x FakeRuntime', () => {
  it('the golden run reaches COMPLETED, journaling the agent’s one tool call exactly once', async () => {
    const skeleton = await openSkeleton();
    try {
      await seedIdleRun(skeleton);
      await skeleton.store.enqueueCommand(signedStart(skeleton));

      const hits: CrashHit[] = [];
      const stop = await withInjector(recordingInjector(hits), () => skeleton.runHost(HOST_B));

      expect(stop.reason).toBe('review-clean');
      expect(skeleton.toolCalls).toEqual([{ toolCallId: 'tc_1_1', status: 'done' }]);
      // The effect's `perform()` ran once, counted at its first statement — the claim `toolCalls` cannot make.
      expect(skeleton.performs).toBe(1);
      const types = await expectSettled(skeleton);

      // An unarmed run is deterministic: the recorded golden stream below is the same stream, event for event. Every
      // crash case is measured against it, so a golden run that drifted would quietly weaken all eight.
      expect(types).toEqual(GOLDEN.types);

      // The other end of the counts every crash case pins. `run.resumed` is NOT "only a resumed run has it": the
      // engine calls `recover()` unconditionally (G1-D1), so one host incarnation is one `run.resumed`, and the
      // unarmed run has exactly one. `lock.stolen`, on the other hand, needs a dead owner — so none here.
      expect(types.filter((type) => type === 'run.resumed')).toHaveLength(1);
      expect(types.filter((type) => type === 'lock.stolen')).toHaveLength(0);

      // The recording injector is the one that makes "a declared point never hit fails the suite" checkable at all:
      // this skeleton must genuinely reach the journal's and the engine's crash points.
      const points = new Set(hits.map((hit) => hit.point));
      expect([...points].sort()).toEqual(
        [
          'checkpoint.after-events-before-snapshot',
          'host.after-lease',
          'tool.after-done',
          'tool.after-effect',
          'tool.after-intent',
          'transition.after-commit',
          'transition.before-commit',
        ].sort(),
      );
    } finally {
      await skeleton.close();
    }
  });
});

describe('killed at every commit, then resumed by a second host', () => {
  it('the golden run hit at least one crash point of each of the engine and the journal', () => {
    expect(GOLDEN.hits.length).toBeGreaterThan(5);
  });

  for (const hit of GOLDEN.hits) {
    it(`killed at ${hit.point}#${hit.occurrence}: host B resumes to the same final state`, async () => {
      const skeleton = await openSkeleton();
      try {
        await seedIdleRun(skeleton);
        await skeleton.store.enqueueCommand(signedStart(skeleton));

        // Host A dies exactly there. A `SimulatedCrash` stands for the process being gone: nothing after that point
        // in `run()` may execute, so the lease is NOT released and the run row is left mid-flight.
        await withInjector(armedInjector(hit), async () => {
          await expect(skeleton.runHost(HOST_A)).rejects.toThrow(/simulated crash/i);
        });

        // MEASURED, not assumed: the dead host's run lock is still there, with host A's identity on it. This is the
        // premise of every line below and of DESIGN 4.3 crash point #2 — and it was FALSE until fix round 2. A
        // `finally` runs even when the `catch` around it rethrows, so `run()`'s outer one released the lease of the
        // host the crash had just "killed"; host B then found a FREE lock and the takeover branch had zero coverage
        // in all eight cases, while the gate claimed the opposite. Raised by the U1.INT reviewer (G1 §4).
        const orphaned = await skeleton.store.listLocks({ scope: 'run' });
        expect(orphaned.map((lock) => `${lock.ownerHostId}/${lock.ownerPid}/${lock.ownerStartToken}`)).toEqual([
          `${HOST_A.hostId}/${HOST_A.pid}/${HOST_A.startToken}`,
        ]);
        const fencingTokenOfTheDead = orphaned[0]?.fencingToken;

        // Host B is a NEW process (the sweeper reports host A dead): its `Resumer` takes the run lease over and the
        // engine carries the run the rest of the way.
        const stop = await skeleton.runHost(HOST_B);
        expect(stop.reason).toBe('review-clean');
        const types = await expectSettled(skeleton);

        // THE property the whole matrix exists to prove (I4.1): the effect body executed exactly ONCE across host A
        // and host B, whichever side ran it. Counting `journal.run` OUTCOMES cannot say this — a host killed inside
        // the effect reports none, and a host that wrongly re-performed a `done` effect reports the same single
        // `'done'` as one that performed it for the first time. `performs` is incremented at `perform()`'s first
        // statement, so a second execution is visible even if it crashes half-way.
        expect(skeleton.performs).toBe(1);

        // The takeover itself, which is what the orphaned lock above exists to make possible: host B's `Resumer`
        // stole a lease held by a dead `(pid, startToken)` after its liveness check, and fenced it — `fencingToken`
        // + 1, exactly DESIGN 4.3 crash point #2's right-hand column. Counted (and read out of the durable row's own
        // payload) rather than assumed: `lock.stolen` is excluded from `lifecycleSpine` because it is genuinely
        // resume-only, not because it is unobserved.
        expect(types.filter((type) => type === 'lock.stolen')).toHaveLength(1);
        const stolen = await lockStolenPayloads(skeleton.store, skeleton.runId);
        expect(stolen[0]).toMatchObject({
          scope: 'run',
          key: skeleton.runId,
          mode: 'exclusive',
          owner: HOST_B.hostId,
          fencingToken: (fencingTokenOfTheDead ?? Number.NaN) + 1,
        });

        // Recovery's own report, one per HOST INCARNATION (`run()` calls `recover()` unconditionally — G1-D1): host
        // A's and host B's. The golden run has one. Measured by the U1.INT reviewer; the docblock of
        // `NON_STATE_EVENT_TYPES` used to say "only a resumed run has them", which was simply wrong.
        expect(types.filter((type) => type === 'run.resumed')).toHaveLength(2);

        // And the stream says the same thing: the tool call was requested (once, or twice when the crash landed
        // before it ever ran and the next incarnation re-issued under the same key) and completed exactly once —
        // never a second `tool.completed` for one `toolCallId` — EXCEPT for the one case that legitimately has none:
        // a crash inside the effect window leaves an `intent` that `Resumer` reconciles to `done`, so the host that
        // would have emitted `tool.completed` never ran and the replaying one must not invent it (U1.10 D3). Named
        // here rather than allowed everywhere, and filed as an obligation on the units that CONSUME the stream
        // (G1 §3, `docs/v3/requests/U1.INT.md` R8): a tool call is paired on its EFFECT row, not on the event pair.
        expect(types.filter((type) => type === 'tool.requested').length).toBeGreaterThanOrEqual(1);
        expect(types.filter((type) => type === 'tool.requested').length).toBeLessThanOrEqual(2);
        expect(types.filter((type) => type === 'tool.completed')).toHaveLength(
          hit.point === 'tool.after-effect' ? 0 : 1,
        );

        // A checkpoint is an optimisation (DESIGN 4.3 row 18), so a host killed after the last transition may leave
        // a COMPLETED run with none — but never with two for one run.
        expect(types.filter((type) => type === 'checkpoint.created').length).toBeLessThanOrEqual(1);

        // "Same final state" for the run itself: outside the rows a crash may legitimately change, the resumed run's
        // event stream is the golden run's, event for event, in order. This is what catches a phase re-entered after
        // it completed or a `start` accepted twice — neither of which the per-row invariants above can see, because
        // appending extra events is perfectly legal.
        expect(lifecycleSpine(types)).toEqual(GOLDEN.spine);

        // And the work itself survived: whichever host wrote it, the file is there, with the content the intent's
        // own `verify` names.
        expect(readFileSync(join(skeleton.dir, 'work', WRITTEN_FILE), 'utf8')).toBe(WRITTEN_TEXT);
      } finally {
        await skeleton.close();
      }
    });
  }
});
