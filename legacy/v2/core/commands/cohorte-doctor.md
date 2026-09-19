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

0. **Runtime.** Say which coding agent you are running as and what it can enforce — every check
   below is read through it. **You already know which one**: the Runtime preamble at the top of
   this file names it. Read `<core>/pipeline/runtimes.json` for the details — a map of every
   runtime installed against this core, since they share one core. Report one line:
   `runtime: <label> · scope <global|project> · hooks <yes|no> · workflows <yes|no>`,
   and name the other installed runtimes if there are any (they share `<state>` and `<config>`, so
   a board or a gate config wired from one is seen by all — that is intended, and worth stating).
   File absent ⇒ a core installed before the adapter existed ⇒ ⚠️, fix by re-running the installer.
   A runtime without hooks makes check 3's gate **advisory** — say so there rather than
   reporting a false ✅.
1. **Core & pointer.** A core exists (`<core>/pipeline/VERSION`); `<state>/pipeline.json` names a mode + `core_version`
   coherent with the VERSION file. A **global**-mode pointer lagging the VERSION file is ⚠️, not ❌:
   nothing bumped that field before 1.2.5, so the core itself is fine and only the pointer is stale
   ⇒ fix by running `/cohorte-update-pipeline` (§3 syncs it now), or by editing the one field. Compare
   against `npm view cohorte version` — behind ⇒ suggest `/cohorte-update-pipeline`. Read `pipeline/CHANGELOG.md` for what they're missing. The router
   commands' step files are present — `templates/steps/init-pipeline/` non-empty (a router whose
   `templates/steps/<cmd>/` dir is missing is a partial/stale install ⇒
   re-run install/update). **Shipped scripts present and executable** in `<core>/pipeline/scripts/`:
   `kanban-move.sh`, `preflight.sh`; the `new-feature.sh.template` and
   `remove-feature.sh.template` sources must be readable, not executable — ❌ any missing one.
   Every caller chains these with `|| true`, so an absent script is a **silent**
   no-op (no kanban card moves, no error anywhere) — this check is the only thing
   that sees it. Also flag ❌ a `VERSION` **newer than** the other `pipeline/` files (compare mtimes):
   a version bumped without a full re-copy is a half-done update ⇒ re-run install/update.
2. **Profile.** `PIPELINE.md` exists and its `yaml pipeline-profile` block parses. Every
<!-- cohorte:if runtime:codex -->
   `surfaces[].agent` has a valid `.codex/agents/<agent>.toml` in this project, regardless of
   core scope. Check `name`, `description`, `developer_instructions` and no unfilled placeholders.
   Reconcile only this project's agents; never treat unrelated global agents as orphans.
   Generic `review.toml`, `release.toml`, `profile-reader.toml` live under `<fixed-agents>/`.
   The read-only generic agents must carry `sandbox_mode = "read-only"`.
   Missing `model` means inheritance, not an error. Reject Anthropic aliases; compare explicit
   Codex model pins with the profile when supplied. Claude `tools:` is not a Codex TOML field.
   Flag project launchers that redefine `CODEX_HOME` just to discover local agents; native
   project discovery needs no auth symlink. Do not delete global agents without checking ownership.
<!-- cohorte:else -->
   `surfaces[].agent` has its `<agents>/<agent>.md` and every agent file has its `surfaces[]`
   entry — **no orphans either way** (SCHEMA.md rule). Each rendered agent's frontmatter `tools`
   matches its surface's `tools` (incl. `DesignSync` iff `uses_design`, retrieval MCP tools iff
   `retrieval.provider` ≠ `none`). **Model pins:** each rendered agent's frontmatter `model` matches
   its `surfaces[].model` — ❌ if missing, mismatched, or a literal `<SURFACE_MODEL>` placeholder
   (all three silently fall back to inheriting the lead session's model — often Opus — on every
   dispatch); ⚠️ any `inherit` with the note that it bills at the lead's tier. The generic agents
   (`review.md`, `release.md`, `profile-reader.md` in `<agents>/`) must
   each carry their `model:` line too (sonnet/haiku/haiku).
<!-- cohorte:endif -->
<!-- cohorte:if runtime:claude -->
   **Command pins:** every mechanical command file
   (`build`, `review`, `fix`, `ship`, `audit`, `refactor`, `doctor`, `align-ds`,
   `update-pipeline` — in `<commands>/`) carries `model: sonnet` in
   its frontmatter — ⚠️ if missing (the lead's orchestration turn then bills at the session model,
   e.g. Opus/Fable). `brainstorm`, `spec`, `patch`, and `init-pipeline` are intentionally unpinned
   (interactive — they inherit the session model).
<!-- cohorte:endif -->

3. **Hooks & gate.** `<state>/gate-config.json` exists and mirrors the profile's `gate` block
   (regenerate if drifted).
<!-- cohorte:if hooks -->
   The gate hook is registered **once** in the config file the Runtime preamble names — flag a
   double registration, it double-prompts — and its `command` points at a `gate.py` that exists.
   Check the **matcher** actually covers what it must: on Claude Code that means both `Bash` and
   `Task`, since the preflight phase gate keys off `Task` dispatches and a `Bash`-only matcher
   leaves it silently dead (the 1.3.0–1.3.1 regression).
<!-- cohorte:if runtime:codex -->
   Codex's matcher must cover `Bash` plus `spawn_agent`/`Agent`, and
   `gate.py` must read `tool_input.agent_type`. With preflight enabled and no fresh stamp,
   a synthetic `spawn_agent` review payload must be denied. Check client hook enablement/trust
   separately; a direct script check is not proof the client invoked it.
<!-- cohorte:endif -->
   Test the evaluator too: `python3 <core>/hooks/gate.py --check "<a pattern from the ask list>"` must
   return a non-`allow` verdict. If the Runtime preamble said this runtime has **no confirmation
   tier**, state it here too: every `ask` pattern behaves as a `deny`, which is safe but stricter
   than the profile reads, and a human who expects a prompt will read the refusal as a bug.
<!-- cohorte:endif -->
<!-- cohorte:if !hooks -->
   This runtime has **no blocking hook**, so the gate is **advisory**: it only fires when the agent
   calls it. Say that in one line rather than reporting ✅ — the enforcement property genuinely is
   weaker here, and a human who thinks otherwise will approve less carefully. Verify what CAN be
   verified: `<core>/hooks/gate.py` exists and `python3 <core>/hooks/gate.py --check "git push"`
   returns a verdict line (a non-`allow` on a gated pattern proves config + script are wired). ❌ if
   the script is missing or errors; ℹ️ "advisory (this runtime has no hooks)" otherwise.
<!-- cohorte:endif -->
   Then the **preflight stamp is local, never versioned**: `git ls-files --error-unmatch
   <state>/preflight.ok` must miss, and `.gitignore` must cover it. A tracked stamp is a ❌ (not a
   ⚠️) — it records the tree it verified, the commit that carries it moves HEAD past that tree, and
   the committed copy lands in every clone and new worktree; the gate then blocks clean trees and
   greens unchecked ones. fix: `git rm --cached <state>/preflight.ok` + add it to `.gitignore`.
4. **Retrieval** (if `retrieval.provider` ≠ `none`). Run the SCHEMA.md §Code retrieval health
<!-- cohorte:if runtime:codex -->
   check: CLI resolvable from PATH, `[mcp_servers.<provider>]` in `.codex/config.toml`,
   `.serena/` gitignored, and tools actually connected in this session. A standalone
   `.mcp.json` is not Codex project registration.
<!-- cohorte:else -->
   check: CLI resolvable from PATH, `.mcp.json` entry present in PATH-proof launcher form,
   `.serena/` gitignored, server actually connects.
<!-- cohorte:endif -->
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
7. **Kanban** (the board mirror — SCHEMA.md §Kanban). Run
   `<core>/pipeline/scripts/kanban-move.sh --check` and report its one line verbatim: the resolved
   board path, or the exact link that is missing. A board mirror is optional, so "not configured" is
   ℹ️, never ❌ — but it must be **stated**, because the whole class of bug here is a card that
   quietly stopped moving while every command still reported success. Two states earn a ⚠️ with the
   fix named: `boards` has no entry for this profile's `name` while it does have an entry for some
   other key whose board file exists (a **rename** orphaned the link — re-key it via
   `/cohorte-update-pipeline`), and an entry whose board file no longer exists at
   `vault_path`-relative `board` (moved or renamed in the vault).
<!-- cohorte:if workflows -->
8. **Workflows** (the opt-in execution path — SCHEMA.md §Workflows; the conversational commands
   stay the default, so failures here are ⚠️ at most, never ❌). Report which path this machine will
   take and why:
   - **Claude Code version** ≥ 2.1.154 (`claude --version 2>/dev/null | head -1`) — older or no CLI
     on PATH ⇒ conversational only. This is the **workflow** floor and the only one that gates this
     check; do NOT raise it to match a newer feature's floor, or every install between the two
     versions reads as broken while its workflows run fine. When `design.inline` is on, report the
     design floor (≥ 2.1.234) as its own line under check 8b — separate prerequisite, separate verdict.
   - **Scripts present:** `<core>/workflows/review.js` + `audit.js` + `refactor.js` + `loop.js` —
     missing on a current core ⇒ half-done install, re-run install/update. (`/cohorte-loop` is
     **workflow-only** — no command file exists on purpose; without this runtime it refuses
     rather than degrading to a conversational loop.)
   - **Phase-0 agent present:** `<agents>/profile-reader.md` — the workflows abort without it.
   - **Workflows enabled in this session** — the `Workflow` tool is in your own toolset right now;
     absent ⇒ disabled for this session (a setting or an old client), conversational path.
   - **Preflight wiring** (used by both paths): `pipeline/scripts/preflight.sh` executable and
     `gate-config.json` carries the `preflight` block — mismatch ⇒ regenerate from the profile.
   End the check with ONE summary line, e.g.
   `workflows: available (opt-in — ask to "run the review workflow")` or
   `workflows: unavailable (<first failing prerequisite>) — conversational commands (the default)`.
<!-- cohorte:if inline_design -->
8b. **Inline design** (`design.inline: true` — the `/design` artboard step between spec and build).
   A research preview, so every failure here is ⚠️, never ❌: the design brief still exists on disk
   at `specs/design/<feature_id>.md` and can be carried to the design tool by hand, which is what
   every install did before this flag. Report:
   - **Claude Code version** ≥ 2.1.234 — `/design` ships as a skill and is simply absent below it.
     Older CLI ⇒ say so and name `npm i -g cohorte@latest`'s sibling, `claude update`.
   - **The `/design` skill resolves in this session** — absent ⇒ the preview is off for this account
     or plan (Pro/Max/Team/Enterprise are the eligible ones), not a cohorte defect.
   - **`design.enabled` is true and `provider` is `claude-design`** — `inline` on top of a `figma` or
     `none` provider is a profile contradiction; name it and point at `/cohorte-update-pipeline`.
   - **Artboards are not persisted for you.** State it every run, unconditionally, even when all
     three checks pass: the preview hands designs to the build step but does not save them, so an
     artboard nobody exported dies with the session. This is the single thing most likely to lose
     work, and it is not detectable after the fact.
   One summary line: `inline design: available (preview — export artboards yourself)` or
   `inline design: unavailable (<first failing prerequisite>) — design brief on disk, carry it over by hand`.
<!-- cohorte:endif -->
<!-- cohorte:else -->
8. **Preflight wiring.** `<core>/pipeline/scripts/preflight.sh` is executable and
   `gate-config.json` carries the `preflight` block — mismatch ⇒ regenerate from the profile.
   (The workflow execution path does not exist on this runtime; the conversational commands are
   the only path, which is also the default everywhere else. Not a defect — state it and move on.)
<!-- cohorte:endif -->
9. **Specs & metrics.** Every `specs/*.md` front-matter `status` is a valid stage — one of
   `draft · frozen · in-progress · in-review · shipped · blocked` (SCHEMA.md §Spec status) — excluding
   `_`-prefixed files (the spec template and `specs/_decisions.md`, the decision journal) and
   `specs/refactor-backlog.md`, which `/cohorte-audit` writes as a backlog, not a
   spec, and which has no front-matter to check. A spec left `in-progress` or `blocked` is a round
   that never finished ⇒ say so and route it: open `## Remediation` items ⇒ `/cohorte-fix`, none ⇒
   `/cohorte-build`. `shipped` specs
   with a live worktree flagged (see 6). `<state>/pipeline-metrics.jsonl` and `specs/reports/` (the
   `/cohorte-review` report buffer that lets a `/cohorte-fix` survive a `/clear`) are gitignored. Metrics
   belong to the **main checkout** — a `pipeline-metrics.jsonl` inside a live feature worktree is a
   stale-core sign (its lines die at teardown) ⇒ suggest appending its lines to the main checkout's
   file and deleting the stray.

## Report

Group by check, one line each: `✅|⚠️|❌ <check> — <one-line detail>`; every ⚠️/❌ followed by
`   fix: <exact command or edit>`. End with the overall count and, if anything failed, the ordered
repair sequence. Nothing failing ⇒ say the installation is healthy, and the installed core version.
