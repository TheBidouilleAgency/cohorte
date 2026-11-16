# /cohorte-init-pipeline · 04 Write & render

### Phase 4 — Write & render (after go-ahead)

1. **Write `PIPELINE.md`** at the repo root (source: the installer's `pipeline/PIPELINE.template.md`).
2. **Wire it into `<memory>`:** if `<memory>` exists, ensure it references the profile (add a line
   near the top: `> Project profile & pipeline facts: **@PIPELINE.md**`). If not, create a minimal
   `<memory>` with that reference + a one-paragraph project intro.
3. **Render one agent per surface** — for each surface, follow `<core>/pipeline/schema/rendering.md` (steps 2–3): render `<agents>/<agent>.md` from the installer's
   `pipeline/implementer.template.md`, substituting `<SURFACE_AGENT>`, `<SURFACE_LABEL>`, `<SURFACE_PATH>`,
   `<SURFACE_TOOLS>`, `<SURFACE_MODEL>`, `<PROJECT_NAME>`, `<SURFACE_CONVENTIONS>` (the surface's
   baked convention slice — §Shared + its `### Surface:` stanza + its §Testing lines from the
   PIPELINE.md you just wrote), and the surface-specific blocks
   (`<SURFACE_EXTRA_NEVER>`, `<SURFACE_DESIGN_INPUT>`, `<SURFACE_TDD_STEP1>` — fill design-related ones
   only when `uses_design`).
   Leave the fixed agents as-is (generic, shipped by the installer under `<fixed-agents>/`). Surface
   agents go in `<agents>/` (this repo) — never under `~/.claude/agents`, where two projects with a
   surface of the same name would overwrite each other.
4. **Generate `<state>/gate-config.json`** from the `gate` block — copy all five keys verbatim:
   `{"deny": [...], "ask": [...], "ask_on_default_branch": [...], "default_branch": "<vcs.default_branch>",
   "preflight": {"enabled": <gate.preflight.enabled>, "agents": [...], "max_age_minutes": <n>}}`
   (profile has no `preflight` block ⇒ omit the key — the hook then skips the phase gate).
5. **Write `.claude/settings.json`** permissions (`ask`/`deny` lists mirroring the gate, **plus an
   `allow` list of the project's read-only / verification commands** so agents don't stall on
   permission prompts — including mid-workflow, where nobody is watching a prompt: the detected
   per-surface `test_cmd`/`lint_cmd`/`typecheck_cmd`/`build_cmd` **and their `*_quiet_cmd`
   variants** and repo-wide `commands.*` equivalents as `Bash(<cmd>:*)` rules, plus read-only git —
   `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git rev-parse:*)` — plus the
   shipped pipeline scripts (`Bash(<core>/pipeline/scripts/:*)` — preflight, kanban-move;
   a prefix rule matches a command *starting* with that path, so a `bash <path>`
   invocation would need its own entry), and the
   retrieval provider's MCP tools when wired (e.g. `mcp__serena`). Never allowlist anything matching
   a `gate.ask`/`gate.deny` pattern. Mention the human can widen it later with
   `/fewer-permission-prompts`) + the PostToolUse formatter hook (detected formatter). Do **not**
   write the gate hook here — step 9 (`<sync>`) registers it.
   Preserve any existing custom keys.
6. **Wire the retrieval provider** (skip if `retrieval.provider: none`):
   - **serena:** if the `serena` CLI is missing, have the human install it (`uv tool install -p 3.13
     serena-agent`) — or set the provider to `none` if they decline, and say `/cohorte-update-pipeline` can wire
     it later. If the binary exists (e.g. `~/.local/bin/serena`) but `command -v serena` fails,
     recommend the PATH fix (`uv tool update-shell`, or add `~/.local/bin` to the shell profile) for
     CLI use. Then register at **project scope** (committed `.mcp.json`, portable —
     `--project-from-cwd` resolves the project at server start) using the **PATH-proof launcher**
     from `<core>/pipeline/schema/retrieval.md` (`sh -c 'exec "$(command -v serena || echo
     "$HOME/.local/bin/serena")" start-mcp-server …'` — a bare `serena` entry dies with ENOENT when
     Claude Code was launched from an environment without `~/.local/bin` on PATH; Windows-native
     teams use the bare form + PATH instead). If `.mcp.json` already has a bare `serena` entry,
     upgrade it to the launcher form rather than skipping. Add `.serena/` to the repo's `.gitignore`
     (per-machine cache/config Serena creates on first launch). On a large repo, offer the one-off
     `serena project index`. Finish with the **health check** from `<core>/pipeline/schema/retrieval.md` and
     report each result — if the static checks pass but the server isn't connected in this session,
     say a session restart is needed; never report Serena wired on registration alone.
   - **graphify:** have the human install it (`uv tool install graphify` then `graphify install`),
     build the initial graph (`/graphify .`), and note it needs incremental rescans (`--update`) after
     big changes.
   - Either way the rendered agents already carry the provider's MCP tools in their `tools:` list
     (step 3 / `<core>/pipeline/schema/rendering.md`); remind the human the new MCP server appears after a session restart.
7. **Render the isolation scripts** (if `isolation.enabled`) from the installer's
   `pipeline/scripts/*.template` to this repo's `scripts/new-feature.sh` and `scripts/remove-feature.sh`,
   substituting the `__TOKENS__` (project
   slug, DB pattern, port bases, compose file, branch prefix, install/dev/migrate commands, per-surface
   env stanzas). `chmod +x` them. If isolation is disabled, skip and note features build in the main checkout.
8. **Wire the project: run `<sync>`** from the repo root (one Bash call) and show its output. It is
   deterministic and idempotent: it copies the gate to `.claude/hooks/cohorte-gate.py`, registers it
   in `.claude/settings.json` (matchers `Bash|Task|Agent` and `Write|Edit|MultiEdit`, exactly once,
   every other hook kept), writes the `<state>/pipeline.json` pointer, adds
   `<state>/preflight.ok`, `<state>/pipeline-metrics.jsonl` and `specs/reports/` to `.gitignore`, and
   seeds `specs/_template.md`. If it exits non-zero (e.g. `.claude/settings.json` is not valid JSON),
   stop and show the error — never hand-write those files instead. If `<state>/preflight.ok` is
   already tracked: `git rm --cached <state>/preflight.ok`.
9. **Tell the human what to commit:** `PIPELINE.md`, `<agents>/`, `<state>/gate-config.json`,
   `<state>/settings.json`, `.claude/hooks/cohorte-gate.py`, `<state>/pipeline.json`, `.gitignore`,
   `<memory>`. A teammate who clones gets the gate immediately; they need `npm i -g cohorte &&
   cohorte install` only for the commands.
10. **CI workflow** (if `vcs.host: github` and no existing workflow already runs the profile's
    checks): with the human's go-ahead, generate `.github/workflows/pipeline-ci.yml` — on
    `pull_request` to `<default_branch>`: checkout, set up the `package_manager` toolchain,
    `commands.install`, then `commands.lint` · `commands.typecheck` · `commands.test` (+ per-surface
    `build_cmd`s that are non-empty). Derive the setup steps from the detected stack — mirror what a
    sibling workflow does if one exists. `/cohorte-ship` watches these checks before the merge.
11. **Design system:** if `design.enabled` with a snapshot dir, note that `/cohorte-align-ds` is active; else the
    `/cohorte-align-ds` command will no-op with a clear message.
12. **Kanban** (only if the human opted in at Phase 2): wire it per `<core>/pipeline/schema/kanban.md`, writing into the
    **global** `<config>` (never into this repo — the board points at a
    personal vault). Create the file from `pipeline/cohorte.config.template.yaml` if absent; set
    `kanban.enabled: true` and `obsidian.vault_path` if it was empty. Add a `kanban.boards[<PIPELINE
    name>]` entry with `board: <folder>/Tasks.md`. Then **create the board file**
    `<vault>/<folder>/Tasks.md` (per §Kanban) if it doesn't exist — one column per `kanban.columns`
    stage, in pipeline order. Finally run the §Kanban backfill so any spec already in `specs/` lands on
    the board. Report the board path + the `obsidian://` URI. Skip silently if the human declined.
