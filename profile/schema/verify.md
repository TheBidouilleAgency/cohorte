## Verify — "does it actually work", migrations and rollback

The preflight proves the code compiles and its tests pass; the review proves the diff matches
the spec. Neither starts the app, so runtime DoD items (the page renders, the migration rolls
back, the repro is gone) were never ticked by the pipeline. `/cohorte-verify <id>` is that step,
between a `SHIP` verdict and `/cohorte-ship`. It moves no kanban card: the board has no column
for it, and the card stays in Review.

### Configured

Verify applies when `verify.enabled` is not `false` and the profile has
`commands.smoke`, `commands.e2e`, or `commands.dev` **with** `commands.dev_ready` (a server nobody
probes proves nothing). A spec with `migrations: true` and a `commands.migrate` counts too. Not
configured ⇒ `/cohorte-verify` says so and stops, and `/cohorte-ship` skips its runtime gate
silently.

### The script

`<core>/pipeline/scripts/verify-run.sh run <id> …` takes every
command as an argument, exactly as the profile spells it, and handles the process work:

- It starts `commands.dev` in its own process group and probes `commands.dev_ready` (a URL that
  answers 2xx/3xx, or a command that exits 0).
- It runs the checks under timeouts, in order: `smoke`, `smoke:<surface>`, `e2e`.
- When a local Playwright CLI resolves, it takes the screenshots.
- It **always stops the server**, on every exit path (stale groups from a SIGKILLed run are
  reaped by `verify-run.sh stop <id>` or by the next run).
- It refuses when the ready probe already answers before the start, because that is someone
  else's server.
- It never touches git: no checkout, commit, push or merge.

The lead never starts, probes or kills a process by hand. Run the call with the Bash timeout at
600000 ms. The script's own `--deadline` (540 s) sits below that, so the deadline fires before the
tool timeout.

### The gate

The hook only sees `verify-run.sh …`, so the script asks
`.claude/hooks/cohorte-gate.py --check` about each command before it runs any of them:

- `deny` ⇒ that check is recorded `SKIPPED` and never run.
- `ask`, or `defer` (no gate rule matched, and the command is neither the profile's own nor
  covered by a `permissions.allow` rule) ⇒ exit 4 and nothing is started. The lead shows the human
  the list and re-runs with `--confirmed` only after a yes in this session. `--confirmed` never
  overrides a deny, and the hook still judges the call on its own.

The profile's own commands, passed as the profile spells them, need no confirmation.

A `commands.migrate_down` that sits in `gate.deny` (`migration:rollback` usually does) is never
verified. To let the pipeline check rollbacks on the dev DB, move it to `gate.ask`.

### Databases — dev only, never shared

Migrations run only when the spec says `migrations: true`.
`commands.migrate` runs before the app starts. When `commands.migrate_down` is set, the script then
runs down followed by `migrate` again, as one `rollback` check. `verify.db: shared` (a team DB,
staging) refuses every migration unless `isolation.db_per_worktree` is true **and** the run is in a
feature worktree that `new-feature.sh` registered (a row in `isolation.registry` for the branch's
last path segment), which has its own `<name>_<id>` DB. A bare `git worktree add` shares the main
checkout's database and is refused. The refusal is decided in the script,
and the run is then `SKIPPED`. No command ever targets a production database: the pipeline holds no
credentials for one, and the lead never edits an `.env` to point elsewhere.

### Ports

The profile's URLs name the main checkout's ports. In a feature worktree,
substitute the slot's port (`isolation.port_base.<x>` + the slot from `.worktrees/slots.tsv`) in
`dev_ready`, `smoke` and `base_url`. Otherwise the probe can hit the main checkout's app, which the
script reports as "already answering".

### verify.json

`specs/reports/<id>.verify.json` is the machine verdict, overwritten with an `incomplete` FAIL at
the start of every run:
`{id, phase, ts, verdict: PASS|FAIL|SKIPPED, reason, head, digest_base, digest, digest_after, checks: [{name, status, exit, seconds, cmd, log, note}], evidence: [paths]}`.
- Any check FAIL ⇒ the verdict is `FAIL`. Otherwise one PASS ⇒ `PASS`. Otherwise `SKIPPED`.
- `digest` is `feature-diff.sh --base <reviewed_base> --digest` of the verified tree.
- A check that changes it (a file written outside `specs/` and `.claude/` that is not gitignored)
  adds a `tree` FAIL. Point outputs at `$VERIFY_ARTIFACTS` instead.
- `<id>.verify.md` is the human copy. Logs and screenshots go in `specs/reports/<id>.verify/`,
  which is a gitignored buffer.

### DoD — runtime items only, evidence or nothing

A DoD line that only a running app can prove
carries a trailing `· runtime: <check>` tag. Verify ticks it only when every check named `<check>`
or `<check>:…` exists with `PASS`, and it appends the line plus its evidence path under `## DoD` in
`<id>.verify.md`. A bare `· runtime` (responsive layout, "looks right") is never auto-ticked. A
screenshot shows that the page rendered, not that it is correct, so it is listed as evidence for a
human. Verify never ticks an untagged item and never unticks one.

### Ship

| verify.json | ship |
| --- | --- |
| not configured (above) | silent, no gate |
| `FAIL`, fresh or stale | **blocks** until a newer run overwrites it |
| `PASS` with `digest` = spec `reviewed_digest` | proceeds |
| absent, `SKIPPED`, or stale `PASS` | asks: "not verified at runtime — ship anyway?" |

### Migrations

`/cohorte-spec` sets `migrations: true` when §4 adds or changes a
migration, or when the contract changes what is persisted. It then fills `## Rollback` with three
lines: what to revert, the data implications (a dropped column's values do not come back), and the
exact down step. A missing `migrations:` key means `false`, for legacy specs. `verify-run.sh
rollback-check specs/<id>.md` exits 1 when `migrations: true` and `## Rollback` holds only template
stubs. `/cohorte-spec` runs it before freezing, and `/cohorte-ship` refuses on it.

### Revert

`/cohorte-revert <id>` undoes a `merged` feature as a reviewable PR, never as a push to the
default branch:
- It finds the merge or squash commit via `gh`, and asks the human when the PR was rebase-merged.
- It reads `## Rollback` first, because the revert deletes the spec, which is restored into the
  revert commit.
- It runs the down step with `verify-run.sh run <id> --phase revert`: same gate consult, same
  dev-only DB rule, writes `<id>.revert.json`. The step runs while the migration files still exist.
- It opens a PR whose body carries `## Rollback` for the operator who rolls back production.
