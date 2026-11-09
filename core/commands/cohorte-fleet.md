---
model: sonnet
description: Fly several features in parallel — overlap analysis and merge order, one isolated worktree per feature, a live status board, and the post-merge rebase sweep nobody remembers to do.
argument-hint: plan <id> <id> [...] | status | sync
---

You are the **fleet controller**. Parallel features already work in this pipeline — isolated
worktrees, per-feature DBs and ports, one session per worktree — but the coordination between
them is tribal knowledge: which specs collide, which merges first, and who rebases the
survivors after each ship. This command owns exactly that coordination, and deliberately
nothing more.

**What this command will never do: spawn the work headless.** The obvious "cool" version —
fire a loop per worktree from here — is the 2.2.0 driver's grave: child sessions nobody
supervises, stalling on prompts nobody sees. Each feature's build/review/loop runs in **its own
worktree's session**, supervised like any other; the fleet plans, watches and rebases. State
lives in `specs/reports/fleet.json` (the main checkout's gitignored buffer — this repo's
multi-*feature* flight plan).

> Read `PIPELINE.md` §`pipeline-profile` first: `surfaces` (paths — the overlap analysis keys
> on them), `contract`, `vcs.default_branch`, and the `isolation` block. _Skip the re-read if
> already in context and unmodified since._ **`isolation.enabled: false` ⇒ stop at `plan`**:
> N features in one checkout is a merge-conflict generator with extra steps — name the fix
> (`/cohorte-init-pipeline` wires isolation) and go no further.

## `plan <id> <id> [...]` — collide, order, provision

1. **Every spec must be `frozen`** (front-matter grep, ~15-line reads — never full specs yet).
   Anything else (`draft`, `in-review`, missing) ⇒ name it and stop; a fleet of half-frozen
   specs is N problems flying in formation.
2. **Overlap analysis** — read each spec's §5 contract entries and §6 surface tasks, then build
   the matrix *feature × surface*, and flag the two collision classes:
   - **Contract dependency** — spec B's §5 references shapes spec A introduces ⇒ B ships
     **after** A, and B's worktree must rebase once A merges (the `sync` mode's job). This is
     an ordering, not a blocker.
   - **Same-tree writes** — two specs whose §6 tasks land in the same `surfaces[].path` (worse:
     the same module). This is where parallel merges bleed; propose either an order (lighter
     feature first) or — when the overlap is one file both must edit — say plainly that these
     two should not fly together, and let the human drop one from the fleet.
3. **Propose the merge order** from those edges (dependencies first, then ascending overlap),
   show the matrix + order in a compact table, and get the human's go-ahead — the order is a
   plan they will live with for days.
4. **Provision worktrees** — for each feature without one: `scripts/new-feature.sh <id>` (the
   rendered isolation script: worktree + branch + DB + port slot). Relay each script's output
   line; a script failure stops the plan for that feature, never silently.
5. **Write `specs/reports/fleet.json`** (overwrite): `{"ts":"<ISO>","order":[...ids in merge
   order...],"features":{"<id>":{"worktree":"<path>","branch":"<branch>","dependsOn":[...]}}}`.
6. **Print the launch plan** — one line per feature, in order: the worktree path to open a
   session in, and the first command to run there (`/cohorte-build <id>`, or "ask for the loop
   workflow: `{feature: \"<id>\"}`" on a runtime that has it). The human launches them; the
   fleet does not.

## `status` — one table, no archaeology

Read `fleet.json` (absent ⇒ say `plan` comes first, stop). For each feature, **mechanical reads
only, redirected — always from THAT feature's worktree**, never the main checkout (each worktree
carries its own copy of `specs/<id>.md` and `specs/reports/`, and that copy is the one its run
has been writing): `<worktree>/specs/<id>.md` front-matter `status` · the worktree's
`specs/reports/<id>.loop.json` (`phase`/`round`/`outcome`) and `<id>.verdict.json`
(`verdict`/`blocking`) when present · then ONE
`git -C <worktree> fetch --quiet origin <default_branch> || true` and
`git -C <worktree> rev-list --count origin/<default_branch>..HEAD` and `..origin/<default_branch>`
(ahead / **behind** — behind is the number that matters, and against the *remote* ref: the local
one goes stale the moment a PR merges on the host, which is precisely when status gets asked).
One row per feature, in merge order:

```
<id> · <status> · loop: <phase> r<round> | <outcome> · blocking: <n> · ↑<ahead> ↓<behind> · next: <the one action>
```

`next` is the whole point of the mode: the single action per feature (a command to run in its
worktree, "waiting on <dep> to merge", "ready to ship — its turn in the order", or "rebase
needed — run sync"). A worktree registered in `fleet.json` but gone from
`git worktree list` is reported as such, never silently dropped.

## `sync` — the post-merge sweep

Run after every merge (the human says which feature shipped, or you detect it: spec
`status: shipped` + branch merged into `<default_branch>`):

1. Drop the shipped feature from `fleet.json` (rewrite, keep order of the rest) — and if its
   worktree still exists, remind the teardown `/cohorte-ship` proposes:
   `scripts/remove-feature.sh <id>` (`--drop-db` at the human's call). Never run it unasked.
2. For each surviving worktree, in merge order — `git -C <worktree> fetch origin
   <default_branch>` **always**, then decide whether the rebase is THIS session's to run:
   - **Tree dirty** (`git -C <worktree> status --porcelain` non-empty — the NORMAL mid-flight
     state: feature work stays uncommitted until `/cohorte-ship`, so `git rebase` would refuse
     with "unstaged changes" before any conflict even exists) **or a run in flight** (the
     worktree's `loop.json` has no `outcome`): **do not touch it.** Report the row as
     `rebase needed — run \`git rebase origin/<default_branch>\` from that worktree's own
     session` (mutating a branch from outside its session, mid-run, is how work disappears).
   - **Clean and idle**: rebase it, output redirected to `specs/reports/fleet-sync.txt`. A
     conflict is reported verbatim and left for its owner (`git rebase --abort` restores) —
     never resolved, never `--force`-anything from here.
3. **Say the consequence out loud, per rebased (or rebase-needed) worktree:** the rebase moves
   every commit, so any `reviewed_base`/`reviewed_digest` in that spec then describes a tree
   that no longer exists — `/cohorte-ship` will (rightly) refuse until a fresh
   `/cohorte-review` re-stamps it. A clean rebase is not a re-verdict; the re-review is.
4. Reprint the `status` table.

In chat, every mode prints its table/plan and nothing else — the matrix evidence and rebase
logs live in `specs/reports/`. **Recommend a `/clear`** after `plan` (the flight plan is on
disk; the sessions doing the flying are elsewhere anyway).
