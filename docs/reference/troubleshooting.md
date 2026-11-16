# Troubleshooting

First reflex, always: **`cohorte doctor`** in the shell, or **`/cohorte-doctor`** in Claude Code —
they check every piece of wiring and print the exact fix per failure. This page covers the
failures with a story behind them.

## Installation & versions

**`cohorte install` stops with "settings.json is not valid JSON".**
By design: Cohorte never rewrites a file it cannot parse (2.x used to replace it, taking your
model, env and permissions with it). Nothing was changed. Fix the file — usually a trailing comma
or a stray BOM — and re-run. `cohorte sync` does the same for the project's `.claude/settings.json`
and `.claude/pipeline.json`.

**`cohorte install <path>` is refused.**
3.x installs on the machine only; the 2.x per-project ("bundled") core is gone. To wire a repo, run
`/cohorte-init-pipeline` inside it, or `cohorte sync <path>` for the gate wiring alone.

**"cohorte 3.x supports Claude Code only".**
You passed `--runtime=codex` (or another runtime) or `--all-runtimes`. Codex, Cursor, Gemini CLI and
OpenCode were dropped in 3.0.0: stay on `npx cohorte@2.10.2 …` for them (source on the
[`archive/multi-runtime`](https://github.com/TheBidouilleAgency/cohorte/tree/archive/multi-runtime)
branch).

**The commands don't show up after installing or updating.**
Claude Code scans commands and agents at session start: restart it (or open a new session). Then
check `~/.claude/commands/cohorte-*.md` exists — or `$CLAUDE_CONFIG_DIR/commands/` if you set it.

**A heads-up says one of my files "differed from what cohorte installed".**
You edited a file Cohorte owns (or had one of your own on its name). Your copy is in
`~/.claude/cohorte/backup/<timestamp>/` and the shipped version replaced it. Put customisations in
`PIPELINE.md` §Conventions or your own commands — the installed files are regenerated on every
update.

**A command exists but its agent doesn't (or vice-versa).**
Half-copied or stale core. Re-run `npm i -g cohorte@latest && cohorte update`. `/cohorte-doctor`
check 1 (Core & pointer) also flags a missing `manifest.json` — the signature of a core copied by
hand.

**`/cohorte-loop` is not in the command list.**
Expected: the loop is **workflow-only** — there is no `cohorte-loop.md`, only
`~/.claude/workflows/cohorte-loop.js`. Ask *"run the loop workflow for `<id>`"* (Claude Code ≥
2.1.154 with workflows enabled). See [Workflows](/guide/workflows).

**Kanban cards stopped moving — with no error anywhere.**
Every caller chains the shipped scripts with `|| true`, so a missing
`kanban-move.sh`/`preflight.sh` is a *silent* no-op. `/cohorte-doctor` check 1 is
the only thing that sees it; the fix is `cohorte update`.

**Cards move for some stages and not others.**
Run `kanban-move.sh --check` (or `/cohorte-doctor` check 7, Kanban): it prints the resolved board,
or the exact link that is missing. Before 2.0.2 the stages only *described* the move, so a phase
session — each one starts after a `/clear`, with no memory of the config — could conclude "no board
is configured" without opening it, and report success either way. Update the core; every stage now
calls the resolver and reports what it printed.

**The board went quiet right after renaming the project.**
`kanban.boards` is keyed by the profile `name`, so editing `name:` in `PIPELINE.md` orphans the old
entry and no lookup matches the new one — a legitimate "no board configured", indistinguishable from
never having had one. `/cohorte-update-pipeline` spots the orphan and offers to re-key it; or edit
the key in `~/.claude/cohorte.config.yaml` by hand.

**`pipeline.json` claims an old `core_version` on a current core.**
The pointer is written by `cohorte sync`, per repo. Warn-level, not broken — run
`/cohorte-update-pipeline` (or `cohorte sync`) in that repo and commit the pointer.

**A workflow says the Workflow runtime is unavailable.**
`/cohorte-doctor` check 8 (Workflows) tells you which prerequisite fails: Claude Code < 2.1.154,
workflows disabled for the session, scripts missing from `~/.claude/workflows/`, or the
`cohorte-profile-reader` agent missing. The conversational commands are the designed fallback —
nothing is broken (except `/cohorte-loop`, which has no conversational form on purpose).

## Coming from 2.x

**`doctor` warns about 2.x leftovers.**
Three kinds, each with its fix: a 2.x core in `~/.claude/pipeline/` or a gate registered in
`~/.claude/settings.json` ⇒ `cohorte update` migrates the machine; a vendored core in the repo
(`.claude/pipeline/VERSION`, `.claude/hooks/gate.py`) ⇒ `cohorte sync` (or
`/cohorte-update-pipeline`) removes it; a pointer still carrying `"mode"` ⇒
`/cohorte-update-pipeline`. See [Migrating from 2.x](/reference/installers#migrating-from-2-x).

**`cohorte update` said it "left in place" agents in `~/.claude/agents`.**
Surface agents (`backend.md`, `frontend.md`…) a 2.x global init rendered there. They are left
because a project you have not migrated yet still dispatches them. Run `/cohorte-update-pipeline` in
every project that uses them — it re-renders them into that project's `.claude/agents` — then delete
the global copies.

**Where did my 2.x files go?**
Machine: `~/.claude/cohorte/legacy-backup/<timestamp>/`. Repo: files git tracked unmodified were
deleted (they are in git history); anything else is in `.claude/cohorte-legacy-backup/<timestamp>/`.

**Another `cohorte` binary answers (`cohorte --version` is not 3.x from npm).**
The discontinued Python line (`cohorte-engine` on PyPI) installs a binary of the same name:
`uv tool uninstall cohorte-engine` (or `pipx uninstall cohorte-engine`), then delete `~/.cohorte/`
and any `.cohorte/` directory it left in your repos.

## Serena / retrieval

**Agents silently fell back to grep-and-read.**
The MCP server failed to start. Run the health check (`/cohorte-doctor` check 4): the usual causes are
`serena` not on PATH in the environment Claude Code was launched from (fix: the PATH-proof
launcher entry in `.mcp.json`, or `uv tool update-shell`), the tool uninstalled, or a hand-edited
entry. After repair, a **session restart** is needed before the tools appear — `/cohorte-doctor` says so
explicitly rather than reporting success on registration alone.

## Gate & permissions

**Every Bash call in the project is refused (and edits and agent dispatches with it).**
The gate is registered fail-closed (`onFailure: block`) on `Bash|Task|Agent` and
`Write|Edit|MultiEdit|NotebookEdit`: when the hook itself cannot run, Claude Code refuses every one of those
calls. Usual causes: no `python3` on PATH (Python ≥ 3.9 is required — on Windows
make sure `python3` resolves, not only `py`), or `.claude/hooks/cohorte-gate.py` missing while
`.claude/settings.json` still registers it (a partial checkout, a deleted file). Fix: install
Python, or run `cohorte sync` to restore the hook file. `cohorte doctor` reports a registration
whose file is missing as bad. Older Claude Code clients (< 2.1.295) ignore `onFailure` and fail
open instead.

**The gate is silent although `PIPELINE.md` has gate patterns.**
A missing or unparseable `.claude/gate-config.json` makes the hook allow everything (it never
bricks a repo over its config). `cohorte doctor` "Gate config" flags a config that is missing or
drifted from the profile, with the command that regenerates it from the `gate` block. Prove it
fires with
`python3 .claude/hooks/cohorte-gate.py --check "<a deny pattern>"` from the repo root.

**The gate prompts twice for the same command.**
Double hook registration — usually a 2.x machine-wide gate still in `~/.claude/settings.json` on top
of the project's. `cohorte doctor` flags it; `cohorte update` removes the 2.x registration.

**A review dispatch asks for confirmation about a "preflight stamp".**
The phase gate: preflight hasn't run green recently, or the code changed since it did. Run the
command's §0 preflight (or let it run — the prompt is the sign something skipped it). You can
consciously confirm through it; the point is that it can't happen *accidentally*.

**Every review dispatch claims the stamp is stale / "HEAD moved" on a clean tree.**
The `preflight.ok` stamp got committed. It names the tree it verified, so the commit carrying
it moves HEAD past that tree — the copy in git can never match its own commit, and it rides into
every clone and new worktree as a green nobody earned. Untrack it:
`git rm --cached .claude/preflight.ok` (`cohorte sync` already lists it in `.gitignore`;
`cohorte doctor` "Local artifacts" flags a tracked stamp as bad). Since 2.0.0 the stamp also
carries a content digest instead of keying on HEAD, so committing already-verified code no longer
invalidates it.

**Headless runs (workflow subagents, `claude -p`) get hard denies on gated commands.**
By design: in `bypassPermissions` there's nobody to answer an "ask", so the gate escalates it to
a clear deny. Run that operation interactively instead.

**Under `claude -p` (CI, francois, a script), every pipeline script asks for permission.**
Claude Code ignores a project's `permissions.allow` until its folder has been trusted — the dialog
an interactive `claude` shows the first time — and a headless run never shows it (it prints
`Ignoring N permissions.allow entries … this workspace has not been trusted`). Open `claude` once in
the repo, or in a parent folder, and accept the dialog; `cohorte doctor` reports it as
**Folder trust**. Hooks are not affected: the gate runs either way.

**Something got past the gate.**
The gate matches the project's patterns against parsed commands; a pattern list cannot anticipate
every spelling of a destructive operation, and it is not a sandbox against a process that wants
around it. Add the pattern to `gate.deny` / `gate.ask` in `PIPELINE.md` and run
`/cohorte-update-pipeline` — and keep **GitHub branch protection** on the default branch as the
hard boundary for the remote.

## The loop

**`/cohorte-ship` refuses: freshness mismatch.**
Source (or the contract) changed after the SHIP verdict — the verdict is stale. Re-run
`/cohorte-review <id>`; ship only on the fresh stamp. This is the gate working, not failing.

**`/cohorte-build` keeps re-dispatching items that were already fixed.**
The spec's `## Remediation` checkboxes are the state. If a prior round's fixes were never ticked
`- [x]` (e.g. an interrupted `/cohorte-fix`), tick what the diff shows fixed, or run `/cohorte-fix` again — its
§3 reconciles the boxes from the handoffs.

**A worktree's review diffs against ancient code.**
The worktree is behind main. `/cohorte-doctor` check 6 shows "behind by N commits" per live worktree;
`git rebase main` in the worktree before the next review.

**A workflow run died mid-flight (session killed, headless audit interrupted).**
Disk state is safe by design: reports staged, remediation appended, backlog written — relaunch the
workflow (or continue conversationally) and it picks up from the files. The loop workflow keeps its
state in `specs/reports/<id>.loop.json`, so re-invoking it resumes.

## Starting over

Machine: `cohorte uninstall` (keeps your config and any file you edited), then `cohorte install`.
Project: `cohorte uninstall --project`, back up and remove `PIPELINE.md`, `.claude/agents/`,
`.claude/gate-config.json` (and optionally `specs/`), then re-run `/cohorte-init-pipeline`. Neither
touches the other.
