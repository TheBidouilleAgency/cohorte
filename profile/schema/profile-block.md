# PIPELINE.md profile — field reference

`/cohorte-init-pipeline` fills the `yaml pipeline-profile` block in `PIPELINE.md` (from
`PIPELINE.template.md`) plus the prose sections. This documents every field and how the
generic pipeline uses it, so a stateless agent can read/regenerate the profile correctly.

## `yaml pipeline-profile` block

| Field                                | Type         | Used by                           | Meaning                                                       |
| ------------------------------------ | ------------ | --------------------------------- | ------------------------------------------------------------- |
| `name`                               | string       | all                               | Project name, used in agent prose + commit scopes.            |
| `one_liner`                          | string       | brainstorm/spec                   | One-sentence product description.                             |
| `ui_language`                        | string       | implementer, review               | Language of ALL user-facing copy.                             |
| `package_manager`                    | enum         | all                               | `pnpm`/`npm`/`yarn`/`bun`/`pip`/`cargo`/`go`.                 |
| `vcs.host`                           | enum         | release                           | `github`→use `gh`; else emit compare URL.                     |
| `vcs.remote`                         | string       | release                           | `owner/repo` for the PR/compare URL.                          |
| `vcs.default_branch`                 | string       | build, review, release            | Base branch for diffs + PRs.                                  |
| `vcs.feature_branch_prefix`          | string       | ship, isolation script            | `feature/` → branch `feature/<id>`.                           |
| `vcs.patch_branch_prefix`            | string       | ship                              | Same, for a `kind: patch` spec: `fix/` → branch `fix/patch-<slug>`. Optional — a profile that predates it falls back to `fix/`. |
| `project.kind`                       | enum         | init, spec, review                | What the repo delivers: `web`/`api`/`cli`/`library`/`mobile`/`data`/`other`. Selects the spec's DoD defaults, the review's kind-specific checks and whether the design step applies (`<core>/pipeline/schema/project-kinds.md`). Optional — absent ⇒ `web` (top-up default). |
| `repo.layout`                        | enum         | build, audit                      | `monorepo` (many surfaces) or `single`.                       |
| `repo.workspace_tool`                | enum         | audit                             | `turborepo`/`nx`/`none`.                                      |
| `retrieval.provider`                 | enum         | init, update-pipeline, implementer | `serena` (default) / `graphify` / `none` — see §Code retrieval (`<core>/pipeline/schema/retrieval.md`). |
| **`surfaces[]`**                     | list         | **build, review, refactor, init** | One per independently-built area. Grows via reconcile (`<core>/pipeline/schema/rendering.md`). |
| `surfaces[].key`                     | string       | build                             | Short id + review scope.                                      |
| `surfaces[].path`                    | string       | implementer                       | The ONLY tree that surface's agent may touch.                 |
| `surfaces[].owns_also`               | list         | hooks/gate.py                     | Optional. Extra root-relative paths (file, directory, or glob where `*` matches `/`) this surface's agent may also write, e.g. `[db/migrations]`. Default `[]`. |
| `surfaces[].label`                   | string       | build, init (`<SURFACE_LABEL>`)   | Human label + framework, e.g. `frontend (React)`.            |
| `surfaces[].agent`                   | string       | build (`subagent_type`)           | Rendered agent file name.                                     |
| `surfaces[].tools`                   | list         | init                              | Frontmatter `tools:` for the rendered agent.                  |
| `surfaces[].model`                   | enum         | init (`<SURFACE_MODEL>`)          | Frontmatter `model:` tier — `sonnet`/`haiku`/`inherit`. Default `sonnet` (implementers mostly apply a frozen contract — far cheaper than the Opus lead the dispatcher runs on, and Sonnet handles it well); `haiku` for purely mechanical surfaces (scaffolding); `inherit` only for surfaces with real design decisions worth the lead's model. |
| `surfaces[].*_cmd`                   | string       | implementer                       | test/lint/format/typecheck/build commands.                    |
| `surfaces[].test_quiet_cmd` `.lint_quiet_cmd` | string | implementer, preflight, workflows | Bridled variants agents actually run (dot reporter / `--quiet` / failures-only). `""` ⇒ `<cmd> 2>&1 \| tail -40`. See §Output discipline (`<core>/pipeline/schema/output-discipline.md`). |
| `surfaces[].uses_design`             | bool         | build, frontend                   | Whether this surface consumes designs.                        |
| `contract.enabled`                   | bool         | build                             | `false` ⇒ skip contract authoring (§2 of /cohorte-build).             |
| `contract.mechanism`                 | enum         | build, lead                       | `shared-types-zod`/`openapi`/`protobuf`/`json-schema`/`none`. |
| `contract.path` `.ext` `.index`      | string       | build                             | Where `<feature_id>` contract is authored + barrel.           |
| `contract.authored_by`               | const `lead` | build                             | Implementers import it read-only, never edit.                 |
| `ownership.enforce`                  | bool         | hooks/gate.py                     | Default `true`: the gate denies a surface agent's Write/Edit outside its `path` + `owns_also` + `ownership.shared_writable` and any write to `contract.path`/`.index`. For Bash it is best effort. The lead and non-surface agents are never restricted. `false` turns it off. Read from `.claude/profile.json`, so it is inert until `cohorte sync` writes that file. Inert also when that file is unreadable. |
| `ownership.shared_writable`          | list         | hooks/gate.py                     | Root-relative paths every surface agent may write, typically lockfiles (`pnpm-lock.yaml`). Same forms as `owns_also`. Default `[]`. |
| `release_notes.enabled`              | bool         | ship                              | `false` ⇒ skip note authoring (§2b of /cohorte-ship). See §Release notes (`<core>/pipeline/schema/release-notes.md`). |
| `release_notes.tool`                 | enum         | ship                              | `changesets`/`none` — what consumes the file.                 |
| `release_notes.dir` `.filename`      | string       | ship                              | Where the per-feature note is authored, e.g. `.changeset/<feature_id>.md`. |
| `release_notes.anchor_package`       | string       | ship                              | Sole key in the note's front-matter; a lockstep/`fixed` group propagates the bump. |
| `release_notes.language`             | string       | ship                              | Language of the note's prose — usually `ui_language`.         |
| `release_notes.forbid_levels`        | list         | ship                              | Bump levels project policy refuses, e.g. `[major]` while `0.x`. |
| `release_notes.empty_cmd`            | string       | ship                              | Escape hatch when no version should move; `""` if none.       |
| `release_notes.ci_job`               | string       | ship                              | CI job that fails on a missing note — lets §5 name the red check. |
| `release_notes.guidance`             | string       | ship                              | Project policy the lead follows when picking the bump + writing the prose. |
| `commands.*`                         | string       | all                               | Repo-wide install/dev/lint/format/typecheck/test + migrate.   |
| `commands.test_quiet` `.lint_quiet`  | string       | review, audit, workflows          | Repo-wide bridled variants — what the `/cohorte-review` pre-flight runs. Same fallback as the per-surface ones. |
| `commands.security`                  | list         | review, workflows (preflight)     | Dependency audits and a feature-diff secret scan, run by the `/cohorte-review` pre-flight after typecheck/lint/tests. A red scan aborts the review, and the reviewer reads the green output. Default `[]`. A single string is read as a one-item list. Recipes and rules (static paths, feature diff only): `<core>/pipeline/schema/preflight.md` §Security scans. |
| `commands.migrate_down`              | string       | verify, revert                    | Undo the last migration on the **dev** DB. `/cohorte-verify` checks down-then-up with it; `/cohorte-revert` runs it (`commands.rollback` is read as an alias when this is absent). `""` ⇒ rollback not verified; a command in `gate.deny` is never run. |
| `commands.dev_ready`                 | string       | verify                            | Says `commands.dev` is up: an http(s) URL answering 2xx/3xx, or a shell probe exiting 0. `dev` without it doesn't count as runtime-verifiable. |
| `commands.smoke` `.e2e`              | string       | verify                            | Quick checks / the end-to-end suite (e.g. Playwright), run against the started app. All runtime commands `""` ⇒ verify skipped silently. See `<core>/pipeline/schema/verify.md`. |
| `verify.enabled`                     | bool         | verify, ship                      | `false` ⇒ `/cohorte-verify` is a no-op and `/cohorte-ship` never asks about it. Default `true`. |
| `verify.db`                          | enum         | verify, revert                    | `local` (default — the dev DB is yours) / `shared` (others use it ⇒ migrations refused unless `isolation.db_per_worktree`, in a feature worktree). |
| `verify.ready_timeout_seconds` `.check_timeout_seconds` | number | verify                  | Ready-probe window (default 90) and per-check limit (default 600). |
| `verify.screenshots`                 | enum         | verify                            | `auto` (default — when `node_modules/.bin/playwright` resolves; never `npx`-installs) / `off`. |
| `verify.surfaces.<key>`              | map          | verify                            | Optional per-surface hints: `base_url`, `paths[]` (screenshotted), `smoke` (an extra check `smoke:<key>`). Only touched surfaces are used. |
| `rbac.enabled`                       | bool         | brainstorm, review                | Toggle RBAC personas + authz audit.                           |
| `rbac.hierarchy`                     | list         | review                            | Highest→lowest role list.                                     |
| `design.enabled`                     | bool         | build, frontend, align-ds         | `false` ⇒ design steps are no-ops.                            |
| `design.provider`                    | enum         | frontend, align-ds                | `claude-design`/`figma`/`none`.                               |
| `design.design_system_project`       | id           | align-ds, frontend                | UI-kit source of truth.                                       |
| `design.design_project`              | id           | build, frontend                   | Legacy fallback for bare-filename `design_files` only; default `none`. New specs use full `…/design/p/<projectId>?file=<file>` links that carry their own project + page (nothing to go stale on a DS rebuild). |
| `design.snapshot_dir`                | path         | align-ds                          | Committed DS snapshot for diffing.                            |
| `design.ui_kit_path` `.tokens_path`  | path         | align-ds, frontend                | Where the kit + tokens live in code.                          |
| `isolation.enabled`                  | bool         | new-feature script                | `false` ⇒ build in main checkout.                             |
| `isolation.db_per_worktree`          | bool         | new-feature script                | Create `<name>_<id>` DB per worktree.                         |
| `isolation.db_name_pattern`          | string       | new-feature script                | `<name>_<id>`.                                                |
| `isolation.port_base`                | map          | new-feature script                | `api`/`web` base ports; +slot per worktree.                   |
| `isolation.compose_file` `.registry` | path         | new-feature script                | Docker stack + slot registry.                                 |
| `gate.deny[]`                        | list         | hooks/gate.py, settings           | Command substrings hard-denied, on any branch.                |
| `gate.ask[]`                         | list         | hooks/gate.py, settings           | Command substrings that require confirm, on any branch.       |
| `gate.ask_on_default_branch[]`       | list         | hooks/gate.py                     | Confirm ONLY on `default_branch`; free on feature branches.   |
| `gate.default_branch`                | string       | hooks/gate.py                     | Protected branch (default `main`); gate resolves via git.     |
| `gate.preflight.enabled`             | bool         | hooks/gate.py, review             | Phase gate: review dispatches need a fresh preflight stamp. See §Preflight (`<core>/pipeline/schema/preflight.md`). |
| `gate.preflight.agents[]`            | list         | hooks/gate.py                     | `subagent_type`s the stamp gates (default `[cohorte-review]`; `review` still accepted). |
| `gate.preflight.max_age_minutes`     | number       | hooks/gate.py                     | Stamp freshness window (default 30).                          |
| `gate.hook_form`                     | enum         | sync                              | `shell` (default) — the hook is one command line run by a POSIX shell. `exec` — `python3` + an `args` list, `${CLAUDE_PROJECT_DIR}` substituted by Claude Code, no shell: for Windows teams without Git Bash. Needs a recent Claude Code on every machine (verified on 2.1.325). |

## Prose sections

- **Conventions** — per-surface rules the implementer follows and review audits.
- **Testing** — the TDD contract per surface (what a test must cover, DB isolation).
- **Design brief note** — feeds `/cohorte-spec` §8 and the Claude Design step.
- **Personas** — the `/cohorte-brainstorm` panel; include one per RBAC role when `rbac.enabled`.

## How the pieces reference this file

- **Agents** (`implementer`, `review`, `release`) are told at dispatch: _read `PIPELINE.md`
  §Commands / §Conventions / §Surfaces first._ They have `Read`, so they load it live.
- **Commands** (`/cohorte-build`, `/cohorte-review`, …) parse the `yaml pipeline-profile` block to know how
  many surfaces to dispatch, the contract mechanism, the commands, and the capability flags.
- **`<state>/profile.json`** is this block parsed to JSON by `<sync>` (committed, regenerated by
  every sync — so every command that edits the block runs `<sync>` after it). Agents that need only
  the machine block — the implementers, `cohorte-review`, `cohorte-release`, the workflows'
  `cohorte-profile-reader` — read it instead of `PIPELINE.md`, falling back to the fenced block when
  it is absent. `cohorte doctor` warns when it no longer matches `PIPELINE.md`.
- **Hook** (`gate.py`) reads `gate.deny`/`gate.ask`/`gate.ask_on_default_branch`/`gate.default_branch`
  from a generated `<state>/gate-config.json`. The last two make git + docker free on feature branches
  but confirm-gated on the default branch (branch resolved at run time via `git rev-parse`).
- **Scripts** (`new-feature.sh`) read the `isolation` block (rendered in at init).
