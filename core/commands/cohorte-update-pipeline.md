---
model: sonnet
description: Refresh this runtime's global or project-local pipeline core, then reconcile the project's generated files — /cohorte-init-pipeline stays one-time.
argument-hint: [path-to-local-checkout]
---

You are the **pipeline updater**. Refresh the installed pipeline core to the latest version of the pipeline
repo. The installer's `--update` mode never touches generated files: `PIPELINE.md`, rendered surface agents,
`gate-config.json`, `settings.json`, and the filled `<config>` are all preserved.
YOU then bring those generated files up to the new core yourself (§3.5) — additively, never clobbering
the human's choices — so `/cohorte-init-pipeline` never needs re-running for an upgrade.

## 1. Detect the install scope + current version

- **Global** install ⇒ `<core>/pipeline/VERSION` exists. **Bundled** ⇒ this repo's
  `<core>/pipeline/VERSION` exists. (Both can exist; prefer the bundled one when running inside such a
  repo, and update both if the human wants.)
- **Never migrate a repo between bundled and global mode on your own.** Updating means refreshing the
  core *in its current mode*. Only migrate (e.g. delete a bundled core in favor of the global one) if
  the human explicitly asks — and confirm before deleting anything, since it rewrites the repo's
  committed `.claude/` and the `pipeline.json` pointer teammates rely on.
- Read the VERSION file(s) — a semver like `0.1.0`, possibly suffixed `(abc1234)` for from-main
  installs, or a bare commit hash on old cores. If missing, note "unknown (pre-versioning)".

## 2. Run the update

<!-- cohorte:if runtime:codex -->
Preserve the existing install scope and explicitly select Codex:

- Local source checkout supplied: `node <path>/bin/cli.js update --runtime=codex [--global]`.
- Published release: `npm i -g cohorte@latest`, then `cohorte update --runtime=codex [--global]`.

Expand `[--global]` to `--global` only for a global core; otherwise omit it. Run from the target
project, or pass its path. Keep the user's normal `CODEX_HOME`. The global core and generic
agents may be shared, but reconciliation always writes surface agents in this project's
`.codex/agents/*.toml`.
<!-- cohorte:else -->
- If `$ARGUMENTS` is a path to a local checkout of the pipeline repo (contains `core/` + `install.sh`),
  run from there — useful when iterating on the pipeline itself:

  ```sh
  sh <path>/install.sh --update --global     # global core
  sh <path>/install.sh --update              # bundled core of the current repo
  ```

- Otherwise use the published npm package (preferred — installs the latest tagged release):

  ```sh
  npm i -g cohorte@latest              # the CLI itself, refreshed
  cohorte update --global              # global core
  cohorte update                       # bundled core of the current repo
  ```

  If `cohorte` is not on PATH, `npx cohorte@latest update [--global]` runs the same thing
  without installing anything.

- If npm is unavailable, fall back to piping the installer from the repo's latest `main`:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.sh | sh -s -- --update --global
  # bundled:  … | sh -s -- --update
  ```

  (The piped installer clones the repo itself; `-s --` forwards the flags.)
<!-- cohorte:endif -->

## 3. Report old → new

Re-read the VERSION file(s) and print `old → new`. If unchanged, say the core was already up to date.

**Sync the pointer — in BOTH modes.** If this repo has a `<state>/pipeline.json` whose `core_version`
differs from the core you just installed, rewrite that one field (leave every other field untouched)
and tell the human to commit it. In **bundled** mode the installer already did it; in **global** mode
**nothing does** — the installer refreshes one shared core and cannot know which repos point at it,
so before 1.2.5 the field simply drifted forever (a repo on a current core still claiming `1.0.0`).
`/cohorte-doctor` check 1 requires the pointer to be coherent with the VERSION file, so a drifted field reads
as a broken install when nothing is broken.

Then print **What's new**: read the installed `<core>/pipeline/CHANGELOG.md` and show the entries
between the old and new versions (most recent first). File absent ⇒ the old core predates 0.1.14 —
skip silently.

## 3.5 Reconcile this repo's generated files

Only when the current repo has a `PIPELINE.md`: run the **Reconcile procedure** from the installed
`pipeline/SCHEMA.md` §Reconcile — top up the profile's machine block with new fields at their defaults
(one batched question set for any genuinely new human decision — e.g. choosing a `retrieval` provider,
or the **quiet command variants**: `test_quiet_cmd`/`lint_quiet_cmd` + `commands.test_quiet`/
`lint_quiet`, proposing the detected bridled forms per §Output discipline; `gate.preflight` tops up
silently at its defaults), re-render the surface agents from the current `implementer.template.md`
(this refreshes each agent's **baked §Conventions slice** — required after any hand-edit of the
profile's prose).
<!-- cohorte:if runtime:codex -->
Write surface agents as `.codex/agents/*.toml`, validate TOML, and preserve explicit Codex model
choices (legacy Anthropic aliases mean inheritance). Patch `<state>/gate-config.json` and
verify the selected scope's hook covers shell and `spawn_agent`/`Agent`; do not duplicate it.
Verify `<fixed-agents>/profile-reader.toml` and the other shipped generic agents. Workflows are
unavailable on Codex and their absence is expected. Reconcile MCP in `.codex/config.toml` using
SCHEMA.md §Code retrieval, preserving unrelated configuration and checking actual connectivity.
If a previous install wrote this project's agents globally, compare ownership/content before
moving them locally; never remove unrelated global agents or overwrite modified local copies.
Remove project-only `CODEX_HOME` workarounds only after verifying native discovery. Do not copy
authentication into the repository. Report what changed and anything still unverified.
<!-- cohorte:else -->
Additively patch `settings.json`/`gate-config.json` (including the `preflight`
block and the workflow-agent `allow` entries from init step 5), and run any newly-added capability's
wiring (e.g. Serena's project-scope `claude mcp add`). Verify the refreshed core actually carries
`<core>/workflows/` + `agents/profile-reader.md` — missing means the update half-ran: re-run the
installer. Even when no capability is new, **re-run the retrieval provider's
health check** (SCHEMA.md §Code retrieval: CLI resolvable from PATH, `.mcp.json` entry present —
upgrading a bare `serena` entry to the PATH-proof launcher form, `.serena/` gitignored, server
actually connected) and repair whatever fails — wiring that worked at
init can rot (PATH changes, uninstalls, hand-edits). Report what was reconciled; if nothing was
missing, say so. This is why `/cohorte-init-pipeline` never needs re-running for a core upgrade.
<!-- cohorte:endif -->

Four of the §Reconcile steps matter specifically here:

- **Local-artifact hygiene** (§Reconcile step 8): gitignore + untrack the pipeline's runtime files
  (`<state>/preflight.ok`, `<state>/pipeline-metrics.jsonl`, `specs/reports/`). A tracked
  `preflight.ok` — what every pre-2.0.0 install ends up with once a release agent stages `.claude/` —
  makes the phase gate ask on every single review dispatch, so fix it here and say so.

- **Spec-template top-up** (§Reconcile step 7): `specs/_template.md` was seeded at install and never
  refreshed since, so add the front-matter fields the current `templates/spec.template.md` has and the
  repo's copy lacks — and drop `loop_pass`/`loop_phase`, retired with `/cohorte-loop` in 2.2.0 —
  front-matter only, never the body.

- **Global config seed** (§Reconcile step 5): if `<config>` is absent, seed it
  from the template so the kanban + shared-vault config has a home. Never clobber an existing filled
  file. Report what was seeded. Then **scrub the retired `telemetry:` block** if the existing file
  still has one (every install seeded before 2.3.0 does) — one targeted Edit deleting the block and
  its comment header, nothing else touched. That capability was removed in 2.3.0, sender included,
  so the block is dead config: nothing reads it, and an `enabled: true` left sitting in a file the
  human may open reads as though data were still leaving the machine. Say you removed it.
- **Kanban sync** (§Reconcile step 6): resolve this project's board with
  `<core>/pipeline/scripts/kanban-move.sh --check` — it prints either the board path or the exact
  missing link. **Not linked** → offer to link/create a board (confirm the vault + `<folder>/Tasks.md`,
  write the `boards` entry, create the board file per §Kanban). **Linked** → verify the board file
  exists (recreate if the human confirms) and its columns match `kanban.columns` (repair drift). Either
  way, run the §Kanban **full sync/backfill** from `specs/*.md` — one
  `kanban-move.sh auto <id> <stage>` per spec, `<stage>` from the status mapping — this is what adds
  every already-developed feature to the board and repositions cards to match each spec's `status`.
  Report cards added / moved / already-correct. Skip silently if `kanban.enabled` is false and the
  human doesn't want to turn it on.
- **A project renamed since its last update loses its board silently** — `boards` is keyed by the
  profile `name`, so a `name:` edit orphans the old entry and no lookup matches the new one. When
  `--check` finds no entry for `<name>` but `boards` holds exactly one other key whose board file
  exists, say so and offer to re-key it rather than creating a second board.

## 4. Tell the human the follow-ups

- **Restart / reload the coding-agent session** so it picks up updated commands, agents, and any
  newly-registered MCP server.
- **Other repos using the global core:** their core is already fresh, but reconcile is per-repo — run
  `/cohorte-update-pipeline` inside each (it will skip the already-done core update and just reconcile).
<!-- cohorte:if runtime:codex -->
- **Commit** the reconciled `PIPELINE.md`, `.codex/agents/*.toml`, `.codex/config.toml` if added,
  and versioned `<state>` files. Never commit auth or session state.
<!-- cohorte:else -->
- **Commit** the reconciled files (`PIPELINE.md`, `.claude/`, `.mcp.json` if added) so teammates get them.
<!-- cohorte:endif -->
- The kanban config is global and user-scoped
  (`<config>`) — never committed. The core update never touches it; only the
  reconcile above seeds the file and writes kanban board links (into that global file, not the repo).
