# ADR-0020: V3.0 binding scope

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** brief D10; spec 28, 29, 30 ("scope V3 trop large")
- **Design reference:** DESIGN.md §9, §7.5 (acceptance), §10

## Context

Spec 28 lists ten V3.0 deliverables; spec 29 lists twelve acceptance bullets, which pull a minimal deterministic `init` and `reconcile --plan`
(drift detection, human overrides never destroyed) into V3.0. Spec 30 names scope as a strong risk. The three design proposals disagreed on
whether the OS sandbox, command authentication, architect/verifier roles, API-key mode and transcript continuation belong in V3.0.

## Decision

**Binding scope = spec 28's V3.0 list + every spec 29 "V3.0 est acceptable quand" bullet.** `tests/acceptance/` holds one executable check per
bullet and is the definition of done. Judged against that rule:

- **In**, because a spec-29 bullet or a spec MUST needs it: L1 OS sandbox (bullet 3, spec 9), HMAC command authentication (spec 17.2, 23),
  provisioning of worktrees (bullets 1 and 10), deterministic `init` / `discover` / conflict-free `reconcile --plan/--apply` with five field classes (bullet 11),
  the real Cohorte-on-Cohorte run as a release gate (bullet 10, spec 32), the review profile from the CLI (D6), five budget levels (spec 10),
  migrations CI (bullet 12).
- **Seam only**: BRAINSTORM/SPEC executors, architect and verifier roles, `git_commit` / `network_request` / `secret_read` tools,
  `summary-with-refs` reduction, the `runRpcMode` host, `Continuation.transcript`, `apps/daemon`, the V2 importer.
- **Implemented but exercised with fakes only**: API-key mode and the Anthropic metered opt-in (policy + accounting + price catalogue).
- **Out**: semantic discovery, multi-provider routing/fallback, `update --apply`, push/PR/release, socket/HTTP transport,
  Windows, packaged binary, skill registry, egress proxy, a shell-script form of `run_command`.
- Roles exercised in V3.0: implementer, fixer, reviewer, security-reviewer; all other role ids are reserved with prompts.

## Consequences

- Everything Pi-, L1- and HMAC-specific sits in leaf units off the critical path; the first spec-29-shaped green state (fake runtime, built
  CLI, kill -9, resume) needs none of them.
- Spec sections marked V3.1 keep their seams typed in Wave 0, so later work does not reopen frozen contracts.

## Revisit when

- A wave gate slips badly → the first candidates to defer are the Linux half of L1 (keep macOS), the brain sandbox, and the metered legs — each
  deferral must be recorded against the acceptance bullet it weakens.
- The human re-prioritises (e.g. wants agentic SPEC in 3.0) → amend this ADR and the acceptance table together.
