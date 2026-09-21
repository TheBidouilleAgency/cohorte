# V2/V3 workflow parity

This document is the acceptance matrix for the V3 migration. V2 references are kept under
`legacy/v2/core/commands/` and `legacy/v2/core/workflows/`. V3 must preserve the user-visible
workflow semantics while using the durable Pi host, SQLite state store, typed phase contracts and
the configured Pi runtime.

## Acceptance matrix

| V2 capability | V3 implementation | Evidence | State |
| --- | --- | --- | --- |
| Brainstorm seed and structured handoff | `commands/brainstorm`, `BRAINSTORM` phase | `apps/cli/test/commands-project/brainstorm.test.ts`, phase contract tests | Implemented; interactive persona panel still needs runtime-level coverage |
| Spec validation and freeze | `commands/spec validate\|freeze`, Markdown/YAML loaders | `apps/cli/test/commands-project/spec.test.ts` | Implemented |
| Build fan-out by owned surface | `BUILD` phase contracts and selected start surfaces | core phase/executor tests, acceptance run | Implemented |
| Test gate before review | `TEST` phase and check runner | engine and acceptance tests | Implemented |
| Parallel review and typed verdict | `REVIEW` phase, `ReviewResult`, persisted findings | review/core tests and finding projection | Implemented |
| Fix only affected surfaces | `fix` remediation handoff plus `--surfaces` start scope | workflow tests | Implemented as a follow-up run; same-run retry remains to be integrated |
| Loop reducer | `commands/loop/reducer.ts` plus core `LoopController` | workflow and core loop tests | Partially implemented; durable multi-round orchestration remains |
| Treading-water / max-rounds / dead-reviewer stops | typed reducer decisions | reducer tests | Implemented in reducer; needs wiring to durable host rounds |
| Audit gates + per-domain review | `commands/audit` | workflow tests, `audit-gates.txt`, `audit-dispatch.json` | Implemented; each configured domain plus `shared` gets an independent Pi review and dead dispatches are recorded |
| Refactor backlog execution | `commands/refactor` | refactor tests | Partial; contract authoring and per-surface retry semantics remain |
| Fleet plan/status/sync | `commands/fleet` | workflow tests and `fleet.json` | Implemented; dependency extraction from contracts remains limited |
| Retro pattern mining and ratification | `commands/retro` | workflow tests | Implemented read-only scan and explicit convention write |
| Design-system alignment | `commands/align-ds` | command tests, configured `design.live_snapshot_dir` | Implemented for the deterministic filesystem adapter: live source → committed snapshot → UI kit; external design connector remains an optional integration |
| Pipeline update/reconcile | `commands/update-pipeline` | workflow tests, `.cohorte/update-pipeline.json` | Implemented for V3's externally refreshed install: verifies the pinned Pi bundle, then plans/applies project reconciliation with a durable report |
| Ship preflight and release | `commands/ship`, `ship --apply [--watch]` | CLI typecheck; release flow implementation | Implemented through PR creation, Kanban Ship→Shipped mirroring and optional GitHub checks watch; post-merge confirmation/teardown remains human-gated |
| Obsidian Kanban mirroring | `commands/obsidian` and configured card moves | Obsidian command tests | Implemented for configured board moves |

## Completion gate

The migration is complete only when every row is `Implemented`, the remaining partial rows have
native Pi host coverage, and the following checks are green on the PR head:

```sh
pnpm ci:typecheck
pnpm ci:unit
pnpm ci:integration
pnpm ci:e2e
pnpm ci:acceptance
pnpm ci:legacy
```

The `.cohorte/` state directory is local runtime state and must remain uncommitted.
