# Commands

Every slash command the core installs, in pipeline order. **Model pins:** mechanical commands pin
`model: sonnet` in their frontmatter so orchestration turns never bill at the session model;
interactive commands (`/cohorte-brainstorm`, `/cohorte-spec`, `/cohorte-patch`, `/cohorte-init-pipeline`) deliberately inherit the session
model — their value is the conversation.

| Command | Model | Role |
| --- | --- | --- |
| `/cohorte-init-pipeline` | inherit | Detect stack → interview → generate profile + agents. Once per project. |
| `/cohorte-po [request]` | inherit | The product owner: talks with the business (never code), proposes tickets as `cohorte-ticket` blocks. Company flow. |
| `/cohorte-lead <ticket>` | inherit | The lead: frames a validated ticket with the developer, writes the spec, posts the CP1 plan, freezes on approval. Company flow. |
| `/cohorte-brainstorm` | inherit | Persona panel pressure-tests a feature idea. |
| `/cohorte-spec` | inherit | Freeze the spec + contract; also applies review returns (Mode B). |
| `/cohorte-intake [paste]` | inherit | Triage a ticket / email / trace / thread into a `/cohorte-patch` handoff or a brainstorm seed. |
| `/cohorte-patch [bug]` | inherit | Triage a bug → freeze `specs/patch-<slug>.md` (`kind: patch`). Then the normal build/review/ship. |
| `/cohorte-build <id> [--readiness-only]` | sonnet | Readiness verdict, then author the contract and dispatch one implementer per surface, parallel. `--readiness-only` stops after the verdict. |
| `/cohorte-review <id>` | sonnet | Preflight, staged diff, one reviewer per touched surface, merged verdict. |
| `/cohorte-fix <id>` | sonnet | Apply a report; re-dispatch only the surfaces with findings. |
| `/cohorte-fleet plan\|status\|sync` | sonnet | Several features in parallel: overlap matrix, merge order, one worktree each, post-merge rebase sweep. |
| `/cohorte-verify <id>` | sonnet | Run the app: migrations (+ down-then-up), dev server + ready probe, smoke/e2e, screenshots; ticks only evidenced `· runtime` DoD items; `verify.json`. |
| `/cohorte-ship <id>` | sonnet | Verdict-file + freshness + DoD gates, human confirm, release agent, CI watch, `merged` reconcile, teardown. |
| `/cohorte-revert <id>` | sonnet | Revert a merged feature as a branch + PR; its down migration only on a dev DB. Never pushes the default branch. |
| `/cohorte-audit [target]` | sonnet | Mechanical gates + convention/TDD audit → prioritized backlog. |
| `/cohorte-refactor <domain…>` | sonnet | Apply the backlog per domain via the surface implementers, TDD-first; freeze the round as a `kind: refactor` spec for review → ship. |
| `/cohorte-learn <id> [merged\|abandoned]` | sonnet | Write the feature's journal entries (findings, red checks, corrections, contested decisions) as counted motifs. |
| `/cohorte-acceptance <ticket>` | sonnet | The PO's acceptance note for a merged ticket, in the business's words (CP4). |
| `/cohorte-product-map` | sonnet | Write `PRODUCT.md`: what the product does, in business language, from the code. |
| `/cohorte-vision [idea]` | inherit | New project: the PO turns an idea into a vision and the first version's tickets. |
| `/cohorte-foundation [brief]` | inherit | New project: the lead chooses the stack with the developer and posts the foundations plan. |
| `/cohorte-scaffold` | sonnet | New project: generate the walking skeleton from the approved plan (official generators), check it, commit it. |
| `/cohorte-retro [last <n> \| all]` | inherit | Turn the journal and repeated review findings into ratified §Conventions rules (with stable ids), re-render the agents. |
| `/cohorte-align-ds` | sonnet | Align the code UI kit to the design system (design → code). |
| `/cohorte-update-pipeline` | sonnet | `cohorte update`, `cohorte sync` this repo, reconcile its generated files. |
| `/cohorte-doctor` | sonnet | Diagnose the whole installation; exact fix per failure. |

---

## The company flow commands

`cohorte ui` runs these itself — see [The company flow](/guide/company-flow). In a plain Claude Code
session they drive the same state through the CLI verbs below: `/cohorte-po` files the tickets the
requester confirms, `/cohorte-lead` takes the ticket and starts the autopilot on approval, `/cohorte-spec
<ticket id>` adopts the spec it froze, `/cohorte-acceptance` records the verdict, `/cohorte-vision` and
`/cohorte-foundation` relay `cohorte new-project`.

- **`/cohorte-po [request]`** — a business conversation. Asks about need, value, frequency, scope; never
  code. Reads `PRODUCT.md` and the existing tickets to avoid duplicates. Each ticket it proposes is a
  ` ```cohorte-ticket ` JSON block (`ref`, `title`, `type`, `need`, `value`, `criteria`, `outOfScope`,
  `priority`, `size`, `parent`); the dashboard turns it into a draft ticket waiting for CP0. In a plain
  session it files the ones the requester confirms with `cohorte ticket create --status validate`.
  Otherwise read-only.
- **`/cohorte-lead <ticket>`** — framing with the developer. Proposes an approach and asks the decisions
  the developer must own (by class), writes `specs/<ticket>.md` as a draft from `/cohorte-spec`'s
  doctrine, posts a ` ```cohorte-plan ` block for CP1, and freezes on `CP1 APPROVED`. In a plain session
  it reads the ticket with `cohorte ticket show`, takes it with `cohorte take <id> --no-lead`, and on the
  developer's approval freezes and runs `cohorte checkpoint <id> approve --detach`.
- **`/cohorte-learn <id> [merged|abandoned]`** — the feature's journal: one entry per pattern worth
  counting, in `.claude/journal/<date>-<id>.md` of the main checkout, reusing existing motifs.
- **`/cohorte-acceptance <ticket>`** — the acceptance note (` ```cohorte-acceptance ` block): what changed,
  how to check it, what is not in this delivery. Read-only.
- **`/cohorte-product-map`** — writes or updates `PRODUCT.md` (≤ ~200 lines, no paths or technology).

Starting a project — `cohorte ui` → **New project** ([guide](/guide/company-flow#starting-a-new-project)):

- **`/cohorte-vision [idea]`** — the PO for a product that does not exist yet: who it is for, the problem,
  the first version, what waits. Posts a ` ```cohorte-vision ` block and the first version's
  ` ```cohorte-ticket ` blocks. Read-only; never names a technology.
- **`/cohorte-foundation [brief]`** — the lead for a project that does not exist yet: surfaces, stack,
  generators, data, auth, checks — defaulting to what the developer's other projects use, or following
  one of them (shape and conventions, never its code). Posts a ` ```cohorte-foundation ` block. Read-only.
- **`/cohorte-scaffold`** — builds the walking skeleton the approved plan describes: each surface from its
  official generator, one trivial path through all of them, tests/lint/build green, compose, CI, README;
  commits it. Reports in a ` ```cohorte-scaffold ` block. No business feature, no push.

## The flow verbs (`cohorte …`)

The CLI side of the company flow — same files as `cohorte ui` (`~/.claude/cohorte-ui/`, the project's
tracker), same transitions as its buttons. Every verb takes `--project <path>` (default: the repo of the
current folder; a feature worktree counts as its repo), `--json` (the result on stdout, progress on
stderr) and `--interactive` / `--no-interactive` (ask on stdin even when it is not a TTY / never ask).

| Verb | Does |
| --- | --- |
| `cohorte ticket list [--status S]` | the tickets with their feature's phase, and the specs a plain session wrote that the flow does not follow yet |
| `cohorte ticket show <id>` | a ticket and its feature (phase, checkpoint, stages, driver) |
| `cohorte ticket create --title T [--body-file F \| --need …] [--type] [--criteria C]… [--value] [--out-of-scope X]… [--priority] [--size] [--parent] [--requester] [--status validate]` | to the backlog (a tech ticket), or `--status validate` for the requester's CP0 |
| `cohorte ticket move <id> <status>` | `validate` → `backlog`/`rejected` is CP0; any other move edits the note and the card |
| `cohorte take <id> [--yes] [--skip-docker-check] [--no-lead]` | worktree + feature record (id = ticket id), then the lead frames it → CP1. `--no-lead`: the calling session is the lead |
| `cohorte lead <id> --note TEXT` | reply to the lead, print its next turn |
| `cohorte checkpoint <id> <action> [--note TEXT]` | CP1 `approve` `correct` `abandon` · CP2 `continue` `correct` `reframe` `abandon` · CP3 `approve` `correct` `abandon`; then follows what it started |
| `cohorte autopilot <id>` | build → review → fix → verify in the terminal: a line per stage, the decider's decisions, CP2/CP3 and handed-over questions asked here |
| `cohorte autopilot <id> --follow` / `--status` | attach to a detached drive (its log, its questions asked here) / where it stands |
| `cohorte merge <id>` | `gh pr merge`, then the journal and the acceptance note (CP4) |
| `cohorte accept <id> ok\|not-quite [--note TEXT]` | CP4; `not-quite` opens a follow-up PO conversation |
| `cohorte adopt <id>` | a frozen (or further) spec with no feature record joins the flow at the phase its files say — CP2, CP3, PR — its ticket linked or created |
| `cohorte new-project --idea "…" --name N [--parent DIR] [--based-on PATH]` · `--stack` · `--existing PATH` | the founding chain — vision, foundations, skeleton, pipeline set-up — with the dashboard's checkpoints and git identity check |
| `cohorte new-project --resume --project PATH [approve\|reply\|retry\|continue\|abandon] [--note] [--identity github\|"Name <email>"]` | the next step of a founding |

`--detach` (on `take`, `lead`, `checkpoint`, `autopilot`, `merge`, `adopt`) runs the verb in a background
process that holds the feature until its next checkpoint and logs to `~/.claude/cohorte-ui/drives/`;
its questions wait in the dashboard's inbox and in `--follow`. Exit codes: `0` nothing waits on you,
`2` a checkpoint or the lead waits on you, `3` a question was parked (the feature is at CP2), `4` another
process drives the feature, `1` an error.

## `/cohorte-init-pipeline`

One-time per project, interactive, driven by step files (`templates/steps/init-pipeline/01…05`):
**detect** the stack read-only → **interview only the gaps** (surfaces + model tiers, quiet
command variants, contract mechanism, UI language, RBAC, design, retrieval provider, isolation,
gate patterns, personas; optional kanban link) → **show the
draft** → **write & render** (`PIPELINE.md`, one agent per surface with baked conventions,
`gate-config.json` incl. the preflight block, `settings.json` permissions, the gate + pointer +
gitignore entries via `cohorte sync`, retrieval wiring with health check, isolation scripts, optional CI workflow) → **report**. Everything it generates goes into
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

**A ticket id as input:** reads the ticket (`cohorte ticket show`), reuses its id as the feature id and
its criteria as the DoD, and links the frozen spec to the flow with `cohorte adopt`.
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
[`profile/schema/spec-status.md`](https://github.com/TheBidouilleAgency/cohorte/blob/main/profile/schema/spec-status.md) for the three places `kind: patch` changes behaviour.

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
stamp). The PR is fetched into a throwaway worktree (your checkout is never touched). **Code from
someone else's PR is untrusted:** unless its author is an owner, member or collaborator of the repo,
nothing from it runs — the review is static and reads `gh pr checks` instead — until you agree; even
then dependencies install with `--ignore-scripts`. Preflight then runs in the worktree (red ⇒ the
mechanical failures *are* the review — no reviewers wasted), and the
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

Not a command file: **the loop exists only as a workflow script** (`~/.claude/workflows/cohorte-loop.js`,
Claude Code ≥ 2.1.154 with workflows enabled — ask *"run the loop workflow for `<id>`"*, args
`{feature, maxRounds?}`). If the runtime is unavailable it refuses; there is deliberately no
conversational fallback (a lead re-reasoning the fan-out every round at session prices is the
cost the script exists to avoid). It runs build → review → [fix → review]* unattended for one
feature: verifies `/cohorte-build`'s outputs as preconditions (frozen spec, fresh
`readiness.json`, contract on disk), skips its build phase when a fresh `build.json` shows the
work already landed, calls the review workflow each round, and exits on zero blocking findings
(ship), identical blocking findings two rounds running (treading water), `maxRounds` (default
5), an unreviewed surface, dead implementers, or a finding that would change the frozen
contract (lead-only). State lives in `specs/reports/<id>.loop.json`; re-invoking resumes after a
resumable stop (a crash, a dead surface, an unreviewed surface, maxRounds) — a terminal stop (ship,
treading water) is not resumed.
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

## `/cohorte-verify <id>`

The "does it actually work" step between a `SHIP` verdict and `/cohorte-ship` — the only phase that
runs the app. One call to `verify-run.sh run`, which owns every process: applies `commands.migrate`
when the spec says `migrations: true` and checks `commands.migrate_down` down-then-up (dev DB only —
`verify.db: shared` is refused unless a registered feature worktree has its own DB), starts `commands.dev` in its own
process group, waits for `commands.dev_ready`, runs `commands.smoke` / `verify.surfaces.<key>.smoke`
/ `commands.e2e` under timeouts, takes screenshots when a local Playwright CLI exists, and **always
stops the server**. It asks the project gate about each command first (`deny` ⇒ skipped, `ask` ⇒
your confirmation). Writes `specs/reports/<id>.verify.json` (`PASS`/`FAIL`/`SKIPPED`, checks,
evidence, the tree digest) and `.verify.md`; ticks a DoD line only when it carries
`· runtime: <check>` and that check passed. No kanban move. Not configured (no
`smoke`/`e2e`/`dev`+`dev_ready`) ⇒ says so and stops. See
[`profile/schema/verify.md`](https://github.com/TheBidouilleAgency/cohorte/blob/main/profile/schema/verify.md).

## `/cohorte-ship <id>`

Pre-flight: `specs/reports/<id>.verdict.json` must say `SHIP` with no unreviewed surface and no
HIGH/MEDIUM left; **freshness gate** (recompute the digest — mismatch ⇒
refuse, re-review); a `migrations: true` spec with an empty `## Rollback` is refused; the
**runtime gate** — a `FAIL` `verify.json` blocks, an absent / `SKIPPED` / stale one asks "not
verified at runtime — ship anyway?" (silent when the profile has no runtime commands); DoD
verification (open boxes need explicit human override); human
confirmation. Then: spec → `status: shipped` *before* dispatch, the **release note** when
`release_notes.enabled` (the lead writes it — bump level is project policy — so it lands in the
release commit, not a follow-up), `cohorte-release` agent (conventional commits, plain push, PR via `gh` or
compare URL + drafted body), kanban → Shipped with the PR number,
CI watch, and — after the confirmed merge — the worktree teardown proposal.

## `/cohorte-revert <id>`

For a `merged` feature: finds the merge or squash commit from the spec's `pr:` / `branch:` via `gh`
(a rebase-merge's range is the human's to name), reads `## Rollback` before the revert deletes the
spec, branches off the default branch (`new-feature.sh revert-<id>` under isolation, else
`revert/<id>`), runs the down step through `verify-run.sh run --phase revert` **while the migration
files still exist** — dev DB only, same gate consult — then `git revert --no-commit`, keeps the spec
as history, commits, and on your confirmation pushes the revert branch and opens a PR whose body
carries `## Rollback` for whoever rolls back production. Never pushes or merges the default branch.
No kanban move.

## `/cohorte-audit [target]`

§1 runs the mechanical gates (quiet variants) scoped to the target, redirected to
`specs/reports/audit-gates.txt`. §2 dispatches `cohorte-review` in **audit mode** (no spec; conventions +
TDD coverage + over-engineering + design usage as the rulebook). §3 writes the prioritized
`specs/refactor-backlog.md` grouped by domain. Backlog items tagged `complexity` are the
over-engineering cuts, ranked biggest first inside their domain — the cheapest wins in the file
(deleting code needs no new tests), but never ahead of a security, correctness or `tdd` item.

## `/cohorte-refactor <domain…>`

Reads the backlog, maps domains to surfaces (`shared` = the contract package, refactored by the
lead directly). Dispatches implementers — tests pinned first, then refactor, public behavior
preserved — in parallel when domains are independent, `shared` always alone and first.
Verifies per domain (quiet gates + item-by-item `file:line` check — no `/cohorte-audit` re-run per
round), loops until each dispatched domain is clean.

Then it **delivers**: with the gates green and ≥ 1 item cleared, it freezes the round as one spec,
`specs/refactor-<domains>-<date>.md` — `kind: refactor`, the cleared items as §6 scope, the still-open
ones under §7, a DoD of "public behaviour preserved" + "all tests green", and **no contract
section** — cuts `<feature_branch_prefix><id>` if you are on the default branch, and ticks each
cleared backlog line `- [x] … · refactor:<id>`. Route: `/cohorte-review <id>` (the reviewer checks
behaviour preservation, conventions and over-engineering instead of contract conformance) →
`/cohorte-fix`* → `/cohorte-ship <id>`, unchanged. Never `/cohorte-build` or the loop workflow on it:
both assume a contract. The refactor workflow does the same at its end.

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

§1 reads the core version and this repo's pointer (a pointer with a 2.x `mode` marks a repo to
migrate). §2 runs `npm i -g cohorte@latest && cohorte update` (or `node <path>/bin/cli.js update`
from a local checkout). §2b runs `cohorte sync` for this repo — refreshes the committed gate and the
pointer and, on a 2.x repo, removes the vendored core. §3 prints old → new and the CHANGELOG delta.
§3.5 **reconciles** this repo's generated files: profile top-up (new fields at defaults, one batched
question set for genuine decisions), agent re-render into `.claude/agents` (refreshes baked
conventions), additive permissions/gate-config patch, capability wiring + health checks, config
seed, kanban sync. §4 follow-ups: session restart, `/cohorte-update-pipeline` in each other repo,
commit.

## `/cohorte-doctor`

Starts from `cohorte doctor` (the same file-level checks, deterministic), then adds what only a live
session can see. Nine check groups, each failure with its exact fix: **1** core & pointer (+ 2.x
leftovers, shipped scripts present & executable), **2** profile ↔ agents (orphans, tool lists,
**model pins** on agents and commands), **3** hooks & gate (config drift, the committed
`cohorte-gate.py` registered once for `Bash|Task|Agent` and `Write|Edit|MultiEdit|NotebookEdit`, `python3`
present), **4** retrieval health, **5** design paths, **6** isolation (rendered scripts, slot table,
stale slots / zombie worktrees), **7** the kanban board link, **8** workflows (CLI ≥ 2.1.154, the four
`cohorte-*.js` scripts, `cohorte-profile-reader`, runtime in-session, preflight wiring — with the
one-line path summary), **9** specs & metrics hygiene (including `shipped` specs whose PR has merged
or closed).
