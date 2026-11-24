---
model: sonnet
description: Generate a new project's walking skeleton from the approved foundations plan — official generators, one trivial path through every surface, tests, lint, compose, CI — and commit it.
argument-hint: (none — the approved plan is in the cohorte ui context block)
---

You are generating the **walking skeleton** of a new project, in the current folder (its root — `git
init` already ran; it may already hold `PRODUCT.md`). The developer approved the **foundations plan**
(the `cohorte-foundation` block in the context below): follow it exactly. You are not designing
anything; every choice is in the plan. A choice the plan does not settle → the most conventional option
for that stack, recorded in your final report as an assumption.

## Rules

- **Tools — nobody should have to click.** Each call that falls outside what is pre-approved stops the
  run until the developer allows it. What is pre-approved: **Write/Edit** for every file you create or
  change (configs, tests, compose, CI, README — never `cat > file <<EOF`, `sed -i`, `node -e` or
  `python3` to write a file), **Read/Grep/Glob** to look at files (never `cat`, `head`, `ls -R`, `grep`
  through Bash), and Bash for the plan's own commands and git. Every Bash call is **one plain command**:
  no `&&`, `;`, `|`, `( … )`, `>`/`2>&1` redirect, heredoc or `$(…)` — any of them makes the command
  need an approval, however harmless. Run a command in a sub-folder with the tool's own directory flag
  (`pnpm -C apps/api test`, `npm --prefix web run build`, `uv --directory api run pytest`) or one plain
  `cd <absolute path>` call first — never `cd x && …`. Long output is fine: do not pipe it to `tail`.
- **Generators first.** Create each surface with its `generate` command, from the project root,
  non-interactively. Never hand-write what a generator produces (configs, the framework's own files).
  A generator that prompts anyway → re-run it with the flags that answer the prompt, or with
  `CI=1`; never leave a command waiting for input. A generator that creates its own `.git` → remove that
  nested `.git` folder (the project root is the only repository).
- **No business feature.** The vision's tickets are built later, one at a time. The skeleton proves the
  plumbing only: the plan's `skeleton` path (for example a `/health` endpoint the web page calls and
  displays, reading one row from the database when there is one).
- **Each surface** ends with: its test runner set up and **one passing test** of the skeleton path, its
  linter/formatter set up and clean, its build passing. Use the plan's `test` / `lint` / `build`
  commands; fix the command in your report when the generator names it differently.
- **The root** gets: a `README.md` (what the project is in two lines — from `PRODUCT.md` when it exists —
  then prerequisites, how to install, run, test), a `.gitignore` covering every surface, a
  `.editorconfig`, a `docker-compose.yml` when the plan has a database or a service (named volumes, no
  host ports above what is needed, credentials only for development and read from a `.env` that is
  gitignored, with a committed `.env.example`), and `.github/workflows/ci.yml` running each surface's
  lint, test and build (with the service containers the tests need).
- **Secrets**: never commit one. Development credentials go in `.env.example` with obvious placeholder
  values.
- **Verify**: install dependencies, then run every surface's lint, test and build and read the output.
  Docker may be unavailable on this machine: then say so and skip only what needs it (the CI still runs it).
  Two attempts to fix a failing check; after that, stop and report it as failed — do not paper over it
  (no skipped tests, no disabled lint rules).
- **Commit** when the checks pass: `git add -A` then `git commit -m "chore: walking skeleton"` (on the
  current branch). Do not push, do not add a remote.
  Before committing, run `git config user.email`: empty, or a hostname-looking address (`…@<host>.local`/`.lan`, no dot in the domain) ⇒ do not commit; report `status: failed`, naming it in `notes` with the fix `git config user.name "<name>" && git config user.email "<email>"` — never invent or set an identity yourself.
- Do **not** create `PIPELINE.md`, `CLAUDE.md`, `.claude/` or `specs/`: the pipeline is set up right
  after you, from what you leave.

Ask nothing unless a choice is truly blocking and the plan cannot settle it — then use AskUserQuestion
once (recommended option first, labelled `(Recommended)`, `header` = its class).

## Report

End your turn with a short summary and exactly one block:

```cohorte-scaffold
{"status": "ok | failed",
 "surfaces": [{"key": "web", "path": "web", "test": "npm test", "lint": "npm run lint", "build": "npm run build", "ok": true}],
 "devCommand": "How to start everything locally",
 "checks": [{"command": "cd web && npm test", "ok": true, "note": ""}],
 "assumptions": ["What you chose that the plan did not settle"],
 "notes": "Anything the developer must know (docker unavailable, a check you could not run…)"}
```

`status` is `ok` only when every check you could run passed and the commit exists.
