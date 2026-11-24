# The company flow

The [feature cycle](/guide/feature-cycle) is a developer typing commands: `/cohorte-spec`, `/clear`,
`/cohorte-build`, `/clear`, `/cohorte-review`… The company flow is the same pipeline run the way a
company runs work: **the business asks, the developers build, the code host merges, the business
checks**. It lives in `cohorte ui`, and nobody types a command or a `/clear` — or, on the same state,
in a terminal and in Claude Code sessions ([From the terminal](#from-the-terminal)).

```
BUSINESS        │ DEVELOPER (with the lead)                                   │ BUSINESS
                │                                                             │
talk to the PO  │ take ─► frame ─► [CP1 Plan] ─► build→review→fix→verify ─►   │
   │            │                                    (autopilot)              │
[CP0 Ticket]    │                               (CP2 course check, only       │
   │            │                                on a signal)                 │
   ▼            │                                                             │
 backlog ───────┼──►                         [CP3 Ship] ─► PR ─► merge ───────┼─► [CP4 Acceptance]
                │                                                             │    ok → done
                │                                                             │    not quite → follow-up
```

Every agent run is a fresh `claude -p` session that `cohorte ui` starts and feeds from disk — the
spec, the reports, the feature's record. Context is shed by the system at every stage, which is what
`/clear` did by hand.

## The roles

| Role | Talks with | Runs on (default) | Does |
| --- | --- | --- | --- |
| **Product owner** (`/cohorte-po`) | the business | `opus` | Discusses needs, value, UX, scope — never code. Proposes tickets. Read-only: the dashboard writes what it proposes. |
| **Lead** (`/cohorte-lead`) | the developer | `opus` | Frames a ticket with the developer who took it: approach, contract, the decisions they must own. Writes the spec, posts the plan. |
| **Autopilot** | nobody | per stage | Runs build → review → fix → verify, each in its own session, on its own model. Stops at a checkpoint or on a signal. |
| **Decider** | the autopilot's agents | `haiku`, then `sonnet` | Answers a mid-run question when what is already settled answers it. Hands the rest to the developer. |

## The checkpoints

| | Who | What they see | What they decide |
| --- | --- | --- | --- |
| **CP0 Ticket** | the requester | the ticket the PO drafted (need, value, business acceptance criteria, out of scope) | validate → backlog, or reject |
| **CP1 Plan** | the developer | the lead's plan: criteria, contract, work per surface, risks, assumptions | approve → the spec freezes and the autopilot starts |
| **CP2 Course check** | the developer | why the autopilot stopped | continue, correct the code, re-frame with the lead, abandon |
| **CP3 Ship** | the developer | the verdict, the Definition of Done, the implementers' assumptions, the diff, every decision taken on their behalf | ship (opens the PR), correct first, abandon |
| **CP4 Acceptance** | the requester | the PO's acceptance note: what changed, how to check it | accept, or "not quite" — which opens a follow-up conversation |

**CP2 opens only on a signal** — the point is that a feature with a good plan goes from CP1 to CP3
without you: a stage failed twice, the spec is not ready, the review found a security issue (never
auto-fixed), the spec had reservations (checked once after the first build), the fix loop is out of
rounds or not making progress.

A ticket with nothing for the business to discuss — tech debt, an upgrade, a bug a developer found —
skips the PO and CP0: **New tech ticket** puts it straight in the backlog.

## Questions during the run

Implementers never stop to wait. They build their recommended option, and list the decision in their
handoff with its **class** — `reversible · visible · behavior · contract · cost · security ·
irreversible`. The stage asks them through `AskUserQuestion`, and the decider takes it first:

- it answers **only from what is settled**: the plan validated at CP1, the spec, `specs/_decisions.md`,
  `PIPELINE.md` §Conventions, and your past answers — and it cites the source;
- its confidence is the **agreement of independent votes** (3 by default, each a one-turn, tool-less
  call that costs a fraction of a cent). Unanimous ⇒ settled. Split ⇒ the same question goes one model
  up. Still split, or no source ⇒ it is yours, with the decider's reading pre-selected;
- it **never** settles `behavior`, `contract`, `cost`, `security` or `irreversible` — whatever the votes;
- a `reversible` choice nothing written settles takes the asking agent's own recommendation (except at
  the `prudent` level).

The autonomy level (Settings) sets how much it may settle: **prudent** (reversible choices backed by a
written decision), **balanced** (also visible ones, unanimous — the default), **autonomous** (also a
precedent in the code, 2 votes out of 3).

At CP3 every decision taken on your behalf is listed with its source. Shipping **confirms** them;
**"I would not have done that"** contests one. Both are remembered: the decider reads your answers,
confirmations and contests the next time — the more features go through, the fewer questions reach you.

## Learning

| Level | Written by | Read by |
| --- | --- | --- |
| Your preferences | cohorte ui, from every answer, confirmation and contest | the decider, on every question |
| The journal (`.claude/journal/`, main checkout, gitignored) | `/cohorte-learn`, when a feature merges or is abandoned: findings, red checks, your corrections, contested decisions, implementer traps — as counted **motifs** | `/cohorte-retro` |
| Conventions (`PIPELINE.md` §Conventions) | `/cohorte-retro`, one rule at a time, **ratified by you**, with a stable id (`SH-004`, `BACKEND-002`) | every implementer (baked) and reviewer (cited by id) |
| Model routing | the feature record: every stage, its model, whether it finished, its cost | you, in Settings → What it learned; a failed stage retries one model up automatically |

A convention that keeps being broken is reported by the retro as a rule that **does not work** —
reword it, turn it into a check, or retire it. A rejected proposal is recorded so it is not proposed again.

## Models

Each role has its model (Settings → Models): the strongest where judgment is the product (the PO, the
lead), the mid one where a frozen spec already did the thinking (build, fix, review), the light one for
mechanical work and votes (verify, the decider's first round). The autopilot sends the expanded
command as the prompt, so the setting wins over the command's own `model:` — and passes the implementer
model to `/cohorte-build` and `/cohorte-fix`, which hand it to every implementer dispatch.

Every flow run loads **only the project's own MCP servers** (`.mcp.json`). A machine with many MCP
servers can carry 200k+ tokens of tool schemas into every session; the agents of this flow need none of them.

## Starting a new project

**New project** (Home, or the sidebar) starts a project that does not exist yet — the same flow, one step
earlier. Nothing is pushed anywhere and nothing is required but a folder name.

| Step | With | What comes out | Checkpoint |
| --- | --- | --- | --- |
| **Vision** (`/cohorte-vision`) | the person with the idea | who it is for, the problem, the first version, what waits — and the first version's tickets | **Vision**: they validate it → `PRODUCT.md` |
| **Foundations** (`/cohorte-foundation`) | the developer | the surfaces, the stack, each one's official generator, the data, the checks | **Foundations**: the developer approves the plan |
| **Skeleton** (`/cohorte-scaffold`) | nobody | every surface generated and wired, one trivial path through all of them, tests/lint/build green, compose, CI, README — committed | only if it fails: retry (one model up), answer, or keep it as is |
| **Pipeline** (`/cohorte-init-pipeline`) | nobody, mostly | `PIPELINE.md`, the gate, the surface agents — the plan answers the interview — committed | — |

Then it is an ordinary project: the first version's tickets wait in the backlog, and the first one is taken
like any other. **Start from an idea** begins at the vision; **I know what to build** skips it and talks to
the lead directly.

- **The lead defaults to what you already use.** It sees the stacks of your other registered projects and
  recommends the same language, framework, package manager and test runner unless the vision needs
  otherwise. **Start from one of my projects** goes further: the same structure, tooling and
  `§Conventions` — never a line of its business code.
- **Official generators only** (`npm create vite`, `nest new`, `uv init`, `cargo new`…): no hand-written
  framework setup, nothing to maintain on cohorte's side. The skeleton may run, without asking, the
  package managers and tools the approved plan names; anything else (a remover, a shell, a download)
  asks you in the page.
- **The skeleton has no feature.** It proves the plumbing; the vision's tickets are built one at a time,
  through the normal flow — the first build already has a frozen spec, a review and a verify.

**A repository you already have** (or one the sidebar refuses because it has no `PIPELINE.md`) goes
straight to the pipeline set-up; nothing is committed for you there.

### The code host — when you want one

A project can stay on your machine. When you want pull requests, **Settings → Where the code is hosted**
(also shown on the Overview until there is one) does it in one step: **a new GitHub repository** (`gh repo
create`, private by default — `gh` must be installed and signed in once) or **the URL of an empty
repository you made anywhere** (GitLab, Gitea…). cohorte points `PIPELINE.md`'s `vcs` at it — so
shipping opens PRs there — commits that, and pushes.

## Where tickets live

**Settings → Connect Obsidian** points the project at a board in your vault (creating it with the
company layout if needed — see [Kanban](/guide/kanban)). Each ticket is then a note in a `Tickets/` folder
next to the board, and its card links to it; every step moves the card. Without a vault, tickets are
kept on this machine. Jira and other trackers are planned as adapters of the same ticket format.

## From the terminal

Everything the dashboard does, the `cohorte` CLI does on the **same state** — the same tickets, feature
records, checkpoints and questions — so a ticket filed in a terminal is on the board, a CP1 approved on
the page can be followed in a terminal, and the reverse. Each verb takes `--project <path>` (default: the
repo you are in) and `--json`.

| In `cohorte ui` | From a terminal | From a Claude Code session |
| --- | --- | --- |
| Talk to the PO, CP0 drafts | — (the chat is Claude Code itself) | `/cohorte-po` files what the requester confirms with `cohorte ticket create --status validate` |
| CP0 Validate / Reject | `cohorte ticket move <id> backlog` / `rejected` | — |
| New tech ticket | `cohorte ticket create --title … [--body-file …]` | — |
| The board | `cohorte ticket list`, `cohorte ticket show <id>` | the same commands |
| Take it | `cohorte take <id>` (the lead frames it here, CP1 at the end) | `/cohorte-lead <id>` — takes it with `--no-lead`: the session is the lead |
| Reply to the lead | `cohorte lead <id> --note …` | the session itself |
| CP1 Approve | `cohorte checkpoint <id> approve [--detach]` — the spec freezes, the autopilot runs | `/cohorte-lead` runs `cohorte checkpoint <id> approve --detach` on your "approved" |
| CP2 Continue / Correct / Re-frame / Abandon | `cohorte checkpoint <id> continue\|correct\|reframe\|abandon [--note …]` | — |
| Watch the autopilot, answer its questions | `cohorte autopilot <id>` (in the foreground), or `--follow` a detached one, `--status` | — |
| CP3 Ship / Correct | `cohorte checkpoint <id> approve` / `correct --note …` | — |
| Merge | `cohorte merge <id>` | — |
| CP4 It is what I asked for / Not quite | `cohorte accept <id> ok\|not-quite [--note …]` | `/cohorte-acceptance <id>` records the requester's answer the same way |
| A spec written outside the flow → **Adopt** | `cohorte adopt <id>` (also listed by `cohorte ticket list`) | `/cohorte-spec <ticket id>` reuses the ticket id and adopts the spec once frozen |
| New project | `cohorte new-project --idea … \| --stack \| --existing <path>` | `/cohorte-vision`, `/cohorte-foundation` relay `cohorte new-project` |

**Questions.** The decider answers first, as in the dashboard. What it hands over is asked in the
terminal that runs the autopilot — and is in the dashboard's inbox at the same time: answer it in either
place. A terminal that cannot ask (a script, a pipe) stops the run and parks the feature at CP2 with the
question in the reason (exit code 3); `cohorte autopilot <id>` in a terminal resumes it.

**`--detach`** sends `take`, `lead`, `checkpoint`, `autopilot`, `merge` or `adopt` to a background
process of its own and returns at once: it holds the feature until its next checkpoint, logs under
`~/.claude/cohorte-ui/drives/`, and waits for answers from the inbox or from `cohorte autopilot <id>
--follow`. That is how `/cohorte-lead` starts the autopilot from a Claude Code session.

**Who drives.** While a run of a feature is in flight, the process that started it — the dashboard or a
terminal — holds the feature; the other refuses to move it (it says which process has it) until the run
ends. Between runs, at a checkpoint or with a PR open, either side may answer.

Exit codes: `0` nothing waits on you · `2` a checkpoint or the lead waits on you · `3` a question was
parked · `4` another process drives the feature · `1` an error.

## What stays a human's

Merging (cohorte opens the PR; you merge on the host, or press **Merge** in the dashboard), every
permission the project's gate asks, every `behavior`/`contract`/`security`/`cost`/`irreversible`
decision, and every rule that enters `PIPELINE.md`.
