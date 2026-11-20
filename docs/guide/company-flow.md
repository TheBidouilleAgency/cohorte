# The company flow

The [feature cycle](/guide/feature-cycle) is a developer typing commands: `/cohorte-spec`, `/clear`,
`/cohorte-build`, `/clear`, `/cohorte-review`… The company flow is the same pipeline run the way a
company runs work: **the business asks, the developers build, the code host merges, the business
checks**. It lives in `cohorte ui`, and nobody types a command or a `/clear`.

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

## Where tickets live

**Settings → Connect Obsidian** points the project at a board in your vault (creating it with the
company layout if needed — see [Kanban](/guide/kanban)). Each ticket is then a note in a `Tickets/` folder
next to the board, and its card links to it; every step moves the card. Without a vault, tickets are
kept on this machine. Jira and other trackers are planned as adapters of the same ticket format.

## What stays a human's

Merging (cohorte opens the PR; you merge on the host, or press **Merge** in the dashboard), every
permission the project's gate asks, every `behavior`/`contract`/`security`/`cost`/`irreversible`
decision, and every rule that enters `PIPELINE.md`.
