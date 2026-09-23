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
| Spec preparation and freeze | `spec` builds a single-surface draft from a stored brief, preserves open questions, and offers exact-hash approval; explicit freeze commands remain available | Multi-surface specs and richer criteria still need the file-based path. |
| Build and delivery | `start` verifies a guided frozen spec and current profile, then asks before launching a live worktree run | Ship remains a separate explicit approval and command; Fleet and expert runs still need explicit paths and IDs. |
| Patch and maintenance | `patch-spec`, `patch`, `audit`, `refactor`, `retro`, `align-ds-*` are explicit | These expert flows need separate wizards with scope and evidence review; silently inferring write paths or approvals would be unsafe. |
| Integrations and operations | `retrieve`, `design-snapshot`, `kanban-project`, `migrate`, `rpc`, `service`, `schemas`, `check`, `metrics`, `export` remain explicit | These are primarily diagnostic, integration or automation commands. Give them concise human summaries where useful, but keep all protocol and migration inputs explicit. |

The next UX step is richer single- and multi-surface spec editing, including multiple scenarios
and acceptance criteria, followed by a guided delivery review. Patch and maintenance can follow
as dedicated guided flows. A GUI can use the same persisted profile, artifacts and decisions.
