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
| `repo.layout`                        | enum         | build, audit                      | `monorepo` (many surfaces) or `single`.                       |
| `repo.workspace_tool`                | enum         | audit                             | `turborepo`/`nx`/`none`.                                      |
| `retrieval.provider`                 | enum         | init, update-pipeline, implementer | `serena` (default) / `graphify` / `none` — see §Code retrieval. |
| **`surfaces[]`**                     | list         | **build, review, refactor, init** | One per independently-built area. Grows via reconcile (below). |
| `surfaces[].key`                     | string       | build                             | Short id + review scope.                                      |
| `surfaces[].path`                    | string       | implementer                       | The ONLY tree that surface's agent may touch.                 |
| `surfaces[].label`                   | string       | build, init (`<SURFACE_LABEL>`)   | Human label + framework, e.g. `frontend (React)`.            |
| `surfaces[].agent`                   | string       | build (`subagent_type`)           | Rendered agent file name.                                     |
| `surfaces[].tools`                   | list         | init                              | Frontmatter `tools:` for the rendered agent.                  |
| `surfaces[].model`                   | enum         | init (`<SURFACE_MODEL>`)          | Frontmatter `model:` tier — `sonnet`/`haiku`/`inherit`. Default `sonnet` (implementers mostly apply a frozen contract — far cheaper than the Opus lead the dispatcher runs on, and Sonnet handles it well); `haiku` for purely mechanical surfaces (scaffolding); `inherit` only for surfaces with real design decisions worth the lead's model. |
| `surfaces[].*_cmd`                   | string       | implementer                       | test/lint/format/typecheck/build commands.                    |
| `surfaces[].test_quiet_cmd` `.lint_quiet_cmd` | string | implementer, preflight, workflows | Bridled variants agents actually run (dot reporter / `--quiet` / failures-only). `""` ⇒ `<cmd> 2>&1 \| tail -40`. See §Output discipline. |
| `surfaces[].uses_design`             | bool         | build, frontend                   | Whether this surface consumes designs.                        |
| `contract.enabled`                   | bool         | build                             | `false` ⇒ skip contract authoring (§2 of /cohorte-build).             |
| `contract.mechanism`                 | enum         | build, lead                       | `shared-types-zod`/`openapi`/`protobuf`/`json-schema`/`none`. |
| `contract.path` `.ext` `.index`      | string       | build                             | Where `<feature_id>` contract is authored + barrel.           |
| `contract.authored_by`               | const `lead` | build                             | Implementers import it read-only, never edit.                 |
| `release_notes.enabled`              | bool         | ship                              | `false` ⇒ skip note authoring (§2b of /cohorte-ship). See §Release notes. |
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
| `rbac.enabled`                       | bool         | brainstorm, review                | Toggle RBAC personas + authz audit.                           |
| `rbac.hierarchy`                     | list         | review                            | Highest→lowest role list.                                     |
| `design.enabled`                     | bool         | build, frontend, align-ds         | `false` ⇒ design steps are no-ops.                            |
| `design.provider`                    | enum         | frontend, align-ds                | `claude-design`/`figma`/`none`.                               |
| `design.inline`                      | bool         | spec, build, doctor               | Default `false`. `true` ⇒ `/cohorte-spec` offers the `/design` artboard step after freezing the brief, instead of ending at "paste this into the design tool". Requires `provider: claude-design`, the `inline_design` runtime capability, and Claude Code ≥ 2.1.234. **A research preview: artboards are not persisted for you.** The brief on disk stays the source of truth either way, so `false` loses nothing but the round trip. |
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
| `gate.preflight.enabled`             | bool         | hooks/gate.py, review             | Phase gate: review dispatches need a fresh preflight stamp. See §Preflight. |
| `gate.preflight.agents[]`            | list         | hooks/gate.py                     | `subagent_type`s the stamp gates (default `[review]`).        |
| `gate.preflight.max_age_minutes`     | number       | hooks/gate.py                     | Stamp freshness window (default 30).                          |

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
- **Hook** (`gate.py`) reads `gate.deny`/`gate.ask`/`gate.ask_on_default_branch`/`gate.default_branch`
  from a generated `<state>/gate-config.json`. The last two make git + docker free on feature branches
  but confirm-gated on the default branch (branch resolved at run time via `git rev-parse`).
- **Scripts** (`new-feature.sh`) read the `isolation` block (rendered in at init).

## Code retrieval — `retrieval.provider`

Agents spend most of their wall-clock reading the repo; a retrieval provider replaces grep-and-read
with symbol/graph queries. The flag is a **value, not a boolean**, so switching provider later is a
one-line profile change + re-running the wiring (no agent re-render needed — the guidance agents
follow is provider-agnostic: _"prefer the retrieval MCP tools over Grep/Glob + whole-file Reads"_).

| Provider | Mechanism | Freshness | Cost |
| --- | --- | --- | --- |
| `serena` (default) | live LSP symbol navigation (find symbol, references, semantic edits) | always current | none — no index |
| `graphify` | persistent tree-sitter knowledge graph over code + docs | as fresh as the last rescan | index step + re-index discipline |
| `none` | agents fall back to Grep/Glob/Read | — | — |

**Wiring (done by `/cohorte-init-pipeline`, or `/cohorte-update-pipeline` retroactively):**

<!-- cohorte:if runtime:codex -->
For `serena`, install its CLI if missing (`uv tool install -p 3.13 serena-agent`), then merge
this project-scoped table into `.codex/config.toml`, preserving all existing settings:

```toml
[mcp_servers.serena]
command = "sh"
args = ["-c", 'exec "$(command -v serena || echo "$HOME/.local/bin/serena")" start-mcp-server --context codex --project-from-cwd --open-web-dashboard False']
```

On Windows without `sh`, use `command = "serena"` and the server arguments directly; ensure
the CLI is on PATH. Gitignore `.serena/`. Keep `CODEX_HOME` at its normal user location;
the project table is discovered natively once the project is trusted.
For `graphify`, install its CLI and build/update the graph according to the provider's instructions;
verify any required MCP registration in `.codex/config.toml` rather than `.mcp.json`.

**Health check:** verify (1) `command -v serena`, (2) the `[mcp_servers.serena]` table,
(3) `.serena/` ignored, (4) actual tools in the session. `codex mcp list` inspects registration,
but is not proof of a live connection; restart the session when needed and report that limitation.
Codex agents inherit MCP configuration; do not write a Claude `tools:` allowlist.
Teammates receive `.codex/config.toml` and need the provider CLI installed and the project trusted.
<!-- cohorte:else -->
- `serena` — requires the `serena` CLI (`uv tool install -p 3.13 serena-agent`). For day-to-day CLI
  use it should also be on PATH (`uv tool update-shell`; uv installs to `~/.local/bin`). Register at
  **project scope** so the registration is committed and portable (`--project-from-cwd` resolves the
  project at server start, so the committed entry works on every machine) — and register the
  **PATH-proof launcher**, not the bare command: Claude Code spawns MCP servers with whatever
  environment it was launched from (a stale terminal, a GUI/IDE launch that never sourced a shell
  profile), where `~/.local/bin` may be missing from PATH — a bare `serena` entry then dies with
  ENOENT and agents silently fall back to Grep/Read:

  ```sh
  claude mcp add --scope project serena -- sh -c 'exec "$(command -v serena || echo "$HOME/.local/bin/serena")" start-mcp-server --context claude-code --project-from-cwd --open-web-dashboard False'
  ```

  (Windows-native teams: no `sh` — register the bare `serena` form instead and ensure the uv tools
  dir is on PATH; keep the `--open-web-dashboard False` flag.) `--open-web-dashboard False` keeps the
  dashboard available (reachable at `http://localhost:24282/dashboard/`) but stops it popping a browser
  tab on every server start — the flag overrides the machine's `serena_config.yml`, so the behaviour is
  the same for everyone on the repo. Gitignore `.serena/` (per-machine cache/config). Optionally
  pre-index large repos once: `serena project index`.
- `graphify` — requires `uv tool install graphify` + `graphify install`; build the initial graph
  (`/graphify .`) and rescan incrementally after big changes (`--update`). See graphify.net.
- Rendered agents get the provider's MCP tools appended to their `tools:` list (e.g. `mcp__serena`
  grants the whole server); `none` ⇒ nothing appended.

**Serena health check** — run after wiring in `/cohorte-init-pipeline` AND on every `/cohorte-update-pipeline`
reconcile (wiring that worked once can rot: PATH changes, tool uninstalled, entry hand-edited):

1. **CLI resolves:** `command -v serena`. Fails but `~/.local/bin/serena` exists ⇒ PATH repair
   above; missing entirely ⇒ reinstall.
2. **Registered:** this repo's `.mcp.json` has the `serena` entry ⇒ else re-run the `claude mcp add`.
   If the entry is the bare `serena` form on a POSIX machine, upgrade it to the PATH-proof launcher
   above (immune to launch-environment PATH gaps). If a launcher entry predates the
   `--open-web-dashboard False` flag, append it so the dashboard no longer auto-opens a browser tab.
3. **Gitignored:** `.serena/` is in `.gitignore` ⇒ else append it.
4. **Actually connected:** the `mcp__serena` tools are exposed in the session (or `claude mcp list`
   shows serena connected). If 1–3 pass but this fails, a session restart is needed — say so
   explicitly instead of reporting success.

Report each check's result; never report Serena "wired" on registration alone.

Teammates cloning the repo get the committed `.mcp.json` and only need the provider CLI installed
and on PATH — if either is missing, the MCP server fails to start and agents silently fall back to
Grep/Read; the health check above is the diagnostic.
<!-- cohorte:endif -->

## Specialization — when to split one surface into more agents

`/cohorte-build` dispatches ONE agent per surface, in parallel, so build wall-clock ≈ the **slowest single
surface**. More agents only build faster when they let the *slowest* surface's work run concurrently —
and only if the split is safe. The invariant that keeps parallelism safe is **one owner per tree, and
the frozen contract as the only cross-surface channel**. So specialization means carving a surface into
**smaller non-overlapping surfaces**, never pointing two agents at the same tree.

**Split a surface into specialized sub-surfaces only when BOTH hold:**

1. **It's a bottleneck** — the surface is large (many modules / high LOC) and dominates build time.
2. **The boundary is clean** — its work partitions into trees that don't share files, e.g. feature
   modules (`src/features/*`, `src/modules/*`), route groups, or independent services (`services/*`).

**Rules when splitting (non-negotiable — they preserve the invariant):**

- **Shared code gets its own surface with a single owner.** Anything two slices both touch — routing,
  global state/store, the design-system kit + tokens, shared utils — becomes its OWN surface (e.g.
  `web-shared`), owned by exactly one agent. Never let two feature-slice agents both edit shared trees.
- **Cross-slice references go through the contract**, not direct imports between slice trees. If
  `web-checkout` needs a shape produced by `api-billing`, that shape lives in the frozen contract.
- **Don't over-split.** A slice too small to hold ≥1 real task, or one with tangled boundaries, is worse
  than not splitting — the coordination + token cost (each stateless agent re-reads `PIPELINE.md` + spec)
  outweighs the parallelism. When boundaries aren't clean, keep one surface.

Coarse first, specialize on evidence: start with one `frontend` / `backend` surface each; split only a
surface that's proven slow and cleanly separable. The evidence lives in
the **main checkout's** `<state>/pipeline-metrics.jsonl` (gitignored) — one JSONL line per phase batch
(`ts`/`feature`/`phase`/`seconds`/`surfaces:{key: result}`), appended by `/cohorte-build`, `/cohorte-review`
and `/cohorte-fix`.
**`surfaces` keys are surface keys, nothing else** — run-level facts go in their own top-level
fields. Anything put inside `surfaces` is read
as a surface: `cohorte doctor` renders it as a row in the per-surface table and scores a non-`ok`
value as that surface failing. Always the main checkout, never the feature worktree (which dies at teardown while
metrics must accumulate across features) — resolve from anywhere with
`$(dirname "$(git rev-parse --git-common-dir)")/<state>/pipeline-metrics.jsonl`. Read it before
proposing a split: split the surface that actually dominates wall-clock, not the one that feels big.

## Measuring cost — what's slow vs what's expensive

`pipeline-metrics.jsonl` records **wall-clock seconds** per phase batch (§Specialization) — it tells you
what's SLOW. Tokens are recorded only where they can be read honestly: the **workflow paths**
(`loop.js`, `review.js`) stamp an approximate `tokens` field per batch from the runtime's own
counter (`budget.spent()` deltas), and the loop's return carries a per-round breakdown in its
`history`. The **conversational** commands still record none — a lead cannot reliably read a
subagent's token count, and a guessed number is worse than a missing one. `cohorte metrics` sums
whatever is stamped (a token-less line aggregates as 0, rendered as absent, never as "free").
For exact spend, use Claude Code's own accounting:

- **`/cost`** (built-in, zero setup) — reports per-**subagent** and per-**slash-command** share of your usage
  over the last 24 h / 7 d (e.g. _"Top subagents: frontend 7 %, backend 4 % · Top skills: /cohorte-build 1 %,
  /cohorte-review 1 %"_). That IS the per-phase ledger — approximate (share-of-total, machine-local, not exact
  tokens). Read it to see which surface/command actually dominates the bill before you tune a `model` tier.

**Lead context discipline — the silent bill.** The lead session's conversation history is re-sent as
input on EVERY turn; a session that spans spec→build→review→fix without clearing re-pays the
accumulated spec walk-through, handoffs, and reports on each turn. The pipeline is built so this is
never necessary: every phase handoff (spec, contract, diff, staged reports) lives on disk, so `/clear`
at each phase boundary is always safe — each command's closing line recommends it. Corollaries the
commands enforce: never paste a diff into a dispatch (agents compute their own, scoped); never echo a
staged report or design brief into chat; redirect bulky command output to a file and grep it.

## Output discipline — quiet commands

A test runner's default output is written for a human watching a terminal: one line per test, banners,
timing tables. An agent pays input price for every one of those lines, on every turn they survive in its
context. The profile therefore stores **two forms of each noisy command**:

- `test_cmd` / `lint_cmd` — the full form, for a human running it by hand.
- `test_quiet_cmd` / `lint_quiet_cmd` (per surface) and `commands.test_quiet` / `commands.lint_quiet`
  (repo-wide) — the **bridled** form agents actually execute: dot/failures-only reporter
  (`--reporter=dot`, `--quiet`, `-q`, `--silent`, framework equivalent) so a green run costs lines,
  not pages, and a red run prints only the failures.

Rules for every consumer (implementers, preflight, `/cohorte-audit` gates, workflow agents):

1. Run the quiet variant when set.
2. Quiet variant empty/absent (older profile) ⇒ run `<full cmd> 2>&1 | tail -40` — never the bare
   command into your context.
3. Need the full log? Redirect it to a file and grep it; never print it.

`/cohorte-init-pipeline` **asks** for these variants (detected defaults offered first) instead of silently
storing a bare `pnpm test` as the thing agents execute; `/cohorte-update-pipeline` tops up older profiles.

## Spec status — the lifecycle state machine

A spec's front-matter `status` is not a label, it is the pipeline's **state**: every command routes on
it, `cohorte specs` boards on it, and the kanban backfill maps it to a column. Six states:

| status | meaning | written by | who may build it |
| --- | --- | --- | --- |
| `draft` | the interview is open, nothing is frozen | `/cohorte-spec` Mode A | no |
| `frozen` | the contract is frozen — the handoff to `/cohorte-build` | `/cohorte-spec` Mode A freeze | yes |
| `in-progress` | a round is under way on this spec (or died mid-way) | an automated driver, if any | yes |
| `in-review` | reviewed / awaiting the next round or `/cohorte-ship` | `/cohorte-spec` Mode B, `/cohorte-fix` | yes |
| `blocked` | a round gave up here (non-convergent, no verdict, not implementable) | an automated driver, if any | yes, with the reason named |
| `shipped` | the PR is open; the status flip is part of the release commit | `/cohorte-ship` | no |

**`in-progress` and `blocked` are driver states.** No conversational command writes them — the
human-driven cycle moves `frozen` → `in-review` → `shipped`. Their producer is the **loop
workflow** (`core/workflows/loop.js`, `/cohorte-loop` — the successor of the 2.2.0-retired
conversational driver): it stamps `in-progress` at each round, `in-review` when a run ends at
zero blocking findings, and `blocked` when a round gives up (non-convergent, unreviewed
surfaces, dead implementers, a contract-change finding), with the reason in
`specs/reports/<id>.loop.json`. External drivers may write them too. Every reader routes on
them either way, and a stamp on a spec with no front-matter stays a silent no-op — no driver
dies over a status line.

**`kind` — feature (default) or `patch`.** Orthogonal to `status`, and the only other front-matter
field commands route on. `/cohorte-patch` freezes `specs/patch-<slug>.md` with `kind: patch` from
`templates/patch.template.md`: a ~60-line bug spec whose §4 **regression test** replaces §5 CONTRACT
as the thing the diff is checked against. It moves through the same states and the same commands —
`/cohorte-build` → `/cohorte-review` → `/cohorte-fix`* → `/cohorte-ship` — which is the whole design:
a patch is a spec, so nothing downstream is special-cased beyond three lines.

| what reads `kind: patch` | what it does differently |
| --- | --- |
| `/cohorte-build` §1.6 | judges §1 repro + §4 regression test instead of contract completeness; gap check `repro` |
| `/cohorte-build` §2 | authors no contract when §5 Contract delta is `none` (the usual case) |
| `/cohorte-ship` §1/§2b/§3 | branches off `vcs.patch_branch_prefix`; a `patch` bump by default; `fix(<scope>)` commit |

A patch may span **several surfaces** — one bug, one repro, one spec. What it may never do is add
**new** contract surface area: two surfaces agreeing on a shape that doesn't exist yet is what §5 is
for, so `/cohorte-patch` routes that to `/cohorte-spec` instead. Changing an *existing* contract entry
is a legitimate delta. The patch template keeps contract on **§5** and acceptance on **§9** — the two
numbers `review.md` and `implementer.template.md` name verbatim — and simply has no §8.

Corollaries worth knowing:

- A spec with no front-matter makes every stamp a **silent no-op** — the state is bookkeeping, and the
  loop must never die over a status line.
- Child commands write `status` too (`/cohorte-fix` sets `in-review`); re-stamping before each phase is what
  keeps `in-progress` true for the duration of the run rather than for its first phase.
- `blocked` is not a failure to hide: it is the resumable state. `/cohorte-build` accepts it, names it, and
  routes by the spec's `## Remediation` (open items ⇒ `/cohorte-fix`).

## Dead agents — silence is not a green light

A subagent can die mid-run: a rate limit, a transport error that outlived its retries, its own context
exhausted on a big surface. When it does it returns **nothing** — and nothing is byte-identical to
"finished, nothing to report". Every phase that fans out therefore does a **roll call** before it
integrates anything, because the default reading of silence is the most dangerous one available:

| phase | what a dead agent looks like | what the phase must do |
| --- | --- | --- |
| `/cohorte-build` | a surface with no handoff | retry it **once** alone (byte-identical prompt), then mark it `dead`, verify the tree with that surface's own quiet commands, never call the batch ok |
| `/cohorte-review` | a reviewer with no report ⇒ **zero findings** | retry once, then list the surface in `unreviewed` and refuse to score `SHIP` |
| `/cohorte-fix` | a re-dispatched agent with no handoff | retry once, then leave **every** one of its items `- [ ]` — a dead agent never ticks a box |
| workflows | `agent()` resolves to `null` | already enforced (`review.js` `unreviewedSurfaces`) — the doctrine started here |

Non-negotiables, in every phase:

- **Retry once, alone, byte-identical.** Most deaths are transient, and the other surfaces' work is
  already on disk — so recovery costs one agent, never a rebuild. Never retry an agent that answered.
- **Never speak for a dead agent.** You did not see its work: report what the *tree* says (quiet
  commands, redirected to a file, grepped), not what a handoff would have said.
- **Never let it reach a driver as clean.** `/cohorte-build` writes `dead[]` into
  `specs/reports/<id>.build.json`, `/cohorte-review` writes `unreviewed[]` into the verdict; a driver
  must abort on either *before* it reads `blocking`, since a dead reviewer makes
  `blocking == 0` a statement about code nobody read.
- **`unreviewed` is separate from `blocking` on purpose.** Faking a count in `blocking` to force a
  driver's hand would corrupt the one field the whole contract rests on; a driver reads them as two
  different facts — "what was found" and "what was covered".
- **Write the metrics line anyway** (`"<key>":"dead"`). An incomplete batch is exactly the batch worth
  recording; holding the append back "until it's complete" deletes the evidence that anything failed.

## Readiness — the gate between a frozen spec and N implementers

`/cohorte-build` §1.6 scores the frozen spec on **implementability** before authoring the contract and before
dispatching anything, and writes `specs/reports/<id>.readiness.json`
(`verdict`: `READY` · `RESERVATIONS` · `NOT-READY`, plus `gaps[]`). It costs **zero extra agents** — the
lead already holds the spec, the profile and the reconciled surface list — which is the whole economics
of the step: a spec that cannot be built does not get cheaper by being built on N surfaces in parallel.

- Five checks: contract completeness · surface coverage · dependencies exist · residual ambiguity ·
  the design gate. Each maps to `NOT-READY` (a surface would have to invent the answer) or
  `RESERVATIONS` (a surface can proceed on a stated assumption).
- **`NOT-READY` aborts the build with no agent spawned** and sends the human to `/cohorte-spec`.
  A driver reads the same file and must stop rather than retry — it is the one outcome more passes
  cannot fix.
- **`RESERVATIONS` never blocks.** Each gap is inlined verbatim into the dispatch of the surface it
  affects, as an assumption the implementer must apply *and* flag in its handoff. A gate that stalled a
  sound build on a missing error case would cost more human round-trips than it saves.

## Deferred findings — real, but not this feature's problem

`/cohorte-review` ends on "zero blocking findings", so everything non-blocking used to be discarded with the
report. A **deferred** finding is one the reviewer judges true and **out of this feature's scope**
(pre-existing code the staged diff never touched, adjacent debt the spec never claims to fix). The
review agent returns them in their own `## Deferred` section — never in `findings` — each carrying its
own out-of-scope reason.

- They count in **no** severity row, enter **no** verdict, and are **never** cross-checked: a deferred
  item cannot cost a fix loop an iteration, and refuting one would spend an agent arguing about
  something that cannot change the outcome.
- **Not deferrable, ever:** anything the diff touched or introduced, any spec violation, any security
  issue on a path this feature adds, calls or modifies.
- `/cohorte-review` §3.5 routes them, **on every verdict**, into `specs/refactor-backlog.md` under the
  `## <domain>` heading of the owning surface, tagged `deferred:<feature_id>` — the same grouping
  `/cohorte-audit` writes, so `/cohorte-refactor <domain>` picks them up with no extra plumbing. Never into the spec's
  `## Remediation`, which is what `/cohorte-fix` re-dispatches.
- `/cohorte-audit` **carries open `deferred:` items over** when it rewrites the backlog; overwriting them away
  is the one way they silently vanish.
- The verdict JSON carries `deferred: <n>` (informational, outside `blocking`), so a driver can name
  them in its closing line without reading a report.

## Decisions — the transverse decision journal

`PIPELINE.md` is a **stack profile** (surfaces, commands, conventions); it says nothing about what this
project has *decided*. Without somewhere for those, every `/cohorte-spec` re-discovers or contradicts them.
`specs/_decisions.md` (from `core/templates/decisions.template.md`) is that place, deliberately small:

- **Append-only, one line per decision, ≤ ~160 chars:**
  `- <YYYY-MM-DD> · <area> · <decision> — because <reason> · <origin>`, where `<origin>` is the
  `feature_id` that decided it — or the originating command (`retro`) when no single feature owns
  it. Reversal never edits a line:
  append a superseding one (`· supersedes <date> <area>`) and move the old one to `## Superseded`. When
  `## Live` passes ~100 lines, sweep the superseded ones down.
- **Written by** `/cohorte-spec` at freeze (the decisions that outlive the feature — typically 0–3 lines, and
  zero is a normal outcome), `/cohorte-build` §1.5 when it adds or splits a surface, and
  `/cohorte-retro` §4 when the human ratifies a convention rule (one line per adopted rule).
- **Read by the deciding stages only** — `/cohorte-brainstorm` (so the panel argues about the idea, not about
  settled ground), `/cohorte-spec` (so a new spec does not silently un-decide something), `/cohorte-audit` (standing
  decisions are part of the rulebook it audits against).
- **Never read by implementers or reviewers.** They work from the frozen contract, which already tells
  them what to do; shipping them the rationale would cost `surfaces × dispatches` tokens per feature
  for a fact they cannot act on. This is what keeps the journal cheap enough to be worth having.
- The `_` prefix is load-bearing: `/cohorte-doctor`, the `cohorte specs` scanner and the kanban backfill all skip
  `specs/_*.md`, so the journal is never mistaken for a spec (no phantom card, no bogus stage).

## Preflight — the deterministic phase gate

`/cohorte-review` starts by running `pipeline/scripts/preflight.sh` — a plain shell script (no
agent) that executes the profile's mechanical checks in order (typecheck → lint → tests, quiet
variants) with all output redirected to `specs/reports/<id>.preflight.txt`:

- **Any check red** ⇒ the script prints the last 40 lines raw and exits 1. The command **aborts
  there: zero agents are spawned.** A reviewer dispatched onto code that doesn't compile burns its
  whole run rediscovering what `tsc` already printed for free — the failure goes straight to the
  human (or `/cohorte-fix`) instead.
- **All green** ⇒ the script stamps `<state>/preflight.ok` (`<epoch> <HEAD sha> <tree digest>` —
  local and **gitignored**; a versioned stamp describes the tree *before* its own commit and rides
  into every clone and worktree, which breaks the gate both ways).

`hooks/gate.py` enforces the stamp as a **phase gate** (the `preflight` block of `gate-config.json`,
generated from `gate.preflight`): a Task dispatch of a listed `subagent_type` (default
`review`) with a missing/stale stamp — older than `max_age_minutes`, or the digest no longer
matches the working tree (`.claude`, `.cohorte` and `specs` excluded, so the pipeline's own writes and a
commit of already-verified code do not invalidate it) — gets an
"ask", so a lead can't accidentally skip the gate but a human can consciously override it. The gate
hook fires for **every** agent in the session, including subagents spawned by the Workflow runtime
(they run in `acceptEdits` whatever the session mode — Write/Edit auto-approved — but Bash and Task
still pass through hooks). In `bypassPermissions` (headless runs) every gate "ask" is escalated to a
hard deny, because nobody is there to answer a prompt.

## Rendering / reconciling a surface agent (shared procedure)

Both `/cohorte-init-pipeline` (initial render) and `/cohorte-build` (auto-reconcile when a spec needs a new agent) use
this exact procedure so a surface is always defined the same way. To add surface `S`:

1. **Add the `surfaces[]` entry** to `PIPELINE.md`: `key`, `path` (the disjoint tree it exclusively
   owns), `label`, `agent` (rendered file name), `tools` (add `DesignSync` only if `uses_design: true`;
   append the retrieval provider's MCP tools when `retrieval.provider` ≠ `none` — e.g. `mcp__serena`),
   `model` (tier for the rendered agent: `sonnet` (default) — the implementer mostly applies a frozen
   contract, which Sonnet does well at a fraction of the Opus-lead cost; `haiku` for purely mechanical
   scaffolding; `inherit` only when the surface makes real design decisions worth the lead's model),
   the five `*_cmd`s (derive from the surface's `package.json` / workspace
   filter, mirroring a sibling surface), and `uses_design`.
<!-- cohorte:if runtime:codex -->
   **Codex model policy:** use `model: inherit` by default, or a model explicitly selected for
   Codex. Legacy `sonnet`/`haiku` values are not executable Codex pins: omit them in the rendered
   agent and report inheritance. Preserve explicit Codex `model`/`model_reasoning_effort` choices.
<!-- cohorte:endif -->
2. **Render the agent file** `<agents>/<agent>.md` from `<core>/pipeline/implementer.template.md`
   — the template is already rendered for this runtime, so only the placeholders are yours to fill —
   substituting `<SURFACE_AGENT>`, `<SURFACE_LABEL>`,
   `<SURFACE_PATH>`, `<SURFACE_TOOLS>`, `<SURFACE_MODEL>`, `<PROJECT_NAME>`, and the surface-specific
   blocks (`<SURFACE_EXTRA_NEVER>`, `<SURFACE_DESIGN_INPUT>`, `<SURFACE_TDD_STEP1>` — leave the design
   ones empty unless `uses_design`). Fill `<SURFACE_CONVENTIONS>` with the surface's convention slice
   **baked at render time**: `PIPELINE.md` §Conventions `### Shared` + this surface's
   `### Surface: <key>` stanza + its §Testing lines, verbatim. At runtime the agent then reads only
   the profile's machine block (the fenced `yaml pipeline-profile`) — never the prose sections. The
   bake stays honest because §Conventions edits go through `/cohorte-update-pipeline`, whose reconcile
   re-renders every agent (step 2 below); hand-edit the prose without re-rendering and the baked
   slice goes stale — that's the trade for not re-reading the prose on every dispatch. For a `uses_design` surface, fill them **link-based** (never with a
   stored `design_project` id — that goes stale on a DS rebuild):
   - `<SURFACE_DESIGN_INPUT>` — a 4th input bullet: _"The **feature design** — the pages this feature
     touches, listed in your dispatch's design slot as full links
     (`https://claude.ai/design/p/<projectId>?file=<file>`); a slot saying `none` means a fix loop with
     no visual work — skip DesignSync entirely. For each link, extract the `<projectId>` (the
     `/p/…` segment) and `<file>` (the `?file=` query) from the URL and read it read-only via `DesignSync
     get_file(<projectId>, <file>)`; `list_files(<projectId>)` to catch linked pages (shared nav/modals)
     this feature also changes. The link is self-contained — no stored project id. Build with the code UI
     kit (the `design_system_project`'s materialization: `@/components/ui/*` + tokens); read a primitive
     via `get_file` only if it's missing/stale in code. Mobile-first."_
   - `<SURFACE_TDD_STEP1>` — a **lead-in paragraph** above the TDD list (not a numbered item; it
     renders as nothing for a non-design surface, which is why the list must not start at it):
     _"**Pull the feature design first** (skip if your dispatch's design slot
     says `none`): `DesignSync get_file(<projectId>, <file>)` for each link in the slot and translate
     each into the code design system (`@/components/ui/*`, `cn()` + CVA), mobile-first — never ad-hoc
     CSS. Then:"_
<!-- cohorte:if runtime:codex -->
   **Codex destination and format:** always write `.codex/agents/<agent>.toml` in the current
   project, including with a global core. The source template has a `.md` filename but contains
   TOML for this runtime. Validate TOML after substitutions; keep `name`, `description`, and
   `developer_instructions`. Do not add Claude `tools:`/`model: sonnet` frontmatter.
   Keep generic agents under `<fixed-agents>/`; never write surface agents there in global mode.
   No `CODEX_HOME` override, auth symlink or per-project launcher is needed. When migrating an
   old global surface agent, compare ownership/content with this project's profile before
   removing its old copy; do not overwrite local customizations or touch other projects' agents.
<!-- cohorte:endif -->
3. **Add a §Conventions + §Testing stanza** for `S` in `PIPELINE.md` (mirror a sibling surface; keep it
   rule-shaped). If `S` is a shared-code surface, its convention is "single owner of shared X; slices
   consume, never redefine."

Removing/merging a surface is the reverse: drop the `surfaces[]` entry, delete its agent file, fold its
conventions. Never leave an agent file with no matching `surfaces[]` entry (orphan) or vice-versa.

## Release notes — the per-feature note the versioning tool consumes

Many repos gate merges on a **per-feature release note**: Changesets' `changeset` CI job fails any PR
that touches product code without a `.changeset/*.md`. That file is **not** something the release
agent can invent — picking the bump level is project policy (semver over an API vs. over a product,
a `0.x` rule forbidding `major`, what counts as user-visible), and the prose is outward-facing copy.
It is the **lead's** to write, exactly like the contract.

The failure mode this block exists to prevent is silent and reproducible: the requirement lives in the
project's `CLAUDE.md`, which the ship flow never reads, so `/cohorte-ship` completes, opens the PR,
moves the kanban card to **Shipped** — and CI goes red on a job nobody looked at. The feature reads as
shipped while being unmergeable. Encoding it in the profile is what makes the step survive a stateless
lead.

- **Authored before the dispatch**, next to the `status: shipped` flip (`/cohorte-ship` §2b), so the note
  lands **inside** the release commit. Written after the fact it needs a second commit, and the PR is
  already open and red.
- **One key in the front-matter** — `anchor_package`. Lockstep/`fixed` version groups propagate the bump
  from it to every other workspace; listing more is how a repo ends up with a package bumped twice.
- **`forbid_levels`** encodes policy the tool itself may not enforce. The common one: while the product
  is `0.y.z`, a `major` changeset makes Changesets jump to `1.0.0` with no human deciding it — so `0.x`
  repos forbid `major` and declare a breaking change as `minor`.
- **Ask, don't guess, on an ambiguous bump.** Between two defensible levels (a refactor that also changes
  what the user sees), state the reading and let the human pick — a wrong bump is a published version
  number, not a fixable draft.
- **`empty_cmd`** covers the honest no-op: a PR that touches product code but must move no version.
  Prefer it to skipping the step; the CI job wants a file, not a version.

`enabled: false` (or `tool: none`) ⇒ §2b is a no-op and nothing below applies.

## Reconcile — bringing generated files up to the current core

`/cohorte-init-pipeline` is **one-time per project**. Afterwards, `/cohorte-update-pipeline` runs this procedure so a
core upgrade never requires re-running init — new pipeline features flow into the repo's generated
files automatically. It works because every generated artifact is a **deterministic function of
(current template × the profile's data)**; nothing needs re-detecting or re-interviewing.

1. **Profile top-up.** Diff `PIPELINE.md`'s machine block against the current
   `pipeline/PIPELINE.template.md`: every block/field the template has and the profile lacks is added
   with its documented default (e.g. `surfaces[].model: sonnet`, `retrieval.provider: serena`).
   **Ask only when a new field is a genuine human decision** (batch into ONE question set); never
   change a value the profile already sets; never rewrite the prose sections. `release_notes` is one
   such decision and must not be defaulted blind: detect a versioning tool / note-enforcing CI job per
   `/cohorte-init-pipeline` Phase 1, and if there is one, ask Phase 2's release-notes question (anchor
   package, language, bump policy, forbidden levels). No tool found ⇒ top up with `enabled: false`.
2. **Re-render agent frontmatter + body.** For each `surfaces[]` entry, re-render
   `<agents>/<agent>.md` from the current `implementer.template.md` per §Rendering above. Safe by
   doctrine: rendered agents are regenerable artifacts — hand-written rules belong in `PIPELINE.md`
   §Conventions (which reconcile never touches), NOT in agent files, where they'd be clobbered here.
3. **Additive settings patch.** Bring `<state>/gate-config.json` — and, on a runtime with a settings
   file the pipeline generates, that too — up to the current init spec (missing `allow` entries,
   hooks per install mode): add what's missing, never remove or rewrite existing/custom keys.
4. **Capability wiring.** If a top-up added a capability needing external setup (e.g. a `retrieval`
   provider whose MCP server isn't registered yet), run its wiring step from `/cohorte-init-pipeline` Phase 4.
   Even when nothing new was added, re-run the provider's health check (§Code retrieval) — wiring
   rots (PATH changes, uninstalls, hand-edits) — and repair whatever fails.
5. **Global config seed.** If `<config>` is absent, seed it from the template
   (`profile/cohorte.config.template.yaml`) so the kanban + shared-vault config has a home. Never
   clobber an existing filled file; report what was seeded. Then **scrub the retired `telemetry:`
   block** if the file still carries one (every install seeded before 2.3.0 does): delete the block
   and its comment header, leaving the rest byte-identical. It is dead config — the sender is gone
   and nothing reads it — but a `telemetry.enabled: true` sitting in a file the human may open reads
   as "this is still sending", which is the one thing it must not imply. This is the single
   exception to "never rewrite the config": a targeted deletion of a block the core no longer
   defines, never a re-seed.
6. **Kanban sync.** Run the §Kanban reconcile: link/create the project's board if configured, verify
   its columns, and backfill/sync cards from `specs/*.md`. See §Kanban.
7. **Spec-template top-up.** `specs/_template.md` is seeded once at install and then **never**
   refreshed, so a repo keeps whatever front-matter the core shipped the day it was installed (a
   pre-1.6 copy's `status` comment still lists four states). Top it up the same way as the profile:
   add the **front-matter fields** the current `templates/spec.template.md` has and the repo's copy
   lacks, with their documented defaults, drop `loop_pass`/`loop_phase` (retired with
   `/cohorte-loop` in 2.2.0), and refresh the `status:` comment. Never rewrite its body — the section list is the human's to shape,
   and some repos have deliberately trimmed it. Nothing breaks without this (the fields are written on
   demand when a driver needs them); it just keeps a new spec's front-matter honest about the states
   the pipeline can put it in.

8. **Local-artifact hygiene.** The pipeline's own runtime files must stay out of git:
   `<state>/preflight.ok`, `<state>/pipeline-metrics.jsonl`, `specs/reports/`. Add any missing entry to
   `.gitignore`, and **untrack** what a pre-2.0.0 install let slip in —
   `git rm --cached --ignore-unmatch <state>/preflight.ok` (repeat per stray path). The stamp is the
   one that actively breaks: it records the tree it verified, the commit carrying it moves HEAD past
   that tree, and the committed copy lands in every clone and worktree — so the phase gate ends up
   blocking clean trees and greening unchecked ones. Report what was untracked; the human commits it.

Re-running `/cohorte-init-pipeline` remains possible (it reconciles too) but is only *needed* when the stack
itself changes in ways `/cohorte-build` §1.5 can't auto-grow (e.g. package manager or contract mechanism swap).

## Workflows — deterministic multi-agent runs (opt-in)

Four scripts run under the Claude Code Workflow runtime instead of the lead reasoning out the
fan-out turn by turn: `<core>/workflows/review.js`, `audit.js`, `refactor.js` — each the
**workflow variant** of its same-named conversational command — plus `loop.js`
(`/cohorte-loop`), which has **no conversational form at all** (below). For the variant pairs,
the conversational commands (`/cohorte-review`, `/cohorte-audit`, `/cohorte-refactor`)
**remain the default path and the fallback** — a workflow runs only when the human explicitly asks
for it ("run the review workflow"), and requires Claude Code ≥ **2.1.154** with workflows
enabled.
`/cohorte-doctor` reports which path a session will take. The interactive commands (`/cohorte-init-pipeline`,
`/cohorte-brainstorm`, `/cohorte-spec`) and the dispatch-only ones (`/cohorte-build`, `/cohorte-ship`) have **no** workflow variant on
purpose: they're interviews or already a single parallel dispatch — a script adds nothing.
`/cohorte-loop` does not change that: it **consumes** `/cohorte-build`'s outputs (the frozen
spec, `readiness.json`, the lead-authored contract, `build.json`) — it is not a build variant,
and adding one would put the lead-only steps (§1.5 reconcile, §2 contract authoring) inside a
script that cannot ask.

Shared design, all four scripts:

- **Phase 0 is always `profile-reader`** — workflow scripts have no filesystem or shell access, so a
  dedicated agent (`core/agents/profile-reader.md`, haiku, read-only) reads `PIPELINE.md` and returns
  the `yaml pipeline-profile` block as JSON. Every later phase is parameterized from that object.
- **Mechanical phases run on haiku** (profile read, preflight, diff staging, report merging/writing);
  judgment phases dispatch the same pinned agents the commands use (`review` at sonnet, the surface
  implementers at their `surfaces[].model` tier) — the per-surface `model:` routing carries over.
- **Only the verdict comes back.** Bulk (diffs, reports, backlogs) is staged to the same disk
  buffers the commands use (`specs/reports/`, `specs/refactor-backlog.md`); the workflow's return is
  counts + verdict + paths.
- **A dead agent is never a clean result.** `agent()` resolves to `null` when a subagent dies, and a
  dead *reviewer* returns zero findings — byte-identical to a surface that is genuinely clean. Any
  script that derives a verdict from "how many findings came back" must first subtract the agents
  that never answered: `review.js` names them in `unreviewedSurfaces` and refuses to score
  `SHIP`. `scripts/test-workflows.mjs`
  pins this — it is the one invariant the structural checks in `validate-core.mjs` cannot see.
  The conversational commands enforce the same rule by roll call (§Dead agents); it was the workflows
  that had it first, and for three releases they had it **alone** — the same crash on the
  conversational path went unreported.
- **`review.js`** — preflight gate (aborts red, zero agents), one `git diff --stat` staged per
  touched surface, one reviewer per surface in parallel, then an **adversarial cross-check** phase
  that tries to refute each CRITICAL/security finding before it can trigger a fix loop.
- **`audit.js`** — one auditor per domain (each surface + `shared`), concurrency capped by the
  runtime (~16), merged into the prioritized `specs/refactor-backlog.md`.
- **`refactor.js`** — big domains only (it skips domains with a handful of open items — the
  conversational `/cohorte-refactor` is cheaper there): `shared` first and alone, then the other domains'
  implementers in parallel, each verified per-domain.
- **`loop.js`** (`/cohorte-loop`) — build → review → [fix → review]* for ONE feature, unattended and
  resumable. Preconditions it verifies and refuses to work around: frozen/`in-review` spec, a fresh
  `readiness.json` at `READY`/`RESERVATIONS`, the contract on disk, every readiness surface owned by
  the profile. Round exits, in order: child abort relayed → `unreviewed` non-empty → `blocking == 0`
  ⇒ ship → same blocking-item identity two consecutive rounds ⇒ treading water → `maxRounds`
  (default 5). A blocking finding on the contract file aborts (`contract-change` — lead-only, per
  `/cohorte-fix` §1). It calls the review **workflow** per round and reads the same `verdict.json`
  contract the conversational `/cohorte-review` §3 writes; it stamps `in-progress` while running,
  `in-review` on ship, `blocked` on a give-up. **Workflow-only, no command file, ever**
  (`validate-core.mjs` pins it): if the runtime is unavailable it refuses explicitly rather than
  degrading to a lead re-reasoning the fan-out every round at session-model prices.
- **No input mid-run.** A workflow runs to completion without questions; anything interactive
  (contract changes, human decisions) belongs to the conversational path. The gate hook still
  fires on workflow subagents (see
  §Preflight) — in unattended runs its asks become denies. Know what that means for edits:
  workflow subagents run in **`acceptEdits` whatever the session mode**, so for the length of a
  run — and `loop.js` runs long, unattended stretches — `hooks/gate.py` is the only brake on
  what agents write. That is stated here rather than discovered.
- **Permissions:** `/cohorte-init-pipeline` and `/cohorte-update-pipeline` extend the generated `settings.json`
  `allow` list with what workflow agents need (the quiet commands, the shipped
  `pipeline/scripts/*.sh`, read-only git incl. `git rev-parse`, and the retrieval provider's MCP
  tools) so a run never stalls mid-workflow on a permission prompt nobody is watching.

## Kanban — mirroring the pipeline onto an Obsidian board

An **optional, user-scoped** mirror of the dev flow: each pipeline stage moves a card across an
[Obsidian Kanban](https://github.com/mgmeyers/obsidian-kanban) board, one board per project. Config
lives in the consolidated global config `<config>` §`kanban` (NOT in
`PIPELINE.md` — the board path points at the user's personal vault, so it is machine-specific and must
not be committed). Everything below **no-ops silently** when the config is absent, `kanban.enabled` is
false, no board is configured for the current project, or the board file is missing — the pipeline never
blocks on the board.

**Config & board resolution.** `kanban.boards` is keyed by the project's `PIPELINE.md` `name`. To resolve
the current project's board: read `name` from `PIPELINE.md`, look up `kanban.boards[name]`. Found ⇒ the
board file is `<obsidian.vault_path>/<boards[name].board>`, its columns are `boards[name].columns` if
present else `kanban.columns`. Not found ⇒ kanban off for this project.

**Card format.** A card is a Kanban list item under a `## <column>` heading:
`- [ ] <human title>  #<feature_id>`. The `#<feature_id>` tag is the join key between a card and its
`specs/<feature_id>.md`; it is how every stage finds *its* card (Grep the board for `#<id>`). Free-text
notes a human writes as sub-bullets under an Ideas card are seed context for `/cohorte-brainstorm`. Never touch
the trailing `%% kanban:settings … %%` block or the `kanban-plugin: board` front-matter.

Once shipped, `/cohorte-ship` appends the **PR number** to the card — `- [ ] <title> #<feature_id> — PR #<num>`.
The bare `#<num>` is what a board reader renders as a clickable link to the GitHub PR, so `/cohorte-ship` always
writes it when a PR was actually created.

**Move a card (the core op).** One call — the script does resolution AND the move outside the
agent's context (find, dedupe, sub-notes carried along, settings block preserved):

```
<core>/pipeline/scripts/kanban-move.sh auto <id> <stage> [--pr <num>] [--title <title>]
```

It creates
the card in the target column when none exists, keeps the first and drops duplicates, and appends
` — PR #<num>` with `--pr`.

**`auto` is not a convenience, it is the contract.** It reads `name` from `PIPELINE.md`, then
`kanban.enabled` / `obsidian.vault_path` / `boards[name]` from `<config>`
(override with `COHORTE_CONFIG`, or skip the profile with `--project <name>`), and it maps the
**stage key** (`ideas` · `brainstorm` · `spec` · `ready` · `building` · `review` · `fix` · `ship` ·
`shipped`) to that board's heading through `boards[name].columns` → `kanban.columns` → the built-in
default. An explicit `<board.md>` path and a literal heading both still work, for one-off and
non-pipeline moves.

**Never conclude "no board is configured" without running it.** The command that resolves nothing
prints `kanban: <reason>` — naming the missing link (no config file, `enabled: false`, no entry for
this project, vault unset, board file gone) — and exits **0**. A configured board that cannot be
moved is loud instead: exit 2 on usage, exit 3 on a missing board file or an unknown column. Both
readings are on stdout, so a caller reports which one it got. This exists because inference was the
actual failure mode: with only "no-op silently if no board" to go on, a fresh phase session (every
phase runs after a `/clear`) decided there was no board without ever opening the config, and cards
stopped moving mid-pipeline while every command still reported success.

**Fallback when the script is absent** (older core): do it by hand, but never read the whole board
into context — it grows with every feature ever tracked: `grep -n` for `#<id>` and the `## ` headings
to locate lines, then use offset-limited Reads + targeted Edits around the matches. Either way: one
card per `#<id>`, whole line moved tag-preserved, card created in the target column if missing.

**Tag before you move.** The join key is the `#<id>` tag, and an **Ideas** card a human typed by hand
does not have one. Moving it first finds nothing, creates a second card, and strands the original in
Ideas — so `/cohorte-brainstorm` appends the tag to the picked line before its first move.

**Stage → column**, used both by each pipeline command (to move its card live) and by backfill:

| Pipeline moment                         | Column          |
| --------------------------------------- | --------------- |
| human drops a raw idea (manual)         | `ideas`         |
| `/cohorte-brainstorm` picks it up               | `brainstorm`    |
| `/cohorte-spec` opens (draft)                   | `spec`          |
| `/cohorte-spec` freezes (`status: frozen`)      | `ready`         |
| `/cohorte-patch` triages / freezes              | `spec` → `ready` (card titled `[patch] <title>`, tag `#patch-<slug>`) |
| `/cohorte-build`                                | `building`      |
| `/cohorte-review`                               | `review`        |
| `/cohorte-fix`                                  | `fix`           |
| a round is under way (`in-progress`)    | `building`      |
| a round gave up (`blocked`)             | `fix`           |
| `/cohorte-ship` starts                          | `ship`          |
| PR opened (`status: shipped`)           | `shipped` (+ `PR #<num>` on the card) |

**Backfill / sync from specs (reconcile).** `specs/*.md` is the source of truth. For each spec, read its
`feature_id` (front-matter or filename) and `status`, map `status`→column — `frozen`→`ready`,
`in-progress`→`building`, `in-review`→`review`, `blocked`→`fix`, `shipped`→`shipped`, anything else / a spec with no
status→`spec` — then **full
sync**: card absent ⇒ add it in that column; card present ⇒ **move it** to that column so the board
always reflects the specs (this repositions cards the human may have moved by hand). Report cards
added vs. moved vs. already-correct.

**Create a board.** When linking a project with no board file yet: write
`<obsidian.vault_path>/<folder>/Tasks.md` with the `kanban-plugin: board` front-matter, one `## <heading>`
per configured column in pipeline order, and the closing `%% kanban:settings %%` block
(`{"kanban-plugin":"board","list-collapse":[false,…]}` with one `false` per column).
