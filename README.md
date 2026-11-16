<div align="center">

<img src="https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/assets/cohorte-banner.png" alt="Cohorte — portable multi-agent pipeline for Claude Code" width="720">

[![npm version](https://img.shields.io/npm/v/cohorte?logo=npm&color=cb3837)](https://www.npmjs.com/package/cohorte)
[![npm downloads](https://img.shields.io/npm/dm/cohorte?logo=npm)](https://www.npmjs.com/package/cohorte)
[![Publish to npm](https://github.com/TheBidouilleAgency/cohorte/actions/workflows/publish.yml/badge.svg)](https://github.com/TheBidouilleAgency/cohorte/actions/workflows/publish.yml)
[![node >=18](https://img.shields.io/node/v/cohorte?logo=node.js&logoColor=white)](https://nodejs.org)
[![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-thebidouilleagency.github.io%2Fcohorte-6f42c1)](https://thebidouilleagency.github.io/cohorte/)

**[📖 Full documentation](https://thebidouilleagency.github.io/cohorte/)** — guides (feature cycle, workflows, token economy, parallel features) + complete reference (commands, agents, profile, gate, scripts).

</div>

A **stack-agnostic multi-agent pipeline for [Claude Code](https://code.claude.com)**. Install it once
on your machine, then one command per project (`/cohorte-init-pipeline`) adapts it to that project's
stack — and everything it generates is committed with the project.

- **The dev pipeline** — a human **lead** drives feature work through gated commands, dispatching
  **stateless agents** that only communicate through a frozen contract:

  ```
  /cohorte-brainstorm → /cohorte-spec → (design) → /cohorte-build <id> → /cohorte-review → (/cohorte-fix) → /cohorte-ship
  ```

<div align="center">
  <img src="https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/assets/demo-cli.gif" alt="cohorte doctor reporting a green pipeline, the spec board, and the gate denying a chained destructive command" width="760">
  <br>
  <sub><code>cohorte doctor</code> · the spec board · the gate refusing a hard-denied command chained behind a benign one.<br>
  Recorded from the real CLI by <code>scripts/demo/record-cli.sh</code> — no output is hand-edited.</sub>
</div>

## Why a pipeline at all

Your coding agent is already good at the first prompt of a feature. It gets worse at every one
after — because what it knows lives in a conversation, and a conversation gets summarised,
truncated, and re-sent at input price on every turn. Cohorte is the set of constraints that stop
that degradation. Each one is a failure you have already had:

| The failure | The constraint |
| --- | --- |
| *"It forgot what we decided."* | The spec is **frozen to disk** and re-read by every stateless agent. Nothing is remembered, so nothing is forgotten — and `/clear` between stages is always safe. |
| *"The API and the UI don't fit."* | The **contract is authored before any implementer is dispatched**. Surfaces import it read-only and never talk to each other — which is what makes building them in parallel safe. |
| *"It edited a file I didn't want it to."* | **One owner per tree, enforced**: the gate denies a surface agent's Write/Edit outside its own tree (and its writes to the contract); its Bash writes are checked best effort, and the review flags anything that slipped through. |
| *"It ran something it shouldn't have."* | The **gate** is a real blocking hook committed in the repo, branch-aware, parsing commands (not grepping them) to deny force-pushes, pushes to the default branch and the project's destructive commands — subagents included. It fails closed. It is a strong guard against agent mistakes, not a sandbox: keep GitHub branch protection as the hard boundary for the remote. |
| *"The review said it was fine."* | Review is a **separate read-only agent** that sees the spec and the diff, never the conversation that produced them. A dead reviewer's zero findings can't read as ship. |
| *"Four agents just told me it doesn't compile."* | A **deterministic preflight** runs typecheck/lint/tests first. Red ⇒ **zero agents spawned**. |
| *"We fixed this same thing last week."* | `/cohorte-retro` turns repeated findings into ratified conventions **baked into the implementers**, so the next build never produces them. |

None of this is intelligence added to your agent — it's the opposite. It moves the decisions an
agent makes badly under context pressure into files, hooks and ownership boundaries, where they're
cheap and don't degrade with conversation length. Which is why it's markdown, shell and one Python
hook: **your app code never imports anything from Cohorte.**

[**The long version — including the four cases where you shouldn't use it →**](https://thebidouilleagency.github.io/cohorte/guide/why-cohorte)

## How it works — one install, everything else in the repo

| What | Holds | Lives in |
| --- | --- | --- |
| **The machine install** (`cohorte install`, once) | the 16 `/cohorte-*` commands, the `cohorte-review` / `cohorte-release` / `cohorte-profile-reader` agents, the workflow scripts, the generic core (templates, schema, scripts, the gate's source) — zero project facts | `~/.claude/commands/cohorte-*.md`, `~/.claude/agents/cohorte-*.md`, `~/.claude/workflows/cohorte-*.js`, `~/.claude/cohorte/` |
| **The project** (generated by `/cohorte-init-pipeline`, **committed**) | the profile (stack, surfaces, commands, conventions, gates), one implementer agent per surface, the gate hook and its registration, the version pointer, the specs | `PIPELINE.md`, `.claude/agents/<surface>.md`, `.claude/gate-config.json`, `.claude/hooks/cohorte-gate.py` + `.claude/settings.json`, `.claude/pipeline.json`, `.claude/profile.json`, `specs/` |
| **You** | kanban board links + shared Obsidian vault path | `~/.claude/cohorte.config.yaml` |

Everything project-specific travels with `git clone` — **including the gate**: a teammate who clones
is protected before they even install Cohorte, and only needs `npm i -g cohorte && cohorte install`
to get the commands. Nothing project-specific is ever written under `~/.claude`, so two projects
with a `frontend` surface never overwrite each other's agent.

The core never hardcodes stack facts. Two mechanisms keep it generic:

1. **Runtime indirection** — commands/agents read project facts from `PIPELINE.md` (dev pipeline) or
   `~/.claude/cohorte.config.yaml` (kanban board links + shared vault) at run time — an agent's
   _first action_ is to read its config.
2. **Render-at-init** — things that must be in agent frontmatter (name, `tools:`, surface ownership)
   are rendered per **surface** by `/cohorte-init-pipeline` from `implementer.template.md`.

> **Claude Code only.** 3.0.0 dropped Codex, Cursor, Gemini CLI and OpenCode. The last multi-runtime
> release is `cohorte@2.10.2`; its source is on the
> [`archive/multi-runtime`](https://github.com/TheBidouilleAgency/cohorte/tree/archive/multi-runtime) branch.

## Prerequisites

- **Node ≥ 20 + npm** — for the `cohorte` CLI.
- **Python ≥ 3.9** as `python3` — the gate hook every project commits runs on it. The hook is
  fail-closed: without Python, Claude Code refuses every Bash call in a Cohorte project.
  **Windows:** the committed hook is `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py"`, run
  through a POSIX shell (Git Bash). Without one, set `gate.hook_form: exec` in `PIPELINE.md` and run
  `cohorte sync`: the hook becomes `python3` + an argument list that Claude Code launches directly
  (every teammate then needs a recent Claude Code). `python3` must be on `PATH` either way.
- **Claude Code** — workflows (the opt-in deterministic runs) need ≥ 2.1.154; the hook's
  fail-closed `onFailure` setting is honoured from 2.1.295 (older clients ignore it and fail open).
- **[`uv`](https://docs.astral.sh/uv/) + the Serena CLI** — _optional_, the default code-retrieval
  provider (`uv tool install -p 3.13 serena-agent && uv tool update-shell`). Without it agents fall back
  to Grep/Read. Installed before `/cohorte-init-pipeline`, init wires it in one pass.

## Install

```sh
npm i -g cohorte
cohorte install
```

`cohorte install` writes only into `~/.claude` (or `$CLAUDE_CONFIG_DIR`) and records every file it
writes in `~/.claude/cohorte/manifest.json`. It never deletes a file it did not write, backs up any
file of its own you edited before refreshing it, and refuses to run — changing nothing — if
`~/.claude/settings.json` is not valid JSON. It registers **no** machine-wide hook.

> **Restart Claude Code** (or start a new session) after installing or updating: commands and agents
> are scanned at session start.

Without a global npm install: `npx cohorte@latest install`, or
`curl -fsSL https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.sh | sh`
(Windows: `irm https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.ps1 | iex`).
Both scripts still need Node and install the **latest release**, not the tip of `main`.

Then, in Claude Code, inside each project, once:

```
/cohorte-init-pipeline
```

It **detects** your stack (package manager, workspaces, frameworks, test runners, linters, git remote,
design system), **interviews** you for the gaps, and **generates**:

- `PIPELINE.md` — the project profile (a machine-readable `pipeline-profile` YAML block + prose conventions)
- one implementer agent per **surface** in `.claude/agents/` (e.g. `backend.md`, `frontend.md`) with its
  own tree and a per-surface `model:` tier
- `.claude/gate-config.json` + the `.claude/settings.json` permissions — plus an `allow` list of the
  project's read-only commands so agents don't stall on permission prompts
- the **gate**, via `cohorte sync`: `.claude/hooks/cohorte-gate.py` registered in `.claude/settings.json`,
  the `.claude/pipeline.json` pointer, `.claude/profile.json` (the profile's machine block parsed to
  JSON, which agents read instead of the whole `PIPELINE.md`) and the `.gitignore` entries for the
  local-only artifacts
- a **code-retrieval provider** wired as a committed project-scope MCP server —
  [Serena](https://github.com/oraios/serena) by default (`graphify` or `none` via `retrieval.provider`)
- `scripts/new-feature.sh` + `remove-feature.sh` — parallel worktree isolation (if you enable it)
- `specs/_template.md` (and, on first decision, `specs/_decisions.md` — the project's one-line-per-decision
  journal, read by `/cohorte-brainstorm`, `/cohorte-spec` and `/cohorte-audit`)

Sanity-check `PIPELINE.md`, commit what init lists, and run `/cohorte-brainstorm`.

## Update

```sh
npm i -g cohorte@latest && cohorte update
```

`cohorte update` is the same idempotent operation as `install`: it refreshes the machine install and
removes files the previous version shipped and this one does not (only when you have not edited them).
Then, inside each project, run **`/cohorte-update-pipeline`**: it runs `cohorte sync` (refreshes the
committed gate and the pointer) and **reconciles the repo's generated files to the new core** — new
profile fields at their defaults, surface agents re-rendered, permissions patched additively, new
capabilities wired. `/cohorte-init-pipeline` is one-time per project.

### From 2.x

`cohorte update` migrates a 2.x machine: it first removes the 2.x gate registration from
`~/.claude/settings.json`, then moves the 2.x core (`~/.claude/pipeline/`, `templates/`, `hooks/gate.py`,
`agents/review.md`…) into `~/.claude/cohorte/legacy-backup/<date>/`. Your own files are never moved.
Then run `/cohorte-update-pipeline` in each project (or `cohorte sync <project>`): a vendored 2.x core
in the repo is removed (git keeps it), the pointer loses its `mode`, and surface agents a 2.x global
init put in `~/.claude/agents` are re-rendered into the project. If you ever tried the discontinued
Python line (`cohorte@dev` 3.0.0-dev.*, `cohorte-engine` on PyPI): `uv tool uninstall cohorte-engine`
(or `pipx uninstall cohorte-engine`) so its `cohorte` binary cannot shadow this one, and delete
`~/.cohorte/` and any `.cohorte/` directory it left in your repos.

## Uninstall

```sh
cohorte uninstall                      # everything install wrote (your edits are kept and listed)
cohorte uninstall --purge              # …and ~/.claude/cohorte.config.yaml
cohorte uninstall --project [path]     # the gate wiring of one repo (PIPELINE.md, agents, specs stay)
```

## Reading a project without an agent

The two read-only halves of the pipeline, in the shell:

```sh
cohorte specs              # the board: id · status · branch · title, from specs/*.md
cohorte doctor             # the /cohorte-doctor checks — exits 1 when any check is bad
cohorte metrics --days=30  # cost + runtime per command, from Claude Code's transcripts
```

`doctor`'s exit code is what makes it a CI step, and the three of them are what the Francois
extension below renders.

`doctor`'s exit code makes it a CI step as-is. Add `--porcelain` for one record per line with
`U+001F` between fields (a spec title with a space in it never misaligns a column), or `--json`
for the native document. Both read through `lib/`, so every consumer — the CLI, a Francois
panel — answers from one implementation and the repo never gets two verdicts.

`--panel` — on `specs`, `doctor` and `metrics` — emits the payload shape a
[Francois](https://github.com/antoine-gmnz/francois) extension panel expects. It is the one
Francois-aware surface in the package, and it exists for
[**francois-plugin-cohorte**](https://github.com/TheBidouilleAgency/francois-plugin-cohorte): a
manifest-only extension that renders the spec board, the doctor report and the 30-day cost as
three panels beside your sessions.

A Francois extension may only spawn a **bare binary name resolved on `PATH`** — never `npx`,
never a shell, never an absolute path. So this one needs the global install, and nothing else
will do:

```sh
npm i -g cohorte
francois ext install TheBidouilleAgency/francois-plugin-cohorte
```

## Releasing (maintainers)

Bump `"version"` in `package.json` and add its `## X.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, then
merge to `main`. [`publish.yml`](.github/workflows/publish.yml) starts only **after CI succeeded** on
that commit, re-runs the suites, and waits for a maintainer's approval (the `npm-publish` environment)
before publishing with provenance, tagging `vX.Y.Z` and creating the GitHub release. A pre-release
version (`3.1.0-rc.1`) is published under the `next` dist-tag, never `latest`. `npm test` runs every
suite locally.

## The commands

| Command              | Role                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| `/cohorte-init-pipeline`     | Detect stack → interview → generate the profile + agents. Run once per project.       |
| `/cohorte-intake [paste]`    | Triage anything that arrives (ticket, email, trace, thread) into a `/cohorte-patch` handoff or a brainstorm seed — staged to disk, carded in Ideas. |
| `/cohorte-brainstorm`        | Interactive persona panel that pressure-tests a feature idea.                         |
| `/cohorte-spec`              | Freeze the feature spec + contract into `specs/<id>.md` (UI features also get a standalone design brief at `specs/design/<id>.md`). Also applies review returns. |
| `/cohorte-patch [bug]`       | Bug-fix entry: triage a bug and freeze a ~60-line patch spec (`specs/patch-<slug>.md`) whose regression test replaces the contract. Then the normal `/cohorte-build → review → ship`. |
| `/cohorte-build <id>`        | Readiness gate on the frozen spec, then the lead authors the contract and dispatches one implementer per surface in parallel. |
| `/cohorte-review <id>`       | Read-only review agents (one per touched surface, parallel) audit the diff vs the spec; out-of-scope findings go to the refactor backlog. `--pr <num>` reviews an **incoming** GitHub PR in a throwaway worktree and offers to post the report as a comment. |
| `/cohorte-fix <id>`          | Apply a review report: remediation into the spec, re-dispatch only the surfaces with findings. |
| `/cohorte-fleet plan\|status\|sync` | Fly several features in parallel: overlap matrix + merge order, one worktree per feature, live status, post-merge rebase sweep. Coordination only — never headless execution. |
| `/cohorte-verify <id>`       | Start the app, run smoke/e2e (and migrations down-then-up on a dev DB), tick the runtime DoD items with evidence. Ship blocks on a FAIL. |
| `/cohorte-ship <id>`         | Release agent commits, pushes, opens the PR; watches CI; proposes worktree teardown.  |
| `/cohorte-revert <id>`       | Revert a shipped feature through a PR (never pushed to the default branch), running its `## Rollback` down migration on a dev DB. |
| `/cohorte-audit [path]`      | Prioritized refactor backlog for existing code.                                       |
| `/cohorte-refactor <domain>` | Apply the backlog for one surface, TDD-first, then freeze the round as a `kind: refactor` spec that goes review → ship. |
| `/cohorte-retro [last n]`    | Mine the accumulated review findings for patterns; ratified ones become §Conventions rules and the surface agents are re-rendered — the next build never produces the finding. |
| `/cohorte-align-ds`          | Align the code UI kit to the design system (no-op if none configured).                |
| `/cohorte-update-pipeline`   | Refresh the machine install, re-wire this repo (`cohorte sync`) and reconcile its generated files. |
| `/cohorte-doctor`            | Diagnose the installation (core, agents↔surfaces, hooks, gate, retrieval, worktrees). |

### Run the loop cheaply — `/clear` between stages

Every command reloads all the state it needs **from disk** — the frozen spec, the contract, the diff, the
Remediation checkboxes, the freshness stamp, and the last `/cohorte-review` report (staged to a gitignored
`specs/reports/<id>.md`). Nothing essential lives in the conversation. So the loop is **`/clear`-safe at
every boundary**:

```
/cohorte-spec → /clear → /cohorte-build → /clear → /cohorte-review → /clear → /cohorte-fix → /clear → /cohorte-review → /cohorte-ship
```

`/clear`-ing between stages sheds the accumulated main-thread context, which is the single biggest token
lever: long sessions (>150k) are expensive even when cached. Each command tells you when its handoff is
safe to clear. If you'd rather stay in one session, `/compact` mid-task does the lighter version. (Claude
can't fire `/clear` itself — it's a client-side command; the pipeline just makes it always safe to type.)


### Run features in parallel — one session per feature

With `isolation.enabled`, every feature already gets its own worktree, ports, and database
(`scripts/new-feature.sh <id>` — slots tracked in `.worktrees/slots.tsv`). That isolation is exactly
what makes **parallel features** safe, and it's the real throughput multiplier when you're rate-limited:
while feature A's `/cohorte-build` runs its agents (minutes of wall-clock you'd otherwise spend waiting), a
second Claude Code session can `/cohorte-spec` or `/cohorte-review` feature B.

The pattern:

```
session 1 (main checkout):   /cohorte-spec feat-a → /cohorte-build feat-a  (agents run…)
session 2 (main checkout):   /cohorte-spec feat-b → /cohorte-build feat-b  (agents run…)
session 1:                   /cohorte-review feat-a → /cohorte-ship feat-a
session 2:                   /cohorte-review feat-b → …
```

Rules that make it safe:

- **One feature per session.** All lead-side state is keyed by feature id on disk
  (`specs/<id>.md`, `<contract.path>/<id>.*`, `specs/reports/<id>*`), so sessions never share state —
  but a single session interleaving two features accumulates both in its context, paying for both.
- **Disjoint surfaces per feature are guaranteed** (each worktree is a full checkout), and each
  feature's DB/ports come from its slot — two features' dev servers collide on neither.
- **The contract package is the one shared tree.** Two features editing
  `<contract.path>/<their-own-id>.<ext>` never conflict (one file per feature); merge order only
  matters if a later feature *imports* an earlier one's contract — ship the dependency first.
- `/cohorte-ship` one at a time: it commits from the feature's branch and the freshness gate keeps a stale
  verdict from shipping; after each merge, rebase the other live worktrees (`git rebase main`) so
  their eventual reviews diff against reality.
- `/cohorte-doctor` check 6 shows the live slot table (feature ↔ worktree ↔ ports) when you lose track.

### Workflows — deterministic multi-agent runs (opt-in)

Four **workflow scripts** ship for the Claude Code Workflow runtime — the same fan-out the
commands orchestrate, but driven by a deterministic script instead of the lead reasoning it out
turn by turn. They are installed in `~/.claude/workflows/`. Three are opt-in variants of their
same-named commands; the fourth, `cohorte-loop.js`, exists **only** as a workflow:

| Script                  | What it runs                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `cohorte-review.js`     | Preflight gate (aborts while red — zero agents), one reviewer per touched surface, adversarial cross-check of CRITICAL/security findings, merged verdict only. |
| `cohorte-audit.js`      | One auditor per domain (every surface + shared) concurrently, prioritized `specs/refactor-backlog.md`. |
| `cohorte-refactor.js`   | Big domains only: `shared` first and alone, then parallel surface implementers, per-domain verify + one retry. |
| `cohorte-loop.js`       | The loop workflow — build → review → [fix → review]* for one feature, unattended and resumable; exits on zero blocking findings, treading water, maxRounds, or anything that needs a human (contract change, unreviewed surface). No conversational fallback, on purpose. |

The essentials:

- **The conversational commands stay the default path** — and the fallback when workflows are
  disabled or the client is too old. A workflow runs only when you explicitly ask for it
  ("run the review workflow").
- **Prerequisite: Claude Code ≥ 2.1.154** with workflows enabled. `/cohorte-doctor` (check 8) tells you
  which path your session will take and why.
- **No input mid-run — questions at the edges.** A workflow runs to completion without asking
  anything: whatever would have been a mid-run question lands in the result at the end. The
  destructive-command gate still fires inside workflow subagents; in unattended runs its confirms
  become denies.
- Phase 0 of every script is the `cohorte-profile-reader` agent (haiku) — one Read of
  `.claude/profile.json` (`PIPELINE.md` as the fallback) hands the script the profile as JSON, since workflow scripts have no filesystem access. Mechanical
  phases run on haiku; judgment phases use the same pinned agents as the commands.

Details: `profile/schema/workflows.md`.

## Privacy

Cohorte sends nothing, anywhere. There is no telemetry, no usage pings, no collector — the
opt-in stats that shipped through 2.2.0 were removed in 2.3.0, sender included. Everything the
pipeline records (`pipeline-metrics.jsonl`, `specs/reports/`) stays in your repo. The network calls
are the ones you can see — `git`, `gh`, whatever MCP providers you wired — plus one read-only lookup
of the latest published version on `registry.npmjs.org` by `cohorte install/update/sync/doctor`
(`COHORTE_NO_VERSION_CHECK=1` turns it off).

## License

[AGPL-3.0](LICENSE). Free to use, including commercially — but if you modify it and distribute it
or offer it as a network service, you must publish your modifications under the same license.

## Profile reference

See `profile/schema/profile-block.md` for every field in `PIPELINE.md` and how the pipeline uses it. The
rest of the pipeline's rulebook sits next to it, one file per topic, indexed by `profile/SCHEMA.md`.

## Layout of this repo

```
package.json            # npm package (cohorte) — semver source of truth; `npm test` runs every suite
bin/cli.js              # the CLI: install / update / sync / uninstall / doctor / specs / metrics / version
bin/report.js           # the four renderings of `specs` / `doctor` (human, porcelain, json, panel)
lib/install.js          # the machine install: manifest, ownership rules, 2.x migration, uninstall
lib/project.js          # `cohorte sync`: wires one repo (copied into the core with its one sibling, yaml.js)
lib/render.js           # renders core/commands + core/agents for Claude Code (one preamble of path tokens)
lib/doctor.js           # the JS port of /cohorte-doctor, + versions.js / yaml.js. No dependencies.
install.sh, install.ps1 # thin wrappers around bin/cli.js for installs without a global npm
core/
  agents/               # implementer.template.md (rendered per surface) + cohorte-review / -release / -profile-reader
  commands/             # the 16 /cohorte-* commands
  hooks/gate.py         # the gate (copied into each project as .claude/hooks/cohorte-gate.py)
  templates/            # handoff / brainstorm-return / design-brief / review-feedback / pr-body / spec + step files
  workflows/            # Workflow-runtime scripts: review / audit / refactor (opt-in variants) + loop (workflow-only)
profile/
  PIPELINE.template.md  # the profile skeleton /cohorte-init-pipeline fills
  SCHEMA.md             # index of schema/ — one line per topic file
  schema/               # the rulebook, one file per topic (profile-block, spec-status, kanban, …)
  cohorte.config.template.yaml   # seeds ~/.claude/cohorte.config.yaml (kanban)
scripts/                # shipped preflight/kanban scripts, worktree-isolation templates, metrics, the test suites
```
