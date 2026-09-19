# ADR-0006: Data policy for multi-provider fallback — none in V3.0

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 6
- **Design reference:** DESIGN.md §2.10 (`routing`), §3.8, §9

## Context

Spec 10 allows a provider failure to trigger a retry, a fallback to another already-connected subscription, or a pause, and forbids ever
sending data automatically to a paid API or to a provider that was not authorised. A fallback changes where repository content is sent, which
is a data-residency decision the spec leaves open. V3.0 has one real provider.

## Decision

1. **No automatic cross-provider fallback in V3.0.** A provider failure is: Cohorte-owned visible retry (bounded backoff) → `AUTH_REQUIRED`,
   `QUOTA_EXCEEDED` or `FAILED`.
2. The seam exists: `providers.fallbackCandidates(plan)` returns only already-connected subscriptions listed in `routing.allowedProviders`, and
   is never called unless `routing.fallback.enabled` (default `false`).
3. Never to an API key, never to a provider absent from the run plan, never silently: any future fallback is a durable event and a line of the
   run plan.

## Consequences

- A quota exhaustion pauses the run instead of moving the repository's content to another vendor.
- Multi-provider routing (latency, residency, capability) is V3.1 and will need this ADR replaced by a real policy.

## Revisit when

- A second officially supported subscription provider exists → define the residency/consent policy (per project, per surface?) and enable the seam.
- Users report that quota pauses dominate run time → consider an *attended* fallback (an approval naming the target provider).
