# V2 behavior parity: working audit

Reference: local tag `v2.10.1` and `cohorte-spec/01-produit-parite.md` (P10–P34).
This is a behavioral audit, not a claim that V3 is complete. The Python engine
already owns durable runs, checks, reviews, fix cycles and delivery; this branch
addresses the human preparation flow and project context. Each statement below
requires requalification with both official providers before a parity release.

| Workflow | Implemented in this branch | Still to qualify or build |
| --- | --- | --- |
| Init | Read-only preview, richer workspace/contract/check/role detection, conventions/design/retrieval/isolation signals, questions for ambiguous ownership, guided retrieval/design selection, structured profile-file acceptance and refresh preserving custom choices | Real-project validation of boundaries; convention/import and container setup still require explicit profile editing |
| Host-client wrappers | Optional Claude/Codex/Cursor/Gemini/OpenCode shortcuts previewed and created without overwriting existing files; all direct execution to the Cohorte CLI | Validate actual invocation from each host client; these are not native Cohorte providers |
| Specs and metrics | Specs board lists feature state and next command; human metrics output summarizes outcomes and availability while JSON keeps detailed groups | Cross-check with real multi-provider run histories |
| Product language | The profile target language is carried into brainstorm/spec context and explicit build/review copy instructions; CLI conversation language stays separate | Provider-live verification of generated copy in a project with a different target language |
| Intake | Read-only agent triage proposal grounded in source and repository, with human route decision and manual fallback | Provider-live proposal quality and revision UX |
| Brainstorm | Project-configured panel, repository overview and cited search every round, focused question proposals with business/code options, acceptance shortcuts | Two two-round live Codex scenarios and one two-round live Claude scenario passed (see `evidence/g5-*-v2-parity-*.json`); broader real-project decisions remain unqualified |
| Spec | Existing agent draft plus per-question acceptance of proposed answers and project overview; `spec-propose` exposes the read-only proposal and `spec-draft` converts an explicitly accepted, fresh proposal into an editable draft while retaining open questions | Live Codex and Claude proposals on a synthetic repository produced valid references, scenarios and surface/check IDs. The first Claude proposal was over-scoped; prompt refinement reduced it and kept user decisions separate. Codex `spec-draft` and freeze-request passed; deterministic tests cover stale-brief rejection. Terminal interview, final approval/freeze, guided editing of existing scenarios/criteria and real-project/multi-surface quality remain unqualified |
| Build, review, fix and fleet | Fresh project overview alongside task-specific repository evidence; reviewers receive coordinator check results and exact surface IDs, with incomplete coverage journaled before blocking. Supervised Fleet plan/status/sync provisions isolated worktrees, checks remote branch drift, and rebases clean idle branches after a proven merge | A live single-surface Codex build/check/review became ready on the third synthetic run after two diagnosed review-boundary failures (see `evidence/g5-codex-v2-parity-synthetic-loop-darwin-arm64.json`). Successful live fix, Claude run, multi-surface real provider runs, external session liveness and integration order remain unqualified; Fleet status does not yet show phase-level run evidence |
| Patch | Read-only code-grounded patch proposal, user-editable scope and regression check, manual fallback | Live diagnosis quality and guided execution of the approved patch |
| Audit/refactor | Current-project defaults and bounded directory-level source inspection; refactor-plan derives a bounded selection from audited findings, previews it and records an exact approval before execution | Broader coverage accounting, live refactor qualification and domain-wide guided selection |
| Retro | Review findings are now journaled; recurring category/surface findings across two features are mined, an agent may suggest a testable rule or identify an existing-rule gap, and ratification updates the active profile | Pre-change review history lacks structured findings; provider-live suggestion quality and more precise pattern grouping remain unqualified |
| Incoming PR/MR review | Dedicated detached checkout at fetched PR/MR head, exact base/head check, read-only diff review, surface coverage and durable local report | Real GitHub/GitLab qualification and large-PR chunking remain unverified |
| Design, RBAC and mobile constraints | Enabled project constraints are captured in guided specs, required at freeze/build, and called out in review prompts | Qualify provider-live proposal quality and full design/RBAC/mobile review evidence |
| Doctor, update, design and delivery | Project doctor now reports missing paths/tools/integrations with exact fixes; update-pipeline previews profile reconciliation before apply; Figma feeds alignment planning and snapshot capture | Compare human flows to V2 and qualify live integrations; generated-wrapper reconciliation is still separate |

The full test suite and static checks cover local behavior. They do not establish
that a live model asks good questions, reads the right files or produces correct
project-specific recommendations. Do not present this branch as complete V2
parity until those rows and P10–P34 are closed with recorded evidence.
