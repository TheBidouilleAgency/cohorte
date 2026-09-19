# ADR-0008: Automatic merge — into the run's integration branch only

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 8; brief D9 (merge part)
- **Design reference:** DESIGN.md §5.4, §5.5

## Context

Spec 15 defines merge as an explicit Cohorte operation (base check, tests, conflict detection, application, revalidation, event) and forbids
merging into a protected branch without capability and approval. The open question is whether automatic merging towards a work branch is V3.0.
Porcelain `git merge` runs hooks and needs a working tree; a crash in the middle leaves `MERGE_HEAD`.

## Decision

1. **Merging agent branches into the run's integration branch (`cohorte/<runId>/integration`) is V3.0 and automatic**, under the
   `integration:<runId>` lock, in deterministic agent order.
2. The merge uses **plumbing**: `merge-tree --write-tree` (no working tree) → `commit-tree` → `update-ref` compare-and-swap, journaled as a
   `verifiable` effect. The ownership audit runs again on the merged diff (second enforcement of ownership).
3. A conflict is never resolved or forced by Cohorte: the owning agent gets one "rebase onto integration" task, then the run waits for a human.
4. Revalidation = the TEST phase runs on the new integration head and binds its results to that tree digest; the reviewer ref is minted from it
   and is immutable.
5. **Nothing merges into a user or protected branch in V3.0.** SHIP ends with the integration branch and a ship report.

## Consequences

- The crash window of a merge is one atomic ref update; no hook, no half-merged working tree.
- Git >= 2.38 is required (`doctor` checks).
- The human performs the final merge/PR manually in V3.0.

## Revisit when

- V3.1 introduces the release phase → fast-forward/PR creation under `release-manager` + approval.
- Parallel surfaces conflict often in practice → richer strategies (rebase queues, reservation of shared files) — spec 28 V3.2+.
- A supported platform ships git < 2.38 → add a porcelain fallback with `MERGE_HEAD` recovery.
