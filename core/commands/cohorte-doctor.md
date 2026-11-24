---
model: sonnet
description: Diagnose the pipeline installation — core version, pointer, agents↔surfaces, hooks, gate, retrieval, design, isolation — and print the exact fix for each failure.
---

You are the **pipeline doctor**. Check every piece of wiring the pipeline depends on and report a
✅/⚠️/❌ checklist, each failure with its **exact fix command**. Diagnose read-only first; apply a
fix only with the human's go-ahead (or hand them the command).

> Wiring that worked at init rots: PATH changes, uninstalls, hand-edits, half-done updates. This is
> the one place that verifies it all.

## Checks, in order

0. **Fast path.** Run `cohorte doctor` (or `npx cohorte doctor` if the binary is not on PATH) and
   use its output as the baseline: it runs every file-level check below deterministically. Then add
   what only a live session can see (MCP connectivity, the `Workflow` tool, the `/design` skill).
1. **Core & pointer.** The machine-wide core exists (`<core>/pipeline/VERSION`) and its
   `<core>/manifest.json` too (absent ⇒ ⚠️ a copied-by-hand core; fix `cohorte update`).
   `<state>/pipeline.json` names a `core_version`; one lagging the VERSION file is ⚠️ ⇒ run `<sync>`
   and commit the pointer. A pointer that still carries `mode: bundled|global` predates 3.0 ⇒ ⚠️ ⇒
   `/cohorte-update-pipeline` (it migrates the repo). Compare against `npm view cohorte version` —
   behind ⇒ suggest `cohorte update`. Read `<core>/pipeline/CHANGELOG.md` for what they're missing.
   **2.x leftovers are ⚠️ with a named fix:** a vendored core in this repo (`.claude/pipeline/VERSION`,
   `.claude/hooks/gate.py`) ⇒ `<sync>` removes it; a 2.x core in `~/.claude/pipeline/` or a gate
   registered in `~/.claude/settings.json` ⇒ `cohorte update` migrates it; surface agents for this
   project in `~/.claude/agents/` ⇒ re-render them into `<agents>/` (`<core>/pipeline/schema/rendering.md`) and delete the global
   copies. The router commands' step files are present — `<core>/templates/steps/init-pipeline/`
   non-empty. **Shipped scripts present and executable** in `<core>/pipeline/scripts/`:
   `kanban-move.sh`, `preflight.sh`, `feature-diff.sh`; the `new-feature.sh.template` and
   `remove-feature.sh.template` sources must be readable — ❌ any missing one.
   Kanban callers chain with `|| true`, so an absent `kanban-move.sh` is a **silent**
   no-op (no card moves, no error anywhere) — this check is the only thing that sees it;
   an absent `feature-diff.sh` stops every review and ship (they refuse to fall back to a
   bare `git diff`, which misses untracked files).
2. **Profile.** `PIPELINE.md` exists and its `yaml pipeline-profile` block parses.
   `<state>/profile.json` (the parsed block agents read instead of `PIPELINE.md`) is present and
   matches it (`cohorte doctor`'s `profile-json` row compares them byte for byte); ⚠️
   missing/stale/uncommitted ⇒ fix: `<sync>`, then commit `<state>/profile.json`. Every
   `surfaces[].agent` has its `<agents>/<agent>.md` and every agent file has its `surfaces[]`
   entry — **no orphans either way** (`<core>/pipeline/schema/rendering.md` rule). Each rendered agent's frontmatter `tools`
   matches its surface's `tools` (incl. `DesignSync` iff `uses_design`, retrieval MCP tools iff
   `retrieval.provider` ≠ `none`). **Model pins:** each rendered agent's frontmatter `model` matches
   its `surfaces[].model` — ❌ if missing, mismatched, or a literal `<SURFACE_MODEL>` placeholder
   (all three silently fall back to inheriting the lead session's model — often Opus — on every
   dispatch); ⚠️ any `inherit` with the note that it bills at the lead's tier. The generic agents
   (`cohorte-review.md`, `cohorte-release.md`, `cohorte-profile-reader.md` in `<fixed-agents>/`) must
   each carry their `model:` line too (sonnet/haiku/haiku).
   **Command pins:** every mechanical command file
   (`build`, `review`, `fix`, `ship`, `audit`, `refactor`, `doctor`, `align-ds`,
   `update-pipeline`, `fleet` — `cohorte-<name>.md` in `~/.claude/commands/`) carries `model: sonnet` in
   its frontmatter — ⚠️ if missing (the lead's orchestration turn then bills at the session model,
   e.g. Opus/Fable). `brainstorm`, `spec`, `patch`, and `init-pipeline` are intentionally unpinned
   (interactive — they inherit the session model).

3. **Hooks & gate.** `<state>/gate-config.json` exists and mirrors the profile's `gate` block
   (regenerate if drifted). `.claude/hooks/cohorte-gate.py` exists **and is committed**
   (`git ls-files --error-unmatch .claude/hooks/cohorte-gate.py`), and `.claude/settings.json`
   registers it exactly once per matcher group — `Bash|Task|Agent` (shell + subagent dispatches; the
   preflight phase gate keys off dispatches, and `Agent` is the tool's name since Claude Code 2.1.63)
   and `Write|Edit|MultiEdit|NotebookEdit` (self-protection of the gate's own files). A registration whose file is
   missing is ❌ — with `onFailure: block` it refuses every Bash call; fix: `<sync>`. A second gate
   registered in `~/.claude/settings.json` (2.x) is ⚠️ — it double-prompts; fix: `cohorte update`.
   Test the evaluator too: `python3 .claude/hooks/cohorte-gate.py --check "<a pattern from the ask list>"`
   must return a non-`allow` verdict (exit 1 ask / 2 deny).
   Then the **preflight stamp is local, never versioned**: `git ls-files --error-unmatch
   <state>/preflight.ok` must miss, and `.gitignore` must cover it. A tracked stamp is a ❌ (not a
   ⚠️) — it records the tree it verified, the commit that carries it moves HEAD past that tree, and
   the committed copy lands in every clone and new worktree; the gate then blocks clean trees and
   greens unchecked ones. fix: `git rm --cached <state>/preflight.ok` + add it to `.gitignore`.
4. **Retrieval** (if `retrieval.provider` ≠ `none`). Run the `<core>/pipeline/schema/retrieval.md` health
   check: CLI resolvable from PATH, `.mcp.json` entry present in PATH-proof launcher form,
   `.serena/` gitignored, server actually connects.
5. **Design** (if `design.enabled`). `snapshot_dir` exists and is committed; `ui_kit_path` +
   `tokens_path` exist; if `provider: claude-design`, `DesignSync` responds (`list_files` on the `design_system_project`) and
   `design_system_project` is reachable. Recall: spec `design_files` are full
   `…/design/p/<projectId>?file=<file>` links that carry their own project + page; `design_project` is
   only a legacy fallback for old bare-filename specs (default `none`).
6. **Isolation** (if `isolation.enabled`). `scripts/new-feature.sh` + `scripts/remove-feature.sh`
   rendered (no `__TOKEN__` placeholders left). `.worktrees/slots.tsv` coherent with
   `git worktree list` — flag **stale slots** (registered but no worktree) and **zombie worktrees**
   (worktree but no slot / spec already `shipped`) ⇒ suggest `scripts/remove-feature.sh <id>`.
   When ≥2 slots are live, print the parallel-feature table (feature · worktree · ports · db ·
   branch behind main by N commits) — a worktree far behind main means its next review will diff
   against stale code ⇒ suggest rebasing it.
7. **Kanban** (the board mirror — `<core>/pipeline/schema/kanban.md`). Run
   `<core>/pipeline/scripts/kanban-move.sh --check` and report its one line verbatim: the resolved
   board path, or the exact link that is missing. A board mirror is optional, so "not configured" is
   ℹ️, never ❌ — but it must be **stated**, because the whole class of bug here is a card that
   quietly stopped moving while every command still reported success. Two states earn a ⚠️ with the
   fix named: `boards` has no entry for this profile's `name` while it does have an entry for some
   other key whose board file exists (a **rename** orphaned the link — re-key it via
   `/cohorte-update-pipeline`), and an entry whose board file no longer exists at
   `vault_path`-relative `board` (moved or renamed in the vault).
8. **Workflows** (the opt-in execution path — `<core>/pipeline/schema/workflows.md`; the conversational commands
   stay the default, so failures here are ⚠️ at most, never ❌). Report which path this machine will
   take and why:
   - **Claude Code version** ≥ 2.1.154 (`claude --version 2>/dev/null | head -1`) — older or no CLI
     on PATH ⇒ conversational only. This is the **workflow** floor and the only one that gates this
     check; do NOT raise it to match a newer feature's floor, or every install between the two
     versions reads as broken while its workflows run fine.
   - **Scripts present:** `<workflows>/cohorte-review.js` + `cohorte-audit.js` + `cohorte-refactor.js` + `cohorte-loop.js` —
     missing on a current core ⇒ half-done install, re-run install/update. (The loop workflow (`cohorte-loop.js`) is
     **workflow-only** — no command file exists on purpose; without this runtime it refuses
     rather than degrading to a conversational loop.)
   - **Phase-0 agent present:** `<fixed-agents>/cohorte-profile-reader.md` — the workflows abort without it.
   - **Workflows enabled in this session** — the `Workflow` tool is in your own toolset right now;
     absent ⇒ disabled for this session (a setting or an old client), conversational path.
   - **Preflight wiring** (used by both paths): `<core>/pipeline/scripts/preflight.sh` executable and
     `gate-config.json` carries the `preflight` block — mismatch ⇒ regenerate from the profile.
   End the check with ONE summary line, e.g.
   `workflows: available (opt-in — ask to "run the review workflow")` or
   `workflows: unavailable (<first failing prerequisite>) — conversational commands (the default)`.
9. **Specs & metrics.** Every `specs/*.md` front-matter `status` is a valid stage — one of
   `draft · frozen · in-progress · in-review · blocked · shipped · merged · abandoned` (`<core>/pipeline/schema/spec-status.md`) — excluding
   `_`-prefixed files (the spec template and `specs/_decisions.md`, the decision journal) and
   `specs/refactor-backlog.md`, which `/cohorte-audit` writes as a backlog, not a
   spec, and which has no front-matter to check. A spec left `in-progress` or `blocked` is a round
   that never finished ⇒ say so and route it: open `## Remediation` items ⇒ `/cohorte-fix`, none ⇒
   `/cohorte-build` (a `blocked` spec whose `specs/reports/<id>.loop.json` has a `reason` and no
   `outcome` is a resumable stop — re-running the loop workflow resumes it). **Reconcile `shipped`
   specs with their PR** (when `vcs.host: github` and `gh` is available — one
   `gh pr view <branch> --json state` per shipped spec, never more than the shipped ones): `MERGED` ⇒
   ⚠️ with the fix `set status: merged` (offer to apply it); `CLOSED` unmerged ⇒ ⚠️ — ask the human:
   reopen, or `status: abandoned`. `shipped`/`merged` specs with a live worktree flagged (see 6). `<state>/pipeline-metrics.jsonl` and `specs/reports/` (the
   `/cohorte-review` report buffer that lets a `/cohorte-fix` survive a `/clear`) are gitignored. Metrics
   belong to the **main checkout** — a `pipeline-metrics.jsonl` inside a live feature worktree is a
   stale-core sign (its lines die at teardown) ⇒ suggest appending its lines to the main checkout's
   file and deleting the stray.
10. **Git identity** (`cohorte doctor`'s `identity` row). `git config user.name` and `git config user.email`
   are set for this repo (conditional includes count). Unset ⇒ ❌: git falls back to `<os user>@<hostname>`
   and the code host cannot link the commits; an email whose domain has no dot or ends in
   `.local`/`.lan`/`.localdomain` ⇒ ⚠️ (a hostname, not a mailbox). fix:
   `git config user.name "<name>" && git config user.email "<email>"` (repo-local; with `gh` signed in,
   `<id>+<login>@users.noreply.github.com` from `gh api user`). Never invent the values.

## Report

Group by check, one line each: `✅|⚠️|❌ <check> — <one-line detail>`; every ⚠️/❌ followed by
`   fix: <exact command or edit>`. End with the overall count and, if anything failed, the ordered
repair sequence. Nothing failing ⇒ say the installation is healthy, and the installed core version.
