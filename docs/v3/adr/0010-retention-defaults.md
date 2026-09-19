# ADR-0010: Default retention for transcripts, events and costs

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 10
- **Design reference:** DESIGN.md §2.10 (`retention`), §3.5 (transcript), §5.9

## Context

Spec 19 says full transcripts may be heavy and must be compressed, referenced and subject to configurable retention. Durable events are the
audit log and the resume source; they are small and sealed (redacted). Pi transcripts contain raw model output and are the one place where
unredacted *assistant* text lives (tool results reach Pi already sealed).

## Decision

Defaults (all configurable under `retention`, all under the gitignored `.cohorte/state`):

| Data | Default |
|---|---|
| Durable events (incl. token/quota/cost accounting) | `forever` |
| Pi transcripts and host-protocol wire logs (`sensitive`) | 30 days; gzip after 1 day |
| Artifacts (tool outputs, diffs, reports, quarantine patches) | 90 days |
| Ephemeral spool | deleted at run end + 1 day |
| Content-addressed snapshot blobs | kept while any non-purged run references them |

**Owner of the behaviour: `cohorte gc --dry-run|--apply`** (PLAN `U4.05`, test `apps/cli/test/commands-project/gc-retention.test.ts` on a
`FixedClock`). It applies `retention.*`: gzips `sensitive` files older than `compressAfterDays`, deletes transcripts and wire logs older than
`transcriptsDays`, artifacts older than `artifactsDays`, the spool one day after run end; purges event rows only for runs in terminal states
(through `runs.purgeable`, the only path on which the append-only trigger lets event rows go) and removes unreferenced blobs. **It never
touches a file of a non-terminal run.** Compression is gzip (no zstd dependency decision in V3.0).

## Consequences

- A project's audit trail survives by default; its heavy, sensitive material does not.
- Resuming a run never depends on a transcript (V3.0 resumes with fresh incarnations), so transcript expiry cannot break a run.

## Revisit when

- Legal/compliance needs of a user require shorter event retention or export → add redacted export (spec 14 "MAY versionner des événements expurgés").
- Transcript-based continuation is built → transcripts of non-terminal runs must be exempt from expiry.
- DB growth on long-lived projects becomes a problem → archive terminal runs to per-run files.
