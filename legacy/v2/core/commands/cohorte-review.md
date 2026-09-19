---
model: sonnet
description: Dispatch the read-only review agent to audit the feature against its frozen spec.
argument-hint: <feature_id>
---

You are the **lead**. Dispatch the review for feature **$ARGUMENTS**.

> Read `PIPELINE.md` §`vcs.default_branch` (diff base) and the `surfaces`/`contract`/`commands` fields.
> _Skip the re-read if it's already in your context this session and unmodified since._
>
> **Kanban** (SCHEMA.md §Kanban): run
> `<core>/pipeline/scripts/kanban-move.sh auto $ARGUMENTS review`. `auto` resolves the board from the config itself and
> exits 0 with a `kanban: <reason>` line when there is none — so **never decide "no board is
> configured" without running it**. _(PR mode — `--pr` below — skips this entirely: an incoming
> PR is not a pipeline feature and has no card.)_
>
<!-- cohorte:if workflows -->
> **Workflow variant** (opt-in — SCHEMA.md §Workflows): on Claude Code ≥ 2.1.154 with workflows
> enabled, the human can ask to "run the review workflow" (`<core>/workflows/review.js`) instead.
> This conversational path stays the default and the fallback; `/cohorte-doctor` shows which is available.
<!-- cohorte:endif -->

## PR mode — review an INCOMING pull request (`--pr <num>` or a PR URL)

If `$ARGUMENTS` contains `--pr <num>` (or a GitHub PR URL — extract the number), this is not a
pipeline feature: it is **someone else's work arriving**, reviewed with the same reviewers and the
same report format, without pretending it went through the pipeline. What that changes, explicitly:
**no spec** (nothing to check conformance against — reviewers run in audit mode: conventions +
correctness + security + TDD coverage only), **no kanban move**, **no verdict.json**, **no DoD
tick, no freshness stamp, no metrics line** — those certify pipeline features, and this is not one.
Requires `vcs.host: github` + `gh`; otherwise say so and stop.

1. **Fetch into a throwaway worktree — never touch the current checkout.** One Bash call:
   `gh pr view <num> --json title,baseRefName,headRefName,author` (relay the one-line summary), then
   `git fetch -f origin pull/<num>/head:cohorte-pr-<num> <baseRefName> && git worktree add ../<repo>-pr-<num> cohorte-pr-<num>`
   — `-f` so a branch left behind by a crashed earlier run updates instead of failing, and the
   **base ref is fetched too**: the diff below is against `origin/<baseRefName>`, and a stale
   local base blames the PR for every commit it merely hasn't rebased onto yet.
   The human's tree, branch and stamps stay untouched; every later step runs `-C` that worktree.
2. **Mechanical checks inside the worktree — the commands directly, NEVER `preflight.sh`.** The
   script's whole point is stamping `<state>/preflight.ok` in the MAIN checkout (it resolves
   through `git-common-dir` on purpose), so running it here would overwrite the human's stamp
   with the PR tree's digest — greening pipeline review dispatches of a tree nobody preflighted,
   then blocking them once the worktree is gone. Instead: install dependencies first
   (`commands.install` — a bare `worktree add` has no `node_modules`), then run the profile's
   typecheck/lint-quiet/test-quiet yourself, each appended to the worktree's
   `specs/reports/pr-<num>.preflight.txt`, stopping at the first failure. **Red does NOT get
   reviewers** — same economics as §0 (a reviewer on code that doesn't compile rediscovers what
   `tsc` printed for free) — but unlike §0 it is not an abort: the mechanical failures ARE the
   review (severity CRITICAL, kind `quality`, the failing command + last lines) — jump to
   step 4. An *environmental* failure (install itself failed, a missing service) is reported as
   "not verifiable here", never as a finding against the PR.
3. **Stage + dispatch — §1's staging procedure and §2's dispatch, minus everything spec-shaped**
   (there is no `specs/<id>.md` to confirm and no small-diff fast path — an unknown author's
   diff always gets a full reviewer), with three substitutions: the diff is
   `git diff origin/<baseRefName>...HEAD` (**three-dot** — only the PR's own commits, not the
   base's drift), staged diffs and file paths are **absolute paths into the worktree**
   (reviewers are stateless — they must not read the main checkout), and the dispatch template's
   spec/contract slots read
   `spec: none (incoming PR — audit mode: PIPELINE.md conventions + quality/security/TDD only,
   skip spec conformance)` · `contract: none`. Roll call + merge per §3 (retry once, `unreviewed`
   forbids a clean verdict), same capped REVIEW REPORT.
4. **Stage the report to the MAIN checkout's `specs/reports/pr-<num>.md`** (it must outlive the
   worktree), print the verdict + severity table + CRITICAL/security digests in chat. Then —
   **always ask the human first, posting is outward-facing** — offer:
   `gh pr comment <num> --body-file specs/reports/pr-<num>.md` (prefix the body with one line:
   `Automated review — cohorte pipeline (advisory)`). Never post without the explicit go-ahead;
   "no" leaves the report on disk and that is a complete outcome.
5. **Teardown, always** (also after a red preflight or a dead reviewer):
   `git worktree remove --force ../<repo>-pr-<num> && git branch -D cohorte-pr-<num>`.

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
<!-- cohorte:if hooks -->
- **Zero exit** ⇒ it stamped `<state>/preflight.ok`, which the gate hook checks before letting
  `review` dispatches through (SCHEMA.md §Preflight). Continue.
<!-- cohorte:else -->
- **Zero exit** ⇒ it stamped `<state>/preflight.ok`. Nothing enforces that stamp on this runtime, so
  §2 does not start until you have seen this line: a review of red code is the one failure mode this
  step exists to prevent, and here only you can prevent it (SCHEMA.md §Preflight). Continue.
<!-- cohorte:endif -->
- Script absent (older core) ⇒ run the three commands yourself, each redirected into
  `specs/reports/$ARGUMENTS.preflight.txt`, aborting on the first failure the same way.

## 1. Gather the inputs for stateless reviewers

- Confirm `specs/$ARGUMENTS.md` exists.
- **Compute the diff ONCE — `--stat` first, patches only for retained surfaces.** One call:
  `git diff <default_branch> --stat > specs/reports/$ARGUMENTS.stat.txt`, then grep that file to
  group the changed paths by `surfaces[].path` prefix (deterministic — don't reason it out file by
  file). Paths under no surface (contract file, root config) are the **`shared` remainder**: attach
  them to the most relevant surface's reviewer and say so in its dispatch. A surface with no changed
  paths gets no reviewer — and no `.diff` is ever generated for it.
- **Stage the hunks once per touched surface** (reviewers are read-only — no Bash — so the staged
  diff file is the ONLY way they can review hunks instead of re-reading whole files, and staging it
  here means N reviewers never re-run git N times). Regenerated every round:
  `git diff <default_branch> -- <surface.path> > specs/reports/$ARGUMENTS.<surface.key>.diff`
  (same gitignored buffer dir as the reports). For the surface that carries the shared remainder,
  append the remainder pathspecs to its command so its `.diff` includes them. Never print a diff into
  your own context — redirect straight to the file.

## 2. Dispatch review agents — one per touched surface, IN PARALLEL

Spawn ONE `review` agent per surface that has changed files, in a **single message** (one dispatch
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

> `subagent_type: review` (or this runtime's equivalent) — "Review one feature surface against its frozen spec. Read `PIPELINE.md`
> first (flags + the §Conventions/§Testing slice for your scope). Check spec conformance first, then
> correctness, security, conventions, RBAC/mobile-first _if the profile enables them_, and TDD
> coverage. Your dispatch names a staged diff file — read it FIRST; open a full source file only when
> a finding demands it. Emit the REVIEW REPORT in the capped format your agent instructions define —
> every finding self-sufficient (`file:line` · severity · type · one-line concrete fix), no code
> excerpts. — Variable slots: feature `$ARGUMENTS` · scope: the `<surface.key>` surface only · spec:
> `specs/$ARGUMENTS.md` (source of truth) · contract: `<contract.path>/$ARGUMENTS.<ext>` · staged
> diff: `specs/reports/$ARGUMENTS.<surface.key>.diff` · changed files (`--stat`): <list>."

§0's preflight call already gave you the wall-clock start (`date +%s` in the same call) — §3's
metrics line needs it.

## 3. Merge & relay the verdict

**Roll call FIRST — a dead reviewer is not a clean surface.** Every surface you dispatched in §2 must
come back with a REVIEW REPORT. A reviewer that died (rate limit, transport error, exhausted context)
returns **nothing**, and zero findings from a dead reviewer is byte-identical to zero findings from a
genuinely clean one — which is how "every reviewer crashed" reads as the strongest possible verdict
from no evidence at all (SCHEMA.md §Dead agents). So:

- **Retry a silent surface ONCE**, byte-identical dispatch. Most deaths are transient, and the staged
  diff is already on disk — the retry costs one agent, not a re-review.
- **Silent twice ⇒ that surface is `unreviewed`.** Name it in the report under
  `## NOT reviewed (no verdict on these)`, list it in the verdict JSON's `unreviewed`, and **refuse to
  score `SHIP`** — the merged verdict is at least `REVISE`. Absence of evidence is not evidence of
  absence, and it must never reach `/cohorte-ship` or tick a DoD box.
- **Never re-review the other surfaces** to compensate: their reports are valid and already on disk.

Then merge the returned reports into **one** REVIEW REPORT (same template): findings concatenated and
re-ordered by severity, counts summed, duplicates collapsed, verdict = the worst returned
(`BLOCK` > `REVISE` > `SHIP`). The `## Deferred` sections merge the same way (dedupe by
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
  counts once). That is exactly the agent's existing verdict rule restated as a number, so
  `blocking == 0` ⟺ `verdict == SHIP`. HIGH/MEDIUM/LOW quality findings are **not** blocking and
  must never cost a driver an iteration — a *human* routes them in the verdict branch below
  (a `/cohorte-fix` pass, or a deliberate park in the backlog); a driver ignores them.
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
- Append with `>>` in ONE Bash call; never read the whole backlog into context to rewrite it (it grows
  with every audit the repo has ever run).
- Report it as **one line** in chat: `deferred: <n> parked in specs/refactor-backlog.md (<domains>)`.

In chat print ONLY: the verdict, the severity-count table, a one-line digest of each CRITICAL/security
finding, and `Full report: specs/reports/$ARGUMENTS.md` — never echo the findings body into chat (it
would sit in this session's history, re-sent every turn). Then:

- **SHIP** → only reachable with `unreviewed` empty (the roll call above forbids it otherwise).
  **Split on what survived — the DoD tick and the freshness stamp are earned by a clean bill, not
  by the verdict alone** (the workflow variant enforces the same rule; certifying surviving
  HIGH/MEDIUM findings for `/cohorte-ship` would ship known defects):
  - **Nothing above LOW survived** — the clean bill. **Tick the DoD**: in `specs/$ARGUMENTS.md`
    §`Acceptance criteria / DoD`, flip each `- [ ]` → `- [x]` for the criteria the pipeline has
    actually verified — spec conformance + `ui_language` copy (this review), tests · lint ·
    typecheck (a green `/cohorte-build`), mobile-first as far as the code shows it (this review).
    **Leave `- [ ]` (and say which) any item no stage actually verified** — nothing in the pipeline
    *runs* the feature, so any criterion that needs the app up (runtime flows, a visual check
    against the design) stays open unless the human says they exercised it by hand and it held.
    Ticking is the lead's job (the reviewer is read-only). **Then stamp the freshness gate** so
    `/cohorte-ship` can refuse to ship code edited after this verdict: compute
    `BASE=$(git merge-base <default_branch> HEAD)` and write into the spec front-matter
    `reviewed_base: $BASE` plus `reviewed_digest: $(git diff $BASE -- . ':(exclude)specs/' | sha256sum | cut -c1-16)`
    (`shasum -a 256` then the first 16 hex chars where there is no `sha256sum` — macOS) — the
    fingerprint of exactly the source you just reviewed (specs excluded, so DoD ticks + the ship
    status flip don't trip it). Park the leftover LOWs through §3.5's exact route (the backlog,
    under their surface's domain heading, tagged `deferred:$ARGUMENTS` — never as open
    `## Remediation` items, which would re-trigger the fix loop). Then tell the human they can
    `/cohorte-ship` — **recommend a `/clear` first**, the handoff is fully on disk.
  - **HIGH or MEDIUM findings survived** — the verdict stays SHIP (they are not blocking), but
    **no DoD tick and no freshness stamp**. Route them: `/cohorte-fix $ARGUMENTS` for what should
    be fixed now; MEDIUMs the human *explicitly* chooses to live with go through §3.5's park
    instead — and once everything left is LOW, apply the clean-bill branch above (tick, stamp,
    ship). The stamp is the pipeline certifying what ships; it is never written over known
    HIGH/MEDIUM defects.
- **REVISE / BLOCK**, or any CRITICAL/HIGH/security finding → tell the human to run
  **`/cohorte-fix $ARGUMENTS`** — it appends the report to the spec's `## Remediation` and re-dispatches ONLY
  the surfaces with findings. The full path (`/cohorte-spec` Mode B then `/cohorte-build`) remains for findings that
  change the contract in ways that ripple into clean surfaces. _The report is staged to
  `specs/reports/$ARGUMENTS.md`, so you can `/clear` before `/cohorte-fix` — it reads the findings back from
  disk._
