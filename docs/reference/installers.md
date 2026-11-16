# Installers & updates

One install mode since 3.0.0. The machine gets the commands and the generic core; everything that
describes a project lives in that project and is committed with it.

| Route | Needs | Notes |
| --- | --- | --- |
| `npm i -g cohorte && cohorte install` | Node ≥ 20 + npm | **The documented route.** Puts the `cohorte` binary on `PATH`. |
| `npx cohorte@latest install` | Node ≥ 20 + npm | Same CLI, run once from the npm cache; leaves no binary behind. |
| `install.sh` (curl … \| sh) | Node ≥ 20, `git`, POSIX sh | A thin wrapper: clones the **latest release tag** (never the tip of `main`) into a temp dir and runs its `bin/cli.js install`. From a checkout, installs that working tree. Leaves no `cohorte` binary on `PATH`. |
| `install.ps1` (irm … \| iex) | Node ≥ 20, `git`, Windows PowerShell 5.1+ / PowerShell 7 | Same wrapper for Windows. Its Node version probe parses `node --version`, so it works on PowerShell 5.1. Leaves no binary either. |

There is no Node-free install: both scripts check for Node ≥ 20 and stop with the npm command
if it is missing. They exist for machines where you would rather not install a global npm
package; they lay down exactly what the CLI lays down, because they *are* the CLI. Without the
global binary, run the other verbs as `npx cohorte@latest doctor | sync | uninstall …` — the
commands themselves call `sync` through `node ~/.claude/cohorte/lib/project.js`, so they don't need
it.

## Commands

```sh
npm i -g cohorte                         # once per machine — this is what puts `cohorte` on PATH

cohorte install                          # install (or refresh) on this machine — idempotent
cohorte update                           # the same operation; also migrates a 2.x install
cohorte sync      [project]              # wire one repo (run by /cohorte-init-pipeline and /cohorte-update-pipeline)
cohorte uninstall [--purge]              # remove what install wrote (--purge also removes your config)
cohorte uninstall --project [project]    # remove what sync wrote in one repo
cohorte doctor    [project] [--porcelain | --json | --panel]
cohorte specs     [project] [--porcelain | --json | --panel]
cohorte metrics   [project] [--days=N] [--since=ISO] [--runs] [--json]
cohorte version
```

`[project]` defaults to the current directory. Leftovers from 2.x:

- `--global` (or `-g`) is accepted and means nothing — it is the only mode.
- `cohorte install <path>` is **refused** with a pointer to `cohorte sync <path>`: the 2.x
  "bundled" mode (a core copied into each repo) no longer exists.
- `--runtime=claude` is accepted; any other `--runtime` / `--all-runtimes` is an error naming
  `cohorte@2.10.2`.

`CLAUDE_CONFIG_DIR` moves `~/.claude` for every verb. `COHORTE_NO_VERSION_CHECK=1` skips the one
network call (see [The version check](#the-version-check)).

## What `cohorte install` writes

```
~/.claude/commands/cohorte-*.md          the 16 slash commands
~/.claude/agents/cohorte-review.md       the fixed agents (surface agents are never written here)
                 cohorte-release.md
                 cohorte-profile-reader.md
~/.claude/workflows/cohorte-review.js    the four workflow scripts (cohorte-loop.js is workflow-only)
                    cohorte-audit.js
                    cohorte-refactor.js
                    cohorte-loop.js
~/.claude/cohorte/
  pipeline/      PIPELINE.template.md · SCHEMA.md · cohorte.config.template.yaml ·
                 implementer.template.md · CHANGELOG.md · VERSION
    schema/      the rulebook, one file per topic (SCHEMA.md is its index)
    scripts/     preflight.sh · kanban-move.sh · new-feature.sh.template · remove-feature.sh.template
  templates/     handoff, review-feedback, spec, patch, design-brief, pr-body, brainstorm-return,
                 decisions + steps/init-pipeline/ (the router's step files)
  hooks/gate.py  the gate's source — copied into each project by `cohorte sync`
  lib/project.js the self-contained `sync` (runs without the binary on PATH) + lib/yaml.js, its parser
  manifest.json  every file above, with the hash it was written with
~/.claude/cohorte.config.yaml            YOUR config — seeded once (a TTY install asks for the vault
                                         path), never overwritten, never in the manifest
```

Commands and agents are **rendered**, not copied as-is: the sources in `core/commands/` and
`core/agents/` keep only the frontmatter keys Claude Code understands and get one preamble that
resolves the path tokens (`<core>`, `<state>`, `<agents>`, `<fixed-agents>`, `<workflows>`,
`<sync>`…) for this machine. The surface-agent template ships under `pipeline/`, never under
`agents/`, so it is never mistaken for a dispatchable agent.

`install` registers **no hook** in `~/.claude/settings.json`. The gate lives in each project.

### Ownership rules

Each one is a bug that shipped in 2.x:

- **The manifest is the list of what is ours.** Nothing outside it is ever deleted. (2.x removed
  any `~/.claude/commands/review.md`, `build.md`, `spec.md`…, yours or not.)
- **Edited files are backed up.** A file of ours you modified — or a file of yours sitting on one
  of our names — is copied to `~/.claude/cohorte/backup/<timestamp>/` before it is refreshed, and
  the run says so.
- **Retired files go only when untouched.** A file the previous version shipped and this one does
  not is deleted if it is byte-for-byte what we wrote; if you edited it, it is kept and listed.
- **An unparseable `settings.json` aborts the run, unchanged.** `install`, `update`, `uninstall`
  and `sync` parse every JSON file they may edit (`~/.claude/settings.json`;
  `.claude/settings.json` and `.claude/pipeline.json` in a project) before writing anything, and
  stop with the parse error instead of resetting your model, env and permissions.
- **Another tool's hook is never touched.** Only registrations of Cohorte's own gate paths are
  recognised as ours — an unrelated `~/tools/gate.py` sharing a matcher group survives.

## `cohorte sync` — wiring one project

`/cohorte-init-pipeline` and `/cohorte-update-pipeline` run it; you can too. It is the same code as
`node ~/.claude/cohorte/lib/project.js sync .`, which the commands call so it works without the
binary on `PATH`. Deterministic and idempotent (a second run prints `already in sync`):

1. copies the gate to **`.claude/hooks/cohorte-gate.py`** (executable);
2. registers it in **`.claude/settings.json`** as two `PreToolUse` groups — matchers
   `Bash|Task|Agent` and `Write|Edit|MultiEdit|NotebookEdit` — exactly once, every other hook kept:

   ```json
   {
     "matcher": "Bash|Task|Agent",
     "hooks": [{
       "type": "command",
       "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py\"",
       "onFailure": "block"
     }]
   }
   ```

   `onFailure: block` makes it fail-closed (honoured from Claude Code 2.1.295): if `python3` or the
   hook file is missing, the call is refused rather than let through;
3. writes the **`.claude/pipeline.json`** pointer (below);
4. adds `.claude/preflight.ok`, `.claude/pipeline-metrics.jsonl` and `specs/reports/` to
   **`.gitignore`**;
5. seeds **`specs/_template.md`** if absent;
6. writes **`.claude/profile.json`** — the `yaml pipeline-profile` block of `PIPELINE.md` parsed to
   JSON, which the implementers, the reviewer, the release agent and the workflows' profile-reader
   read instead of the whole profile. Regenerated on every sync, so every command that edits the
   machine block re-runs sync after it. No `PIPELINE.md` (or no parseable block) ⇒ nothing is
   written and sync says so;
7. on a 2.x repo, removes the vendored core (see [Migrating from 2.x](#migrating-from-2-x)) and
   repoints 2.x permission rules at `~/.claude/cohorte/pipeline/scripts/`.

Commit `.claude/settings.json`, `.claude/hooks/cohorte-gate.py`, `.claude/pipeline.json`,
`.claude/profile.json` and `.gitignore` — a teammate who clones is protected before installing anything.

`sync` never writes `PIPELINE.md`, the surface agents, `gate-config.json` or the permission rules;
those are `/cohorte-init-pipeline`'s and `/cohorte-update-pipeline`'s job.

### The pointer — `.claude/pipeline.json`

```json
{ "pipeline": "cohorte", "core_version": "3.0.0", "install": "npm i -g cohorte && cohorte install" }
```

It tells a teammate which core to install, and lets `cohorte doctor` detect version drift. 3.x
has no `mode` field — `sync` drops a 2.x `"mode": "bundled" | "global"`.

## Updating

```sh
npm i -g cohorte@latest && cohorte update
```

then, in each project, **`/cohorte-update-pipeline`** — it runs `cohorte sync` and reconciles the
repo's generated files to the new core (new profile fields at their defaults, surface agents
re-rendered, permissions patched additively). `cohorte update` itself never touches a project.

`install` and `update` lay down the core carried by the CLI that runs them, so update the CLI
first. **Restart Claude Code** afterwards: commands and agents are scanned at session start.

### The version check

`cohorte install`, `update` and `sync` end with one read-only lookup of the latest published
version on `registry.npmjs.org`, and tell you when the CLI you ran is behind
(`npm i -g cohorte@latest`, or `npx cohorte@latest …` when run through npx) — skipped under `CI`.
`cohorte doctor` makes the same lookup to report the "behind npm" line, under `CI` too.
`COHORTE_NO_VERSION_CHECK=1` turns all of them off. That lookup is the only network call the CLI
makes — there is no telemetry.

### Why `npm i -g`, not `npx`

`npm i -g` installs the package and leaves a **`cohorte` binary on your `PATH`**, pinned to the
version you installed; `npx` fetches it into a cache, runs it once, and leaves nothing behind. The
docs use the first form because a **Francois extension panel** may only spawn a bare binary name
resolved on `PATH` — [francois-plugin-cohorte](https://github.com/TheBidouilleAgency/francois-plugin-cohorte)
requires the global install. `npx cohorte@latest <verb>` remains the right call for a one-off on
a machine you do not own.

## Migrating from 2.x

```sh
npm i -g cohorte@latest && cohorte update
```

On a 2.x machine, `cohorte update`:

1. **removes the 2.x machine-wide gate registration** from `~/.claude/settings.json` — first,
   before any file moves (a registered hook whose script is missing would block every Bash call
   on the machine). Other hooks in the same file are kept;
2. **moves the 2.x core** (`~/.claude/pipeline/`, the 2.x `templates/`, `hooks/gate.py`,
   `agents/review.md`, `release.md`, `profile-reader.md`, the unprefixed workflow scripts, retired
   commands carrying the Cohorte marker…) into `~/.claude/cohorte/legacy-backup/<timestamp>/`. Only
   files that are provably Cohorte's move — your own files are never touched;
3. **reports, and leaves in place**, surface agents a 2.x global init rendered into
   `~/.claude/agents` (e.g. `backend.md`) — live projects may still dispatch them.

Then, in **each project**, run `/cohorte-update-pipeline` (or `cohorte sync <project>`). On a 2.x
repo it removes the vendored core (`.claude/pipeline/`, `.claude/templates/`, `.claude/workflows/`,
`.claude/commands/cohorte-*.md`, `.claude/agents/{review,release,profile-reader}.md`,
`.claude/hooks/gate.py`) — files git tracks unmodified are deleted (git history keeps them),
anything else is moved to `.claude/cohorte-legacy-backup/<timestamp>/` — registers the new gate,
drops the pointer's `mode`, and re-renders surface agents that lived in `~/.claude/agents` into the
project's `.claude/agents`. Commit the result; once no project uses them, delete the global copies
of the surface agents.

Renamed in 3.0: the fixed agents are `cohorte-review`, `cohorte-release` and
`cohorte-profile-reader`; the workflow files are `cohorte-*.js`.

Using Codex, Cursor, Gemini CLI or OpenCode? 3.x does not support them — stay on
`cohorte@2.10.2` (`npx cohorte@2.10.2 …`); its source is on the
[`archive/multi-runtime`](https://github.com/TheBidouilleAgency/cohorte/tree/archive/multi-runtime)
branch.

If you ever tried the discontinued Python line (`cohorte@dev` 3.0.0-dev.*, `cohorte-engine` on
PyPI): `uv tool uninstall cohorte-engine` (or `pipx uninstall cohorte-engine`) so its `cohorte`
binary cannot shadow this one, and delete `~/.cohorte/` and any `.cohorte/` directory it left in
your repos.

## Uninstall

```sh
cohorte uninstall                      # everything install wrote
cohorte uninstall --purge              # …and ~/.claude/cohorte.config.yaml
cohorte uninstall --project [path]     # the gate wiring of one repo
```

- **`cohorte uninstall`** deletes every manifest file that is still exactly as written; files you
  modified are kept and listed, and so is `~/.claude/cohorte/` while it still holds backups. It
  also removes a 2.x machine-wide gate registration if one is left. Projects are not touched.
- **`--purge`** additionally deletes your `~/.claude/cohorte.config.yaml`.
- **`--project`** removes Cohorte's hook registrations from `.claude/settings.json` (foreign hooks
  kept), `.claude/hooks/cohorte-gate.py`, `.claude/pipeline.json` and `.claude/profile.json`. It leaves `PIPELINE.md`,
  `.claude/gate-config.json`, the surface agents, `specs/` (including `specs/_template.md`), the
  isolation scripts and the `.gitignore` lines — those are yours to delete.

Uninstall the projects first if you want the gate gone everywhere: a project whose gate is still
registered keeps running it (it is committed in the repo, not under `~/.claude`).

## The two-minute check

After installing, in a project you have run `/cohorte-init-pipeline` in:

```sh
cohorte version            # 3.x
cohorte doctor             # exits 1 when any check is bad
```

What a healthy report shows, and what to do when a line is not `ok`:

| Line | Healthy | When it is not |
| --- | --- | --- |
| Core & pointer | `core 3.x` | not installed ⇒ `cohorte install`; pointer behind ⇒ `cohorte sync` and commit; `mode` in the pointer or a 2.x core ⇒ `/cohorte-update-pipeline` / `cohorte update` |
| Profile (PIPELINE.md) | surfaces counted | missing ⇒ `/cohorte-init-pipeline` |
| Profile cache (.claude/profile.json) | `matches PIPELINE.md` | missing, stale (PIPELINE.md edited since the last sync) or differing ⇒ `cohorte sync` and commit; not committed ⇒ `git add .claude/profile.json` |
| Surfaces ↔ agents | every surface has its `.claude/agents/<agent>.md`, no orphans | `/cohorte-update-pipeline` re-renders |
| Gate config | `gate-config.json` mirrors the profile | missing or drifted ⇒ regenerate it from the profile's `gate` block (doctor prints the command) |
| Gate hook | `registered once (Bash\|Task\|Agent + Write\|Edit\|MultiEdit), committed` | not committed ⇒ `git add .claude/hooks/cohorte-gate.py .claude/settings.json`; missing ⇒ `cohorte sync` |
| Folder trust | `trusted` (or `trusted through <parent>`) | not trusted ⇒ open `claude` once in the repo (or a parent folder) and accept the trust dialog — until then `claude -p` (CI, francois) ignores the project's `permissions.allow` |
| Local artifacts | all gitignored | a tracked `preflight.ok` ⇒ `git rm --cached .claude/preflight.ok` |
| Workflows | scripts + `cohorte-profile-reader` installed | `cohorte update` |

Then, in Claude Code, `/cohorte-doctor` runs the same checks plus the live half (the workflow
runtime in this session, retrieval connectivity, the kanban link). Finally, prove the gate fires:

```sh
python3 .claude/hooks/cohorte-gate.py --check "<a pattern from your gate.deny list>"
# → gate: deny — …   (exit 2)
```

Treat the gate as a strong guard against agent mistakes, not a sandbox: keep **branch
protection** on the default branch in GitHub (require a PR, block force-pushes) as the hard
boundary for the remote.

## Reading a project without a coding agent

`specs` and `doctor` are the read-only half of the pipeline, in the shell. `specs` prints the
board (`id`, `status`, `branch`, `title`) from the frontmatter of `specs/*.md`; `doctor` runs the
checks above and **exits 1 when any check is bad**, so it drops into CI unchanged. Both read
through `lib/`, so every consumer — the CLI, a Francois panel — answers from one implementation.

| Flag | Shape |
| --- | --- |
| `--porcelain` | one record per line, fields separated by `U+001F` — a spec title with a space in it never misaligns a field |
| `--json` | the native document (the full doctor state, the spec list) |
| `--panel` | the payload a [Francois](https://github.com/antoine-gmnz/francois) extension panel validates against — also accepted by `metrics`, which emits the headline tiles |

`--panel` is the one Francois-aware surface in the package, and it exists for
[francois-plugin-cohorte](https://github.com/TheBidouilleAgency/francois-plugin-cohorte): a
manifest-only extension that renders the spec board, the doctor report and the 30-day cost as
three panels beside your sessions. It needs `npm i -g cohorte` — the manifest names a bare binary
and Francois resolves it on `PATH` at spawn time.

## Releases (maintainers)

```
package.json (semver source of truth)
  → merge to main → CI green on that commit
    → publish.yml re-runs the suites, waits for a maintainer's approval (npm-publish environment)
      → npm publish --provenance (latest, or `next` for a pre-release) · tag vX.Y.Z · GitHub release
        → cohorte install stamps ~/.claude/cohorte/pipeline/VERSION
          → cohorte doctor compares VERSION ↔ pointer ↔ npm latest
            → /cohorte-update-pipeline shows the CHANGELOG entries between old and new
```

Bump `"version"` in `package.json` and add its `## X.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`,
then merge to `main`. `publish.yml` starts only **after CI succeeded** on that commit and publishes
nothing for a version already on the registry. A pre-release version (`3.1.0-rc.1`) is published
under the `next` dist-tag, never `latest`. `install.sh` / `install.ps1` pick up the new `vX.Y.Z`
tag automatically.

## Repo layout (for contributors)

```
package.json            npm package (cohorte) — semver source of truth; `npm test` runs every suite
bin/cli.js              the CLI: install / update / sync / uninstall / doctor / specs / metrics / version
bin/report.js           the four renderings of `specs` / `doctor` (human, porcelain, json, panel)
lib/install.js          the machine install: manifest, ownership rules, 2.x migration, uninstall
lib/project.js          `cohorte sync`: wires one repo (copied into the core with its one sibling, yaml.js)
lib/render.js           renders core/commands + core/agents for Claude Code (one preamble of path tokens)
lib/doctor.js           the JS port of /cohorte-doctor, + versions.js / yaml.js. No dependencies.
install.sh, install.ps1 thin wrappers around bin/cli.js (Node required)
core/                   rendered (commands, agents) or copied (the rest) into ~/.claude by install
  agents/ commands/ hooks/ templates/ workflows/
profile/                PIPELINE.template.md · SCHEMA.md (index) · schema/ · cohorte.config.template.yaml
scripts/                shipped preflight/kanban scripts, isolation templates, metrics, the test suites
docs/                   this site (VitePress → GitHub Pages)
```
