# ADR-0009: Windows — best-effort, not a V3.0 target, never an OS literal in code

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 9
- **Design reference:** DESIGN.md §3.9 (`platforms`), §2.5.1 (guard `runtime.platform-supported`), §11

## Context

Spec 26 targets macOS and Linux and says Windows parity must not be promised before worktrees, signals, permissions and sandbox are validated.
Spec 32 forbids coding an open choice as a hidden invariant. Blocking unknowns on Windows: kill-tree (Job Objects instead of process groups),
worktree path lengths, no sandbox backend, Pi's own assumptions about a POSIX shell environment.

## Decision

1. Windows is **best-effort and not a V3.0 target**: no Windows CI job, no parity claim.
2. **No `process.platform === 'win32'` refusal anywhere.** Support is expressed through capabilities: `PiRuntime.capabilities().platforms.win32
   = { value: 'no', why }`, the executor's `SandboxCapabilities`, and the start guards `runtime.platform-supported` and
   `sandbox.meets-policy`, which fail with `configuration/platform-unsupported` naming the missing capability.
3. `doctor` reports the platform status; read-only verbs and fake-runtime runs are not artificially blocked.

## Consequences

- If a later runtime or executor backend reports Windows support, runs start without touching orchestration code or a published schema.
- Path handling already rejects drive/UNC forms in model-supplied paths; this is a security rule, not a platform refusal.

## Revisit when

- A decision to support Windows is taken (spec 28 lists it under V3.2+) → implement Job Object kill-tree, a sandbox backend, long-path handling,
  add a CI job, flip the capabilities.
- Users demonstrably run Cohorte under WSL2 → document it as the Linux target it is.
