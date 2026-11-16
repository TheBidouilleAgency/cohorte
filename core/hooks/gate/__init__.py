"""Cohorte PreToolUse gate for Claude Code (3.0 — Claude Code only).

Installed per project as `.claude/hooks/cohorte-gate.py` and registered in the project's
`.claude/settings.json` as a PreToolUse hook:

    python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py"     matcher: Bash|Task|Agent
                                                                    and: Write|Edit|MultiEdit

It reads the PreToolUse payload on stdin and either stays silent (allow, exit 0) or prints
one `hookSpecificOutput.permissionDecision` of "ask" or "deny" (exit 0). Stdlib only,
Python >= 3.8.

What it does, in order of authority:

1. Inert outside Cohorte projects. With no `.claude/pipeline.json` pointer and no
   `gate-config.json` in the project, every call is allowed silently: this file can be
   registered somewhere that is not a Cohorte repo without changing anything.
2. Built-in hard floor (any Cohorte project, even with no gate-config.json): a force push
   or a remote deletion whose destination is the default branch is denied. "Force" covers
   `-f`, `--force`, `--force-with-lease[=…]`, `--force-if-includes`, abbreviations
   (`--forc`), combined short flags (`-uf`), `--mirror`, `--delete`/`-d`, and `+`/`:`
   refspecs.
3. Self-protection: a Bash command that writes, moves, truncates or deletes the files
   the gate depends on is denied (`.claude/gate-config.json`, `.claude/preflight.ok`,
   `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/cohorte-gate.py`,
   the legacy `.cohorte/gate-config.json`, `~/.claude/settings*.json`). The same applies to
   deleting `.claude/pipeline.json` or a directory that contains any of them. A
   Write/Edit/MultiEdit/NotebookEdit call aimed at one of them gets "ask".
4. Project rules from `.claude/gate-config.json` (`deny` / `ask` / `ask_on_default_branch`).
   These are matched as tokens, not substrings (see "Matching").
5. Preflight phase gate: a Task/Agent dispatch of a listed subagent needs a fresh
   `.claude/preflight.ok` stamp whose content digest equals the dispatch checkout's.
6. Surface ownership: a subagent (payload `agent_id`) whose `agent_type` is a surface agent
   of `.claude/profile.json` is denied a Write/Edit/MultiEdit/NotebookEdit outside its
   `surfaces[].path` (+ its `owns_also`, + `ownership.shared_writable`) and any write to the
   contract (`contract.path`/`contract.index`). Its Bash writes get the same check, best
   effort, through the self-protection target analysis (redirections, cp/mv/rm, tee, sed -i,
   …). The lead, the fixed cohorte-* agents and unknown agent types are not restricted; no
   profile.json or `ownership.enforce: false` ⇒ inert. Only targets inside a project
   checkout are judged.

Matching. The command is lexed like a shell does it: quotes, escapes, `\\`-newline
continuations, comments, heredocs (bodies are data unless fed to a shell), `$(…)`,
backticks, `<(…)`, subshells, redirections, and the separators `; && || | |& &` and newline.
Each simple command loses its prefixes (`VAR=val`, `env`, `command`, `builtin`, `exec`,
`nice`, `time`, `nohup`, `timeout`, `sudo`, …). Its basename is lowercased (`GIT`,
`/usr/bin/git`, `\\git` and `"git"` are all `git`). A pattern is lexed the same way. It
matches when its command name is equal and its positional words come, in order, at the
start of the command's positional words. Each of its flags must be present in the command,
compared by meaning: `-rf` = `-r -f` = `-fr` = `--recursive --force`. For git, global options
(`-c`, `-C`, `--git-dir`, `--no-pager`, …) are skipped, git aliases are expanded, and long
options can be abbreviated. For `git push`, every force form listed above satisfies a `-f`
or `--force` pattern. Package runners are looked through: `npx`/`pnpm exec`/`yarn`/
`bunx`/`uv run`/`python -m`… `prisma migrate reset` matches `prisma migrate reset`.

A pattern that itself contains a separator (`curl | sh`) matches a run of consecutive
commands that each match their part, joined by the same separator.

Indirection (`sh -c`, `bash <<EOF`, `eval`, `$(…)`, `| sh`, `source` of a just-written
file, inline `python -c`/`node -e` code that spawns processes, xargs, find -exec, git
aliases) is followed when the inner text is static. When it can't be judged statically,
the call gets "ask", but only if there are rules to protect (deny/ask patterns, or the
floor when the hidden text mentions git). A deny pattern found in the raw hidden text is a
deny.

Branch awareness. `ask_on_default_branch` patterns fire when the branch is the default
branch or unknown. The branch is unknown on a detached HEAD, outside a repo, after a
`cd` that can't be resolved, and for the rest of a chain after `git checkout`/`switch`,
`pushd`/`popd`, a subshell, `git -C`, or `GIT_DIR`/`GIT_WORK_TREE`. A plain `cd <dir>`
chained with `&&` or `;` is followed (never through `|`). For `git push`, the destination
also counts: `src:dst`, `HEAD`, the upstream/push target of a bare push, `--all`/`--mirror`.

Permission modes. In `bypassPermissions` and `dontAsk` nobody answers a prompt, so every
"ask" becomes a "deny" with the reason attached. `default`, `acceptEdits` and `plan` keep
"ask".

Fail closed. If the project is active and the payload is a Bash/Task/Agent call that
can't be evaluated (wrong types, internal error, unparseable JSON that still looks like a
tool call), the answer is "deny". A command the lexer can't parse (an unbalanced quote) is
not an internal error: it is denied if its raw text contains a deny pattern, and otherwise
gets "ask" when rules exist. When gate-config.json is invalid (unparseable or wrong types),
the floor and self-protection still deny, and every other Bash command and every dispatch
gets "ask" until the config is fixed.

Explicit mode, for scripts and humans:

    cohorte-gate.py --check [--cwd DIR] [--unattended] [--] <command…>
    cohorte-gate.py --check-dispatch [--cwd DIR] [--unattended] [--] <subagent_type>

It prints `gate: allow` / `gate: ask — …` / `gate: deny — …` and exits 0 / 1 / 2. Options
are only read before the command (or before `--`). A legacy `--runtime claude` argument is
accepted and ignored.

This is a strong guard against agent mistakes on the common forms, not a sandbox. A script
file that does a force push (`./release.sh`, `npm run x`, `make`) is not inspected. Branch
protection on the remote is the real boundary.
"""

# ── source layout ────────────────────────────────────────────────────────────
# core/hooks/gate/ is the gate's source; core/hooks/gate.py is GENERATED from it by
# `node scripts/build-gate.mjs` and committed: the installers and the npm package ship that one
# stdlib-only file, and nothing is built at install time. validate-core fails when the two
# disagree. The docstring above becomes gate.py's docstring; the comments here and each
# module's own docstring stay in the source tree.
#
# The builder concatenates the modules in the fixed order of MODULES in build-gate.mjs, so:
#   - a module's leading block holds its imports: `import <stdlib>` lines are hoisted to the top
#     of gate.py (deduplicated, sorted), `from .<module> import …` lines are stripped — they
#     record what the module uses, and may only name a module built before it;
#   - everything after that block is copied verbatim, and all modules share one namespace:
#     a top-level name must be defined in exactly one module;
#   - code that runs at import time (constants, `_START`) runs in build order.
# The Bash analyzer spans five modules: findings, rules, protect and indirect each hold one
# mixin class (methods only, no state of their own), and analyze — built last of them — composes
# them into `Analyzer`. A method name must be unique across the mixins and `Analyzer`.
# scripts/test-gate.mjs checks that the import lines are complete and accurate.
