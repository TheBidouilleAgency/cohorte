# ADR-0004: François transport — NDJSON only, detached run host, durable command inbox

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 4; brief D5; François requirements R1, R2, R4, R5
- **Design reference:** DESIGN.md §2.3, §4.7

## Context

Spec 17 lists NDJSON over stdin/stdout, a Unix socket and optional HTTP/WebSocket, and leaves the exact transport open while requiring
identical envelopes and semantics. François today can only do one-shot, read-only, stdin-closed spawns of a bare `cohorte` binary (10 s,
4 MiB) plus a raw-text log tail; its future is a Pi-based desktop client. Spec 18 says a François crash must not stop a run.

## Decision

1. **NDJSON framing only** in V3.0. No HTTP, no WebSocket, no long-lived stdin session.
2. A run is owned by a **detached run host**. `cohorte run` always hands the run to it and becomes an observer; `--detach` returns the run id
   within 2 s; `--foreground` is an explicit flag for CI and tests.
3. **Observers** (`status --json`, `logs|tail --follow --since-seq N`) are pure readers of the event store with replay from a sequence; they
   hold no lock, write nothing, and are SIGKILL-safe. The first line of every stream is a `snapshot` envelope (R2 tree document).
4. **Control** = one-shot idempotent CLI commands (`commandId`) written to a durable, MAC-authenticated command inbox in the state store
   (ADR-0022); a poke file is a wake-up hint only. Controllers wait at most 8 s by default and return "pending" rather than fail.
4b. Because one-shot CLI spawns are the only transport, **every spec-17.2 command type has a CLI verb** (`inspect`, `shutdown`, `run-tool`
   and `send` included; the last two answer "not available" unless policy enables them) and **every `--json` output has a published
   schema** (`InspectDocument`, `RunDiffDocument`, `CommandResultDocument`, `DoctorReport`, `AuthStatusDocument`, `ReconcilePlan`, next to
   the two status documents). Read-only commands (`status`, `inspect`, `tail`, `reconcile --plan`) emit **no result event**: a SIGKILL-safe
   pure reader writes nothing (deviation D-23); their result is the document itself. A process that *waits* for a run (`run`, `--wait`)
   exits with a code that reflects the outcome (0 / the error class code / 4 suspended / 16 cancelled); plain readers exit 0.
   `Actor.transport` is an open enum whose only known value in V3.0 is `cli`: `stdin` and `socket` are not promised by the wire schema.
5. `--panel` and `--format=line` adapters keep today's François panels working; they are presentation, not protocol. Every human-facing
   string is sanitised of C0/C1 control characters in one place (DESIGN 2.3.6): agent-controlled text must not rewrite an approval prompt.
6. Durable and ephemeral events share one envelope with `(sequence, sub, durability)` (ADR-0019).

## Consequences

- The most constrained client (one-shot spawns under 10 s) and a future long-lived client use the same semantics.
- No second transport and none of its failure modes in V3.0; polling an indexed table every 250 ms is the cost.
- A Unix socket carrying the same frames can arrive with the V3.1 daemon without changing envelopes.

## Revisit when

- François (Pi-based) needs sub-100 ms streaming latency or push notifications that polling cannot give → add the socket transport.
- A remote daemon or distributed runs are scheduled (V3.2+) → define HTTP/WebSocket over the same envelopes.
- Inbox polling shows measurable cost on large stores → make the socket poke mandatory instead of optional.
