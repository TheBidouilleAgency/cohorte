# ADR-0025: Recovery model — fresh incarnation, file ledger, checkpoint commits, replay classes; approvals as pre-state-bound grants

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 2.1 ("sans exécuter deux fois une action non idempotente"), spec 11.3, spec 17.2 (pause/approve semantics), spec 24
- **Design reference:** DESIGN.md §4, §2.4 (effects, ledger, approvals DDL), §5.2, §5.8

## Context

The proposals offered three recovery models for an agent whose host died: (X) continue Pi's transcript with a continuation note; (Y) "the
worktree is the transaction": journal nothing per tool call, reset the worktree to the last Cohorte commit, start over; (Z) journal every
effect with a replay class, compare a per-mutation tree digest, quarantine on mismatch. Judges found: X is scope sprawl and Pi repairs orphaned
tool calls with a synthetic result; Y discards paid-for work and can re-issue a non-idempotent command; Z as written compared digests *before*
reconciling open intents, so a crash between a write and its `done` wiped earlier journaled writes while the journal still called them done,
and a per-mutation tree digest is expensive. Approvals executed as "durable continuations" with no live requester could act on a state the
human never saw.

## Decision

1. **Journal every effect**: `intent → effect → done`, fenced, with an idempotency key, a **replay class** (`idempotent` | `verifiable` |
   `at-most-once`) and a kind-specific verifier. `at-most-once` effects are never re-executed: they become `in-doubt` and are surfaced.
2. **File ledger instead of per-call tree digests**: each done write (and each command's post-scan) records `path → sha256` for the slot since
   the last Cohorte commit. Recovery **reconciles open intents first**, then audits: the dirty set must equal the ledger, path by path.
   Explained ⇒ the work is kept. Unexplained with an in-doubt/interrupted command in that slot ⇒ quarantine (patch artifact) + journaled reset
   to the checkpoint, and every effect after the checkpoint is marked `compensated` in the same transaction. Unexplained otherwise ⇒
   `unexpected-repo-change` ⇒ BLOCKED. Tree digests remain for phase-level binding (checks, review ref, ship).
3. **Checkpoint commits, explicit cadence**: at agent completion; at park, pause, suspension, failure and graceful shutdown; and immediately
   before any `at-most-once` command — so a reset can lose only that command's own writes.
4. **Fresh incarnation + reconciliation note**: V3.0 never resumes a transcript (`continuationFromTranscript: no`). The note is built after
   recovery and describes the post-recovery tree: executed calls with results, compensated work, in-doubt commands, approval outcomes. Host
   restarts do not consume retry attempts but count against `maxIncarnations`.
5. **Resolving an approval never executes anything by itself.** A resolution mints a grant keyed by `sha256(tool | normalised call |
   pre-state binding)`; `allow-once` is consumed inside the intent transaction of the matching effect. The binding is the target's
   `beforeSha256` for write/patch and **the slot's content-addressed tree digest for a command — never `(checkpoint_sha, ledger digest)`**:
   parking makes a checkpoint commit, which moves the sha and clears the ledger, so that binding could never match again and every human
   answer slower than `parkAfterMinutes` would be wasted; the tree digest survives a commit of identical content.
6. **If the requester is gone, the host replays the approved call** when the agent's next incarnation is about to start: stages 1-5 run
   again on the stored normalised call, the binding is recomputed, and only if the grant key still matches does the call execute — as a
   journaled effect under the original `toolCallId` and idempotency key, consuming the grant in its intent transaction. The result goes
   into the reconciliation note like any call that completed before the brain died. If the binding changed, nothing executes, the approval
   is `superseded`, the note says so, and a re-issued call opens a new ask. This revises the earlier "tell the model to re-issue" rule:
   matching a grant by re-emission needs a byte-identical normalised call (for `write_file`, the whole content), which made approval
   liveness depend on prompt compliance — control logic in a note (spec principle 5). The objection that rejected "durable continuation"
   (acting on a state the human never saw) is exactly what the re-checked binding detects, so it does not apply to a *bound* replay.
7. **Reincarnation is not a retry.** Recovery, a parked approval and an expired pause re-spawn the agent through the lifecycle edges
   `spawning | running | waiting | paused → spawning` with a cause (`recovery | park | pause-expiry`): incarnation+1, attempt unchanged.
   `attempt` is incremented only by `failed → retrying | escalated`.

## Consequences

- No journaled-done write can be silently lost; no non-idempotent command can run twice; no approval applies to a state the human did not see.
- More rows (effects, ledger) than model Y, far fewer git operations than model Z.
- An in-doubt command may need a human acknowledgement (`policy.inDoubt: ask`, default).
- An approved call is executed at most once, by the live requester or by the host replay, and only against the state the human saw.
- The per-ask cost of a tree digest (at ask time and at consumption) is accepted: asks are rare.

## Revisit when

- Quota cost of fresh incarnations is high in practice → build transcript continuation behind the existing `Continuation.transcript` seam.
- In-doubt acknowledgements annoy users on commands that are in fact idempotent → improve rule metadata (`replay: idempotent`) rather than
  weakening the rule.
- Ledger audits are slow on huge dirty sets → hash incrementally at write time (already the case for tool writes) and cap command post-scans.
