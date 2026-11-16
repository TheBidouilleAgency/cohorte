---
model: sonnet
description: Prepare the revert of a merged feature — a revert branch and PR, its down migration run only on a dev database. Never pushes to the default branch.
argument-hint: <feature_id>
---

You are the **lead**. Prepare the revert of feature **$ARGUMENTS**. The output is a branch and a PR
that a human reviews and merges. Rules: `<core>/pipeline/schema/verify.md` (§Databases, §Revert).

> **Never push to the default branch, never force-push, never merge.** The revert lands the way
> every change does, through a PR, and the gate confirms git writes on the default branch anyway.
> **No kanban move.** The board has no revert column, so the card stays in Shipped. This command
> calls no `kanban-move.sh` on purpose.
> Never run a migration outside `<core>/pipeline/scripts/verify-run.sh`, never against a
> shared, staging or production database, and never edit an `.env` to reach one.

## 1. What landed

- `grep -E '^(status|branch|pr|migrations|title):' specs/$ARGUMENTS.md`.
  - `merged` ⇒ continue.
  - `shipped` ⇒ check it the way `/cohorte-ship` §0 does (`gh pr view <branch> --json state`).
    `MERGED` ⇒ continue, and leave the status line to `/cohorte-doctor`'s reconcile, because §2
    needs a clean tree. `OPEN` ⇒ there is nothing to revert: the human closes the PR.
  - Anything else ⇒ stop, because nothing merged.
- **Read `## Rollback` now and keep it.** The revert deletes the spec from the tree (the release
  commit added it). `migrations: true` with an empty Rollback
  (`<core>/pipeline/scripts/verify-run.sh rollback-check specs/$ARGUMENTS.md` exits 1) ⇒ stop and
  have the human fill it. A migration nobody knows how to undo is not reverted blind.
- Find the PR: the spec's `pr:` if present, else
  `gh pr list --state merged --head <branch> --json number,url,title,mergeCommit --limit 1`.
  No `gh`, or not `vcs.host: github` ⇒ ask the human for the merge commit SHA.
- `git fetch origin <default_branch>`, then
  `git merge-base --is-ancestor <sha> origin/<default_branch>`. If it is not an ancestor, stop.
- Work out how the PR merged: `git rev-list --parents -n 1 <sha>`.
  - **Two parents** ⇒ a merge commit: `git revert -m 1`.
  - **One parent** ⇒ compare `git diff-tree --no-commit-id --name-only -r <sha>` with
    `gh pr view <num> --json files --jq '.files[].path'`. The same set ⇒ a squash: a plain
    `git revert`.
  - A different set ⇒ a rebase-merge, with several commits on the default branch. Show
    `git log --oneline -<commits+1> <sha>` and have the human name the range. **Never guess it.**

## 2. A branch off the default branch

`git status --porcelain` must be empty, otherwise stop.
- `isolation.enabled` ⇒ `scripts/new-feature.sh revert-$ARGUMENTS`. It creates its own worktree and
  branch `<feature_branch_prefix>revert-$ARGUMENTS` off `origin/<default_branch>`, plus its own
  database when `isolation.db_per_worktree` is set. Do the rest in that worktree.
- Otherwise ⇒ `git switch -c revert/$ARGUMENTS origin/<default_branch>`.

## 3. The down migration, on a dev database, before the revert

Do this only when `migrations: true`. The down step runs **while the migration files still exist**,
since the revert deletes them. The step is Rollback's **Migration down** line. Fall back to
`commands.migrate_down` (or `commands.rollback`) only after the human confirms that this feature's
migrations are still the newest on the default branch. "Undo the last migration" otherwise undoes
a later feature's. Run one Bash call with the timeout at 600000 ms:

```
<core>/pipeline/scripts/verify-run.sh run $ARGUMENTS --phase revert \
  [--migrate "<commands.migrate>"] --migrate-down "<down step>" \
  --db <verify.db, default local> --db-per-worktree <isolation.db_per_worktree, default false> \
  --slots <isolation.registry, default .worktrees/slots.tsv>
```

Pass `--migrate` when the database is fresh (an isolated worktree's), so that it first reaches the
default branch's schema. Route on the exit code:
- **4** ⇒ show the human the gate's list. On yes, re-run with `--confirmed`.
- **0** ⇒ the down step worked on dev.
- **1** ⇒ stop and relay `tail -40` of the `migrate-down` log. A down step that fails on dev will
  fail in production, and the human decides what happens next.
- **3** ⇒ refused or denied: a shared DB, or the step is in `gate.deny`. Carry on, but the PR body
  must say that the down step was **not** exercised.

The verdict is in `specs/reports/$ARGUMENTS.revert.json`.

## 4. The revert commit

1. Run `git revert --no-commit [-m 1] <sha>` (or the human's range).
2. Keep the spec as history: `git checkout HEAD -- specs/$ARGUMENTS.md`, plus `specs/design/$ARGUMENTS.md`
   if it exists. This also resolves the conflict a later `status: merged` commit causes.
3. Any other conflict (`git diff --name-only --diff-filter=U`): a consumed release note is
   `git rm`'d. For everything else, stop, list the files, and leave the tree to the human
   (`git revert --abort` is theirs to run).
4. Ask whether the spec becomes `status: abandoned` in this commit. It only says so if the revert
   merges, and it is the human's call (`<core>/pipeline/schema/spec-status.md`).
5. `release_notes.enabled` ⇒ write the note yourself per `<core>/pipeline/schema/release-notes.md`,
   describing the removal for the user, and ask the human for the level.
6. Commit with `revert: <title> (#<num>)` and the body `This reverts <sha> (PR #<num>).`

## 5. Confirm, push the revert branch, open the PR

Show `git show --stat HEAD` and the down-step result, then **ask the human** to confirm the push.
On yes:
1. `git push -u origin <the revert branch>` (never `<default_branch>`, never `--force`).
2. `gh pr create --base <default_branch> --head <the revert branch> --title "revert: <title>"`.
   The body has three parts:
   - what is reverted, with a link to the original PR;
   - `## Rollback` verbatim, because these are the steps the operator runs on production
     **before or with** the deploy, in the order it gives;
   - whether the down step was exercised on dev (from `revert.json`).
3. No `gh` ⇒ print the compare URL and that body instead.

Report the branch, commit SHA, PR URL and down-step verdict. Once the revert PR merges, propose
`scripts/remove-feature.sh revert-$ARGUMENTS` when a worktree was made.
