# CLI experience audit

The CLI serves two audiences: a person in a project directory and automation using `--json`.
The JSON commands are a stable explicit interface. A human flow should infer the registered
project, show short results, and ask for decisions only when the necessary evidence is visible.

| Area | Current human flow | Remaining gap |
| --- | --- | --- |
| `doctor`, `auth` | Explicit diagnostics and provider account operations | Responses are mostly raw objects; a short health summary would be easier to scan. |
| `init`, `profile` | Concise discovery, stored profile review/edit/refresh | Discovery is evidence based but does not resolve ownership, contracts, design sources or service setup automatically. |
| `intake`, `status` | Project inferred from the directory; intake prompts and status summary | Intake triage is deterministic and cannot replace a product decision. |
| `brainstorm` | Guided questions and concise synthesis; full brief persisted | The panel runs live, so actual provider access and project context still determine answer quality. |
| Spec preparation and freeze | `spec-freeze-request`, `approve`, `spec-freeze` accept exact files and IDs | There is no guided command to turn a brief into a draft spec, inspect it, answer blocking questions and freeze it. This is the next critical UX gap. |
| Build and delivery | `loop`, `fleet`, `resume`, `pause`, `cancel`, `ship`, `delivery-status` are explicit | Running a feature still needs a frozen spec path, profile path, worktree root, run ID and `--live`. A guided launcher must show the candidate and approval gate before shipping. |
| Patch and maintenance | `patch-spec`, `patch`, `audit`, `refactor`, `retro`, `align-ds-*` are explicit | These expert flows need separate wizards with scope and evidence review; silently inferring write paths or approvals would be unsafe. |
| Integrations and operations | `retrieve`, `design-snapshot`, `kanban-project`, `migrate`, `rpc`, `service`, `schemas`, `check`, `metrics`, `export` remain explicit | These are primarily diagnostic, integration or automation commands. Give them concise human summaries where useful, but keep all protocol and migration inputs explicit. |

The next implementation should focus on `brainstorm → draft spec → freeze → run` using the
stored profile and brief. It must preserve the current approval and frozen-spec checks; the
wizard should collect and display their inputs, not bypass them. Patch and maintenance can follow
as dedicated guided flows. A GUI can use the same persisted profile, artifacts and decisions once
the terminal path works end to end.
