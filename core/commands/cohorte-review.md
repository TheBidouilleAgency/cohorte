---
model: sonnet
description: Dispatch the read-only review agent to audit the feature against its frozen spec.
argument-hint: <feature_id> | --pr <num>
---

You are the **lead**. Dispatch the review for feature **$ARGUMENTS**.

> Read `PIPELINE.md` §`vcs.default_branch` (diff base) and the `surfaces`/`contract`/`commands` fields.
> _Skip the re-read if it's already in your context this session and unmodified since._
>
> **Kanban** (`<core>/pipeline/schema/kanban.md`): run
> `<core>/pipeline/scripts/kanban-move.sh auto $ARGUMENTS review`. `auto` resolves the board from the config itself and
> exits 0 with a `kanban: <reason>` line when there is none — so **never decide "no board is
> configured" without running it**. _(PR mode — `--pr` below — skips this entirely: an incoming
> PR is not a pipeline feature and has no card.)_
>
> **Workflow variant** (opt-in — `<core>/pipeline/schema/workflows.md`): on Claude Code ≥ 2.1.154 with workflows
> enabled, the human can ask to "run the review workflow" (`<core>/workflows/review.js`) instead.
> This conversational path stays the default and the fallback; `/cohorte-doctor` shows which is available.

## PR mode (`--pr <num>` or a PR URL) — load its step file, only then

If `$ARGUMENTS` carries `--pr <num>` (or a GitHub PR URL), this is an **incoming** pull request, not
a pipeline feature: read `<core>/templates/steps/review-pr/01-pr-mode.md` and follow it **instead of**
§0–§3.5 below (it reuses §1's staging and §2/§3's dispatch and roll call, and says where). It decides
whether the PR's code may run on this machine before anything executes. No `--pr` ⇒ never read it.

Everything below this line is the normal pipeline-feature flow.

## 0. Deterministic pre-flight — no agents while red

Run the profile's mechanical gates in ONE Bash call via the shipped script
(`<core>/pipeline/scripts/preflight.sh`); note the epoch (`date +%s`) in the same call — §3's
metrics line needs it:

```
<core>/pipeline/scripts/preflight.sh specs/reports/$ARGUMENTS.preflight.txt \
  "<commands.typecheck>" "<commands.lint_quiet, else lint>" "<commands.test_quiet, else test>"
```

- **Non-zero exit** ⇒ the script already printed the raw last-40 lines. **STOP: relay them verbatim
  and spawn NO agent** — a compiler/test failure needs `/cohorte-fix` (or the human), not a review that
  rediscovers it at agent prices. This abort is the whole point of the step. Before stopping, write
  the **aborted verdict** (§3's contract, degraded form) so an automated driver gets a diagnosis
  rather than silence:
  `{"id":"$ARGUMENTS","phase":"review","ts":"<ISO>","aborted":"preflight","verdict":"BLOCK","blocking":null}`
  → `specs/reports/$ARGUMENTS.verdict.json`. One `printf`, in the same Bash call.
- **Zero exit** ⇒ it stamped `<state>/preflight.ok`, which the gate hook checks before letting
  `cohorte-review` dispatches through (`<core>/pipeline/schema/preflight.md`). Continue.
- Script absent (older core) ⇒ run the three commands yourself, each redirected into
  `specs/reports/$ARGUMENTS.preflight.txt`, aborting on the first failure the same way.

## 1. Gather the inputs for stateless reviewers

- Confirm `specs/$ARGUMENTS.md` exists. Front-matter **`kind: refactor`** (written by
  `/cohorte-refactor` at the end of a round) ⇒ no contract: the reviewer checks behaviour
  preservation, conventions and over-engineering against §6's backlog items instead of a contract
  (its own check 1). Everything else below is unchanged.
- **Every diff comes from `<core>/pipeline/scripts/feature-diff.sh`, never a bare `git diff`**
  (`<core>/pipeline/schema/feature-diff.md`): feature work is uncommitted until ship, and `git diff <ref>` drops
  every untracked file and diffs against the branch tip, not the merge-base. Non-zero exit ⇒ **stop
  and relay it** (exit 3 = base unresolvable); script absent ⇒ stop (`cohorte update`). Never fall
  back to `git diff`.
- **List the changed paths ONCE, patches only for retained surfaces.** One call:
  `<core>/pipeline/scripts/feature-diff.sh --default <default_branch> --numstat > specs/reports/$ARGUMENTS.stat.txt`
  (`added<TAB>deleted<TAB>path`, full paths), then group the paths by `surfaces[].path` prefix with
  one `awk` over that file — deterministic, never file by file. Paths under no surface (contract
  file, root config) are the **`shared` remainder**: attach them to the most relevant surface's
  reviewer and say so in its dispatch. A surface with no changed paths gets no reviewer and no
  `.diff`. **An empty list is not a SHIP:** nothing was reviewed, so nothing is certified — write the
  aborted verdict `{"id":"$ARGUMENTS","phase":"review","ts":"<ISO>","aborted":"empty-diff","verdict":"BLOCK","blocking":null}`
  to `specs/reports/$ARGUMENTS.verdict.json` (it overwrites a stale one), say the diff is empty
  (unbuilt feature? wrong branch?), and stop.
- **Stage the hunks once per touched surface** (reviewers have no Bash — the staged file is the
  only way they read hunks instead of whole files). Regenerated every round:
  `<core>/pipeline/scripts/feature-diff.sh --default <default_branch> --patch -- <surface.path> [<remainder paths>] > specs/reports/$ARGUMENTS.<surface.key>.diff`.
  Never print a diff into your own context.

## 2. Dispatch review agents — one per touched surface, IN PARALLEL

Spawn ONE `cohorte-review` agent per surface that has changed files, in a **single message** (one dispatch
each, like `/cohorte-build`) so they run concurrently — NEVER serially: review wall-clock must be the
slowest surface, not the sum. A diff touching a single surface ⇒ a single reviewer.

**Small-diff fast path (re-reviews only):** if a surface's staged diff is tiny (≤2 files and ≤~40
changed lines), touches no contract file, and every open finding it addresses is non-security
LOW/MEDIUM, skip the dispatch: verify the hunks yourself against the open Remediation items (did the
prescribed fixes land? — NOT a de-novo audit) and write the same REVIEW REPORT into the §3 flow.
First-round reviews, contract changes, and security findings always get a full reviewer. For each
reviewed surface:

Keep the dispatch prompt **byte-identical across features and rounds** except the variable block,
which sits at the END so every repeat hits the prompt-cache prefix:

> `subagent_type: cohorte-review` — "Review one feature surface against its frozen spec. Read `PIPELINE.md`
> first (flags + the §Conventions/§Testing slice for your scope). Check spec conformance first, then
> correctness, security, conventions, RBAC/mobile-first _if the profile enables them_, and TDD
> coverage. Your dispatch names a staged diff file — read it FIRST; open a full source file only when
> a finding demands it. Emit the REVIEW REPORT in the capped format your agent instructions define —
> every finding self-sufficient (`file:line` · severity · type · one-line concrete fix), no code
> excerpts. — Variable slots: feature `$ARGUMENTS` · scope: the `<surface.key>` surface only · spec:
> `specs/$ARGUMENTS.md` (source of truth) · contract: `<contract.path>/$ARGUMENTS.<ext>` (`none` on `kind: refactor`) · staged
> diff: `specs/reports/$ARGUMENTS.<surface.key>.diff` · changed files: <list>."

## 3. Merge & relay the verdict

**Roll call FIRST — a dead reviewer is not a clean surface** (`<core>/pipeline/schema/dead-agents.md`: its zero
findings are byte-identical to a clean surface's). Every surface dispatched in §2 must come back
with a REVIEW REPORT:

- **Retry a silent surface ONCE**, byte-identical dispatch. Most deaths are transient, and the staged
  diff is already on disk — the retry costs one agent, not a re-review.
- **Silent twice ⇒ that surface is `unreviewed`.** Name it in the report under
  `## NOT reviewed (no verdict on these)`, list it in the verdict JSON's `unreviewed`, and **refuse to
  score `SHIP`** — the merged verdict is at least `REVISE`. Absence of evidence is not evidence of
  absence, and it must never reach `/cohorte-ship` or tick a DoD box.
- **Never re-review the other surfaces** to compensate: their reports are valid and already on disk.

Then merge the returned reports into **one** REVIEW REPORT (same template): findings concatenated and
re-ordered by severity, counts summed, duplicates collapsed, and the verdict **recomputed from the
merged findings** by the one verdict rule (`cohorte-review` agent §Severity & verdict: any security ⇒
`BLOCK`, else any CRITICAL ⇒ `REVISE`, else `SHIP`; plus the roll call's "never `SHIP` with a surface
unreviewed") — never "the worst verdict a reviewer returned", which can disagree with the counts.
Each surface's verdict in the JSON is the same rule over that surface's findings. The `## Deferred` sections merge the same way (dedupe by
`file` + problem) and stay **out of the severity table and out of the verdict** — see §3.5, which
routes them. Append ONE metrics line for the batch to the **main checkout's**
`$(dirname "$(git rev-parse --git-common-dir)")/<state>/pipeline-metrics.jsonl` (rules in
`/cohorte-build` §4; never a bare relative path — from a worktree that strands the lines): `{"ts":"<ISO>","feature":"$ARGUMENTS","phase":"review","seconds":<wall-clock>,"surfaces":{"<key>":"<verdict>:<finding count>",…}}`.
**Stage the full report to `specs/reports/$ARGUMENTS.md`** (overwrite) — a gitignored buffer so a
`/cohorte-fix` after a `/clear` can still read the findings; the `specs/reports/` subfolder is skipped by the
non-recursive `specs/*.md` glob, so it's never mistaken for a spec (no phantom card, no bogus stage).
**Write the machine-readable verdict** to `specs/reports/$ARGUMENTS.verdict.json` (overwrite) — on
**every** run, including the small-diff fast path of §2 and a `SHIP`. This file is the ONLY contract
between the pipeline and any automated driver, which parses no prose:

```json
{ "id": "$ARGUMENTS", "phase": "review", "ts": "<ISO>", "verdict": "REVISE",
  "findings": 7, "blocking": 2, "security": 1, "deferred": 3, "unreviewed": [],
  "severity": {"CRITICAL": 1, "HIGH": 2, "MEDIUM": 3, "LOW": 1},
  "surfaces": {"backend": {"verdict":"BLOCK","findings":4,"blocking":2}},
  "blocking_items": ["backend|apps/api/src/routes/order.ts|missing authz on post"],
  "fingerprint": "b3f1c2a90d4e5f67" }
```

- **`blocking` = CRITICAL findings + `security` findings, deduplicated** (a finding that is both
  counts once) — the verdict rule restated as a number, so with `unreviewed` empty,
  `blocking == 0` ⟺ `verdict == SHIP`. HIGH/MEDIUM/LOW quality findings are **not** blocking and
  never cost a driver an iteration — a *human* routes them (the table below); a driver ignores them.
- **`blocking_items`** — one normalized string per **distinct** blocking finding (deduplicated —
  two findings sharing surface, file and problem head are one identity), `<surface>|<file>|<problem>`:
  the file path **without the `:line`** (a fix that inserts lines shifts every line below it — a
  line-bearing identity would change every pass and the drift detection would never fire), and the
  **problem**, not the fix, cut to its first 8 words, lowercased, every run of non-alphanumerics
  collapsed to one space. Identity of a finding, not its wording.
- **`fingerprint`** — computed in the same Bash call, never by hand:
  `printf '%s\n' "<item>" … | LC_ALL=C sort | sha256sum | cut -c1-16` (`shasum -a 256` where there
  is no `sha256sum`). Empty list ⇒ `""`. A driver comparing two consecutive fingerprints detects a
  fix loop that is treading water.
- **`deferred`** — the count of merged `## Deferred` items §3.5 parked in the backlog. Informational:
  it never enters `blocking`, so it can never cost a driver an iteration.
- **`unreviewed`** — the surface keys whose reviewer died twice, `[]` on a complete run. It is
  **separate from `blocking` on purpose**: `blocking` counts real findings (CRITICAL + security), and
  faking a number there to force a driver's hand would corrupt the one field the whole contract rests
  on. A non-empty `unreviewed` means "this run does not cover everything" — a driver treats it as no
  usable verdict, never as clean, whatever `blocking` says.

## 3.5 Route the deferred findings — the backlog, not the fix loop

Do this on **every** run, before the verdict branch below, and whatever the verdict — a deferred
finding that is only routed on a `SHIP` is a deferred finding lost on every other verdict, which is
exactly the leak this step closes. Append each merged `## Deferred` item to
**`specs/refactor-backlog.md`**, under the `## <domain>` heading of the surface that owns its
`file:line` (create the file and/or heading if absent — same grouping `/cohorte-audit` writes, so
`/cohorte-refactor <domain>` picks them up with no extra plumbing):

```
- [ ] <SEVERITY> · <file:line> · <quality|security|rule|complexity> · <concrete fix> · deferred:$ARGUMENTS
```

- **Never into the spec's `## Remediation`** — that list is what `/cohorte-fix` re-dispatches, so a
  deferred item there would re-trigger the very fix round it was deferred out of.
- **Dedupe before appending:** `grep -F` the backlog for the item's `<file>` + the first words of its
  problem; already there (from a prior round or an `/cohorte-audit`) ⇒ skip it, don't stack duplicates round
  after round.
- Write in ONE Bash call: insert each line directly under its `## <domain>` heading with one `awk`
  pass (heading absent ⇒ append a new `## <domain>` block with `>>` — a bare `>>` lands under
  whichever domain happens to be last). Never read the whole backlog into context to rewrite it.
- Report it as **one line** in chat: `deferred: <n> parked in specs/refactor-backlog.md (<domains>)`.

In chat print ONLY: the verdict, the severity-count table, a one-line digest of each CRITICAL/security
finding, and `Full report: specs/reports/$ARGUMENTS.md` — never echo the findings body into chat (it
would sit in this session's history, re-sent every turn). Then route on **the verdict and the worst
surviving severity** — exactly one row applies:

| verdict | worst surviving finding | DoD tick + freshness stamp | next |
| --- | --- | --- | --- |
| `REVISE` / `BLOCK` | any | no | `/cohorte-fix $ARGUMENTS` |
| `SHIP` | `HIGH` or `MEDIUM` | **no** — not a clean bill | `/cohorte-fix $ARGUMENTS`, or park MEDIUMs (below) |
| `SHIP` | `LOW` or none | **yes** — the clean bill | `/cohorte-ship $ARGUMENTS` |

(`SHIP` is only reachable with `unreviewed` empty — the roll call forbids it otherwise.)

- **`/cohorte-fix` route** — it appends the report to the spec's `## Remediation` and re-dispatches
  ONLY the surfaces with findings. The full path (`/cohorte-spec` Mode B then `/cohorte-build`) remains
  for findings that change the contract in ways that ripple into clean surfaces. The report is
  staged, so you can `/clear` first — `/cohorte-fix` reads the findings back from disk.
- **Parking MEDIUMs** — only MEDIUMs the human *explicitly* chooses to live with (never a HIGH, never
  CRITICAL/security): route each through §3.5 (the backlog, `deferred:$ARGUMENTS`), then **rewrite
  `verdict.json` to match** — subtract them from `findings` and `severity.MEDIUM`, add them to
  `deferred`, add `"parked": <n>` — so `/cohorte-ship`, which reads that file, sees what you decided.
  Once nothing above LOW is left, apply the clean bill below.
- **The clean bill** (the pipeline certifying what ships — never written over a known HIGH/MEDIUM):
  - **Tick the DoD**: in `specs/$ARGUMENTS.md` §`Acceptance criteria / DoD`, flip `- [ ]` → `- [x]`
    for the criteria the pipeline actually verified — spec conformance + `ui_language` copy (this
    review), tests · lint · typecheck (a green `/cohorte-build`), mobile-first as far as the code
    shows it. On `kind: refactor`: behaviour preserved + items cleared (this review), tests · lint ·
    typecheck green (§0's preflight — no `/cohorte-build` ran). **Leave `- [ ]` (and say which) any item no stage verified** — nothing in the pipeline
    *runs* the feature, so a criterion that needs the app up stays open unless the human says they
    exercised it by hand. Ticking is the lead's job (the reviewer is read-only).
  - **Stamp the freshness gate** so `/cohorte-ship` can refuse code edited after this verdict:
    `BASE=$(<core>/pipeline/scripts/feature-diff.sh --default <default_branch> --base-only)`, then
    write into the spec front-matter `reviewed_base: $BASE` and
    `reviewed_digest: $(<core>/pipeline/scripts/feature-diff.sh --base $BASE --digest)` — the
    fingerprint of exactly the source you reviewed, untracked files included (`specs/` and
    `.claude/` excluded, so DoD ticks and the ship status flip don't trip it).
  - Park the leftover LOWs through §3.5 (never as `## Remediation` items — those re-trigger the fix
    loop), then tell the human they can `/cohorte-ship` — **recommend a `/clear` first**.
