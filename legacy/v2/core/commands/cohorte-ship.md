---
model: sonnet
description: At a SHIP verdict, dispatch the release agent to commit, push, and open the PR (with your confirmation).
argument-hint: <feature_id>
---

You are the **lead**. Ship feature **$ARGUMENTS**. This is the outward-facing gate.

> Read `PIPELINE.md` §`vcs` (host, remote, default_branch, feature_branch_prefix) **and
> §`release_notes`** — §2b below is skipped or required based on it, and skipping it when it is
> required opens a PR that CI fails on arrival.
>
> **Kanban** (SCHEMA.md §Kanban) is mirrored in **explicit steps** below, not as an afterthought:
> §1 moves the card → **Ship**; §4 moves it → **Shipped** and writes the PR number. Both are one
> call to `<core>/pipeline/scripts/kanban-move.sh auto …`, which resolves the board from the config itself and exits 0 with a
> `kanban: <reason>` line when there is none. **Never decide "no board is configured" without running
> it** — a ship session that inferred that, having opened neither the config nor `PIPELINE.md`, is
> exactly how a merged feature's card stayed in "Ready to build". Do not skip §4's move either.

## 1. Pre-flight (confirm before doing anything irreversible)

- Confirm the latest `/cohorte-review` returned **SHIP** (no CRITICAL, no security). If not reviewed, or the
  verdict was REVISE/BLOCK, stop and say so.
- **Freshness gate** — the reviewed code must be exactly what ships. If the spec front-matter carries
  `reviewed_base` + `reviewed_digest`, recompute
  `git diff <reviewed_base> -- . ':(exclude)specs/' | sha256sum | cut -c1-16` (`shasum -a 256`
  then the first 16 hex chars where there is no `sha256sum` — macOS) and compare to
  `reviewed_digest`. **Match** ⇒ source unchanged since the SHIP verdict, proceed. **Mismatch** ⇒ source
  (or the contract) was edited after review — the verdict is **stale**: stop and tell the human to re-run
  `/cohorte-review $ARGUMENTS` before shipping. Missing fields (spec predates the gate) ⇒ skip, don't block.
- **DoD gate (verify, don't tick — `/cohorte-review` owns the ticking).** Read `specs/$ARGUMENTS.md`
  §`Acceptance criteria / DoD`; if any item is still `- [ ]`, list the open ones and ask the human to
  confirm shipping anyway (they may be deferred on purpose — e.g. a UI item on a backend-only feature).
  All `- [x]` ⇒ proceed silently.
- Show `git status` + `git diff --stat`; confirm the branch is `<prefix>$ARGUMENTS`, where `<prefix>`
  is `vcs.patch_branch_prefix` (falling back to `fix/` on a profile that predates the key) when the
  spec front-matter carries `kind: patch`, and `vcs.feature_branch_prefix` otherwise. Resolve it once
  here and pass the **literal** branch to §3's dispatch — the release agent must not re-derive it.
- **Ask the human to confirm** they want to commit, push, and open the PR. Wait for yes.
- After the yes: `<core>/pipeline/scripts/kanban-move.sh auto $ARGUMENTS ship`. Report what it
  printed — `moved #…` or `kanban: <reason>` — never a guess about which happened.

## 2. Mark the spec shipped (BEFORE dispatch, so it ships in the same commit)

Once the human confirms, edit `specs/$ARGUMENTS.md` front-matter `status: → shipped` — **before**
dispatching the release agent, so the status flip is part of the tree it commits (otherwise it lands
uncommitted after the PR opens). Only flip after the human's "yes"; if they decline, leave it.

## 2b. Write the release note (only if `release_notes.enabled` — same reason: it must ship in the commit)

`release_notes.enabled: false` (or `tool: none`) ⇒ skip this section entirely, silently.

Otherwise **you** write it — never the release agent, never the implementers. Picking the bump is
project policy and the prose is outward-facing copy; both are the lead's, exactly like the contract.
See SCHEMA.md §Release notes.

- Write `<release_notes.dir>/<release_notes.filename>` (`<feature_id>` substituted), front-matter
  carrying the **single** key `release_notes.anchor_package` and the chosen level, then the prose body
  in `release_notes.language`.
- **Choose the level** against `release_notes.guidance`, and refuse any level in
  `release_notes.forbid_levels` (a `0.x` repo forbidding `major` declares the rupture `minor`).
- **Ambiguous between two defensible levels?** State your reading in one line and **ask the human to
  pick** before writing. A wrong bump becomes a published version number.
- A `kind: patch` spec is a `patch` bump by default — that is what the level means. It is a default,
  not a rule: a bug fix that changes documented behaviour is still a `minor`, and one that removes it
  is still breaking. Say which you chose when it isn't `patch`.
- The body describes what changed **for the user**, from the spec §1/§2 — no client names, no internal
  paths, no exploitable attack vector, no file lists.
- If the feature genuinely must move no version, use `release_notes.empty_cmd` instead. Prefer that to
  skipping: the CI job wants a file, not a version.
- Then say in one line which level you chose and why — this is the human's last chance to correct it
  before it is committed.

> **Why this is its own gate.** The requirement usually lives in the project's `<memory>`, which this
> flow never reads. Skip it and everything below still "succeeds": commit, push, PR opened, kanban card
> moved to **Shipped** — and CI red on a job nobody watched. The feature reads as shipped while being
> unmergeable.

## 3. Dispatch the `release` agent

Spawn one agent (`subagent_type: release`, or the equivalent dispatch for this runtime):
"Release feature `$ARGUMENTS` on branch
`<the branch §1 resolved>`. Read `PIPELINE.md` §vcs first. Spec: `specs/$ARGUMENTS.md` (already
`status: shipped` — stage it). Write conventional commit(s), push (no force), open the PR (use `gh` if
`host: github` + available; else emit the compare URL + drafted PR body from `<core>/templates/pr-body.md`).
Stage **all** the feature's changes including `specs/$ARGUMENTS.md` and, if `release_notes.enabled`, the
release note at `<release_notes.dir>/<release_notes.filename>` — it is already written, stage it as-is and
never author or edit one yourself. Never edit source, never force-push, never run migrations."

## 4. Relay + move the card to Shipped (do not skip)

Print the release agent's report: commit SHA(s), pushed branch, PR URL (or compare URL + drafted body).
Confirm `specs/$ARGUMENTS.md` was committed as `status: shipped` (part of the release commit), and — if
`release_notes.enabled` — that the release note is in that same commit
(`git show <sha> --stat | grep <release_notes.dir>`). Missing ⇒ commit and push it now, before §5's CI
watch, rather than letting the job go red.

**Move the card to Shipped — required, and verify it actually moved.** Run
`<core>/pipeline/scripts/kanban-move.sh auto $ARGUMENTS shipped --pr <num>`, which **appends the PR
number** so the line reads `- [ ] <title> #$ARGUMENTS — PR #<num>`. Take `<num>` from the PR URL
(`…/pull/13` ⇒ `13`); **always pass it when a PR was created** (the `gh` path) — it is what a
board reader turns into a PR link. If only a compare URL was emitted (no PR yet), drop `--pr`.

Then **read the script's own output**, which is the verification: `moved #$ARGUMENTS -> Shipped
(PR #<num>)` means done, and a `kanban: <reason>` line means the mirror is off and says why. Both are
exit 0 and they are not interchangeable — say which one you got. Only if it moved, confirm placement
with a **grep for `#$ARGUMENTS`** on the board it named (with surrounding heading context —
`grep -B20 '#$ARGUMENTS' | grep '^##'`, or an offset-limited Read around the match): exactly one card,
under the `shipped` heading — never re-read the whole board into context.

## 5. After the PR — CI gate + teardown

- If `host: github` and `gh` is available, watch the PR's checks (`gh pr checks <url> --watch`) and
  report the result — the human merges only on green. A red check ⇒ back to `/cohorte-fix $ARGUMENTS`,
  **except** a red `release_notes.ci_job`: that one is this command's own miss, not a code finding —
  write the note per §2b, commit, push, and re-watch. Never send a missing release note through `/cohorte-fix`.
- Once the human confirms the PR is **merged**: if `isolation.enabled`, propose the teardown —
  `scripts/remove-feature.sh $ARGUMENTS` (add `--drop-db` to also drop the feature db; kept by
  default). It removes the worktree, deletes the merged branch, frees the slot. Never run it before
  the merge is confirmed, and only with the human's go-ahead (the gate will ask anyway).
- Feature closed — **recommend a `/clear`** before starting the next one; nothing from this session
  is needed again (spec `shipped`, PR merged, board updated).
