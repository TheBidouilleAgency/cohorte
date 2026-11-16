# Pipeline schema — index

The pipeline's rulebook, one file per topic under `<core>/pipeline/schema/` (source:
`profile/schema/`). **Read only the file a step cites — never all of them.** Each prompt names the
exact file it needs (`<core>/pipeline/schema/<file>.md`); this index is for finding one by topic.

| File | Governs | Read it when |
| --- | --- | --- |
| `profile-block.md` | every field of the `yaml pipeline-profile` block, the prose sections, who reads what | writing, topping up or validating `PIPELINE.md` |
| `retrieval.md` | `retrieval.provider` (serena / graphify / none): wiring + the health check | wiring or checking the code-retrieval MCP server |
| `specialization.md` | when to split one surface into several agents; `pipeline-metrics.jsonl` | proposing a new surface or a split |
| `metrics.md` | what's slow vs what's expensive; `/cost`; lead context discipline | tuning cost or reading the metrics |
| `output-discipline.md` | the quiet `*_quiet_cmd` variants and the `tail -40` fallback | running tests/lint as an agent; filling the quiet commands |
| `spec-status.md` | the spec `status` state machine and `kind: patch` | reading or writing a spec's `status` / `kind` |
| `dead-agents.md` | roll call: a silent agent is never a clean result | integrating any parallel fan-out |
| `readiness.md` | the `readiness.json` gate between a frozen spec and N implementers | `/cohorte-build` §1.6, or a driver reading it |
| `deferred.md` | out-of-scope review findings → `specs/refactor-backlog.md` | routing review findings; rewriting the backlog |
| `decisions.md` | the `specs/_decisions.md` journal: who writes it, who reads it | freezing a spec, adding a surface, ratifying a rule |
| `feature-diff.md` | `feature-diff.sh` — the only way the pipeline diffs | reading or digesting what a feature changed |
| `preflight.md` | `preflight.sh` and the `preflight.ok` phase gate | starting a review; the gate's preflight block |
| `rendering.md` | adding/rendering/removing a surface agent (shared procedure) | init, `/cohorte-build` §1.5, reconcile, retro re-render |
| `release-notes.md` | the per-feature release note (`release_notes.*`) | `/cohorte-ship` §2b |
| `reconcile.md` | bringing a repo's generated files up to the current core | `/cohorte-update-pipeline` |
| `workflows.md` | the opt-in Workflow scripts (review / audit / refactor / loop) | running, checking or editing a workflow |
| `project-kinds.md` | `project.kind` presets: detection, per-kind DoD lines, review checks, design step | init 01–02; `/cohorte-spec` §9 defaults; the review agent's kind-specific checks |
| `verify.md` | `/cohorte-verify` (runtime checks, `verify-run.sh`, `verify.json`), migrations + `## Rollback`, `/cohorte-revert` | running the app before ship; a spec with `migrations: true`; reverting a merged feature |
| `kanban.md` | the Obsidian board mirror: config, card format, `kanban-move.sh` | moving a card; linking or backfilling a board |

The parsed machine block itself lives in `<state>/profile.json` (written by `<sync>`, committed): an
agent that needs only the `yaml pipeline-profile` block reads that file, not `PIPELINE.md`.
