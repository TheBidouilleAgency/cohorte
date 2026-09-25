# V2 behavior parity: working audit

Reference: local tag `v2.10.1` and `cohorte-spec/01-produit-parite.md` (P10–P34).
This is a behavioral audit, not a claim that V3 is complete. The Python engine
already owns durable runs, checks, reviews, fix cycles and delivery; this branch
addresses the human preparation flow and project context. Each statement below
requires requalification with both official providers before a parity release.

| Workflow | Implemented in this branch | Still to qualify or build |
| --- | --- | --- |
| Init | Read-only preview, richer workspace/contract/check/role detection, questions for ambiguous ownership, refresh preserving custom choices | Real-project review of detected boundaries, migrations, design source, retrieval and execution isolation |
| Intake | Read-only agent triage proposal grounded in source and repository, with human route decision and manual fallback | Provider-live proposal quality and revision UX |
| Brainstorm | Project-configured panel, repository overview and cited search every round, focused question proposals with business/code options, acceptance shortcuts | One two-round live Codex scenario passed (see `evidence/g5-codex-v2-parity-brainstorm-darwin-arm64.json`); Claude and other real-project decisions remain unqualified |
| Spec | Existing agent draft plus per-question acceptance of proposed answers and project overview | Provider-live quality, guided editing of existing scenarios/criteria |
| Build, review, fix and fleet | Fresh project overview alongside task-specific repository evidence | Real provider runs over multi-surface projects and integration order |
| Patch | Read-only code-grounded patch proposal, user-editable scope and regression check, manual fallback | Live diagnosis quality and guided execution of the approved patch |
| Audit | Current-project defaults and bounded directory-level source inspection | Broader coverage accounting, guided finding selection and refactor execution |
| Retro | Existing deterministic proposal/ratification flow | Automatically mine review history, propose rules and show enforcement gaps |
| Incoming PR/MR review | None | Independent checkout and review report |
| Doctor, update, design and delivery | Existing explicit commands | Compare each human flow to V2 and qualify live integrations |

The full test suite and static checks cover local behavior. They do not establish
that a live model asks good questions, reads the right files or produces correct
project-specific recommendations. Do not present this branch as complete V2
parity until those rows and P10–P34 are closed with recorded evidence.
