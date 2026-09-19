# ADR-0002: Initial state store — SQLite behind an async `StateStore`

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 2; brief D4 (store part)
- **Design reference:** DESIGN.md §2.4, §4

## Context

Spec 20 requires append event, atomic snapshot, read by run, search by sequence, lock and transaction, and says an abstraction must allow a
later file or remote store. `node:sqlite` is Release Candidate (stability 1.2) on Node 24.15+ and its API is synchronous; a synchronous
transaction body cannot be interleaved by an `await`, which removes a class of state-machine races. A fully synchronous `StateStore`
interface, however, cannot be implemented by a remote store.

## Decision

1. V3.0 ships **one durable store: SQLite** (`node:sqlite`, WAL, `synchronous=FULL`, `BEGIN IMMEDIATE` writers, `STRICT` tables, append-only
   triggers on `events`), one file per project at `<main checkout>/.cohorte/state/cohorte.db`, resolved through the git common dir.
2. The `StateStore` contract has an **asynchronous boundary and a synchronous transaction body** (`transact(scope, lease, body)`); the lease's
   fencing token is asserted as the first statement of every write transaction.
3. `MemoryStateStore` is a second, shipped-to-tests implementation; both pass one shared conformance suite delivered complete in Wave 0.
4. Stores are dumb: `core` writes projections explicitly in the same transaction as the events; no store contains a reducer.
5. Spec 14's `state/{events,snapshots,locks}` directories are tables of that file; only artifacts, transcripts, the ephemeral spool and the
   content-addressed blob store are files.
6. `better-sqlite3` behind the same `SqlDriver` seam is the documented fallback.

## Consequences

- One file is the bus between the run host, observers and controllers; observers are lock-free readers and are SIGKILL-safe.
- Events are hash-chained and MAC-anchored (ADR-0022); `doctor --verify-state` rebuilds projections from the log and diffs them.
- A file/remote store remains implementable (optimistic: load aggregate, run the body in memory, compare-and-swap on `runs.version`).
- The DB must live on a local filesystem (`doctor` checks); WAL on network filesystems is unsupported.

## Revisit when

- `node:sqlite` regresses or changes API on a supported Node line → switch the driver to `better-sqlite3`.
- A remote daemon / distributed runs (V3.2+) need a shared store → implement the second durable backend against the same conformance suite.
- Event volume or DB size makes a single file impractical for long-lived projects → add archival of terminal runs (`gc`) or per-run files.
- The human refuses the Node floor of ADR-0017 → `better-sqlite3` becomes the primary driver on Node 22.
