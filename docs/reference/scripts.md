# Shipped scripts

Installed to `<core>/pipeline/scripts/` (`~/.claude` global, `.claude` bundled). Two families:
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
`gate.py` checks before letting review dispatches through. It is a **local, gitignored** file —
never commit it (see [gate.md](gate.md#the-preflight-phase-gate)).

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

- `scripts/validate-core.mjs` — CI's structural validator for the core itself: command/agent
  frontmatter + model pins, template placeholders, cross-references, the no-telemetry ratchet,
  installer coverage of every shipped script, packaging negations,
  and workflow-script invariants (parses each `core/workflows/*.js` exactly as the runtime does —
  async body wrap — plus meta literal, `profile-reader` phase 0, no `Date.now()`).
- `scripts/test-workflows.mjs` — **behavioural** tests for `core/workflows/*.js`: runs each script
  with stub agents and asserts the returned verdict object. Structural checks cannot see verdict
  logic, and one failure mode needs exactly this — `agent()` returns `null` when a subagent dies,
  so a crashed reviewer yields zero findings, indistinguishable from a clean surface.
  `review.js` scored that as `SHIP` until this test existed; the same suite now pins the
  loop workflow's reducer (`loop.js`) and the refactor retry round.
- `scripts/test-gate.mjs` — **behavioural** tests for `hooks/gate.py`, driving its real
  stdin→stdout contract with PreToolUse payloads: the deny/ask tiers, chained-command splitting
  (`&&`, `;`, `|`, `||`, newlines), branch-conditional gating resolved at the *payload's* cwd,
  the `bypassPermissions` ask⇒deny escalation, config robustness (missing/unparseable ⇒ silent),
  the preflight phase gate (missing/stale/HEAD-moved/unreadable stamp), and worktree-aware HEAD
  matching. The gate is the only component that can block a user's command; `py_compile` proves
  only that it parses.
- `scripts/test-adapter.mjs` — tests for the runtime adapter (`core/adapter/render.js` +
  `core/runtimes/*.json`), which turns one set of source prompts into five runtimes' worth of
  commands and agents. Its failures are silent by construction — a dropped conditional or a leaked
  marker still installs cleanly and only misleads the model at run time — so this installs for every
  runtime into a scratch home and asserts what lands on disk: no unresolved markers, the dispatch
  doctrine matching that runtime's capabilities, the gate described as blocking or advisory
  according to whether it really is, only supported frontmatter keys surviving, the reviewer's
  read-only restriction re-emitted in that runtime's spelling, and Claude Code's output unchanged.
- `scripts/test-lib.mjs` — tests for `lib/*.js`, the shipped runtime code behind `cohorte doctor`
  and `cohorte specs`: the block-YAML parser (against the real `PIPELINE.template.md`), the JS port
  of `/cohorte-doctor` (each check green, then each one made to fail), and the runtime-layout
  resolver — including a non-Claude layout and a registry whose absolute paths point at someone
  else's checkout, both of which used to report a healthy install as several false reds.
- `scripts/assert-gate-hook.mjs` — post-install assertion on a `settings.json`: exactly one
  `gate.py` registration (callers install twice first), with a matcher covering both `Bash` and
  `Task`. Both invariants are shipped regressions.
- `.github/workflows/ci.yml` — runs the validator, syntax-checks CLI/lib/hook/installers,
  and **dry-runs both installers** into scratch homes, asserting the exact postconditions
  (agents present, scripts executable, workflows shipped, templates-not-rendered).
- `.github/workflows/publish.yml` — publish-on-main: version-diff check against the registry, a
  required CHANGELOG entry, `npm publish --provenance` (token-less OIDC trusted
  publishing), tag + GitHub release.
