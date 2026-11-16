# Getting started

## Prerequisites

- **[Claude Code](https://code.claude.com)** — Cohorte targets Claude Code only. Workflows (the
  opt-in [deterministic runs](/guide/workflows)) need **≥ 2.1.154** with workflows enabled; the
  gate hook's fail-closed `onFailure` setting is honoured from **2.1.295** (older clients ignore
  it, so a broken hook fails open there).
- **Node ≥ 20 + npm** — for the `cohorte` CLI. Every install route needs it, the shell scripts
  included.
- **Python ≥ 3.8 as `python3`** — the gate hook every project commits runs on it. The hook is
  registered fail-closed: without a working `python3`, Claude Code refuses every Bash call in a
  Cohorte project.
- Optional: [`uv`](https://docs.astral.sh/uv/) to install **Serena** (the default code-retrieval
  provider): `uv tool install -p 3.13 serena-agent`, and make sure `~/.local/bin` is on PATH
  (`uv tool update-shell`). Without it agents fall back to Grep/Read. Install it before
  `/cohorte-init-pipeline` and init wires it in one pass.
- Optional: `gh` (GitHub CLI) — `/cohorte-ship` uses it to open PRs and watch CI; without it you get a
  compare URL + drafted PR body instead.

::: info Codex, Cursor, Gemini CLI, OpenCode
3.0.0 dropped them. The last multi-runtime release is `cohorte@2.10.2`; its source is on the
[`archive/multi-runtime`](https://github.com/TheBidouilleAgency/cohorte/tree/archive/multi-runtime)
branch.
:::

## Install once per machine

```sh
npm i -g cohorte
cohorte install
```

There is one install mode. `cohorte install` writes only into `~/.claude` (or
`$CLAUDE_CONFIG_DIR`), records every file it writes in `~/.claude/cohorte/manifest.json`, and
registers **no** machine-wide hook — the gate lives in each project. It is idempotent: run it
again (or `cohorte update`, the same operation) any time.

**Restart Claude Code** (or start a new session) afterwards: commands and agents are scanned at
session start.

No global npm install? `npx cohorte@latest install` does the same once. The shell scripts are
thin wrappers that still need Node ≥ 20 (plus `git`) and install the **latest release tag**, not
the tip of `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.sh | sh
```

```powershell
# Windows PowerShell 5.1+ / PowerShell 7
irm https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.ps1 | iex
```

::: tip What lands where
```
~/.claude/commands/cohorte-*.md        the 16 slash commands
~/.claude/agents/cohorte-review.md     the three fixed agents
                 cohorte-release.md
                 cohorte-profile-reader.md
~/.claude/workflows/cohorte-*.js       review · audit · refactor · loop
~/.claude/cohorte/                     the generic core: pipeline/ (SCHEMA.md, templates,
                                       implementer.template.md, scripts/, VERSION, CHANGELOG.md),
                                       templates/, hooks/gate.py, lib/project.js, manifest.json
~/.claude/cohorte.config.yaml          YOUR config (kanban boards, shared vault) — seeded once,
                                       never overwritten, not in the manifest
```
Nothing project-specific is ever written under `~/.claude`. See
[Installers & updates](/reference/installers) for the ownership rules.
:::

## Initialize a project

Open the project in Claude Code and run:

```
/cohorte-init-pipeline
```

One-time per project, interactive, in five steps:

1. **Detect** — reads the repo (read-only, no questions yet): package manager, workspace layout,
   apps/services, test/lint/typecheck commands, migration tooling, CI, git remote, design system.
2. **Interview the gaps** — asks *only* what it couldn't detect, batched:
   - **Surfaces & ownership** — one entry per independently-built area (`backend` → `apps/api`,
     `frontend` → `apps/web`, …), each with its agent name, tools, and model tier (`sonnet`
     default / `haiku` for mechanical / `inherit` only when real design decisions justify the
     lead's model).
   - **Quiet commands** — the bridled variants agents actually run (`--reporter=dot`,
     `--quiet`, failures-only) so a green test run costs lines, not pages.
   - **Contract** mechanism (shared Zod types / OpenAPI / protobuf / JSON-schema / none) and
     where feature contracts live.
   - **UI language**, **RBAC** hierarchy, **design system** (provider, kit/token paths),
     **code retrieval** provider (Serena by default), **isolation** (parallel git worktrees with
     per-feature DB + ports), **gate** patterns (destructive commands to deny / confirm), and the
     `/cohorte-brainstorm` **personas**.
   - Optional: **kanban** mirror (Obsidian board) question (default No).
3. **Draft** — shows you the assembled `PIPELINE.md` for approval.
4. **Write & render** — writes `PIPELINE.md`, renders one agent per surface into the project's
   `.claude/agents/` (conventions baked in), generates `.claude/gate-config.json` and the
   `.claude/settings.json` permissions (an `allow` list of read-only commands so agents don't stall
   on prompts), wires the retrieval provider (committed `.mcp.json`), renders the isolation
   scripts, then runs **`cohorte sync`** — which copies the gate to
   `.claude/hooks/cohorte-gate.py`, registers it in `.claude/settings.json`, writes the
   `.claude/pipeline.json` pointer, adds the local-only artifacts to `.gitignore` and seeds
   `specs/_template.md` — and (optionally) a CI workflow.
5. **Report** — core version, the `sync` output, files written, surface → agent mapping.

Then commit what it lists:

```sh
git add PIPELINE.md CLAUDE.md .claude .gitignore specs   # + .mcp.json and scripts/ if init wrote them
git commit -m "chore: set up cohorte pipeline"
```

Everything project-specific travels with `git clone` — **including the gate**: a teammate who
clones is protected before installing anything, and only needs `npm i -g cohorte && cohorte install`
to get the commands.

## Sanity check

```sh
cohorte doctor          # in the shell — exits 1 when any check is bad
```

```
/cohorte-doctor         # in Claude Code — same checks plus the live, in-session half
```

Verifies the whole wiring: core version + pointer coherence, 2.x leftovers, agents ↔ surfaces
(no orphans), model pins, the gate config and the committed, registered gate hook, retrieval
health, design paths, isolation, the kanban board link, workflows availability, specs hygiene.
Every failure comes with its exact fix. The [two-minute check](/reference/installers#the-two-minute-check)
walks through a fresh install.

## Your first feature

```
/cohorte-brainstorm          ← pressure-test the idea with the persona panel
/clear
/cohorte-spec                ← freeze specs/<id>.md — the single source of truth
/clear
/cohorte-build <id>          ← contract authored, one implementer per surface in parallel
/clear
/cohorte-review <id>         ← one reviewer per touched surface → SHIP / REVISE / BLOCK
/clear                          (REVISE/BLOCK → /cohorte-fix <id>, then re-review)
/cohorte-ship <id>           ← commit, push, PR (the one human-confirmed step)
```

Every handoff lands on disk, which is why the `/clear` between phases is always safe — and
always worth it (the lead's history is re-sent at input price on every turn). See
[The feature cycle](/guide/feature-cycle). With workflows enabled, the middle of that loop can also
run unattended: ask to *"run the loop workflow for `<id>`"* after the first `/cohorte-build` —
see [Workflows](/guide/workflows).

## Keeping it current

```sh
npm i -g cohorte@latest && cohorte update   # refresh the CLI first — it lays down its own core
```

then, inside each project:

```
/cohorte-update-pipeline
```

which runs `cohorte sync` (refreshes the committed gate and the pointer) and **reconciles** the
generated files to the new core: tops up new profile fields at their defaults (asking only for
genuine human decisions, batched), re-renders the surface agents (this also refreshes their baked
conventions), additively patches `settings.json`/`gate-config.json`, re-runs capability wiring
health checks, and shows the CHANGELOG entries you just gained. `/cohorte-init-pipeline` never
needs re-running for an upgrade.

Coming from 2.x? See [Migrating from 2.x](/reference/installers#migrating-from-2-x).
