# ADR-0013: Licence and telemetry for public distribution

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 13
- **Design reference:** DESIGN.md §1.4, §2.10 (`telemetry`), §11

## Context

Cohorte is published today as one npm package under AGPL-3.0-only with OIDC provenance. Spec 31 leaves the licence scheme and the opt-in
telemetry policy open; spec 32 forbids freezing an open choice as a hidden invariant (for instance as a literal type in a published schema).

## Decision

1. **AGPL-3.0-only**, one npm package `cohorte`, as today. Third-party code is never inlined in the bundle (`deps.onlyBundle: []`), so no
   notice aggregation is needed; Pi and the other runtime dependencies stay regular dependencies.
2. `publish.yml` keeps its filename and environment (npm trusted publishing is bound to both).
3. **No data leaves the machine in V3.0.** Metrics are local durable events. The config schema has `telemetry.remote: boolean` (default
   `false`) — **not** a literal `false` — and V3.0 rejects `true` with `configuration/telemetry-remote-unavailable`.
4. Pi's own telemetry and version checks are disabled in the child (`PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`, `PI_OFFLINE=1`,
   `enableInstallTelemetry: false`). `update --check` is offline in V3.0.

## Consequences

- A future opt-in telemetry sink needs no schema break, only behaviour and a privacy document.
- AGPL constrains embedding Cohorte in proprietary products; the protocol (JSON Schema) is the integration surface for other clients.

## Revisit when

- A commercial or dual-licensing need appears → decide with the copyright holder; nothing in the architecture depends on the licence.
- The maintainers want usage data → define the opt-in, the payload (never repository content, never prompts), and the sink.
