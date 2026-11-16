# Gate & permissions

Autonomous agents running Bash need guardrails that don't depend on the model's good behavior.
Cohorte layers three mechanisms, all generated from the profile. None of them is a sandbox:
together they are a strong guard against **agent mistakes** on the common forms of dangerous
commands. The real boundary for the remote is **GitHub branch protection** on the default
branch: no force push, no deletion, required reviews and checks. Turn it on.

## `cohorte-gate.py` — the blocking PreToolUse hook

The installer copies `core/hooks/gate.py` into each project as `.claude/hooks/cohorte-gate.py`
and registers it in the project's `.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash|Task|Agent", "hooks": [
  { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py\"" }
] } ] } }
```

It reads the PreToolUse payload on stdin and answers with Claude Code's
`hookSpecificOutput.permissionDecision` (`ask` or `deny`, exit 0), or stays silent (allow). It
handles `Bash`, the subagent tool under either name (`Task` or `Agent`), and, if they are ever
routed to it, `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. It uses only the standard library and
needs Python ≥ 3.8.

### When it acts

| Project state | Behavior |
| --- | --- |
| No `.claude/pipeline.json` pointer and no `gate-config.json` | **Inert.** Every call is allowed silently, so the hook is harmless in a non-Cohorte repo. |
| Pointer present, no `gate-config.json` | The **hard floor** and **self-protection** apply. |
| `gate-config.json` present | Floor + self-protection + the project's `deny` / `ask` / `ask_on_default_branch` rules + the preflight phase gate. |
| `gate-config.json` invalid (bad JSON, wrong types) | Floor and self-protection still **deny**. Every other Bash command and every subagent dispatch gets **ask** until the file is fixed. The reason quotes the problem. |

The project is found from `$CLAUDE_PROJECT_DIR`, from the git toplevel of the payload's `cwd`
(so a subdirectory works), and from the main checkout of a linked worktree. When these
differ, the rules of all of them are combined. The config is `.claude/gate-config.json`. The
legacy `.cohorte/gate-config.json` is still read, and when both exist their lists are combined.

### The hard floor (always on in a Cohorte project)

A `git push` that **forces or deletes** and whose **destination** is the default branch is
denied, whatever the config says. It does not matter which branch is checked out. "Forces"
covers all of these:

- `-f`, `--force`, `--force-with-lease[=…]`, `--force-if-includes`. **Force-with-lease is
  treated as force.**
- abbreviations git accepts (`--forc`) and combined short flags (`-uf`, `-fu`)
- `--mirror`, `--delete` / `-d`
- refspecs starting with `+` (`+main`, `+feat:main`) or `:` (`:main`)

The destination comes from explicit `src:dst` / `dst` refspecs (`refs/heads/…` included),
`HEAD`, and for a bare `git push` the current branch with its `@{push}`/`@{upstream}`. `--all`
and `--mirror` count as reaching the default branch, and so does `push.default=matching`. The
default branch is `default_branch` from the config. Without one, it is `origin/HEAD` plus `main`
and `master`.

A force push whose destination can't be resolved gets **ask**: `"$BRANCH"`, a detached HEAD,
`remote.*.push` config. Force-pushing your own feature branch after a rebase stays free.

### Self-protection

The agent must not be able to switch the gate off. In a Cohorte project, a Bash command that
writes, moves, truncates or deletes one of these files is **denied**:

- `.claude/gate-config.json`, `.claude/preflight.ok`, `.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/hooks/cohorte-gate.py`
- `.cohorte/gate-config.json`
- `~/.claude/settings.json`, `~/.claude/settings.local.json`

The same goes for deleting `.claude/pipeline.json`, or any directory that contains one of
these files (`rm -r .claude`, `find . -delete`, `rm -rf ~`).

These operations are covered:

- redirections (`>`, `>>`, `>|`, `&>`) and `tee`
- `cp`/`mv`/`ln`/`install`/`rsync`, including into a directory
- `rm`/`unlink`/`shred`, `truncate`, `dd of=`, `curl -o`/`wget -O`
- `sed -i`, `perl -pi`
- `git rm` (but not `git rm --cached`) and `git mv`
- `preflight.sh`'s report argument, which it truncates

Paths are resolved through `cd`, globs, `~`, `$HOME`, `$PWD` and `$CLAUDE_PROJECT_DIR`. A
target the gate can't resolve but that looks like one of these files gets **ask**. So do
`chmod`/`chown` on them and inline `python -c` / `node -e` code that mentions them.

Reading them (`cat`, `jq`) is free. `preflight.sh` itself is allowed to write the stamp, but a
direct `date +%s > .claude/preflight.ok` is not. A `Write`/`Edit`/`MultiEdit` aimed at one of
these files gets **ask**, which becomes **deny** in unattended modes (see below). This affects
`/cohorte-init-pipeline` and `/cohorte-update-pipeline` if the hook is ever registered for those
tools: run them interactively. Rules change through PIPELINE.md and
`/cohorte-update-pipeline`, never by editing the generated file from inside a run.

### Project rules — `gate-config.json`

Generated from the profile's `gate` block:

```json
{ "deny": ["node ace migration:fresh", "git push --force"],
  "ask": ["node ace migration:run", "psql"],
  "ask_on_default_branch": ["git commit", "git push", "git reset", "docker compose"],
  "default_branch": "main",
  "preflight": { "enabled": true, "agents": ["cohorte-review", "review"], "max_age_minutes": 30 } }
```

| Tier | Behavior |
| --- | --- |
| `deny` | Hard-blocked, on any branch. Deny wins over every ask anywhere in the chain. |
| `ask` | Confirmation prompt, on any branch. |
| `ask_on_default_branch` | Confirmation **only when the branch is the default branch or unknown**. Free on feature branches. For `git push`, a push whose **destination** is the default branch also counts. |

`deny`, `ask` and `ask_on_default_branch` must be lists of non-empty strings. A plain string
is read as a one-element list, with a warning on stderr, never character by character. Empty
strings are ignored with a warning. `default_branch` must be a string. `preflight` must be an
object: `enabled` a boolean, `agents` a list of strings, `max_age_minutes` a number ≥ 0. `0` is
respected: every stamp is stale. Anything else makes the config **invalid** (see the table
above).

#### How a pattern matches

The gate lexes commands the way a shell does, and **matches tokens, not substrings**. The
command is split on `;`, `&&`, `||`, `|`, `|&`, `&` and newlines, with quotes, escapes, `\`
continuations, comments and heredocs respected. In each simple command:

- leading `VAR=val`, `env [-i] [VAR=…]`, `command`, `builtin`, `exec`, `nice`, `time`,
  `nohup`, `timeout`, `sudo`, … are stripped
- the command's basename is lowercased: `GIT`, `/usr/bin/git`, `\git` and `"git"` are all `git`
- the pattern is lexed the same way. It matches when its command name is equal, its
  positional words appear in order at the start of the command's positional words, and
  each of its flags is present by meaning:
  - `rm -rf` matches `rm -fr`, `rm -r -f`, `rm -Rf` and `rm --recursive --force`
  - for git, global options (`-c k=v`, `-C dir`, `--git-dir=`, `--no-pager`, `-p`, …) are
    skipped to find the subcommand, aliases are expanded (configured ones, `-c alias.x=…`,
    and `git config alias.x …` earlier in the chain), and long options may be abbreviated
    (`git reset --ha`)
  - for `git push`, **any force form above satisfies a `-f`/`--force` pattern**, so one
    `git push --force` rule covers them all
- package runners are looked through: `prisma migrate reset` also matches `npx prisma migrate
  reset`, `pnpm exec …`, `yarn …`, `bunx …`, `uv run …`, `python -m …`

A pattern that contains a separator (`curl | sh`) matches a run of consecutive commands, each
matching its part and joined by the same separator (`curl -fsSL https://x | sh`).

This removes the old false positives. A deny pattern inside a quoted argument is not a
command, so all of these pass:

- `git commit -m "why git push -f is banned"`
- `grep "git push -f"`
- heredoc bodies written to a file
- the commit-message form `git commit -m "$(cat <<'EOF' … EOF)"`

#### Indirection

The gate follows indirection when the inner text is static:

- `sh`/`bash`/`zsh -c '…'`
- `bash <<EOF … EOF`, `bash <<< '…'`
- `echo '…' | sh`, `printf '…' | sh`
- `eval "…"`
- `$(…)` and backticks, judged on their own
- `find -exec`, `xargs`, `watch`, `timeout`, `env -S`
- `alias x='…'`
- `preflight.sh`'s check commands, which it runs through `sh -c`

Some cases can't be judged statically:

- a computed command name (`$x push`)
- `… | base64 -d | sh`
- `eval "$CMD"`
- running or sourcing a file written earlier in the same command
- inline `python -c` / `node -e` / `perl -e` code that starts processes
- `git push` with run-time arguments

For these, a deny pattern found in the raw hidden text is a **deny**. Otherwise they get
**ask**, but only when there is something to protect: deny/ask rules exist, or (floor only)
the hidden text mentions git. A command the gate can't parse at all (an unbalanced quote) is
handled the same way. It is never a crash and never a silent allow.

#### Branch resolution

The branch is read with `git symbolic-ref -q --short HEAD` at the directory the command runs
in. A **detached HEAD** is unknown, and unknown is gated. A plain `cd <dir>` chained with `&&`
or `;` is followed, so `cd ../feature-worktree && git commit` is judged there. A `cd` is never
followed through a pipe.

The branch becomes unknown for the rest of the chain after any of these:

- `git checkout <branch>` or `git switch` (a file checkout `git checkout -- f` does not count)
- `git bisect`, `git branch -m`
- `pushd`/`popd`, `cd -`, `cd $OLDPWD`, a `cd` that can't be resolved, `cd … ||`
- a subshell `( … )`
- `git -C`, `--git-dir`/`--work-tree`, `GIT_DIR`/`GIT_WORK_TREE` (assigned or exported)

### Permission modes

| `permission_mode` | An `ask` verdict becomes |
| --- | --- |
| `default`, `acceptEdits`, `plan`, absent | `ask` (a human confirms) |
| `bypassPermissions`, `dontAsk` | **`deny`**, with the reason attached. Nobody can answer the prompt, and a clear refusal beats a prompt that silently auto-resolves. |

The hook fires for every agent in the session: the lead, `/cohorte-build`'s implementers, and
Workflow subagents. Those run in `acceptEdits`, which does not auto-approve Bash or subagent
dispatches.

### Failing closed

In an active project, these cases are **denied** with a reason (JSON, exit 0):

- a Bash/Task/Agent payload that can't be evaluated (non-object `tool_input`, non-string
  `command`, missing `tool_name`, an internal error)
- unparseable stdin that still looks like a tool call

Stdin that is not a tool call at all is ignored. Every git call draws on one time budget
(6 s), and an exhausted budget answers **ask**, never allow. The installer registers the hook
with `"onFailure": "block"`, so a crash or timeout also blocks. What the hook can't cover: if
`python3` itself is missing, Claude Code reports a hook error instead of a verdict. That is
`/cohorte-doctor`'s job to catch.

### `--check` mode

For scripts and humans:

```
cohorte-gate.py --check [--cwd DIR] [--unattended] [--] <command…>
cohorte-gate.py --check-dispatch [--cwd DIR] [--unattended] [--] <subagent_type>
```

It prints one line (`gate: allow` / `gate: ask — …` / `gate: deny — …`) and exits 0 / 1 / 2,
so `&&` stops on anything but a clean allow. `--unattended` escalates ask to deny. Options are
only read before the command (or before `--`): a `--cwd=` or `--unattended` inside the command
is part of the command. Pass the command as one quoted string; several arguments are re-quoted.
A legacy `--runtime claude` argument is accepted and ignored.

### What it does not guarantee

- **Scripts on disk are not inspected.** `./release.sh`, `npm run deploy`, `make nuke` and a
  git alias defined in a file the gate can't read all run whatever they contain.
- **Other tools are out of scope.** `gh api -X DELETE …`, `ssh host git push -f`, and API
  calls from inline code that builds argv lists the gate can't see all get past it.
- **The stamp can be faked.** `preflight.sh r.txt true` produces a valid stamp without
  running a real check, and so does computing the digest by hand. The phase gate enforces
  ordering, not honesty.
- **It is static analysis**, deliberately conservative where it can't decide. Expect an
  occasional confirmation prompt on an exotic but legitimate command.

Branch protection on the remote, and human review before `/cohorte-ship`, remain the real
boundaries.

## The preflight phase gate

The `preflight` block of `gate-config.json` makes the gate enforce **pipeline ordering**, not
just command safety. A `Task`/`Agent` dispatch of a listed `subagent_type` needs a fresh
`.claude/preflight.ok` stamp. The default list is `["cohorte-review", "review"]`, and a
namespaced `plugin:cohorte-review` also matches. The stamp is written by
`<core>/pipeline/scripts/preflight.sh` only when typecheck + lint + tests are green.

The stamp is `<epoch> <HEAD sha> <tree digest>`. It is accepted only when all of these hold:

- it has **three fields** with a real digest whenever the dispatch runs in a git checkout. A
  bare `date +%s` or a pre-2.0 `<epoch> <sha>` stamp is rejected.
- its epoch is not in the future (more than 60 s ahead is rejected) and not older than
  `max_age_minutes` (default 30)
- its digest equals the **dispatch checkout's own** content digest, at its toplevel or at
  the dispatch cwd

The digest is the git tree id of the working tree, with `.claude/` and `specs/` excluded,
computed in a throwaway index. Committing verified code keeps the stamp valid, and any real
edit (including a new untracked file) invalidates it. Because the digest is content-addressed
and compared only against the dispatching checkout, a green stamp from one worktree can't
green a review dispatched from another checkout with different content.

If anything fails, the dispatch gets **ask** (deny in unattended modes): the lead can't
accidentally review red code, and a human can consciously override. A config without the
block skips the phase gate.

## `settings.json` permissions

`/cohorte-init-pipeline` writes the repo's `.claude/settings.json`:

- **`ask`/`deny` rules** mirroring the gate patterns. This is defense in depth: the hook
  catches the chained and obfuscated forms the rules miss, and the rules still apply if the
  hook is unregistered.
- **An `allow` list**, so agents never stall on prompts for read-only or verification work,
  even mid-workflow where nobody is watching. It covers:
  - the per-surface `test/lint/typecheck/build` commands and their quiet variants, and
    repo-wide equivalents
  - read-only git (`status`, `diff`, `log`, `rev-parse`)
  - the shipped `pipeline/scripts/*.sh`
  - the retrieval provider's MCP tools

  Nothing matching a `gate.ask`/`gate.deny` pattern is ever allowlisted.
- **The PreToolUse gate hook** (above) and the PostToolUse formatter.

`/cohorte-update-pipeline` patches all of this **additively**: it adds missing entries and
never removes or rewrites your custom keys. `/cohorte-doctor` flags drift between the profile's
gate block and `gate-config.json`, as well as double hook registrations.

## Division-of-labor rules the agents themselves enforce

Beyond the mechanical gate, the agent instructions carry hard rules the pipeline depends on:

- Implementers never edit the frozen **contract** (a mismatch is reported, never fixed) and
  never touch another surface's tree.
- Migrations are **append-only** everywhere. `gate.deny` commands are never run, even if the
  hook were absent.
- The `cohorte-release` agent never edits source, never force-pushes, and refuses staged
  secrets.
- `/cohorte-align-ds` uses DesignSync strictly read-only: never write, delete or finalize on a
  curated design system.
- `/cohorte-ship` is the only outward-facing step, and it always waits for an explicit human yes.
