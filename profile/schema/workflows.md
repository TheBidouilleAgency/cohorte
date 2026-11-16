## Workflows — deterministic multi-agent runs (opt-in)

Four scripts run under the Claude Code Workflow runtime instead of the lead reasoning out the
fan-out turn by turn: `<workflows>/cohorte-review.js`, `cohorte-audit.js`, `cohorte-refactor.js` — each the
**workflow variant** of its same-named conversational command — plus **the loop workflow**
(`cohorte-loop.js`), which has **no conversational form at all** (below). For the variant pairs,
the conversational commands (`/cohorte-review`, `/cohorte-audit`, `/cohorte-refactor`)
**remain the default path and the fallback** — a workflow runs only when the human explicitly asks
for it ("run the review workflow"), and requires Claude Code ≥ **2.1.154** with workflows
enabled.
`/cohorte-doctor` reports which path a session will take. The interactive commands (`/cohorte-init-pipeline`,
`/cohorte-brainstorm`, `/cohorte-spec`) and the dispatch-only ones (`/cohorte-build`, `/cohorte-ship`) have **no** workflow variant on
purpose: they're interviews or already a single parallel dispatch — a script adds nothing.
The loop workflow does not change that: it **consumes** `/cohorte-build`'s outputs (the frozen
spec, `readiness.json`, the lead-authored contract, `build.json`) — it is not a build variant,
and adding one would put the lead-only steps (§1.5 reconcile, §2 contract authoring) inside a
script that cannot ask.

Shared design, all four scripts:

- **Phase 0 is always `cohorte-profile-reader`** — workflow scripts have no filesystem or shell access, so a
  dedicated agent (`core/agents/cohorte-profile-reader.md`, haiku, read-only) returns the
  `yaml pipeline-profile` block as JSON — one Read of `<state>/profile.json` (already parsed by
  `<sync>`), falling back to parsing `PIPELINE.md` when that file is absent. Every later phase is parameterized from that object.
- **Mechanical phases run on haiku** (profile read, preflight, diff staging, report merging/writing);
  judgment phases dispatch the same pinned agents the commands use (`review` at sonnet, the surface
  implementers at their `surfaces[].model` tier) — the per-surface `model:` routing carries over.
- **Only the verdict comes back.** Bulk (diffs, reports, backlogs) is staged to the same disk
  buffers the commands use (`specs/reports/`, `specs/refactor-backlog.md`); the workflow's return is
  counts + verdict + paths.
- **A dead agent is never a clean result.** `agent()` resolves to `null` when a subagent dies, and a
  dead *reviewer* returns zero findings — byte-identical to a surface that is genuinely clean. Any
  script that derives a verdict from "how many findings came back" must first subtract the agents
  that never answered: `review.js` names them in `unreviewedSurfaces` and refuses to score
  `SHIP`. `scripts/test-workflows.mjs`
  pins this — it is the one invariant the structural checks in `validate-core.mjs` cannot see.
  The conversational commands enforce the same rule by roll call (§Dead agents, `<core>/pipeline/schema/dead-agents.md`); it was the workflows
  that had it first, and for three releases they had it **alone** — the same crash on the
  conversational path went unreported.
- **`review.js`** — preflight gate (aborts red, zero agents), the changed paths listed once and the
  hunks staged per touched surface (§Feature diff, `<core>/pipeline/schema/feature-diff.md` — an empty diff aborts, it is never a SHIP), one
  reviewer per surface in parallel (a dead one retried once), then an **adversarial cross-check**
  phase that tries to refute each CRITICAL/security finding before it can trigger a fix loop. The
  verdict — merged and per surface — is recomputed from the surviving findings by the review
  agent's one rule.
- **`audit.js`** — one auditor per domain (each surface + `shared`), concurrency capped by the
  runtime (~16), merged into `specs/refactor-backlog.md` — only the audited domains' sections are
  rewritten (§Deferred findings, `<core>/pipeline/schema/deferred.md`).
- **`refactor.js`** — big domains only (it skips domains with a handful of open items — the
  conversational `/cohorte-refactor` is cheaper there): `shared` first and alone (verified with the
  repo-wide commands — it has no surface commands of its own), then the other domains'
  implementers in parallel, each verified per-domain; then, gates green, it freezes the round as one
  `kind: refactor` spec and ticks the backlog with `· refactor:<id>` (review → ship from there).
- **`loop.js`** (the loop workflow, `cohorte-loop.js`) — build → review → [fix → review]* for ONE feature, unattended and
  resumable. Preconditions it verifies and refuses to work around: frozen/`in-review` spec, a fresh
  `readiness.json` at `READY`/`RESERVATIONS`, the contract on disk, every readiness surface owned by
  the profile. Round exits, in order: child abort relayed → `unreviewed` non-empty → `blocking == 0`
  ⇒ ship → same blocking-item identity two consecutive rounds ⇒ treading water → `maxRounds`
  (default 5). A blocking finding on the contract file aborts (`contract-change` — lead-only, per
  `/cohorte-fix` §1). It calls the review **workflow** per round and reads the same `verdict.json`
  contract the conversational `/cohorte-review` §3 writes; it stamps `in-progress` while running,
  `in-review` on ship, `blocked` on a give-up (resumable or terminal — §Spec status, `<core>/pipeline/schema/spec-status.md`). The review runs
  as a child via `workflow('cohorte-review', {feature})`, the runtime's one-level nesting call; a
  throw (runtime or script missing) closes the run as `review-workflow-unavailable`, resumable.
  **Workflow-only, no command file, ever**
  (`validate-core.mjs` pins it): if the runtime is unavailable it refuses explicitly rather than
  degrading to a lead re-reasoning the fan-out every round at session-model prices.
- **No input mid-run.** A workflow runs to completion without questions; anything interactive
  (contract changes, human decisions) belongs to the conversational path. The gate hook still
  fires on workflow subagents (see
  §Preflight, `<core>/pipeline/schema/preflight.md`) — in unattended runs its asks become denies. Know what that means for edits:
  workflow subagents run in **`acceptEdits` whatever the session mode**, so for the length of a
  run — and `loop.js` runs long, unattended stretches — `hooks/gate.py` is the only brake on
  what agents write (the project hook also guards the gate's own files on `Write|Edit|MultiEdit|NotebookEdit`). That is stated here rather than discovered.
- **Permissions:** `/cohorte-init-pipeline` and `/cohorte-update-pipeline` extend the generated `settings.json`
  `allow` list with what workflow agents need (the quiet commands, the shipped
  `pipeline/scripts/*.sh`, read-only git incl. `git rev-parse`, and the retrieval provider's MCP
  tools) so a run never stalls mid-workflow on a permission prompt nobody is watching.
