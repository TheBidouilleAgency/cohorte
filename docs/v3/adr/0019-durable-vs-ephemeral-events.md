# ADR-0019: Durable vs ephemeral events; agent events are "Pi-shaped, not Pi-typed"

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** brief D7; François requirements R1, R8, R10; spec 17
- **Design reference:** DESIGN.md §2.3.2, §2.3.3, §2.2.5, §0.1 (C4, C5)

## Context

Spec 17.1's minimum event list has no message streaming, but a cockpit needs agent transcript granularity (message start/delta/end, thinking,
tool progress). Those events are high-volume and must not threaten the state store. François will render Cohorte agents with the components it
builds for direct Pi sessions, yet spec 5.2/17 forbid exposing a raw Pi event or requiring a client to understand Pi.

## Decision

1. Every event type is declared **once**, with its payload schema and its **durability** (`durable` | `ephemeral`), in one catalogue table.
2. The envelope keeps spec 17.1's numeric `sequence` and adds `sub` and `durability`. Durable events own a gapless per-run sequence (`sub = 0`);
   an ephemeral event carries the sequence of the last **committed** durable event and a `sub` counter. Total order = `(sequence, sub)`.
   Because durable events are appended in batches (≤ 50 ms), an ephemeral is **stamped only after the pending batch of its agent has
   committed** (or the batch is flushed first): otherwise deltas of message 2 could sort before `agent.message.completed` of message 1.
3. Durable events go to the hash-chained `events` table inside a fenced transaction, sealed. Ephemeral events go to a bounded per-run spool
   file and to live subscribers; they are never replayed (a late client gets a `snapshot` envelope first) and can never influence run state
   (type-level: the reducer only accepts durable envelopes). Their text is recoverable from the raw transcript.
3b. **Every durable runtime event has a named protocol target, fixed as a table before the freeze** (DESIGN 2.3.3): engine-side refusals
   map to `tool.rejected` (not `tool.denied`: no gate ran), `agent.message.accepted` and `runtime.warning` exist on both sides,
   `agent.paused/resumed` map to `agent.state.changed`, `tool.call.delivered` is folded into `tool.completed.waitedMs`.
4. Agent-level events are **isomorphic to Pi's concept set** (message started/delta/completed, thinking channel, tool requested/progress/
   completed, usage, context) **without importing or exposing a Pi type**. They are declared twice — in `runtime-contract` and in `protocol`,
   which do not import each other — and joined by one total, `satisfies`-checked mapper in `core`.
5. `runtimeRef` (runtime, version, sessionId, transcriptRef) is optional and opaque; clients must never need it.
6. Effect-journal rows are not events: the public catalogue has no `effect.*` type.

## Consequences

- Replay, resume and crash tests are defined over durable events only.
- ~15 agent-level types are declared twice; a unit test enumerates both unions so they cannot drift silently.
- The two frontiers version independently.

## Revisit when

- A client needs replay of streamed text → serve it from the transcript artifact, not by making deltas durable.
- The spool's bounded size loses events clients care about in practice → raise the bound or add back-pressure, not durability.
- François and Cohorte decide to share an agent-event package → revisit the duplication (R10 said this is not a V3.0 goal).
