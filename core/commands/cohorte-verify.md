---
model: sonnet
description: Run the app between review and ship (migrations, dev server, smoke/e2e, screenshots) and tick only the runtime DoD items it has evidence for.
argument-hint: <feature_id>
---

You are the **lead**. Verify feature **$ARGUMENTS** at runtime, which is the step that actually
runs the app. Rules: `<core>/pipeline/schema/verify.md`. Read it before §2's call if it is not in
your context already.

> **No kanban move.** The board has no verify column and the card stays in Review. This command
> calls no `kanban-move.sh` on purpose.
>
> **The script does the process work.** Everything below goes through
> `<core>/pipeline/scripts/verify-run.sh`:
> - Never start, probe or kill a server yourself, and never run a migration outside it.
> - Never touch git (no checkout, commit, push or merge).
> - Never point an `.env` at another database.
> - A server left behind is stopped with `verify-run.sh stop $ARGUMENTS`, not with `kill`.

## 0. Configured?

Read `<state>/profile.json` (fall back to `PIPELINE.md`'s `yaml pipeline-profile` block). Verify
applies only when both hold:
- `verify.enabled` is not `false`;
- the profile has `commands.smoke`, `commands.e2e`, or `commands.dev` **with** `commands.dev_ready`,
  or the spec has `migrations: true` and the profile has a `commands.migrate`.

Otherwise say "no runtime commands in the profile, so there is nothing to verify (and `/cohorte-ship`
will not ask)" and stop.

## 1. Inputs

- `specs/$ARGUMENTS.md` must exist. `status: merged` or `abandoned` ⇒ stop (a merged feature is
  undone with `/cohorte-revert`, not re-verified). Any other status is fine. Verify normally follows
  a `SHIP` verdict, but nothing forbids an earlier run.
- From the front-matter, take `migrations` (absent means `false`) and `reviewed_base`.
  - `reviewed_base` present ⇒ pass it as `--digest-base`; `/cohorte-ship` compares that digest
    with `reviewed_digest`.
  - Absent ⇒ omit `--digest-base`, and say that ship will treat this run as unanchored.
- Touched surfaces: `<core>/pipeline/scripts/feature-diff.sh --default <default_branch> --name-only`,
  grouped by `surfaces[].path`. Only their `verify.surfaces.<key>` hints are used.
- **In a feature worktree** (`git rev-parse --git-dir` ≠ `--git-common-dir`) with
  `isolation.enabled`, substitute the slot's ports into every URL, as described in
  `<core>/pipeline/schema/verify.md` §Ports.

## 2. One call

Build it from the profile and leave out each bracketed part whose input is `""` or absent. Run it
in one Bash call with the **timeout at 600000 ms**:

```
<core>/pipeline/scripts/verify-run.sh run $ARGUMENTS --digest-base <reviewed_base> \
  [--migrate "<commands.migrate>" [--migrate-down "<commands.migrate_down, else commands.rollback>"] \
     --db <verify.db, default local> --db-per-worktree <isolation.db_per_worktree, default false> \
     --slots <isolation.registry, default .worktrees/slots.tsv>] \
  [--dev "<commands.dev>" --ready "<commands.dev_ready>"] \
  [--check "smoke=<commands.smoke>"] [--check "smoke:<key>=<verify.surfaces.<key>.smoke>"]… \
  [--check "e2e=<commands.e2e>"] \
  [--screenshot "<key><path>=<base_url><path>"]… \
  [--skip "rollback=no commands.migrate_down in the profile"] \
  --ready-timeout <verify.ready_timeout_seconds, 90> --check-timeout <verify.check_timeout_seconds, 600>
```

- The `--migrate…` group goes in **only** when the spec says `migrations: true`. Add `--skip
  "rollback=…"` when it does but the profile has no down command.
- `--screenshot` is left out when `verify.screenshots: off`. Use one per `verify.surfaces.<key>.paths`
  entry of a touched surface. The `base_url` defaults to `dev_ready`'s origin.
- `--dev` without `--ready` is a usage error by design.

Route on the exit code:
- **4**: the gate would ask. The script printed the commands and started nothing. Show the human
  that list and ask once. On yes, re-run the identical call plus `--confirmed`. On no, stop.
- **2**: usage. Fix the call. Never improvise the steps by hand.
- **0 / 1 / 3** (PASS / FAIL / SKIPPED): read `specs/reports/$ARGUMENTS.verify.json`. Keep only
  `verdict`, `reason` and each check's `name · status · note` in context. On a FAIL, `tail -40` the
  failing check's `log` and nothing else.

## 3. Tick the runtime DoD items it proved

Go through the spec's `## 9. Acceptance criteria / DoD`, handling only the `- [ ]` lines that carry
`· runtime`:
- A line with `· runtime: <check>` ⇒ tick it (`- [x]`) **only** if verify.json has at least one
  check named `<check>` or `<check>:…`, and all of them are `PASS`. Leave everything else alone. A
  `SKIPPED` check proves nothing.
- A bare `· runtime` is never ticked. It needs a human eye.
- Never tick an untagged line, never untick a line, and edit nothing else in the spec.

Append to `specs/reports/$ARGUMENTS.verify.md`, under `## DoD`, one line per runtime item:
- a ticked item: `- [x] <item> — evidence: <log path>`;
- an open item: `- [ ] <item> — needs a human eye (evidence: <screenshot paths, or none>)`.

## 4. Report

One line for the verdict and one per check (`<name> · <status> · <note>`), then the items you
ticked. Then route:
- **PASS** ⇒ `/cohorte-ship $ARGUMENTS`. Name any bare `· runtime` items the human should look at
  first, with their screenshot paths.
- **FAIL** ⇒ a runtime finding. Have the human run `/cohorte-fix $ARGUMENTS` with the failing
  check's line and log path pasted. After the fix, `/cohorte-review` and then `/cohorte-verify`
  again (the code changed, so both verdicts are stale). `/cohorte-ship` blocks until a newer run
  passes.
- **SKIPPED** ⇒ say why (the `reason`, or the gate-denied checks). `/cohorte-ship` will ask the
  human whether to ship unverified.

**Recommend a `/clear`.** The verdict, logs and ticks are all on disk.

**Your last message to the developer** — in their language, in plain words: what happened, and
what they need to do (often nothing, or one command). No pipeline jargon (DoD, runtime item, verify.json, freshness, digest…) — those
terms stay in the files you write. If something stopped you (a permission, a missing tool), say in
one plain sentence what they should do about it. A `/clear` tip is one optional sentence, never an
order.
