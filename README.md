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

A **portable, stack-agnostic multi-agent pipeline** for your coding agent — Claude Code, Codex CLI,
Cursor, Gemini CLI or OpenCode. Install it once globally, then one command per project
(`/cohorte-init-pipeline`) adapts it to that project's stack.

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
| *"It edited a file I didn't want it to."* | **One owner per tree**, enforced in the rendered agent's frontmatter — not requested politely in a prompt. |
| *"It ran something it shouldn't have."* | `gate.py` is a **real blocking hook**, branch-aware, hard-denying destructive commands from every agent — subagents included. |
| *"The review said it was fine."* | Review is a **separate read-only agent** that sees the spec and the diff, never the conversation that produced them. A dead reviewer's zero findings can't read as ship. |
| *"Four agents just told me it doesn't compile."* | A **deterministic preflight** runs typecheck/lint/tests first. Red ⇒ **zero agents spawned**. |
| *"We fixed this same thing last week."* | `/cohorte-retro` turns repeated findings into ratified conventions **baked into the implementers**, so the next build never produces them. |

None of this is intelligence added to your agent — it's the opposite. It moves the decisions an
agent makes badly under context pressure into files, hooks and ownership boundaries, where they're
cheap and don't degrade with conversation length. Which is why it's markdown, shell and one Python
hook: **your app code never imports anything from Cohorte.**

[**The long version — including the four cases where you shouldn't use it →**](https://thebidouilleagency.github.io/cohorte/guide/why-cohorte)

## How it works — three layers

| Layer | What it holds | Lives in | Scope |
| --- | --- | --- | --- |
| **Generic core** | the workflow doctrine: commands, fixed agents, templates, hooks — zero project facts | `~/.claude` (global) — or vendored in a repo's `.claude/` (bundled) | identical everywhere, installed once |
| **Project profile** | stack, surfaces, commands, conventions, gates | `PIPELINE.md` + rendered surface agents + `gate-config.json`, **committed in each repo** | generated per project by `/cohorte-init-pipeline` |
| **User config** | kanban board links + shared Obsidian vault path | `~/.claude/cohorte.config.yaml` | personal, project-independent |

The core never hardcodes stack facts. Two mechanisms keep it generic:

1. **Runtime indirection** — commands/agents read project facts from `PIPELINE.md` (dev pipeline) or
   `~/.claude/cohorte.config.yaml` (kanban board links + shared vault) at run time — an agent's
   _first action_ is to read its config.
2. **Render-at-init** — things that must be in agent frontmatter (name, `tools:`, surface ownership)
   are rendered per **surface** by `/cohorte-init-pipeline` from `implementer.template.md`.

## Which coding agent — [full matrix →](https://thebidouilleagency.github.io/cohorte/reference/runtimes)

The doctrine is one set of source prompts. The installer renders them into whatever your agent
actually reads, and branches the instructions on what it can actually do:

```sh
cohorte install --runtime=codex,cursor     # pick explicitly
cohorte install --all-runtimes             # every supported one
cohorte install                            # detects what you have and asks
```

| | Commands | Subagents | Gate | Workflows |
| --- | --- | --- | --- | --- |
| **Claude Code** | `.claude/commands/*.md` | ✅ `.claude/agents` | ✅ blocking hook, deny + **ask** | ✅ |
| **Codex CLI** | `.agents/skills/*/SKILL.md` | ✅ `.codex/agents` (TOML) | ✅ blocking hook, deny only | — |
| **Cursor** | `.cursor/commands/*.md` | ✅ `.cursor/agents` | ✅ blocking hook, deny + **ask** | — |
| **Gemini CLI** | `.gemini/commands/*.toml` | ✅ `.gemini/agents` | ✅ blocking hook, deny only | — |
| **OpenCode** | `.opencode/commands/*.md` | ✅ `.opencode/agents` | advisory `--check` | — |

The same `gate.py` is registered as a real blocking hook on four of the five — it speaks each
runtime's envelope (`PreToolUse`, `beforeShellExecution`, `BeforeTool`). Codex and Gemini have **no
confirmation tier**, so a pattern that would be queried elsewhere is **denied** there rather than
falling through; the rendered prompts say so. OpenCode extends via plugins rather than hooks, so
there the commands call `gate.py --check` themselves — same config and verdicts, but advisory.

**Real subagents are a requirement, not a capability to degrade around** — the pipeline's isolation
guarantee is that boundary, so a runtime without them is refused at install rather than rendered
into a pipeline whose central promise is absent. All five have them.
`/cohorte-doctor` reports what the runtime you are in can actually enforce.

On Codex the commands ship as **skills** (`$cohorte-build`) rather than custom prompts: prompts are
deprecated and user-scoped, so a teammate cloning the repo would get the profile but none of the
commands — `.agents/skills/` is committed with it instead.

One thing does not travel: model pins. The profile names Anthropic aliases, meaningless elsewhere,
so agents inherit the runtime's own model. Claude Code remains the reference implementation and its
install is unchanged.

## Prerequisites

Only one hard requirement — the rest is optional and independent:

- **Node ≥ 18 + npm** — _required_, for the `cohorte` CLI that lays down the core. Nothing else needs it.
- **[`uv`](https://docs.astral.sh/uv/) + the Serena CLI** — _optional_, the default code-retrieval
  provider. Install it separately (`uv tool install -p 3.13 serena-agent && uv tool update-shell`); the
  cohorte install neither needs nor touches it, so the order between the two is irrelevant. Without Serena
  the pipeline still runs — agents just fall back to Grep/Read. Having it installed **before**
  `/cohorte-init-pipeline` lets init wire it in one pass (otherwise `/cohorte-update-pipeline` wires it later).
- **On a new machine cloning a repo that's already pipeline-ised:** the Serena registration is committed
  in the repo's `.mcp.json` (project scope, portable) — you don't re-wire. Just install the Serena CLI,
  restart the session, and run `/cohorte-doctor` to confirm it connects.

## Install

The pipeline ships as an npm package (`cohorte`), so releases are semver-tagged — no clone
needed, works on macOS/Linux/Windows. **Install it once, globally**; every command below is
written as `cohorte …`, and that single form is what the rest of this README, the docs, and the
[Francois extension](https://github.com/TheBidouilleAgency/francois-plugin-cohorte) all assume:

```sh
npm i -g cohorte
```

`npx cohorte <verb>` runs any of them without installing anything, for a one-off on a machine
you don't own. It is the escape hatch, not the path — see
[why one form](https://thebidouilleagency.github.io/cohorte/reference/installers).

**Global (recommended)** — install the generic core ONCE into `~/.claude`; it serves every repo on
your machine. Nothing is copied per project; the gate hook is registered once and reads each repo's
own `gate-config.json`:

```sh
cohorte install --global
```

The per-project part is NOT the core — it's the **profile** `/cohorte-init-pipeline` generates and you
commit: `PIPELINE.md`, the rendered surface agents, `gate-config.json`, `settings.json`, `specs/`.
**That's what makes team work possible in global mode**: everything project-specific travels with the
repo; each teammate just runs the same global one-liner once, guided by the committed
`.claude/pipeline.json` pointer (core version + install command) that `/cohorte-init-pipeline` writes.

<details>
<summary><strong>Alternative: per-project (bundled)</strong> — vendor the core into the repo itself.</summary>

```sh
# inside your project (or pass its path as an argument)
cohorte install
```

Copies the core into `<project>/.claude`, committed with the repo. Choose this when you want
**zero-setup onboarding** (teammates get the core with `git clone`, no install step at all) and a
core version **pinned per repo** (no drift between projects or teammates). Cost: the core is
duplicated in every repo and each repo updates separately.

</details>

<details>
<summary><strong>No Node/npm?</strong> The original script installers still work.</summary>

```sh
# global (recommended)                    # per-project (bundled)
sh install.sh --global                    sh install.sh
# or piped:
curl -fsSL https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.sh | sh -s -- --global
```

```powershell
# Windows (PowerShell 5.1+)
.\install.ps1 -Global         # or without -Global for per-project
# or:  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.ps1))) -Global
```

Script installs from a git checkout stamp the version as `<semver> (<sha>)`; the npm CLI stamps the
published semver. Both land in `.claude/pipeline/VERSION` and the `pipeline.json` pointer.

</details>

> **After installing (or updating): restart Claude Code / start a new session.** Slash commands and
> agents are scanned at session start — in an already-open session the new `/cohorte-init-pipeline`,
> `/cohorte-build`, etc. won't appear until you reload. This is the #1 "the install didn't work" trap.

Then, in Claude Code (from any repo, once the core is installed either way):

```
/cohorte-init-pipeline
```

It **detects** your stack (package manager, workspaces, frameworks, test runners, linters, git remote,
design system), **interviews** you for the gaps, and **generates**:

- `PIPELINE.md` — the project profile (a machine-readable `pipeline-profile` YAML block + prose conventions)
- one implementer agent per **surface** (e.g. `backend.md`, `frontend.md`) with strict tree ownership
  and a per-surface `model:` tier (Haiku for mechanical surfaces, bigger models where design decisions live)
- `.claude/gate-config.json` + `.claude/settings.json` — the destructive-command gate, plus an
  `allow` list of the project's read-only commands so agents don't stall on permission prompts
- a **code-retrieval provider** wired as a committed project-scope MCP server —
  [Serena](https://github.com/oraios/serena) by default (live LSP symbol navigation: agents query
  symbols instead of grep-and-reading whole files; `graphify` or `none` also available via the
  profile's `retrieval.provider`)
- `scripts/new-feature.sh` + `remove-feature.sh` — parallel worktree isolation (if you enable it)
- `specs/_template.md` (and, on first decision, `specs/_decisions.md` — the project's one-line-per-decision
  journal, read by `/cohorte-brainstorm`, `/cohorte-spec` and `/cohorte-audit` so features stop re-litigating settled ground)

Sanity-check `PIPELINE.md`, commit it, and run `/cohorte-brainstorm`.

## Update

```sh
npm i -g cohorte@latest           # refresh the CLI — the core it lays down is its own
cohorte update --global           # the shared core in ~/.claude (recommended setup)
cohorte update                    # a repo's bundled core in <project>/.claude
```

(Script equivalents: `sh install.sh --update [--global]` / `.\install.ps1 -Update [-Global]`.)

The installer refreshes the generic core (commands, hook, templates) **without** touching your
`PIPELINE.md`, rendered agents, `gate-config.json`, `settings.json`, or your filled
`~/.claude/cohorte.config.yaml`.

From inside Claude Code, prefer **`/cohorte-update-pipeline`**: it runs the right update invocation for your
install scope, reports `old → new` — and then **reconciles the repo's generated files to the new
core**: new profile fields are added at their defaults (you're only asked for genuinely new
decisions), surface agents are re-rendered, settings are patched additively, new capabilities get
wired. **`/cohorte-init-pipeline` is one-time per project** — after init, `/cohorte-update-pipeline` is the only
maintenance command you ever run (`/cohorte-build` auto-grows surfaces as specs need them).

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

Versions are tracked with npm semver — the published package is the release artifact.
Publishing is fully automated: [`publish.yml`](.github/workflows/publish.yml) runs on every push
to `main`; when `package.json`'s version isn't on the registry yet it publishes to npm (trusted
publishing / provenance), pushes the `vX.Y.Z` tag, and creates the GitHub release. Pushes without
a version bump just run the sanity checks.

**Releasing = editing one line.** Bump `"version"` in `package.json` (by hand, or
`npm version patch --no-git-tag-version`), commit, push — CI does the rest (publish + tag +
release). No local tagging needed.

`npm i -g cohorte@latest` then serves the new version everywhere; installed cores record
it in `.claude/pipeline/VERSION` and bundled repos in their committed `pipeline.json` pointer.
`install` and `update` compare themselves against the registry and say so when they are behind,
so a CLI pinned at an old version cannot quietly re-lay an old core.

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
| `/cohorte-ship <id>`         | Release agent commits, pushes, opens the PR; watches CI; proposes worktree teardown.  |
| `/cohorte-audit [path]`      | Prioritized refactor backlog for existing code.                                       |
| `/cohorte-refactor <domain>` | Apply the backlog for one surface, TDD-first.                                         |
| `/cohorte-retro [last n]`    | Mine the accumulated review findings for patterns; ratified ones become §Conventions rules and the surface agents are re-rendered — the next build never produces the finding. |
| `/cohorte-align-ds`          | Align the code UI kit to the design system (no-op if none configured).                |
| `/cohorte-update-pipeline`   | Refresh the installed core (global or bundled) to the latest published version.       |
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
turn by turn. Three are opt-in variants of their same-named commands; the fourth, `loop.js`,
exists **only** as a workflow:

| Script                  | What it runs                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `workflows/review.js`   | Preflight gate (aborts while red — zero agents), one reviewer per touched surface, adversarial cross-check of CRITICAL/security findings, merged verdict only. |
| `workflows/audit.js`    | One auditor per domain (every surface + shared) concurrently, prioritized `specs/refactor-backlog.md`. |
| `workflows/refactor.js` | Big domains only: `shared` first and alone, then parallel surface implementers, per-domain verify + one retry. |
| `workflows/loop.js`     | `/cohorte-loop` — build → review → [fix → review]* for one feature, unattended and resumable; exits on zero blocking findings, treading water, maxRounds, or anything that needs a human (contract change, unreviewed surface). No conversational fallback, on purpose. |

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
- Phase 0 of every script is the `profile-reader` agent (haiku) — it reads `PIPELINE.md` and hands
  the script the profile as JSON, since workflow scripts have no filesystem access. Mechanical
  phases run on haiku; judgment phases use the same pinned agents as the commands.

Details: `profile/SCHEMA.md` §Workflows.

## Privacy

Cohorte sends nothing, anywhere. There is no telemetry, no usage pings, no collector — the
opt-in stats that shipped through 2.2.0 were removed in 2.3.0, sender included. Everything the
pipeline records (`pipeline-metrics.jsonl`, `specs/reports/`) stays in your repo, and the only
network calls are the ones you can see: `git`, `gh`, and whatever MCP providers you wired
yourself.

## License

[AGPL-3.0](LICENSE). Free to use, including commercially — but if you modify it and distribute it
or offer it as a network service, you must publish your modifications under the same license.

## Profile reference

See `profile/SCHEMA.md` for every field in `PIPELINE.md` and how the pipeline uses it.

## Layout of this repo

```
package.json            # npm package (cohorte) — semver source of truth
bin/cli.js              # the npm CLI: install / update / specs / doctor / metrics / version (cross-platform, no deps)
bin/report.js           # the four renderings of `specs` / `doctor` (human, porcelain, json, panel)
lib/                    # shared readers behind those verbs — doctor.js (the JS port of
                        #   /cohorte-doctor) + runtime.js / versions.js / yaml.js. No deps.
install.sh              # script installer (fresh + --update) for npm-less setups — still needs Node
install.ps1             # same installer for Windows PowerShell (fresh + -Update)
core/                   # copied verbatim into ~/.claude (global) or <project>/.claude (bundled)
  agents/               # implementer.template.md (rendered per surface) + review / release / profile-reader
  commands/             # init-pipeline + the pipeline commands + /cohorte-update-pipeline
  hooks/                # gate.py (destructive-command gate; branch-aware; preflight phase gate)
  templates/            # handoff / brainstorm-return / design-brief / review-feedback / pr-body / spec
  workflows/            # Workflow-runtime scripts: review.js / audit.js / refactor.js (opt-in variants) + loop.js (workflow-only)
profile/
  PIPELINE.template.md  # the profile skeleton /cohorte-init-pipeline fills
  SCHEMA.md             # field reference
  cohorte.config.template.yaml   # seeds ~/.claude/cohorte.config.yaml (kanban)
scripts/                # worktree-isolation templates + the shipped preflight/kanban scripts
```
