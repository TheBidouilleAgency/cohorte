# CLI experience audit

The CLI serves two audiences: a person in a project directory and automation using `--json`.
The JSON commands are a stable explicit interface. A human flow should infer the registered
project, show short results, and ask for decisions only when the necessary evidence is visible.

| Area | Current human flow | Remaining gap |
| --- | --- | --- |
| `doctor`, `auth` | Explicit diagnostics and provider account operations | Responses are mostly raw objects; a short health summary would be easier to scan. |
| `init`, `profile` | Read-only discovery preview, detected project description, surface roles, package-level checks and contract candidates; stored profile review/edit/refresh | Shared ownership, migrations, design sources and service setup still require human verification. |
| `intake`, `status` | Project inferred from the directory; read-only agent triage proposal with source and repository context; route and revisions are stored and handed to brainstorm or guided patch preparation | Triage still needs an explicit human route when the source is ambiguous. |
| `brainstorm` | Starts from the idea, then a project-configured panel proposes focused questions and business/code options over linked brief revisions. Each round receives a bounded, cited repository scan and project overview. | The local search is lexical, so agents must inspect full files before asserting behavior or absence. Provider-live quality has not been qualified for this change. `brief show` reads only the latest revision. |
| Spec preparation and freeze | `spec` asks blocking questions, resumes a draft, supports multiple surfaces, scenarios and criteria, and offers exact-hash approval | A newer brief is attached only after an explicit prompt. Editing an existing scenario or criterion still uses the JSON editor. |
| Build and delivery | `start` verifies a guided frozen spec and current profile, then asks before launching a live worktree run | Ship remains a separate explicit approval and command; Fleet and expert runs still need explicit paths and IDs. |
| Patch and maintenance | `patch-spec --from-intake` proposes a bounded read-only diagnosis; `audit` can use the current project profile and directories. `patch`, `refactor`, `retro`, `align-ds-*` remain explicit. | Maintenance flows still need separate wizards with scope and evidence review; write paths and approvals remain explicit. |
| Integrations and operations | `retrieve`, `design-snapshot`, `kanban-project`, `migrate`, `rpc`, `service`, `schemas`, `check`, `metrics`, `export` remain explicit | These are primarily diagnostic, integration or automation commands. Give them concise human summaries where useful, but keep all protocol and migration inputs explicit. |

The connected intake, brainstorm, spec and patch preparation flows are guided. Editing an
existing scenario or criterion, browsing history, and the expert maintenance and delivery flows
remain separate UX work. A GUI can use the same persisted profile, artifacts and decisions.

The two-round Codex probe on a disposable project is recorded in
[`g5-codex-iterative-brainstorm-darwin-arm64.json`](evidence/g5-codex-iterative-brainstorm-darwin-arm64.json).
It verifies a stored revision link and a changed synthesis, not conversation continuity within a
provider session or parity with the former V2 flow.
