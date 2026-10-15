# CLI experience audit

Status reconciled on 2026-10-15 for published Python `1.0.0a23` (source commit
`50a123774dc87da35736cad139a90753217dcb80`). This is a documentation review, not a
new provider-live qualification. Historical evidence retains its original candidate,
runtime and platform boundaries. See the [qualification ledger](qualification/README.md).

The CLI serves two audiences: a person in a project directory and automation using `--json`.
The JSON commands are a stable explicit interface. A human flow should infer the registered
project, show short results, and ask for decisions only when the necessary evidence is visible.

| Area | Current human flow | Remaining gap |
| --- | --- | --- |
| `doctor`, `auth` | Project doctor gives a short service/provider/project summary and specific fixes; provider account operations are explicit | Provider-live capability status still requires active verification. |
| `init`, `profile`, `update-pipeline` | Read-only discovery preview, detected project description, surface roles, package-level checks and contract candidates; guided retrieval/design choices; reviewed profile-file input and preview-before-apply refresh | Shared ownership, migrations and container setup still require human verification. |
| `intake`, `status` | Project inferred from the directory; read-only agent triage proposal with source and repository context; route and revisions are stored and handed to brainstorm or guided patch preparation | Triage still needs an explicit human route when the source is ambiguous. |
| `brainstorm` | Starts from the idea, then a project-configured panel proposes focused questions and business/code options over linked brief revisions. Each round receives a bounded, cited repository scan, project overview and live project decisions. Named contributions and free-form `--message` follow-ups are available; configured Obsidian ideas include card notes. | The local search is lexical, so agents must inspect full files before asserting behavior or absence. Bounded synthetic provider-live rounds exist; conversational quality in released François on a real project remains unqualified. `brief show` reads only the latest revision. |
| Spec preparation and freeze | `spec` asks blocking questions, resumes a draft, supports multiple surfaces, scenarios and criteria, and offers exact-hash approval | A newer brief is attached only after an explicit prompt. Item-level scenario/criterion edits use the JSON editor; `spec-session` also supports saved proposals, free-form revision, explicit acceptance and exact freeze approval for François. |
| Build and delivery | `start` verifies a guided frozen spec and current profile, then asks before launching a live worktree run; `incoming-review NUMBER` reviews an existing PR/MR in a detached checkout without publishing a forge comment. Supervised Fleet previews overlap/order, then provisions and monitors per-feature worktrees. | Ship remains a separate explicit approval and command; expert runs still need explicit paths and IDs. |
| Patch and maintenance | `patch-spec --from-intake` proposes a bounded read-only diagnosis; `audit` can use the current project profile and directories. `refactor-plan` selects audited findings and invariants before exact approval. `retro` mines recurring review findings and waits for ratification. | Bounded live maintenance and local-source design runs exist; real-project guided selection and broader external design qualification remain open. |
| Integrations and operations | `retrieve`, `design-snapshot`, `kanban-project`, `migrate`, `rpc`, `service`, `schemas`, `check`, `metrics`, `export` remain explicit; `specs` and `metrics` have short human summaries | Keep protocol and migration inputs explicit; qualify host-client wrappers in their actual clients. |

The connected intake, brainstorm, spec and patch preparation flows are guided. Editing an
existing scenario or criterion, browsing history, and the expert maintenance and delivery flows
remain separate UX work. François bridges use the persisted profile, artifacts and decisions; the complete desktop interaction remains to be qualified.

The two-round Codex probe on a disposable project is recorded in
[`g5-codex-iterative-brainstorm-darwin-arm64.json`](evidence/g5-codex-iterative-brainstorm-darwin-arm64.json).
It verifies a stored revision link and a changed synthesis, not conversation continuity within a
provider session or parity with the former V2 flow.
