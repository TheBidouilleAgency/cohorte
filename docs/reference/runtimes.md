# Runtimes — running cohorte outside Claude Code

Cohorte's doctrine is one set of source prompts in `core/commands/` and `core/agents/`. The
installer **renders** them for whichever coding agent you use: it rewrites the surface (markdown +
frontmatter, plain markdown, or TOML), resolves every path, registers the gate in that runtime's own
hook format, and branches the instructions on what it can actually enforce.

```sh
cohorte install --runtime=codex,cursor     # pick explicitly
cohorte install --all-runtimes             # every supported one
cohorte install                            # detects what you have and asks
```

With no flag and no TTY the installer targets Claude Code alone, which is what every version before
2.2.0 did.

## Support matrix

| | Commands | Invoked | Arguments | Subagents | Gate hook | Workflows |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude Code** | `.claude/commands/*.md` | `/name` | `$ARGUMENTS` | `.claude/agents/*.md` | `PreToolUse`, deny + **ask** | ✅ |
| **Codex CLI** | `.agents/skills/<name>/SKILL.md` | `$name` | trailing text | `.codex/agents/*.toml` | `PreToolUse`, deny only | — |
| **Cursor** | `.cursor/commands/*.md` | `/name` | trailing text | `.cursor/agents/*.md` | `beforeShellExecution`, deny + **ask** | — |
| **Gemini CLI** | `.gemini/commands/*.toml` | `/name` | `{{args}}` | `.gemini/agents/*.md` | `BeforeTool`, deny only | — |
| **OpenCode** | `.opencode/commands/*.md` | `/name` | `$ARGUMENTS` | `.opencode/agents/*.md` | none — advisory `--check` | — |

Sources: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) · [skills](https://learn.chatgpt.com/docs/build-skills),
[Cursor CLI](https://cursor.com/docs/cli/overview) · [subagents](https://cursor.com/docs/subagents),
[Gemini CLI](https://geminicli.com/docs/) · [hooks](https://geminicli.com/docs/hooks/reference/),
[OpenCode](https://opencode.ai/docs/cli/).

**Codex ships as skills, not prompts.** Custom prompts (`~/.codex/prompts`) are deprecated *and*
user-scoped only — a teammate cloning the repo would get `PIPELINE.md` and the profile but none of
the commands, which defeats the point of committing the profile. Skills are discovered from
`.agents/skills` in the repo, so they travel with it; commit that directory alongside `PIPELINE.md`.
They are invoked as `$cohorte-build`, or picked implicitly when the task matches the skill's
`description`.

**Codex scope:** `cohorte install --global --runtime=codex` shares the core, skills and
generic `review`/`release`/`profile-reader` agents. Surface agents generated from a project's
`PIPELINE.md` always live in that project's `.codex/agents/*.toml`. A project install puts
the generic agents there too. Keep the normal user `CODEX_HOME`; no project launcher or
authentication symlink is needed. Codex discovers project agents natively.
[Custom-agent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Initialization and reconciliation use `.codex/config.toml` for project MCP servers, preserving
existing configuration. They do not generate Claude's `.claude/settings.json` permissions or
a standalone `.mcp.json`. Restart the client after changes and verify MCP connectivity and hook
trust; files on disk alone do not prove the client loaded them.

Codex skills and Cursor commands perform **no** placeholder substitution — the rendered preamble
tells the model that `$ARGUMENTS` means the text you typed after the command name.

## The gate, in four dialects

`gate.py` is the one component that can refuse a command. Four runtimes can host it as a real
blocking hook; the installer registers it in the right file and passes `--runtime <id>` so the
script emits the envelope that runtime understands:

| Runtime | Config file | Event | Envelope |
| --- | --- | --- | --- |
| Claude Code | `settings.json` | `PreToolUse` | `hookSpecificOutput.permissionDecision` |
| Codex CLI | `.codex/hooks.json` | `PreToolUse` | same, but `ask` is parsed and **ignored** |
| Cursor | `.cursor/hooks.json` | `beforeShellExecution` | `{"permission", "user_message", "agent_message"}` |
| Gemini CLI | `.gemini/settings.json` | `BeforeTool` | `{"decision", "reason"}` |

An envelope in the wrong shape is read as *allow* by every one of them, which is why each dialect is
covered by `scripts/test-gate.mjs` rather than trusted.

**Where there is no `ask` tier — Codex and Gemini — an `ask` verdict is escalated to `deny`**, with
the reason attached. The point of that tier is that a human sees the command before it runs; a
runtime that cannot ask cannot deliver it, so the honest translation is to refuse and let you re-run
deliberately. It is the same rule the pipeline already applied to unattended headless runs.

OpenCode extends via plugins, which is not a blocking hook contract. There the rendered commands
call the gate themselves:

```sh
python3 <core>/hooks/gate.py --check "git push --force"   # exit 0 allow · 1 ask · 2 deny
python3 <core>/hooks/gate.py --check-dispatch review      # the preflight phase gate
```

Same config, same patterns, same verdicts — but advisory, because an agent can decline to call it.
`/cohorte-doctor` reports it as `advisory` rather than ✅.

The phase gate (no reviewer dispatch onto red code) also has to survive the differences: Claude Code
and Cursor send a `Task` tool carrying `subagent_type`, while Gemini exposes each subagent as a tool
of the **same name**, so the dispatch arrives as `tool_name: review`. Codex uses `spawn_agent`
(matcher alias `Agent`) with `tool_input.agent_type`. The Codex registration covers shell and
dispatch calls; the gate normalizes all these forms before checking the preflight stamp.

## What does not travel

**Model pins.** The profile names Anthropic aliases (`sonnet`, `haiku`). They are meaningless to the
other vendors and would either error or be silently ignored, so the adapter drops them: agents and
commands inherit that runtime's own model selection. `/cohorte-doctor`'s model-pin check is
Claude-specific for those aliases. Codex profiles default to `inherit`; explicit Codex `model`
and `model_reasoning_effort` values are preserved when rendering agents.

**Read-only enforcement, in one case.** The reviewer must never be able to fix what it reports.
Claude expresses that as a `tools:` list without write tools, Cursor as `readonly: true`, Codex as
`sandbox_mode = "read-only"` — all derived automatically from the source agent. Gemini and OpenCode
have no equivalent the adapter can safely generate, so the rendered reviewer instead carries an
explicit instruction that read-only is on it, and says why: a reviewer that fixes what it finds
destroys the evidence the fix loop runs on.

**Workflows.** The deterministic orchestration scripts (`review.js`, `audit.js`, `refactor.js`, `loop.js`) need
Claude Code's Workflow engine. They are not installed elsewhere and the workflow-variant notes are
stripped from the rendered commands — the conversational path is the default everywhere anyway.

## Requirements

**Real subagents are mandatory.** The pipeline's isolation guarantee *is* the subagent boundary:
each surface is built by someone who can only see the frozen contract, so no surface can quietly
depend on another's reasoning. Without them the lead does every surface in one context and that
property is gone.

A sequential-persona fallback existed briefly — the lead adopting one agent file at a time and
dropping it before the next — and was removed. It asked the lead to simulate the boundary by
discipline, which is not the same guarantee, and no supported runtime ever took the branch. A
runtime declaring `subagents: false` is now **refused at install** with a named error rather than
rendered into a pipeline whose central promise is silently absent.

## Layout on disk

| Token | Claude Code | Other runtimes |
| --- | --- | --- |
| `<core>` (rendered assets) | `.claude/` or `~/.claude/` | `.cohorte/<id>/` or `~/.cohorte/<id>/` |
| `<state>` (generated per project) | `.claude/` | `.cohorte/` |
| `<config>` (user-level) | `~/.claude/cohorte.config.yaml` | `~/.cohorte/cohorte.config.yaml` |
| `<memory>` (project instructions) | `CLAUDE.md` | `AGENTS.md` / `GEMINI.md` |

Each runtime gets its **own** core, because the same template resolves differently depending on that
agent's capabilities. The **state** is deliberately shared: it describes the project — one gate
config, one preflight stamp, one metrics log — so a repo driven from two agents cannot disagree with
itself about what is gated and what has been verified. The user config is shared too; the shipped
scripts probe `~/.claude` then `~/.cohorte`, so you keep one kanban board across all of them.

`<core>/pipeline/runtimes.json` records every runtime installed against that core; `/cohorte-doctor`
reads it and reports what the current one can and cannot enforce.

## Adding a runtime

Drop a JSON file in `core/runtimes/`. It declares the install paths per scope, the command and agent
formats, the hook contract, its capabilities, and any command that must not be installed. Nothing
else in the codebase needs to change — `scripts/test-adapter.mjs` picks the new file up
automatically and asserts that every source prompt renders for it.

Capability conditionals in the source prompts use HTML comments, so the neutral file stays readable
markdown:

```markdown
<!-- cohorte:if hooks -->
The gate fires whether or not you cooperate.
<!-- cohorte:else -->
Run `gate.py --check` yourself before any gated command.
<!-- cohorte:endif -->
```

Terms are capability names (`hooks`, `workflows`, `mcp`, `tool_restriction` — not `subagents`,
which is a precondition rather than a branch),
`runtime:<id>`, or either negated with `!`. Several terms in one condition are an OR. An unknown
term is a hard error at install time rather than a silently-false branch.
