# ADR-0012: Semantic discovery — V3.1; V3.0 `init` and `discover` are deterministic and offline

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 12; brief D10
- **Design reference:** DESIGN.md §9 (rows 12, 13, 21), §2.10

## Context

Spec 12 describes a two-stage `init`: a deterministic scan and a semantic analysis by a read-only agent. The open question is whether the
semantic stage may use a remote provider during `init` or must work offline with a local model. Spec 29's V3.0 criteria need only a minimal
deterministic `init` and `reconcile --plan`; spec 28 places discovery in V3.1.

## Decision

1. V3.0 `cohorte init` and `cohorte discover` run the **deterministic scan only**: no model call, no network. Every Project Model field
   carries its class (`human | generated | derived | observed | mixed`) and provenance; unknowns are listed, never invented.
2. `--semantic` is rejected with `configuration/phase-not-available`.
3. When built (V3.1), semantic discovery runs as an ordinary **read-only agent through the same runtime, gate chain and policy**: it may use a
   remote provider only if the project's `authentication`/`routing` allow it, it is visible in a run plan, and a local model is just another
   `ModelRef` — no special path, no separate data policy.

## Consequences

- `init` is safe to run on any repository with no login and no quota.
- Surfaces and ownership must be written or confirmed by a human in V3.0.

## Revisit when

- V3.1 starts → confirm that "same runtime, same policy" is sufficient, or whether `init` on an untrusted repository needs a stricter profile
  (e.g. mandatory L1 and no tools besides reads).
- A credible local model path through Pi exists → document it as the offline option.
