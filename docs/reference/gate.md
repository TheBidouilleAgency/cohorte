# Gate & permissions

Autonomous agents running Bash need guardrails that don't depend on the model's good behavior.
Cohorte layers three mechanisms, all generated from the profile. None of them is a sandbox:
together they are a strong guard against **agent mistakes** on the common forms of dangerous
commands. The real boundary for the remote is **GitHub branch protection** on the default
branch: no force push, no deletion, required reviews and checks. Turn it on.

## `cohorte-gate.py` — the blocking PreToolUse hook

The installer copies `core/hooks/gate.py` into each project as `.claude/hooks/cohorte-gate.py`
and registers it in the project's `.claude/settings.json` (`gate.py` is a single stdlib-only file
built from the modules in `core/hooks/gate/` by `scripts/build-gate.mjs` — see
[scripts.md](scripts.md)):

```json
{ "hooks": { "PreToolUse": [
  { "matcher": "Bash|Task|Agent", "hooks": [
    { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py\"", "onFailure": "block" } ] },
  { "matcher": "Write|Edit|MultiEdit|NotebookEdit", "hooks": [
    { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py\"", "onFailure": "block" } ] }
] } }
```

It reads the PreToolUse payload on stdin and answers with Claude Code's
`hookSpecificOutput.permissionDecision` (`ask` or `deny`, exit 0), or stays silent (allow). It
handles `Bash`, the subagent tool under either name (`Task` or `Agent`), and
`Write`/`Edit`/`MultiEdit`/`NotebookEdit`. It uses only the standard library and needs Python ≥ 3.9.

With `gate.hook_form: exec` in the profile (for Windows teams without Git Bash), `cohorte sync`
writes the same registration without a shell — `"command": "python3", "args":
["${CLAUDE_PROJECT_DIR}/.claude/hooks/cohorte-gate.py"]` — and Claude Code substitutes the
placeholder itself. Verified on Claude Code 2.1.325; every teammate needs a recent client, since an
old one that ignores `args` would run a bare `python3`. `cohorte doctor` recognizes both forms.

### When it acts

| Project state | Behavior |
| --- | --- |
| No `.claude/pipeline.json` pointer and no `gate-config.json` | **Inert.** Every call is allowed silently, so the hook is harmless in a non-Cohorte repo. |
| Pointer present, no `gate-config.json` | The **hard floor** and **self-protection** apply. |
| `gate-config.json` present | Floor + self-protection + the project's `deny` / `ask` / `ask_on_default_branch` rules + the preflight phase gate. |
| `.claude/profile.json` present (any of the above) | Also **surface ownership** for surface subagents (below). |
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
these files gets **ask**, which becomes **deny** in unattended modes (see below). The hook is
registered for those tools, so this affects `/cohorte-init-pipeline` and `/cohorte-update-pipeline`
whenever they edit one of these files with Write/Edit rather than through `cohorte sync`. Run
them interactively. Rules change through PIPELINE.md and
`/cohorte-update-pipeline`, never by editing the generated file from inside a run.

### Surface ownership

Each surface's implementer owns one tree, `surfaces[].path`. The gate enforces this for edits;
it no longer relies on the agent and the reviewer to keep the boundary. The rules come from
`.claude/profile.json`, the parsed profile block that `cohorte sync` writes.

**Who is restricted.** A call made inside a subagent carries `agent_id` and `agent_type` in its
PreToolUse payload. `agent_type` is the agent's frontmatter `name`. When it equals a surface's
`agent` (or its `key` if `agent` is missing), that agent is restricted. Nobody else is:

- the lead (no `agent_id`, including a session started with `--agent`)
- the fixed `cohorte-review`, `cohorte-release` and `cohorte-profile-reader` agents
- any agent type that isn't a surface agent

**What it may write.** A surface agent may write, edit, move or delete files only under:

- its own `surfaces[].path`
- the entries of its optional `surfaces[].owns_also: []`
- the entries of the global `ownership.shared_writable: []` (lockfiles, for example)

Entries are relative to the checkout root. Each one is a file or directory, or a glob in which
`*` also matches `/` (`packages/*/package.json`).

The contract is **read-only** for every surface agent: `contract.path` and `contract.index`.
This holds even when the contract sits inside the agent's own tree or is listed in
`owns_also`. A profile with `contract.enabled: false` has no contract to protect.

| Tool | Enforcement |
| --- | --- |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | **Enforced.** A target outside the allowed paths is **denied**. The reason names the surface that owns it, or says the lead owns it. Paths are resolved with symlinks and `..` normalized, so `apps/api/../web` and `apps/api-v2` are not inside `apps/api`. `file_path`, `notebook_path` and per-edit `file_path`s are all checked. An edit call with no path the gate can find is denied. |
| `Bash` | **Best effort.** It reuses the self-protection target analysis: redirections, `tee`, `cp`/`mv`/`ln`/`install`/`rsync`, `rm`/`unlink`, `truncate`, `dd of=`, `curl -o`, `sed -i`/`perl -pi` on existing files, `git rm`/`git mv`, followed through `cd`, `sh -c`, `eval` and `$(…)`. A target it can't resolve statically is **allowed**, not asked about (`> "$OUT/x"`, a path after an unresolvable `cd`). So is everything a tool writes by itself: formatters, code generators, `npm install`, scripts. |

The surface path is resolved against the checkout the target lives in. A linked worktree (a
sibling directory, or one nested under the main checkout) is judged against its own root, as long
as it belongs to this project. Targets outside every project checkout are not judged at all:
`/dev/null`, `$TMPDIR`, files under `~`.

**Inert when:**

- `.claude/profile.json` is absent (a project that has never run `cohorte sync` since 3.1)
- it is unreadable, which also prints a warning on stderr
- `ownership.enforce: false` is set in the profile
- the agent's surface has no usable `path`

A deny stays a deny in every permission mode. The rule exists so that cross-surface work goes
through the lead: an implementer that needs a change in another tree, or in the contract, says
so in its handoff.

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
- container wrappers are looked through: a pattern is also tried at every later word of
  `docker`/`docker compose`/`podman`/`kubectl` (`docker compose exec api node ace …`,
  `kubectl exec pod -- psql`). `ssh host '<cmd>'` is analyzed as a remote command, with the
  branch unknown.
- a wrapper-only pattern (`sudo`, `env`) matches commands run through that wrapper
- a run-time word (`$X`, `$(…)`) can stand for any argument, so a pattern that might match
  gets **ask**. A double-quoted one (`"$f"`, `"$BRANCH"`) is a single word and is not assumed
  to hide a flag (`rm -f "$f"` passes an `rm -rf` rule), and nothing after `--` is a flag.

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
- **Other tools are out of scope.** `gh api -X DELETE …`, and inline code that builds argv
  lists the gate can't see (`subprocess.run(["git", "push", "-f"])` only gets the generic
  "starts processes" ask), get past the specific rules.
- **Self-protection covers direct writes, not every way to change a file.** These can revert
  or remove a protected file without being flagged: `git checkout`/`restore`/`reset --hard`/
  `stash` (an uncommitted change to `settings.json`), `git clean -x` (the gitignored stamp or
  `settings.local.json`), `tar -x`/`unzip`/`patch` into `.claude/`, and a script that does the
  write itself.
- **A double-quoted variable is trusted to be one ordinary word.** `rm "$(printf -- -rf)" x`
  or `git push origin "$REF"` with `REF=+main` are deliberate obfuscation. They are not
  treated as flags (the push still asks under `ask_on_default_branch`).
- **The stamp can be faked.** `preflight.sh r.txt true` produces a valid stamp without
  running a real check, and so does computing the digest by hand. The phase gate enforces
  ordering, not honesty.
- **Surface ownership depends on the payload.** It works only when Claude Code includes
  `agent_id`/`agent_type` in a subagent's hook payload. That is documented for subagents
  dispatched with the Agent tool. For Workflow-runtime subagents (`agent({agentType})`) it is
  assumed but not verified. Without those fields, the call is treated as the lead's and is not
  restricted.
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
  never touch another surface's tree. For edits the gate now enforces this (see
  [Surface ownership](#surface-ownership)); for Bash it is best effort.
- Migrations are **append-only** everywhere. `gate.deny` commands are never run, even if the
  hook were absent.
- The `cohorte-release` agent never edits source, never force-pushes, and refuses staged
  secrets.
- `/cohorte-align-ds` uses DesignSync strictly read-only: never write, delete or finalize on a
  curated design system.
- `/cohorte-ship` is the only outward-facing step, and it always waits for an explicit human yes.
