# ADR-0018: Pipeline profiles over one state machine, one versioned table per profile

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** brief D6; François requirement R3; spec 11.1
- **Design reference:** DESIGN.md §2.5.1, §2.3.1, §9 (CLI verb semantics)

## Context

François' future sidebar offers `Feature`, `Bugfix`, `Review` and `Current pipeline` entries on any project that has `.cohorte/`. V2 had three
separate entry points (`/cohorte-build`, `/cohorte-patch`, incoming-PR review). Spec 11.1 wants transitions as a versioned code table validated
before persistence, each with from, to, reason, actor, preconditions, effects, idempotencyKey and eventId.

## Decision

1. Three **profiles** — `feature`, `bugfix`, `review` — over the same state set. The protocol `start` command carries `profile`. Because
   this ADR is provisional, the profile is **open on the wire** (an `OpenEnum` with three known values) and `runs.profile` has **no SQL
   `CHECK`**: the known profiles are validated in TypeScript by the table registry, so a fourth profile is a MINOR and not a state migration.
2. **One transition table per profile, versioned per profile** (`feature.v1.ts`, `bugfix.v1.ts`, `review.v1.ts`, `as const`). A run stores
   `(profile, tableVersion)`; tables are append-only files; resuming a run whose table version is not shipped stops with
   `runtime-incompatible`, never a re-interpretation.
3. `bugfix@1` = `feature@1` minus the BRAINSTORM/SPEC entry rows, with `spec.kind = 'patch'` selecting the patch PREFLIGHT contract.
   `review@1` = `IDLE → REVIEW → COMPLETED` on an immutable ref (the verdict is the product), with `REVIEW → FIX → TEST → REVIEW` only when
   started `withFix`.
4. The **review profile is reachable from the CLI**: `cohorte review --ref <rev>` / `--base a --head b`, and `cohorte review <run-id>` over a
   run's integration head.
5. **Totality is tested per table**: every phase outcome has an exit — TEST has three, keyed by the worst check status: passed → REVIEW,
   failed → FIX, **errored (environmental) → FAILED with stop `check-environment` (row T16), never FIX** —, every stop reason maps to one row,
   every `skip` leaves the run able to complete (T33 runs `record-skip` **plus the entry effects of the row it replaces**, and the digest
   guards accept a skip waiver recorded for the same tree digest), and every spec-17.2 command
   (`pause`, `resume`, `retry`, `skip`, `cancel`, `approve`, `deny`) has a row or a defined rejection in every state — `retry` from FAILED,
   `resume --ack` from BLOCKED and `cancel` from IDLE/FAILED/BLOCKED are REQUIRED rows, never "impossible".

## Consequences

- One engine, one reducer, one crash matrix; profiles cost a data file and a PREFLIGHT variant.
- BRAINSTORM and SPEC rows exist but their executors are unavailable in V3.0 (`phase.available = false`).

## Revisit when

- Agentic BRAINSTORM/SPEC are built (V3.1) → enable T01-T03, bump `feature` to v2 if guards change.
- A fourth intent appears (e.g. `refactor`, `audit`) → add a table; if tables start diverging in states, reconsider the single state set.
