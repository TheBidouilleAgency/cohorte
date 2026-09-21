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
| Audit gates + per-domain review | `commands/audit` | workflow tests and `audit-gates.txt` | Gates implemented; domain fan-out/dead-domain reporting still needs native Pi dispatch |
| Refactor backlog execution | `commands/refactor` | refactor tests | Partial; contract authoring and per-surface retry semantics remain |
| Fleet plan/status/sync | `commands/fleet` | workflow tests and `fleet.json` | Implemented; dependency extraction from contracts remains limited |
| Retro pattern mining and ratification | `commands/retro` | workflow tests | Implemented read-only scan and explicit convention write |
| Design-system alignment | `commands/align-ds` | command tests | Filesystem snapshot only; live adapter/token alignment is not configured |
| Ship preflight and release | `commands/ship`, `ship --apply` | CLI typecheck; release flow implementation | Implemented; CI watch and post-merge Kanban verification remain |
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
