## Spec status — the lifecycle state machine

A spec's front-matter `status` is not a label, it is the pipeline's **state**: every command routes on
it, `cohorte specs` boards on it, and the kanban backfill maps it to a column. Eight states:

| status | meaning | written by | who may build it |
| --- | --- | --- | --- |
| `draft` | the interview is open, nothing is frozen | `/cohorte-spec` Mode A | no |
| `frozen` | the contract is frozen — the handoff to `/cohorte-build` | `/cohorte-spec` Mode A freeze | yes |
| `in-progress` | a round is under way on this spec (or died mid-way) | an automated driver, if any | yes |
| `in-review` | reviewed / awaiting the next round or `/cohorte-ship` | `/cohorte-spec` Mode B, `/cohorte-fix` | yes |
| `blocked` | a round gave up here (non-convergent, no verdict, not implementable) | an automated driver, if any | yes, with the reason named |
| `shipped` | the PR is open; the status flip is part of the release commit | `/cohorte-ship` | no |
| `merged` | the PR merged — reconciled from `gh pr view`, never assumed | `/cohorte-ship` §0/§5, `/cohorte-doctor` reconcile | no |
| `abandoned` | the feature was dropped (PR closed unmerged, or never shipped) — the human's call | `/cohorte-ship` §0, the human | no |

**`merged` and `abandoned` close the lifecycle.** `shipped` only says a PR was opened; whether it
landed is a fact on the host, so it is **reconciled**, not guessed: `/cohorte-ship` re-entered on a
`shipped` spec and `/cohorte-doctor` both run `gh pr view <branch> --json state` — `MERGED` ⇒
`merged`; `CLOSED` unmerged ⇒ the human decides (reopen and continue, or `abandoned`). Both are
terminal: every builder refuses them, the kanban backfill maps them to `shipped`, and a worktree
still alive for one is a teardown candidate.

**`in-progress` and `blocked` are driver states.** No conversational command writes them — the
human-driven cycle moves `frozen` → `in-review` → `shipped` → `merged`. Their producer is the
**loop workflow** (`cohorte-loop.js`, from `core/workflows/loop.js` — the successor of the
2.2.0-retired conversational driver): it stamps `in-progress` at each round, `in-review` when a
run ends at zero blocking findings, and `blocked` when a round gives up, with the reason in
`specs/reports/<id>.loop.json`. A **resumable** stop (a dead agent, a red preflight, an
unreviewed surface, a report that never landed) writes `reason` and **no** `outcome`, and
re-invoking the loop resumes at that round; a **terminal** one (treading water, max rounds, a
contract-change finding) writes both, and the next run starts fresh once a human re-entered
through `/cohorte-fix` or `/cohorte-build` (which rewrites `readiness.json` after `loop.json`).
External drivers may write these states too. Every reader routes on
them either way, and a stamp on a spec with no front-matter stays a silent no-op — no driver
dies over a status line.

**`kind` — feature (default) or `patch`.** Orthogonal to `status`, and — with `migrations`
(below) — the only other front-matter field commands route on. `/cohorte-patch` freezes `specs/patch-<slug>.md` with `kind: patch` from
`templates/patch.template.md`: a ~60-line bug spec whose §4 **regression test** replaces §5 CONTRACT
as the thing the diff is checked against. It moves through the same states and the same commands —
`/cohorte-build` → `/cohorte-review` → `/cohorte-fix`* → `/cohorte-ship` — which is the whole design:
a patch is a spec, so nothing downstream is special-cased beyond three lines.

| what reads `kind: patch` | what it does differently |
| --- | --- |
| `/cohorte-build` §1.6 | judges §1 repro + §4 regression test instead of contract completeness; gap check `repro` |
| `/cohorte-build` §2 | authors no contract when §5 Contract delta is `none` (the usual case) |
| `/cohorte-ship` §1/§2b/§3 | branches off `vcs.patch_branch_prefix`; a `patch` bump by default; `fix(<scope>)` commit |

A patch may span **several surfaces** — one bug, one repro, one spec. What it may never do is add
**new** contract surface area: two surfaces agreeing on a shape that doesn't exist yet is what §5 is
for, so `/cohorte-patch` routes that to `/cohorte-spec` instead. Changing an *existing* contract entry
is a legitimate delta. The patch template keeps contract on **§5** and acceptance on **§9** — the two
numbers `review.md` and `implementer.template.md` name verbatim — and simply has no §8.

**`migrations` — `true` when the spec changes the database.** The third routed field. `/cohorte-spec`
sets it when §4 adds or alters a migration (or the contract changes what is persisted); absent
means `false`. It makes `## Rollback` mandatory — `/cohorte-ship` refuses the spec while
`verify-run.sh rollback-check` calls it empty — and makes `/cohorte-verify` run the migration (and its
down-then-up) on the dev database. See `<core>/pipeline/schema/verify.md`. `/cohorte-revert` reads
`## Rollback` for a `merged` spec and, on the human's word, sets `status: abandoned` inside the revert
commit — so the spec says so only if the revert actually merges.

Corollaries worth knowing:

- A spec with no front-matter makes every stamp a **silent no-op** — the state is bookkeeping, and the
  loop must never die over a status line.
- Child commands write `status` too (`/cohorte-fix` sets `in-review`); re-stamping before each phase is what
  keeps `in-progress` true for the duration of the run rather than for its first phase.
- `blocked` is not a failure to hide: `/cohorte-build` accepts it, names the `loop.json` reason, routes
  by the spec's `## Remediation` (open items ⇒ `/cohorte-fix`), and sets `in-review` once its readiness
  verdict is written. `/cohorte-build <id> --readiness-only` does that re-entry (checks, readiness,
  contract) without dispatching anything — the loop then builds.
