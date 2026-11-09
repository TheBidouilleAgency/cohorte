# Commands

Every slash command the core installs, in pipeline order. **Model pins:** mechanical commands pin
`model: sonnet` in their frontmatter so orchestration turns never bill at the session model;
interactive commands (`/cohorte-brainstorm`, `/cohorte-spec`, `/cohorte-patch`, `/cohorte-init-pipeline`) deliberately inherit the session
model — their value is the conversation.

| Command | Model | Role |
| --- | --- | --- |
| `/cohorte-init-pipeline` | inherit | Detect stack → interview → generate profile + agents. Once per project. |
| `/cohorte-brainstorm` | inherit | Persona panel pressure-tests a feature idea. |
| `/cohorte-spec` | inherit | Freeze the spec + contract; also applies review returns (Mode B). |
| `/cohorte-patch [bug]` | inherit | Triage a bug → freeze `specs/patch-<slug>.md` (`kind: patch`). Then the normal build/review/ship. |
| `/cohorte-build <id>` | sonnet | Author the contract, dispatch one implementer per surface, parallel. |
| `/cohorte-review <id>` | sonnet | Preflight, staged diff, one reviewer per touched surface, merged verdict. |
| `/cohorte-fix <id>` | sonnet | Apply a report; re-dispatch only the surfaces with findings. |
| `/cohorte-ship <id>` | sonnet | Freshness + DoD gates, human confirm, release agent, CI watch, teardown. |
| `/cohorte-audit [target]` | sonnet | Mechanical gates + convention/TDD audit → prioritized backlog. |
| `/cohorte-refactor <domain…>` | sonnet | Apply the backlog per domain via the surface implementers, TDD-first. |
| `/cohorte-align-ds` | sonnet | Align the code UI kit to the design system (design → code). |
| `/cohorte-update-pipeline` | sonnet | Refresh the core + reconcile this repo's generated files. |
| `/cohorte-doctor` | sonnet | Diagnose the whole installation; exact fix per failure. |

---

## `/cohorte-init-pipeline`

One-time per project, interactive, driven by step files (`templates/steps/init-pipeline/01…05`):
**detect** the stack read-only → **interview only the gaps** (surfaces + model tiers, quiet
command variants, contract mechanism, UI language, RBAC, design, retrieval provider, isolation,
gate patterns, personas; optional kanban link) → **show the
draft** → **write & render** (`PIPELINE.md`, one agent per surface with baked conventions,
`gate-config.json` incl. the preflight block, `settings.json` permissions + hooks per install
mode, retrieval wiring with health check, isolation scripts, `specs/_template.md`, the committed
`.claude/pipeline.json` pointer, optional CI workflow, gitignore entries for
`pipeline-metrics.jsonl` + `specs/reports/`) → **report**. Everything it generates goes into
*this repo* — never into `~/.claude`.

## `/cohorte-intake [paste]`

The door before the doors. Paste anything that arrives — a ticket, a client email, a stack
trace, a Slack thread — and it triages: **bug** ⇒ distilled into the exact structure
`/cohorte-patch` interviews for (symptom, repro with inferred steps labeled, environment,
suspected surfaces); **feature** ⇒ a brainstorm seed (title, who's asking, goals/non-goals,
open questions as the panel's agenda, prior art incl. any `_decisions.md` line it contradicts);
**neither** ⇒ says so and stops — inventing a spec from noise costs a pipeline run downstream.
Either way the distillate is staged to `specs/reports/intake-<slug>.md` (it survives a
`/clear`) and a kanban card lands in **Ideas** — tagged exactly as the follow-up command joins
(`#patch-<slug>` + `[patch]` title for bugs), so it moves instead of duplicating. The seed
itself travels in the staged file: `/cohorte-brainstorm` and `/cohorte-patch` read it when it
exists. Intake never runs them or freezes anything itself.

## `/cohorte-brainstorm [idea]`

Interactive panel from `PIPELINE.md` §Personas; one voice per RBAC role when enabled. Rounds of
2–4 personas surfacing tensions + a focused question, until scope/roles/data/screens/risks/
non-goals are clear. Finish stages the return to `specs/reports/<id>-brainstorm.md`, settles the
`feature_id`, moves the kanban card. Empty idea + a board ⇒ it offers
the **Ideas** column cards.

## `/cohorte-spec [paste]`

**Mode A (new spec):** reads the staged brainstorm return (or asks), derives the id, enforces
the ≤ ~300-line size budget (proposes a feature split past it), walks the template section by
section — §5 CONTRACT to zero-further-questions precision — authors the design brief to
`specs/design/<id>.md` (UI features), freezes with `status: frozen` (postcondition-checked).
**Mode B (review return):** appends findings to `## Remediation`, updates §5 if the contract
must change, sets `status: in-review`, routes to `/cohorte-build`.

## `/cohorte-patch [bug description | stack trace | empty]`

The bug-fix entry point — the cheap counterpart to `/cohorte-brainstorm` + `/cohorte-spec`, which
exist to *design* something that doesn't exist yet. A bug is already specified by reality, so this
is a triage, not an interview: three questions (repro · expected behaviour · blast radius), you
locate the cause yourself, and it freezes `specs/patch-<slug>.md` from `templates/patch.template.md`
with `kind: patch` and a ~60-line budget.

Empty argument + a configured board ⇒ it offers the **Ideas** column cards, `[patch]`-tagged ones
first. The `feature_id` is `patch-<slug>`, prefix included — it is the kanban join key, the filename
and the branch.

It stops at the freeze. Everything after is the unchanged pipeline: `/cohorte-build patch-<slug>` →
`/cohorte-review` → `/cohorte-fix`* → `/cohorte-ship`, one `/clear` between each. That split is the
point — a patch pays four short sessions instead of one long thread re-sending its own triage
history at input price on every turn.

**Multi-surface is allowed** (one bug, one repro, one spec). The single hard escalation: a fix
needing **new** contract surface area is a feature wearing a bug's clothes ⇒ `/cohorte-spec`.
Changing an *existing* contract entry is a legitimate §5 delta. See
[SCHEMA §Spec status](/reference/profile) for the three places `kind: patch` changes behaviour.

## `/cohorte-build <id>`

§1 loads the spec selectively (status grep first, then only front-matter/§5/tasks/Remediation);
routes to `/cohorte-fix` when only open non-contract items remain; design gate for UI features.
§1.5 **auto-reconciles surfaces** (new tree ⇒ new agent; clean bottleneck ⇒ split proposal —
rendered immediately per the shared procedure, plus one line in `specs/_decisions.md`).
§1.6 scores **readiness** — contract completeness · surface coverage · named dependencies exist ·
residual ambiguity · design links — and writes `specs/reports/<id>.readiness.json`
(`READY`/`RESERVATIONS`/`NOT-READY` + `gaps[]`). **`NOT-READY` stops the build with zero agents
spawned** (go patch the spec); `RESERVATIONS` proceeds, each gap inlined into the affected surface's
dispatch as a flagged assumption. Costs no extra agent — the lead already holds the spec.
§2 authors the contract (postcondition:
file exists). §3 dispatches all implementers in one message, byte-stable prompts, variable slots
last. §3.5 does the **roll call**: a surface that returned no handoff is dead, not clean — retried once alone
(byte-identical prompt), then marked `dead`, its tree verified with its own quiet commands rather than
spoken for. §4 integrates handoffs, appends the batch metrics line (`ok|error|dead`, written even on an
incomplete batch), writes `specs/reports/<id>.build.json` (`dead[]` — the driver's
channel), recommends `/cohorte-review`, and a `/clear`.

## `/cohorte-review <id>`

§0 preflight. §1 one `git diff --stat`, paths grouped by surface (shared remainder attached to
the most relevant surface), full patch staged per touched surface. §2 one reviewer per touched
surface in parallel (small re-reviews: lead verifies hunks itself). §3 **rolls call first** — a reviewer
that died returns zero findings, which reads exactly like a clean surface, so a silent one is retried
once and then listed in the verdict's `unreviewed[]`, which **forbids `SHIP`**. Then it merges into one
report —
verdict `SHIP`/`REVISE`/`BLOCK`, capped findings — stages it, appends metrics; on
SHIP ticks the DoD and stamps `reviewed_base`/`reviewed_digest`; on REVISE/BLOCK routes to
`/cohorte-fix`. §3.5 routes the reviewers' **deferred findings** — real but out of this feature's scope — into
`specs/refactor-backlog.md` under the owning surface's domain heading, tagged `deferred:<id>`, on
**every** verdict; they count in no severity row and can never cost a fix pass. LOW/MEDIUM leftovers on
a SHIP take the same route.
§3 also writes **`specs/reports/<id>.verdict.json`** on every run — counts by severity, per-surface
breakdown, normalized `blocking_items` and a stable `fingerprint` over them. That file is the only
machine contract with any automated driver; no prose is ever parsed. A red preflight writes the degraded
`{"aborted":"preflight"}` form instead of nothing, so an abort reads as a diagnosis.

**PR mode** — `/cohorte-review --pr <num>` (or a PR URL) reviews an **incoming** pull request:
same reviewers, same report format, none of the pipeline's certifications (no spec ⇒ audit mode
— conventions/quality/security/TDD only; no kanban, no verdict.json, no DoD tick, no freshness
stamp). The PR is fetched into a throwaway worktree (your checkout is never touched), preflight
runs there (red ⇒ the mechanical failures *are* the review — no reviewers wasted), and the
merged report is staged to `specs/reports/pr-<num>.md`. Posting it as a PR comment via `gh` is
offered and **always requires your explicit go-ahead** — declining leaves the report on disk as
a complete outcome. Worktree torn down either way.

## `/cohorte-fix <id> [paste]`

§1 ingests the report (paste / session / staged file), appends `- [ ]` items to
`## Remediation`, re-authors the contract itself if a finding demands it (full `/cohorte-build` only
when the change ripples into clean surfaces). §2 maps open items to surfaces by path and
re-dispatches **only those**, items verbatim in the dispatch. §3 ticks `- [x]` per handoff,
collapses fully-fixed rounds to one line, metrics, routes to `/cohorte-review`.

## `/cohorte-loop <id>` — workflow-only

Not a command file: **the loop exists only as a workflow script** (`core/workflows/loop.js`,
Claude Code ≥ 2.1.154 with workflows enabled — ask *"run the loop workflow for `<id>`"*, args
`{feature, maxRounds?}`). If the runtime is unavailable it refuses; there is deliberately no
conversational fallback (a lead re-reasoning the fan-out every round at session prices is the
cost the script exists to avoid). It runs build → review → [fix → review]* unattended for one
feature: verifies `/cohorte-build`'s outputs as preconditions (frozen spec, fresh
`readiness.json`, contract on disk), skips its build phase when a fresh `build.json` shows the
work already landed, calls the review workflow each round, and exits on zero blocking findings
(ship), identical blocking findings two rounds running (treading water), `maxRounds` (default
5), an unreviewed surface, dead implementers, or a finding that would change the frozen
contract (lead-only). State lives in `specs/reports/<id>.loop.json`; re-invoking resumes.
See the [workflows guide](../guide/workflows.md).

## `/cohorte-fleet plan|status|sync`

The flight controller for parallel features — coordination only, never headless execution (each
feature's build/review/loop runs in its own worktree's supervised session; the retired 2.2.0
driver is why). `plan <id> <id> …`: frozen-spec check, *feature × surface* overlap matrix from
§5/§6 (contract dependencies ⇒ merge order, same-tree writes ⇒ serialize or drop), worktree
provisioning via `new-feature.sh`, flight plan to `specs/reports/fleet.json`, one launch line
per feature. `status`: one row per feature — spec status, loop round/outcome, blocking,
ahead/behind main, the single next action. `sync`: post-merge rebase of every surviving
worktree (conflicts reported verbatim, left to their owner), with the reminder that a rebase
invalidates `reviewed_digest` — re-review before ship. Requires `isolation.enabled`.
See the [parallel features guide](../guide/parallel-features.md).

## `/cohorte-ship <id>`

Pre-flight: SHIP verdict confirmed; **freshness gate** (recompute the digest — mismatch ⇒
refuse, re-review); DoD verification (open boxes need explicit human override); human
confirmation. Then: spec → `status: shipped` *before* dispatch, the **release note** when
`release_notes.enabled` (the lead writes it — bump level is project policy — so it lands in the
release commit, not a follow-up), `release` agent (conventional commits, plain push, PR via `gh` or
compare URL + drafted body), kanban → Shipped with the PR number,
CI watch, and — after the confirmed merge — the worktree teardown proposal.

## `/cohorte-audit [target]`

§1 runs the mechanical gates (quiet variants) scoped to the target, redirected to
`specs/reports/audit-gates.txt`. §2 dispatches `review` in **audit mode** (no spec; conventions +
TDD coverage + over-engineering + design usage as the rulebook). §3 writes the prioritized
`specs/refactor-backlog.md` grouped by domain. Backlog items tagged `complexity` are the
over-engineering cuts, ranked biggest first inside their domain — the cheapest wins in the file
(deleting code needs no new tests), but never ahead of a security, correctness or `tdd` item.

## `/cohorte-refactor <domain…>`

Reads the backlog, maps domains to surfaces (`shared` = the contract package, refactored by the
lead directly). Dispatches implementers — tests pinned first, then refactor, public behavior
preserved — in parallel when domains are independent, `shared` always alone and first.
Verifies per domain (quiet gates + item-by-item `file:line` check — no `/cohorte-audit` re-run per
round), ticks the backlog, loops until each dispatched domain is clean.

## `/cohorte-retro [last <n> | all]`

Mines the residue every review leaves on disk — `verdict.json`s, the specs' persistent
`## Remediation` history, the `deferred:` backlog — for **patterns**: the same finding kind ×
surface across ≥ 2 features, a hotspot module, a recurring fix family. Each pattern becomes ONE
drafted, rule-shaped `PIPELINE.md` §Conventions line with its evidence attached; the human
ratifies (none is a fine answer), and adopted rules are appended **and the affected surface
agents re-rendered** — the conventions slice is baked at render time, so a rule without a
re-render is one reviewers enforce and implementers never saw. One decisions-journal line per
adopted rule. Patterns the rulebook already covers are reported as *enforcement gaps*, not
re-proposed. The loop this closes: findings → rules → the next build never produces the finding
— cheaper than any number of review rounds catching it.

## `/cohorte-align-ds`

Design → code alignment. No-ops with a clear message when `design.enabled` is false. See
[Design system](/guide/design-system).

## `/cohorte-update-pipeline [path]`

§1 detects install scope + versions (never migrates bundled ↔ global on its own). §2 runs the
installer's `--update` (npm preferred, local checkout or piped installer as fallbacks). §3
reports old → new + syncs the `pipeline.json` pointer in both modes + prints the CHANGELOG
delta. §3.5 **reconciles** this repo's generated files: profile top-up (new fields at defaults,
one batched question set for genuine decisions — e.g. quiet variants), agent re-render (refreshes
baked conventions), additive settings/gate patch, capability wiring + health checks, global
config seed, kanban sync. §4 follow-ups: session restart, per-repo reconcile for other global
repos, commit.

## `/cohorte-doctor`

Nine check groups, each failure with its exact fix: **1** core & pointer (+ shipped scripts
present & executable, VERSION not newer than siblings), **2** profile ↔ agents (orphans, tool
lists, **model pins** on agents and commands), **3** hooks & gate (config drift, single
registration), **4** retrieval health, **5** design paths, **6** isolation (rendered scripts,
slot table, stale slots / zombie worktrees), **7** the kanban board link, **8** workflows
(CLI ≥ 2.1.154, the four scripts, `profile-reader`, runtime in-session, preflight wiring — with
the one-line path summary), **9** specs & metrics hygiene.
