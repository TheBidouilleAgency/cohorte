# /cohorte-init-pipeline · 04 Write & render

### Phase 4 — Write & render (after go-ahead)

1. **Write `PIPELINE.md`** at the repo root (source: the installer's `pipeline/PIPELINE.template.md`).
2. **Wire it into `<memory>`:** if `<memory>` exists, ensure it references the profile (add a line
<!-- cohorte:if runtime:codex -->
   near the top: `Read PIPELINE.md for the project profile and pipeline rules before pipeline work.`).
   If absent, create `AGENTS.md` with that instruction and a one-paragraph project intro.
<!-- cohorte:else -->
   near the top: `> Project profile & pipeline facts: **@PIPELINE.md**`). If not, create a minimal
   `<memory>` with that reference + a one-paragraph project intro.
<!-- cohorte:endif -->
3. **Render one agent per surface** — for each surface, follow SCHEMA.md §"Rendering / reconciling a
   surface agent" (steps 2–3): render `<agents>/<agent>.md` from the installer's
   `pipeline/implementer.template.md`, substituting `<SURFACE_AGENT>`, `<SURFACE_LABEL>`, `<SURFACE_PATH>`,
   `<SURFACE_TOOLS>`, `<SURFACE_MODEL>`, `<PROJECT_NAME>`, `<SURFACE_CONVENTIONS>` (the surface's
   baked convention slice — §Shared + its `### Surface:` stanza + its §Testing lines from the
   PIPELINE.md you just wrote), and the surface-specific blocks
   (`<SURFACE_EXTRA_NEVER>`, `<SURFACE_DESIGN_INPUT>`, `<SURFACE_TDD_STEP1>` — fill design-related ones
   only when `uses_design`).
   Leave the fixed agents as-is (generic, shipped by the installer under `<fixed-agents>/`).
<!-- cohorte:if runtime:codex -->
   Write `.codex/agents/<agent>.toml` in this project even when the core is global. Preserve
   TOML syntax when substituting the template; parse every result before dispatch. Each file
   needs `name`, `description`, and `developer_instructions`. Omit `model` for `inherit` or
   legacy `sonnet`/`haiku` profiles; preserve an explicitly selected Codex model and reasoning
   effort. Do not add Claude `tools:` frontmatter. Codex discovers these project files natively:
   leave the user's `CODEX_HOME` unchanged and do not create a dedicated launcher or auth symlink.
<!-- cohorte:endif -->
4. **Generate `<state>/gate-config.json`** from the `gate` block — copy all five keys verbatim:
   `{"deny": [...], "ask": [...], "ask_on_default_branch": [...], "default_branch": "<vcs.default_branch>",
   "preflight": {"enabled": <gate.preflight.enabled>, "agents": [...], "max_age_minutes": <n>}}`
   (profile has no `preflight` block ⇒ omit the key — the hook then skips the phase gate).
<!-- cohorte:if runtime:codex -->
5. **Codex configuration.** Preserve `.codex/config.toml` and the user's configuration.
   The installer registers `PreToolUse` in the selected scope's `hooks.json`; verify exactly
   one Cohorte hook covering `Bash|shell|spawn_agent|Agent` with `--runtime codex`.
   In global mode do not duplicate it locally. In project mode use `.codex/hooks.json`.
   Check the hook is enabled/trusted in this client; a file alone does not prove enforcement.
   Never write `.claude/settings.json` or Claude `Bash(...)` permission rules for Codex.
   `ask` rules become `deny` in this hook; explain this stricter behavior.
<!-- cohorte:else -->
<!-- cohorte:if hooks -->
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
   `/fewer-permission-prompts`) + the hooks, **conditioned on the install mode:**
   - **bundled:** register the PreToolUse hook `<core>/hooks/gate.py` with matcher `Bash|Task`
     (Task is required — the preflight phase gate keys off Task dispatches; a `Bash`-only matcher
     leaves it dead) and the PostToolUse formatter (detected formatter). Before adding, drop any
     existing PreToolUse entry whose command ends in `gate.py` (here AND in `~/.claude/settings.json`
     if one points at this repo's copy) — exactly one registration must survive, or every gated
     command prompts twice.
   - **global:** the PreToolUse gate hook is
     already in `~/.claude/settings.json` and reads this repo's `gate-config.json` — do **not** re-register
     it here (double-registration double-prompts). It no-ops where its config is absent, so one
     registration serves every repo; you only supply this repo's `gate-config.json`. Still write the
     PostToolUse formatter hook + the permissions.
   Preserve any existing custom keys.
<!-- cohorte:else -->
5. **No permissions or hook file to write.** This runtime has neither a PreToolUse hook nor a
   settings.json permission model the pipeline can generate, so the gate is enforced by the
   commands calling `<core>/hooks/gate.py --check` at the points the profile marks gated. That
   means `<state>/gate-config.json` (step 4) is not decoration here — it is the ONLY place the
   deny/ask patterns live, so fill it from the profile exactly and do not skip it. If this repo is
   also driven from Claude Code, that install's hook reads the same file; nothing to duplicate.
<!-- cohorte:endif -->
<!-- cohorte:endif -->
6. **Wire the retrieval provider** (skip if `retrieval.provider: none`):
<!-- cohorte:if runtime:codex -->
   Follow SCHEMA.md §Code retrieval's Codex procedure: merge `[mcp_servers.serena]` into the
   project's `.codex/config.toml`, preserve other settings, gitignore `.serena/`, then check
   CLI availability, registration and actual session connectivity. Do not write a standalone
   `.mcp.json` or run `claude mcp add`. Missing connectivity requires a restart/diagnosis,
   not a claim that registration succeeded end to end.
<!-- cohorte:else -->
   - **serena:** if the `serena` CLI is missing, have the human install it (`uv tool install -p 3.13
     serena-agent`) — or set the provider to `none` if they decline, and say `/cohorte-update-pipeline` can wire
     it later. If the binary exists (e.g. `~/.local/bin/serena`) but `command -v serena` fails,
     recommend the PATH fix (`uv tool update-shell`, or add `~/.local/bin` to the shell profile) for
     CLI use. Then register at **project scope** (committed `.mcp.json`, portable —
     `--project-from-cwd` resolves the project at server start) using the **PATH-proof launcher**
     from SCHEMA.md §Code retrieval (`sh -c 'exec "$(command -v serena || echo
     "$HOME/.local/bin/serena")" start-mcp-server …'` — a bare `serena` entry dies with ENOENT when
     Claude Code was launched from an environment without `~/.local/bin` on PATH; Windows-native
     teams use the bare form + PATH instead). If `.mcp.json` already has a bare `serena` entry,
     upgrade it to the launcher form rather than skipping. Add `.serena/` to the repo's `.gitignore`
     (per-machine cache/config Serena creates on first launch). On a large repo, offer the one-off
     `serena project index`. Finish with the **health check** from SCHEMA.md §Code retrieval and
     report each result — if the static checks pass but the server isn't connected in this session,
     say a session restart is needed; never report Serena wired on registration alone.
   - **graphify:** have the human install it (`uv tool install graphify` then `graphify install`),
     build the initial graph (`/graphify .`), and note it needs incremental rescans (`--update`) after
     big changes.
   - Either way the rendered agents already carry the provider's MCP tools in their `tools:` list
     (step 3 / SCHEMA §Rendering); remind the human the new MCP server appears after a session restart.
<!-- cohorte:endif -->
7. **Render the isolation scripts** (if `isolation.enabled`) from the installer's
   `pipeline/scripts/*.template` to this repo's `scripts/new-feature.sh` and `scripts/remove-feature.sh`,
   substituting the `__TOKENS__` (project
   slug, DB pattern, port bases, compose file, branch prefix, install/dev/migrate commands, per-surface
   env stanzas). `chmod +x` them. If isolation is disabled, skip and note features build in the main checkout.
8. **Ensure `specs/_template.md`** exists (copy from the installer's `templates/spec.template.md` if missing).
9. **Write the pointer** `<state>/pipeline.json` (committed — this is how a teammate who clones the repo
   knows which core to install):
   `{ "pipeline": "cohorte", "mode": "<bundled|global>", "core_version": "<contents of the
   installer's pipeline/VERSION>", "install": "<per mode: bundled ⇒ \"npm i -g cohorte && cohorte install\"
   note that the core is committed under .claude/; global ⇒ \"npm i -g cohorte && cohorte install --global\"
   (or, without npm: curl -fsSL https://raw.githubusercontent.com/TheBidouilleAgency/cohorte/main/install.sh | sh -s -- --global;
   Windows: install.ps1 -Global from the same repo)> " }`.
   In **global** mode also add, near the top of `<memory>`, a one-liner:
   `> Pipeline: global core — run the installer above if /cohorte-brainstorm etc. are missing.`
10. **CI workflow** (if `vcs.host: github` and no existing workflow already runs the profile's
    checks): with the human's go-ahead, generate `.github/workflows/pipeline-ci.yml` — on
    `pull_request` to `<default_branch>`: checkout, set up the `package_manager` toolchain,
    `commands.install`, then `commands.lint` · `commands.typecheck` · `commands.test` (+ per-surface
    `build_cmd`s that are non-empty). Derive the setup steps from the detected stack — mirror what a
    sibling workflow does if one exists. `/cohorte-ship` watches these checks before the merge.
11. **Metrics sink, report buffer & preflight stamp:** add `<state>/pipeline-metrics.jsonl` to
    `.gitignore` — `/cohorte-build`, `/cohorte-review` and `/cohorte-fix` append per-dispatch evidence
    there (SCHEMA §Specialization reads it).
    Also add `specs/reports/` — `/cohorte-review` stages its last report there so a `/cohorte-fix` (or
    `/cohorte-spec` Mode B) survives a `/clear`; it's a derived buffer, not a versioned artifact.
    And `<state>/preflight.ok` — a local, per-checkout freshness stamp. Versioning it breaks the phase
    gate for good (a committed stamp describes the tree *before* its own commit, and it rides into every
    new worktree as a green nobody earned). If it is already tracked: `git rm --cached <state>/preflight.ok`.
12. **Design system:** if `design.enabled` with a snapshot dir, note that `/cohorte-align-ds` is active; else the
    `/cohorte-align-ds` command will no-op with a clear message.
13. **Kanban** (only if the human opted in at Phase 2): wire it per SCHEMA.md §Kanban, writing into the
    **global** `<config>` (never into this repo — the board points at a
    personal vault). Create the file from `pipeline/cohorte.config.template.yaml` if absent; set
    `kanban.enabled: true` and `obsidian.vault_path` if it was empty. Add a `kanban.boards[<PIPELINE
    name>]` entry with `board: <folder>/Tasks.md`. Then **create the board file**
    `<vault>/<folder>/Tasks.md` (per §Kanban) if it doesn't exist — one column per `kanban.columns`
    stage, in pipeline order. Finally run the §Kanban backfill so any spec already in `specs/` lands on
    the board. Report the board path + the `obsidian://` URI. Skip silently if the human declined.
