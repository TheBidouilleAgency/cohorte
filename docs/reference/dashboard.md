# The dashboard (`cohorte ui`)

```bash
cohorte ui                 # opens http://127.0.0.1:<port>/ with a session token in the link
cohorte ui --port=4800     # fixed port
cohorte ui --no-open       # print the link, don't open a browser
```

A local web page over **every** Cohorte project on the machine — no account, no network, nothing to
install beyond Cohorte itself. Add a project by path (or pick one Claude Code already knows about);
the list lives in `~/.claude/cohorte.projects.json`.

## What it shows and does

| Tab | |
| --- | --- |
| **Home** | **Waiting for you** — every checkpoint, question and permission ask across projects — then the projects and what is running |
| **Overview** | health, specs by status, worktrees and dev servers up, what is running, what needs attention |
| **Tickets** | the board (to validate · backlog · framing · in progress · PR · acceptance · done), **talk to the product owner**, validate a ticket (CP0), take one, accept a delivery (CP4), add a tech ticket |
| **Features** | each taken ticket: its milestones, the open checkpoint (CP1 plan · CP2 course check · CP3 ship sign-off), its stages with model and cost, the decisions taken on your behalf (contest one), the PR (merge it), the conversation with the lead |
| **Health** | the `cohorte doctor` checks, each with its fix |
| **Specs** | every spec as a pipeline row (Spec → Build → Review → Verify → Ship) with the **next command** to run; open one for its review findings (severity, `file:line`, fix), reports and body |
| **Run** | start a `/cohorte-*` command in a worktree, answer its permission asks and interview questions, reply in the same session, stop it; past runs are kept across restarts |
| **Worktrees** | create / remove (`scripts/new-feature.sh` when the project has it), start / stop dev servers with live logs and an **Open** link, git state (ahead/behind, dirty, last commit), the PR and its checks (needs `gh`), and the diff against the default branch |
| **Docker** | the project's compose stack: daemon state, services with health and ports, start / stop / restart / down (never `-v`), logs |
| **Cost** | spend by command (`cohorte metrics`) |
| **Settings** | connect Obsidian (tickets as notes, the board moved for you), the product map, the autopilot and the decider's autonomy, the model of every role, what it learned |

Updates are pushed live (one authenticated event stream), and the page can raise a browser
notification when a run needs you or finishes while the tab is in the background.

**Worktree creation checks Docker first.** `scripts/new-feature.sh` creates the worktree's database
inside a compose service; when Docker or that service is down the page says so and offers to start
the stack instead of letting the script fail late.

## What it will not do

The dashboard talks to Claude **only** through installed `/cohorte-*` commands (headless `claude -p`):
the Run tab's commands, and the company flow's conversations and stages
([The company flow](/guide/company-flow)) — a product owner and a lead you talk to, each bound to its
command. `bypassPermissions` is never offered, because the project gate's `ask` answers would turn into
denials; the autopilot's stages run in `acceptEdits`, so the gate still asks for everything else.

## Security model

- Listens on `127.0.0.1` only. Every `/api` call needs the session token (a `Bearer` header; the link
  carries it in the URL fragment, which is never sent to a server), a loopback `Host` (DNS rebinding)
  and, when the browser sends one, this server's own `Origin`.
- State-changing requests must be `application/json`; projects, worktrees, jobs and services are
  addressed by id or by what `git` / `docker compose` themselves list — never by a client-supplied path
  or command.
- Every command it launches is asked of the project's **gate** first (`allow` / `ask` → you confirm /
  `deny` → refused).
- Strict CSP (`script-src 'self'`, no inline script or style), project text rendered as text only.

## Developing it

The page is React + TypeScript (Vite), the server TypeScript compiled to plain Node — both live in
`ui/` and ship **built** (`ui/dist-web`, `ui/dist-server`); the package has no runtime dependency.

```bash
npm run build:ui                              # install + build both
cd ui && npm run dev:web                      # hot-reload page; set COHORTE_UI_PORT=<port of a running `cohorte ui`> to proxy /api
cd ui && npm run typecheck && npm test        # types + unit tests
node scripts/test-ui.mjs                      # the HTTP / security / lifecycle suite
```
