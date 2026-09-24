# CLI experience audit

The CLI serves two audiences: a person in a project directory and automation using `--json`.
The JSON commands are a stable explicit interface. A human flow should infer the registered
project, show short results, and ask for decisions only when the necessary evidence is visible.

| Area | Current human flow | Remaining gap |
| --- | --- | --- |
| `doctor`, `auth` | Explicit diagnostics and provider account operations | Responses are mostly raw objects; a short health summary would be easier to scan. |
| `init`, `profile` | Concise discovery, stored profile review/edit/refresh | Discovery is evidence based but does not resolve ownership, contracts, design sources or service setup automatically. |
| `intake`, `status` | Project inferred from the directory; intake answers, route and revisions are stored and handed to brainstorm or guided patch preparation | Triage still needs an explicit human route when the source is ambiguous. |
| `brainstorm` | Guided questions, follow-up rounds over linked brief revisions, and concise synthesis; full brief persisted. Each round receives a bounded, cited scan of relevant local source and project notes alongside the stored profile. | The local search is lexical, so agents must inspect full files before asserting behavior or absence. Provider access and project context still determine answer quality. `brief show` reads only the latest revision; history has no human-facing browser yet. |
| Spec preparation and freeze | `spec` asks blocking questions, resumes a draft, supports multiple surfaces, scenarios and criteria, and offers exact-hash approval | A newer brief is attached only after an explicit prompt. Editing an existing scenario or criterion still uses the JSON editor. |
| Build and delivery | `start` verifies a guided frozen spec and current profile, then asks before launching a live worktree run | Ship remains a separate explicit approval and command; Fleet and expert runs still need explicit paths and IDs. |
| Patch and maintenance | `patch-spec --from-intake` guides a bounded patch; `patch`, `audit`, `refactor`, `retro`, `align-ds-*` remain explicit | Maintenance flows need separate wizards with scope and evidence review; write paths and approvals remain explicit. |
| Integrations and operations | `retrieve`, `design-snapshot`, `kanban-project`, `migrate`, `rpc`, `service`, `schemas`, `check`, `metrics`, `export` remain explicit | These are primarily diagnostic, integration or automation commands. Give them concise human summaries where useful, but keep all protocol and migration inputs explicit. |

The connected intake, brainstorm, spec and patch preparation flows are now guided. Editing an
existing scenario or criterion, browsing history, and the expert maintenance and delivery flows
remain separate UX work. A GUI can use the same persisted profile, artifacts and decisions.

The two-round Codex probe on a disposable project is recorded in
[`g5-codex-iterative-brainstorm-darwin-arm64.json`](evidence/g5-codex-iterative-brainstorm-darwin-arm64.json).
It verifies a stored revision link and a changed synthesis, not conversation continuity within a
provider session or parity with the former V2 flow.
