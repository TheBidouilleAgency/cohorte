# Shipped scripts

Installed to `<core>/pipeline/scripts/`, i.e. `~/.claude/cohorte/pipeline/scripts/`. Two families:
**shipped executables** used as-is by the commands, and **templates** rendered per project by
`/cohorte-init-pipeline`. Every call site chains them with `|| true`, so a missing script is a *silent*
no-op — `/cohorte-doctor` check 1 is what catches a half-copied core.

## `preflight.sh` — the deterministic phase gate

```sh
preflight.sh <report-file> "<cmd>" ["<cmd>"...]
```

Runs each command through `sh -c`, all output appended to `<report-file>` (the bulk never enters
any agent's context). First failure ⇒ prints the last 40 lines of the report raw to stderr, exit
1 — the caller (**`/cohorte-review` §0, the workflow preflight phases**) must stop there
and spawn no agents. All green ⇒ writes `<state>/preflight.ok` (`<epoch> <HEAD sha> <tree digest>`), the stamp
the gate (`.claude/hooks/cohorte-gate.py`) checks before letting review dispatches through. It is a
**local, gitignored** file —
never commit it (see [gate.md](gate.md#the-preflight-phase-gate)).

## `feature-diff.sh` — what the feature changed

The one way every phase computes a feature's diff (review staging, the implementer's self-check, the
freshness digest `/cohorte-ship` recomputes, the loop and refactor workflows):

```sh
<core>/pipeline/scripts/feature-diff.sh --default main --numstat      # changed files, full paths
<core>/pipeline/scripts/feature-diff.sh --default main --patch -- apps/api > specs/reports/x.api.diff
<core>/pipeline/scripts/feature-diff.sh --default main --digest       # the freshness stamp
```

It diffs a **throwaway index** — so untracked files (every new module a feature adds) are
included and your real index is never touched — against the **merge-base** with the default
branch (local or `origin/`, whichever is newer), so commits landing on `main` meanwhile never show up
as deletions. `.claude/` and `specs/` are excluded. Exit 3 means the base could not be resolved;
callers stop rather than fall back to a plain `git diff`.

## `verify-run.sh` — the runtime check behind `/cohorte-verify`

Owns everything a prompt must not improvise about processes: starts `commands.dev` in its own process
group, waits for `commands.dev_ready` (a URL or a probe), runs the smoke / e2e checks under timeouts,
optionally screenshots (a local Playwright only), runs migrations up — and down-then-up when
`commands.migrate_down` is set — **only on a dev database** (`verify.db: shared` is refused unless the
worktree has its own DB), and **stops the server on every exit path**. Writes
`specs/reports/<id>.verify.json` (`PASS`/`FAIL`/`SKIPPED`, checks, evidence, the digest of the tree it
verified — `/cohorte-ship` compares it). Every command it is handed is judged by the gate first; the
gate also inspects its arguments directly, so a denied command never runs, and one that is not the
profile's own (or covered by a `permissions.allow` rule) needs the human's yes. `verify-run.sh stop <id>`
reaps a server a killed run left behind; `rollback-check <spec>` exits 1 when `migrations: true` and
`## Rollback` is empty.

## `kanban-move.sh` — board updates outside agent context

```sh
kanban-move.sh auto <feature_id> <stage> [--pr <num>] [--title <title>]
kanban-move.sh <board.md> <feature_id> <column> [--pr <num>] [--title <title>]
kanban-move.sh --check
```

Moves (or creates) the `#<feature_id>` card under the target `## <column>` heading — find,
dedupe (keeps the first), sub-notes carried along, the `%% kanban:settings %%` block preserved,
`— PR #<num>` appended with `--pr`. Exists so no agent ever reads a whole board (which grows
with every feature ever tracked) into context.

**`auto` resolves the board itself** — `name` from `PIPELINE.md`, then `kanban.enabled` /
`obsidian.vault_path` / `boards[name]` from `~/.claude/cohorte.config.yaml` (override with
`COHORTE_CONFIG`; skip the profile with `--project <name>`) — and maps a **stage key** (`ideas`,
`brainstorm`, `spec`, `ready`, `building`, `review`, `fix`, `ship`, `shipped`) to that board's
heading via `boards[name].columns` → `kanban.columns` → the built-in default. An explicit board
path and a literal heading still work.

When nothing resolves it prints `kanban: <reason>` — naming the missing link — and exits **0**. A
board that *is* configured but can't be moved is loud instead: exit 2 usage, exit 3 missing board
file or unknown column. Callers report which line they got; none of them may infer "no board" on
their own. `--check` does the resolution and nothing else, which is what `/cohorte-doctor` and
`/cohorte-update-pipeline` use to tell "not configured" from "configured and broken".

## `new-feature.sh` / `remove-feature.sh` — worktree isolation (templates)

Shipped as `.template` files; `/cohorte-init-pipeline` renders them to `scripts/` in your repo,
substituting the `__TOKENS__` (project slug, DB pattern, port bases, compose file, branch
prefix, install/dev/migrate commands, per-surface env stanzas).

- `new-feature.sh <id>` — creates the sibling worktree `../<slug>-<id>` on branch
  `<prefix><id>`, assigns the next free slot in `.worktrees/slots.tsv`, creates the per-feature
  DB (when `db_per_worktree`), writes the env with `port_base + slot`, runs install + migrate.
- `remove-feature.sh <id> [--drop-db]` — removes the worktree, deletes the merged branch, frees
  the slot; keeps the DB unless `--drop-db`.

## Repo-side helpers (not installed)

`npm test` runs every suite below, in this order; CI runs them on Linux, macOS and Windows across
Node 20–24 and Python 3.9–3.13.

- `scripts/validate-core.mjs` — the structural validator for the core itself: command/agent
  frontmatter + model pins, template placeholders, cross-references, the no-telemetry ratchet,
  installer coverage of every shipped script, packaging negations,
  and workflow-script invariants (parses each `core/workflows/*.js` exactly as the runtime does —
  async body wrap — plus meta literal, `cohorte-profile-reader` phase 0, no `Date.now()`).
- `scripts/test-install.mjs` — installer and project-wiring tests (`bin/cli.js`, `lib/install.js`,
  `lib/project.js`), run through the real CLI in a scratch `CLAUDE_CONFIG_DIR` + `HOME`. Every
  assertion is a postcondition on disk, and several pin 2.x regressions: install deleting a user's
  own `~/.claude/commands/review.md`, an unparseable `settings.json` being replaced, any hook
  ending in `gate.py` being treated as ours, no uninstall.
- `scripts/test-gate.mjs` — **behavioural** tests for `hooks/gate.py`, driving its real
  stdin→stdout contract with PreToolUse payloads: the deny/ask tiers, chained-command splitting
  (`&&`, `;`, `|`, `||`, newlines), branch-conditional gating resolved at the *payload's* cwd,
  the `bypassPermissions` ask⇒deny escalation, config robustness (missing/unparseable ⇒ silent),
  the preflight phase gate (missing/stale/HEAD-moved/unreadable stamp), and worktree-aware HEAD
  matching. The gate is the only component that can block a user's command; `py_compile` proves
  only that it parses.
- `scripts/test-lib.mjs` — tests for `lib/*.js`, the shipped code behind `cohorte doctor` and
  `cohorte specs`: the block-YAML parser (against the real `PIPELINE.template.md` and real-world
  profile shapes — indentless lists, `- db:wipe` staying a string, block scalars) and the JS port
  of `/cohorte-doctor` (each check green, then each one made to fail).
- `scripts/test-workflows.mjs` — **behavioural** tests for `core/workflows/*.js`: runs each script
  with stub agents and asserts the returned verdict object. Structural checks cannot see verdict
  logic, and one failure mode needs exactly this — `agent()` returns `null` when a subagent dies,
  so a crashed reviewer yields zero findings, indistinguishable from a clean surface.
  `review.js` scored that as `SHIP` until this test existed; the same suite now pins the
  loop workflow's reducer (`loop.js`) and the refactor retry round.
- `scripts/test-kanban.mjs` — behavioural tests for `kanban-move.sh`, the board mirror's only
  writer: what resolves, what refuses to resolve, and that a refusal *says why* on stdout instead
  of exiting quietly.
- `scripts/test-metrics.mjs` — end-to-end checks for `scripts/metrics/collect.mjs` against a
  synthetic transcript: repeated `usage` lines, a mid-command task notification, subagent spend,
  synthetic harness messages, the cache-tier pricing arithmetic.
- `.github/workflows/ci.yml` — the suites above on the OS × Node × Python matrix, plus a
  package-contents job: `install.sh` parses and installs the checkout, and the tarball carries no
  bytecode and no test suite.
- `.github/workflows/publish.yml` — runs only after CI succeeded on `main`: re-runs the suites,
  requires a CHANGELOG entry for the new version, skips a version already on the registry, then
  waits for a maintainer's approval (the `npm-publish` environment) before `npm publish
  --provenance` (token-less OIDC trusted publishing; `next` dist-tag for a pre-release), the
  `vX.Y.Z` tag and the GitHub release.

### `scripts/build-gate.mjs` — builds the gate from its modules

```sh
node scripts/build-gate.mjs           # write core/hooks/gate.py
node scripts/build-gate.mjs --check   # exit 1 if core/hooks/gate.py is stale (writes nothing)
```

The gate ships as **one** stdlib-only file, `core/hooks/gate.py`: `lib/install.js` copies it to
`<core>/hooks/gate.py` and `cohorte sync` into each project as `.claude/hooks/cohorte-gate.py`.
Its source is split into modules under `core/hooks/gate/` — `runtime` (time budget, git runner),
`shell` (lexer, prefix stripping), `git` (global options, push semantics), `config`
(gate-config.json validation, project roots), `ownership` (profile.json surfaces), `patterns`
(pattern matching), `approve` (which commands handed to a pipeline script may run unprompted:
the profile's own and `permissions.allow`), `context` (`Ctx`), then the Bash analyzer: `findings` (the deny/ask list,
hidden-text judgement), `rules` (the push floor, config rules, branch awareness), `protect`
(self-protection, Bash-side ownership), `indirect` (`sh -c`, `eval`, inline code, xargs, …) —
mixins that `analyze` composes into `Analyzer` with the command walk and chain state —
`preflight` (the stamp/digest phase gate), `evaluate` (one payload's decision), `main` (output
envelope, hook and `--check` entry points); `__init__.py` holds the gate's docstring. The builder concatenates them in that fixed order: each module's
`import <stdlib>` lines are hoisted to the top (deduplicated, sorted), its `from .<module> import …`
lines are stripped (they may only name a module built earlier), and the rest is copied
verbatim. It fails on an unlisted or missing module, an unsupported import form, or a top-level
name defined in two modules. The output is deterministic (no timestamps, LF).

**Edit the modules, then rebuild, and commit both** — `core/hooks/gate.py` stays committed
because the installers and the npm package read it directly (nothing is built at install time).
`validate-core` rebuilds it in memory and fails when the committed file differs, and
`test-gate` checks the modules' import lines are complete and accurate. The modules and the
builder are excluded from the npm tarball.
