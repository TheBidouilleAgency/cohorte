# /cohorte-review · PR mode — review an INCOMING pull request (`--pr <num>` or a PR URL)

Loaded by `/cohorte-review` only when its arguments carry `--pr <num>` (or a GitHub PR URL — extract
the number). This is not a pipeline feature: it is **someone else's work arriving**, reviewed with
the same reviewers and the same report format, without pretending it went through the pipeline.
What that changes: **no spec** (reviewers run in audit mode — conventions + correctness + security +
TDD coverage only), **no kanban move, no verdict.json, no DoD tick, no freshness stamp, no metrics
line** — those certify pipeline features. Requires `vcs.host: github` + `gh`; otherwise say so and stop.

1. **Who wrote it — before anything runs.** One Bash call:
   `gh pr view <num> --json title,baseRefName,headRefName,author,isCrossRepository` (relay the one-line
   summary) and `gh api 'repos/{owner}/{repo}/pulls/<num>' --jq .author_association`. **Trusted** =
   `OWNER`, `MEMBER` or `COLLABORATOR`. Anything else — `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`,
   or the call failing — is **untrusted** (fail closed). Installing a PR's dependencies runs its
   lifecycle scripts, and running its tests runs its code: on an untrusted PR that is arbitrary code
   on the human's machine.
   - **Untrusted ⇒ execute nothing from the PR until the human says so.** Default: **static review
     only** — skip step 3's local checks and read the PR's CI instead (`gh pr checks <num>`; a red
     check is a finding exactly as a red local check would be, a pending/absent one is "not verified
     here"). Ask once, naming the risk: "run its install + checks locally (its code executes on this
     machine)?" — only an explicit yes enables step 3, and even then with lifecycle scripts disabled.
   - **Trusted ⇒ step 3 runs**, still with lifecycle scripts disabled by default.
2. **Fetch into a throwaway worktree — never touch the current checkout.**
   `git fetch -f origin pull/<num>/head:cohorte-pr-<num> <baseRefName> && git worktree add ../<repo>-pr-<num> cohorte-pr-<num>`
   — `-f` so a branch left by a crashed earlier run updates instead of failing, and the **base ref is
   fetched too** (the diff is against `origin/<baseRefName>`; a stale local base blames the PR for
   every commit it hasn't rebased onto). Every later step runs `-C` that worktree.
3. **Mechanical checks inside the worktree — the commands directly, NEVER `preflight.sh`** (it stamps
   `<state>/preflight.ok` in the MAIN checkout on purpose; running it here would green pipeline
   dispatches of a tree nobody preflighted). Install first (`commands.install` — a bare `worktree add`
   has no dependencies) **with lifecycle scripts off** (`--ignore-scripts` for npm/pnpm/yarn/bun; no
   equivalent for the stack ⇒ ask before installing at all), then the profile's
   typecheck/lint-quiet/test-quiet, each appended to the worktree's
   `specs/reports/pr-<num>.preflight.txt`, stopping at the first failure. **Red gets no reviewers**
   (a reviewer on code that doesn't compile rediscovers what `tsc` printed) — but it is not an abort:
   the mechanical failures ARE the review (CRITICAL, kind `quality`, the failing command + last lines)
   — jump to step 5. An *environmental* failure (install failed, a missing service, a native build
   that needed its scripts) is "not verifiable here", never a finding against the PR.
4. **Stage + dispatch — `/cohorte-review` §1's staging and §2's dispatch, minus everything
   spec-shaped** (no spec to confirm, no small-diff fast path — an unknown author's diff always gets
   a full reviewer), with three substitutions: the diff is `git diff origin/<baseRefName>...HEAD`
   (**three-dot** — only the PR's own commits; a PR is commits, so the untracked-file problem
   `feature-diff.sh` solves does not arise), staged diffs and file paths are **absolute paths into
   the worktree** (reviewers are stateless — they must not read the main checkout), and the
   dispatch's spec/contract slots read
   `spec: none (incoming PR — audit mode: PIPELINE.md conventions + quality/security/TDD only, skip spec conformance)` · `contract: none`.
   Roll call + merge per §3 (retry once, `unreviewed` forbids a clean verdict), same capped REVIEW REPORT.
5. **Stage the report to the MAIN checkout's `specs/reports/pr-<num>.md`** (it must outlive the
   worktree), print the verdict + severity table + CRITICAL/security digests, and say which checks
   were run locally, read from CI, or not verified. Then — **always ask first, posting is
   outward-facing** — offer `gh pr comment <num> --body-file specs/reports/pr-<num>.md` (body prefixed
   `Automated review — cohorte pipeline (advisory)`). "No" leaves the report on disk; that is complete.
6. **Teardown, always** (also after a red check, a declined run or a dead reviewer):
   `git worktree remove --force ../<repo>-pr-<num> && git branch -D cohorte-pr-<num>`.
