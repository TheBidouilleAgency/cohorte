# Installers & updates

Three installers, one contract: same files, same scrubs, same seeding. CI dry-runs the shell and
npm installers against identical postconditions so they can't drift (they have — that's why the
check exists).

| Installer | Runs where | Notes |
| --- | --- | --- |
| `bin/cli.js` (the `cohorte` CLI) | anywhere with Node ≥ 18 | The npm package; copies by *rule* (every non-template agent, every shipped `.sh`) so new files can't be forgotten. Offers a quick TTY interview when seeding the global config. |
| `install.sh` | POSIX sh (dash/bash/zsh) | Works from a checkout or piped via curl (clones itself). |
| `install.ps1` | Windows PowerShell 5.1+ | Mirrors install.sh; BOM-free JSON writes, Store-alias-proof Python detection. |

## Commands

```sh
npm i -g cohorte                # once per machine — this is what puts `cohorte` on PATH

cohorte install [target]        # bundled: core into <target>/.claude (committable)
cohorte install --global        # global: one shared core in ~/.claude + gate hook registered
cohorte update  [--global]      # refresh the stack-agnostic core ONLY
cohorte metrics [target] [--days=N] [--since=ISO] [--runs] [--json]
cohorte specs   [target] [--porcelain | --json | --panel]
cohorte doctor  [target] [--porcelain | --json | --panel]
cohorte version
```

### Why one form, and why the global one

`npm i -g` and `npx` are different tools, not two spellings: `npm i -g` installs the package and
leaves a **`cohorte` binary on your `PATH`**, pinned to the version you installed; `npx` fetches
the package into a cache, runs it **once**, and leaves nothing behind. Everything here is
documented in the first form, for two reasons:

- A **Francois extension panel** may only spawn a bare binary name resolved on `PATH`. `npx` is
  not reachable that way, so [francois-plugin-cohorte](https://github.com/TheBidouilleAgency/francois-plugin-cohorte)
  requires the global install — this is structural, not a preference.
- One form in the docs is one form to get right. Two spellings of the same command is how a
  README ends up contradicting the thing it documents.

The price of pinning is that **`install` and `update` lay down the core carried by the CLI that
runs them**, so a global CLI left at an old version would re-lay an old core and report success.
That is why both verbs now compare themselves against the registry and print what to run
(`npm i -g cohorte@latest`) when they are behind — set `COHORTE_NO_VERSION_CHECK=1` to silence
it, and it is skipped under `CI` already.

`npx cohorte@latest <verb>` still works, and is the right call for a one-off on a machine you
do not own.

## Reading a project without a coding agent

`specs` and `doctor` are the read-only half of the pipeline, out of the agent's mouth and into
the shell. `specs` prints the board (`id`, `status`, `branch`, `title`) from the frontmatter of
`specs/*.md`; `doctor` runs the same checks `/cohorte-doctor` runs — core, pointer, profile,
surfaces↔agents, gate, hook, retrieval, design, isolation, specs — and **exits 1 when any check
is bad**, so it drops into CI unchanged. Both read through `lib/`, so the board and
the CLI can never give two answers about one repo.

Three machine-readable shapes:

| Flag | Shape |
| --- | --- |
| `--porcelain` | one record per line, fields separated by `U+001F` — a spec title with a space in it never misaligns a field |
| `--json` | the native document (the full doctor state, the spec list) |
| `--panel` | the payload a [Francois](https://github.com/antoine-gmnz/francois) extension panel validates against — also accepted by `metrics`, which emits the headline tiles |

`--panel` is the one Francois-aware surface in the whole package, and it exists for
[francois-plugin-cohorte](https://github.com/TheBidouilleAgency/francois-plugin-cohorte): a
manifest-only Francois extension that renders the spec board, the doctor report and the 30-day
cost as three panels beside your sessions. It needs `npm i -g cohorte` — never `npx`, never a
shell, never an absolute path; the manifest names a bare binary and Francois resolves it on
`PATH` at spawn time.

Add `--runtime=codex,cursor` (or `--all-runtimes`) to `install`/`update` to target coding agents
other than Claude Code; with no flag the installer detects what is configured on the machine and
asks, and with no TTY it targets Claude Code alone. See [Runtimes](/reference/runtimes).

**Update never touches generated files**: `PIPELINE.md`, rendered surface agents,
`gate-config.json`, `settings.json`, and your filled user config are always
preserved. Bringing those up to a new core is `/cohorte-update-pipeline`'s reconcile job.

## What gets copied

Into the destination core — `.claude/` on Claude Code, `.cohorte/<runtime>/` on the others,
with `commands/` and `agents/` redirected to wherever that runtime actually reads them:

```
commands/     the slash commands
agents/       review · release · profile-reader (fixed agents)
hooks/        gate.py
templates/    handoff, review-feedback, spec, design-brief, pr-body, brainstorm-return,
              + steps/init-pipeline/ (the router's step files)
workflows/    review.js · audit.js · refactor.js · loop.js
pipeline/     PIPELINE.template.md · SCHEMA.md · cohorte.config.template.yaml ·
              implementer.template.md · CHANGELOG.md · VERSION
  scripts/    preflight.sh · kanban-move.sh ·
              new-feature.sh.template · remove-feature.sh.template
```

The commands and agents are **rendered**, not copied: `core/commands/` and `core/agents/` are
runtime-neutral sources, and the adapter emits markdown + that runtime's frontmatter keys, a
Codex skill directory, or TOML, resolving every path and stripping the branches that runtime
cannot follow.

Plus, at install: the fixed agents, the spec template into `specs/_template.md` (bundled mode),
the user-config seed, and the gate-hook registration in that runtime's own config file. Installers also
**scrub retired artifacts** from older installs (the removed TDD-gate hook and its settings
registration, the retired research/questionnaire capability) — copy-over never deletes, so the
scrubs are explicit.

## The pointer — `pipeline.json` in the project's state dir

Committed by `/cohorte-init-pipeline`:

```json
{ "pipeline": "cohorte", "mode": "global", "core_version": "1.3.1", "install": "npm i -g cohorte && cohorte install --global …" }
```

It's how a teammate cloning the repo knows which core to install, and how `/cohorte-doctor` detects
version drift. `/cohorte-update-pipeline` syncs `core_version` in **both** modes (a shared global core
can't know which repos point at it, so nothing else can).

## Version flow

```
package.json (semver source of truth)
  → npm publish (CI, on main, trusted publishing + provenance)
    → installers stamp <core>/pipeline/VERSION
      → /cohorte-doctor compares VERSION ↔ pointer ↔ npm latest
        → /cohorte-update-pipeline shows CHANGELOG entries between old and new
```

Releases are fully automated: bump `package.json`, add the `## <version>` CHANGELOG section,
push to main — `publish.yml` verifies, publishes, tags `v<version>`, and creates the GitHub
release. A push without a version change publishes nothing.

## Repo layout (for contributors)

```
package.json           npm package — semver source of truth
bin/cli.js             the npm CLI (cross-platform, dependency-free)
install.sh · install.ps1
core/                  copied verbatim into ~/.claude or <project>/.claude
  agents/ commands/ hooks/ templates/ workflows/
profile/               PIPELINE.template.md · SCHEMA.md · cohorte.config.template.yaml
scripts/               shipped scripts + isolation templates + validate-core.mjs
lib/                   shared readers behind `cohorte doctor` / `specs` (dependency-free)
docs/                  this site (VitePress → GitHub Pages)
```
