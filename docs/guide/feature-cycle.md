# The feature cycle

This page walks one feature through the whole pipeline, conversationally — what each command
does, what lands on disk, and where the human decisions sit. (On Claude Code with workflows
enabled, the middle of this loop — build → review → fix → review — can also run unattended via
the [loop workflow](/guide/workflows); the conversational path below is the default everywhere.)

```
/cohorte-brainstorm → /cohorte-spec → /cohorte-build → /cohorte-review → (/cohorte-fix → /cohorte-review)* → /cohorte-ship
     ↑ human      ↑ human                          ↑ human
```

Between every two commands: **`/clear`**. Every handoff is on disk; clearing sheds the lead's
accumulated history, which is re-sent at input price on every turn it survives.

## 1. `/cohorte-brainstorm` — pressure-test the idea

An interactive roundtable in the main thread. The panel comes from `PIPELINE.md` §Personas (PM,
skeptical senior engineer, UX designer, security… one voice per RBAC role when `rbac.enabled`),
each with a job *and* a personality. They disagree with each other and with you — the point is to
surface tensions, scope cuts, risks, and what's explicitly **out**, a few focused questions per
round.

When you're satisfied, it stages the **brainstorm return** to
`specs/reports/<feature_id>-brainstorm.md` and settles the `feature_id` (kebab-case slug — the
join key used by every later stage and the kanban card). With a board configured, the card moves
to **Brainstorm**.

If you start `/cohorte-brainstorm` with no idea, it lists the cards in your kanban **Ideas** column (with
their notes as seed context) and lets you pick one.

## 2. `/cohorte-spec` — freeze the source of truth

Interactive, section by section over `specs/_template.md`. The critical section is **§5 CONTRACT**:
every endpoint/interface — method, path, auth/role, request fields with types and validation,
success envelope, every error case — plus the exact schema type names that will live in the
contract file. The bar: frontend and backend could each build from it with **zero further
questions**.

Discipline built in:

- **Size budget** — target ≤ ~300 lines. Every implementer re-reads the spec on every first
  build, so each extra line is paid `surfaces × dispatches` times. A spec that genuinely needs
  more is two features — `/cohorte-spec` proposes the split.
- **Decision journal** — before the interview `/cohorte-spec` reads `specs/_decisions.md` (one line per
  standing decision) so the new spec doesn't silently contradict settled ground; at freeze it
  appends the decisions that **outlive this feature** — typically 0–3 lines, and zero is normal.
  That file is the project's transverse memory: `PIPELINE.md` says how the repo is built, the
  journal says what was decided and why. Read by `/cohorte-brainstorm`, `/cohorte-spec` and `/cohorte-audit` only —
  implementers and reviewers never load it (they have the contract; the rationale would cost
  `surfaces × dispatches` tokens for a fact they can't act on).
- **Design brief** (UI features only) — authored to `specs/design/<id>.md`; spec §8 keeps only a
  summary + pointer so non-design surfaces never pay for it. You paste the resulting design page
  links (full `https://claude.ai/design/p/<projectId>?file=<file>` URLs) into the spec's
  `design_files` — each link carries its own project + page, so a design-system rebuild never
  invalidates the profile.
- **New-surface heads-up** — if the feature introduces a tree no surface owns, the spec notes it;
  `/cohorte-build` auto-reconciles (renders the new agent) later.

On your validation it **freezes**: `status: frozen` in the front-matter. Kanban → **Ready to
build**.

`/cohorte-spec` has a second mode: paste (or let it read) a REVIEW REPORT and it applies the findings to
the spec's `## Remediation` instead — the re-entry path for review returns that change the
contract.

::: tip The spec is the autonomy dial
Everything the cycle can't ask you mid-run, it reads from the spec. Edge cases, error envelopes,
role matrices, design links pinned down here = fix rounds and deferred questions you never see
later.
:::

## 3. `/cohorte-build` — contract first, then parallel implementers

1. **Checks** the spec is frozen; routes you to `/cohorte-fix` instead if only open remediation items
   remain (cheaper). For UI features, the **design gate** collects the `design_files` links if
   missing.
2. **Reconciles surfaces** — if the spec touches an unowned tree, or one surface carries a
   cleanly-separable bottleneck, `/cohorte-build` proposes a new/split surface, renders its agent on
   your go-ahead, and continues. You never go back to `/cohorte-init-pipeline` for this.
3. **Scores readiness** — before authoring anything, `/cohorte-build` judges the frozen spec on
   *implementability* (contract shapes complete · every area owned · named dependencies actually
   exist · no ambiguity a surface would have to guess at · design links present) and writes
   `specs/reports/<id>.readiness.json`. **`NOT-READY` aborts with zero agents spawned** and sends you
   to `/cohorte-spec`; `RESERVATIONS` never blocks — each gap is inlined into the affected surface's dispatch
   as an assumption the implementer must apply *and* flag. This costs no extra agent (the lead already
   holds the spec), which is the point: a bancal spec costs one verdict instead of N implementers
   discovering it in parallel.
4. **Authors the contract** — the lead writes `<contract.path>/<id>.<ext>` from spec §5 (e.g.
   Zod v4 schemas + inferred types), exports it from the barrel. This is the *only* file surfaces
   share; implementers import it read-only.
5. **Dispatches one implementer per surface, in a single message** — parallel, never serial:
   build wall-clock is the slowest surface, not the sum. Each dispatch is byte-stable (variable
   slots at the end, for the prompt cache) and self-sufficient: spec path, contract path, its
   tree, its design links or `none`, its remediation items or `none`.

Each implementer works **strict TDD** — failing tests from the contract first, then green, then
refactor to conventions, lint + format before handoff — inside its own tree only, running its
quiet commands. Its return is a tight **handoff** (summary, migrations, test results, contract
mismatches, TODOs — no file lists, no code excerpts).

The lead integrates: flags contract mismatches and failing tests, appends one metrics line to
`<state>/pipeline-metrics.jsonl` (the evidence used later to decide surface splits). Kanban →
**Building**.

**Roll call — silence is not a green light.** A subagent can die mid-run (rate limit, transport error,
its own context exhausted) and it then returns *nothing* — indistinguishable from "finished, nothing to
report". So before integrating, the lead accounts for **every** dispatch: a silent surface is retried
**once**, alone, with the byte-identical prompt (the other surfaces' work is already on disk, so
recovery costs one agent, not a rebuild). Silent twice ⇒ the surface is `dead`: the lead stops speaking
for it and checks the tree instead (that surface's own quiet commands, output redirected), reports it
`DEAD — unverified`, records `"<key>":"dead"` in the metrics line and in
`specs/reports/<id>.build.json`. The batch is never reported as ok. Same rule in `/cohorte-review` (a dead
reviewer lands in the verdict's `unreviewed[]` and forbids `SHIP`) and in `/cohorte-fix` (a dead agent ticks no
checkbox). See [§Dead agents](/reference/profile).

## 4. `/cohorte-review` — audit the diff against the spec

Nothing in the pipeline *runs* the app: the preflight gate (**typecheck + lint + tests via
`preflight.sh`; red aborts with the raw failure, zero agents spawned**) is the mechanical proof,
and anything that needs the app up is yours to exercise by hand before or after this step. Then:

1. The lead computes the diff **once**: one `git diff --stat`, grouped by surface path, then a
   full patch staged per touched surface to `specs/reports/<id>.<surface>.diff`. Reviewers are
   read-only (no Bash) — the staged artifact is how they review hunks instead of whole files.
2. **One `review` agent per touched surface, in parallel.** Checks, in order: spec conformance,
   correctness, security, conventions, RBAC + mobile-first (if enabled), TDD coverage, plus
   language-specific traps (floating promises, mutable default args, `.unwrap()` outside tests,
   un-`ctx`'d goroutines, `UPDATE` without `WHERE`, …).
3. The lead merges reports: severity-ordered findings (deduped), summed counts, worst verdict —
   **`SHIP`** (no CRITICAL, no security) / **`REVISE`** (≥ 1 CRITICAL) / **`BLOCK`** (any
   security vulnerability). Full report staged to `specs/reports/<id>.md`; chat gets only the
   verdict, the severity table, and one-liners for the criticals.

**Deferred findings** are the second half of the report: things the reviewer judges real but **out of
this feature's scope** — pre-existing code the diff never touched, adjacent debt the spec never claims
to fix. They sit in their own `## Deferred` section with an out-of-scope reason each, count in no
severity row, move no verdict, and are never cross-checked. On **every** verdict the lead routes them
into `specs/refactor-backlog.md` under the owning surface's `## <domain>` heading, tagged
`deferred:<id>` — so `/cohorte-refactor <domain>` picks them up, and `/cohorte-review` feeds `/cohorte-audit`'s backlog for
free instead of dropping everything non-blocking. Never into `## Remediation`, which is what `/cohorte-fix`
re-dispatches. What is *not* deferrable: anything the diff touched, any spec violation, any security
issue on a path this feature adds or calls.

On **SHIP**, the lead ticks the verified DoD boxes in the spec and **stamps the freshness gate**:
`reviewed_base` (merge-base SHA) + `reviewed_digest` (hash of exactly the reviewed source) in the
front-matter. Leftover LOW/MEDIUM nits take the same backlog route instead of forcing a fix cycle.

Small re-reviews (≤ 2 files, ~40 lines, no contract/security) take a fast path: the lead verifies
the hunks itself against the open remediation items instead of dispatching.

## 5. `/cohorte-fix` — the scoped loop

Reads the staged report (pasted, from this session, or from `specs/reports/<id>.md` after a
`/clear`), appends findings to the spec's `## Remediation` as `- [ ]` items, then re-dispatches
**only the surfaces owning open items** — each agent gets its items verbatim, reads only the
files they name. If a finding implies the **contract** must change, the lead re-authors it itself
(and falls back to a full `/cohorte-build` only when the change ripples into clean surfaces).

When agents return, the lead ticks `- [x]` what each handoff reports fixed, collapses fully-fixed
rounds to one summary line (the spec stays bounded), and sends you back to `/cohorte-review` for the
re-verdict. Kanban → **Fix**, then back to **Review**.

## 6. `/cohorte-ship` — the human gate

- Confirms the last verdict was **SHIP**; recomputes the freshness digest — **if the source
  changed since the review verdict, it refuses** and sends you back to `/cohorte-review`.
- Verifies the DoD checkboxes; open items require your explicit "ship anyway".
- Asks you to confirm. Then: spec `status: shipped` (before dispatch, so it ships in the same
  commit), and the `release` agent writes conventional commits, pushes (never force), opens the
  PR (`gh` when available, otherwise compare URL + drafted body from the template). It never
  edits source and refuses staged secrets.
- Watches CI (`gh pr checks --watch`); red ⇒ back to `/cohorte-fix`. After the merge, proposes the
  worktree teardown (`scripts/remove-feature.sh <id>`). Kanban → **Shipped**, with the PR number
  written on the card.

## The short way in — `/cohorte-patch` for a bug fix

Steps 1 and 2 exist to *design* something that doesn't exist yet. A bug doesn't need designing: it
is already specified by reality, and putting it through a persona panel and a 300-line contract
interview costs more than the fix. So a bug enters one step earlier and one step lighter:

```
/cohorte-patch → /cohorte-build → /cohorte-review → (/cohorte-fix → /cohorte-review)* → /cohorte-ship
     ↑ human
```

`/cohorte-patch` is a **triage, not an interview**: three questions (repro · expected behaviour ·
what must not change), it locates the cause itself, and it freezes `specs/patch-<slug>.md` —
`kind: patch`, ~60 lines, from `templates/patch.template.md`. With no argument and a board
configured, it offers the **Ideas** column, `[patch]`-titled cards first.

Then **nothing downstream is special-cased**, which is the whole design: a patch spec is a spec, so
build, review, fix and ship consume it unchanged, with the same `/clear` between each. Three lines
read `kind: patch` at all:

- `/cohorte-build` §1.6 judges the **§4 regression test** and the §1 repro instead of contract
  completeness — the test is what the diff gets checked against — and §2 authors no contract when §5
  Contract delta is `none`.
- The `review` agent adds scope creep as a first-class finding: a tidy improvement the spec didn't
  ask for still widens the blast radius of a change that is shipping fast.
- `/cohorte-ship` branches off `vcs.patch_branch_prefix` (`fix/`), defaults the release note to a
  `patch` bump, and the release agent commits `fix(<scope>)`.

A patch may span **several surfaces** — one bug, one repro, one spec. The single hard escalation:
a fix that needs **new** contract surface area is a feature wearing a bug's clothes, and
`/cohorte-patch` sends it to `/cohorte-spec` rather than letting two surfaces invent a shape
independently. Changing an *existing* contract entry is a legitimate §5 delta.

## The disk artifacts, at a glance

`<state>` is the project's pipeline dir: `.claude/` on a Claude Code install, `.cohorte/` on
every other runtime ([Runtimes](/reference/runtimes)).

| Path | Written by | Read by |
| --- | --- | --- |
| `specs/<id>.md` | `/cohorte-spec` (+ `/cohorte-fix` remediation, `/cohorte-review` DoD + freshness stamp) | everyone |
| `specs/patch-<slug>.md` | `/cohorte-patch` (same later writers) | everyone — it *is* a spec, `kind: patch` |
| `specs/design/<id>.md` | `/cohorte-spec` | design surfaces, design tools |
| `<contract.path>/<id>.<ext>` | the lead (`/cohorte-build`, `/cohorte-fix`) | implementers (read-only), reviewers |
| `specs/reports/<id>.md` | `/cohorte-review` (gitignored buffer) | `/cohorte-fix` after a `/clear` |
| `specs/reports/<id>.<surface>.diff` | `/cohorte-review` §1 | the per-surface reviewers |
| `specs/reports/<id>.preflight.txt` | `preflight.sh` | you, on abort |
| `specs/reports/<id>.verdict.json` | `/cohorte-review` §3, every run | you; an external driver — the only machine contract |
| `specs/reports/<id>.readiness.json` | `/cohorte-build` §1.6, every build | you on a `NOT-READY`; an external driver |
| `specs/reports/<id>.build.json` | `/cohorte-build` §4, every batch | you; an external driver (dead implementers) |
| `<state>/pipeline-metrics.jsonl` | `/cohorte-build` `/cohorte-review` `/cohorte-fix` (gitignored) | surface-split decisions, `cohorte metrics` |
| `specs/refactor-backlog.md` | `/cohorte-audit` + `/cohorte-review`'s deferred findings | `/cohorte-refactor` |
| `specs/_decisions.md` | `/cohorte-spec` at freeze, `/cohorte-build` on a surface split | `/cohorte-brainstorm` `/cohorte-spec` `/cohorte-audit` only |
