# CLI ↔ UI parity (4.2)

> Rule: anything `cohorte ui` can do, a Claude Code session can do, and the reverse — on the same state.
> Today the company flow (tickets, checkpoints, worktrees, autopilot, decider) is owned by the UI
> server: its state lives in `~/.claude/cohorte-ui/` and only `ui/server/flow.ts` moves it.

## What is UI-only today

| Capability | UI | CLI today |
| --- | --- | --- |
| Talk to the PO, file tickets (CP0) | Chat → tracker | `/cohorte-po` runs, but nothing writes its tickets |
| Backlog, ticket status | Kanban page | Obsidian board only when connected; local store unreadable |
| Take a ticket (worktree + feature record) | "Take" | nothing — `/cohorte-spec` picks its own id |
| Frame with the lead, CP1 approve | Chat + "Approve" | `/cohorte-lead` runs, but the ticket must be pasted and CP1 has no effect |
| Autopilot build→review→fix→verify, CP2 signals | `Flow.advance` | `/cohorte-loop` covers review↔fix only, no CP2/CP3 |
| Decider on mid-run questions | `decider.ts` | the question waits for the human |
| CP3 ship, merge poll, CP4 acceptance | buttons | `/cohorte-ship`, `/cohorte-acceptance` by hand, no state update |
| New project (vision → foundation → scaffold → init) | Founding | the four skills, chained by hand, no state |
| Settings (models per role, code host) | Settings page | edit files |

And the reverse gap: work done in a plain session (a spec, a build, a merge) is invisible to the
flow — the UI shows the ticket as not taken.

## Design: one engine, two front ends

1. **State is a library, not a server.** Move the stores (`tracker`, `features`, `settings`, `prefs`,
   `founding`) and the pure flow logic (`signals`, checkpoint transitions, ticket↔feature id) out of
   the HTTP layer into a module both `bin/cli.js` and `ui/server` import. Files stay where they are
   (`~/.claude/cohorte-ui/` keeps working; rename later). The UI watches the files, so a CLI change
   shows up live.
2. **A `cohorte flow` CLI over that library** — the verbs the UI buttons call, scriptable and
   `--json`:
   `cohorte ticket list|show|create|move`, `cohorte take <ticket>` (worktree + feature record, same id
   as the ticket), `cohorte checkpoint <ticket> approve|correct|abandon [--note]`,
   `cohorte autopilot <ticket>` (runs `Flow.advance` headless in the terminal, streams stage status,
   surfaces CP2/CP3 and pending questions as prompts; the decider answers first, as in the UI),
   `cohorte accept <ticket> ok|not-quite`, `cohorte new-project`.
3. **The skills call those verbs when they run in a plain session** — no more "you normally run inside
   cohorte ui". `/cohorte-po` files its tickets with `cohorte ticket create` after the requester
   confirms in the chat; `/cohorte-lead <ticket>` reads the ticket with `cohorte ticket show`, takes it
   if needed, and on the developer's "approved" runs `cohorte checkpoint <id> approve`, which freezes
   the spec and starts the autopilot (in the same terminal, or detached so the UI can follow it).
   `/cohorte-spec` accepts a ticket id and reuses it as the feature id.
4. **The UI's own runs go through the same verbs**, so there is exactly one code path per transition,
   and one test suite (`scripts/test-flow.mjs` drives the library, not the HTTP server).

## Out of scope for 4.2

The web chat stays a UI feature (the CLI's chat is Claude Code itself). Docker management and the
metrics pages are views, not flow state.

## Order of work

1. Extract the library (no behavior change; the existing UI tests must pass untouched).
2. `cohorte ticket` + `cohorte take` + spec/ticket id link.
3. `cohorte checkpoint` + `cohorte autopilot` (headless `advance`, questions in the terminal).
4. Skills: po, lead, spec, acceptance, founding chain call the verbs; docs: company-flow from the CLI.
5. Reverse direction: the UI picks up plain-session work (a spec or feature record created by the CLI).

## What was built (steps 1–3)

### The engine, not an extraction

The `Flow` class was already free of HTTP: it needed a `Runs`, a `Jobs` and a data dir. So instead of
moving the stores out, `ui/server/engine.ts` builds the set (`createEngine({ globalDir, by })`: jobs,
runs with their store, the flow, and the job → flow wiring that lived in `server.ts`). The server
uses it; the CLI requires the same compiled file (`ui/dist-server/server/engine.js`). The state files
did not move. The library's only new surface is what a headless front end needs: `active()` /
`idle()` (is anything of this feature in flight in this process, hook work included), `park()` (stop
what this process runs for a feature and leave it where a restart of the UI would), `checkPR()` (one
feature's PR now, which is also what the PR poll does), and `settleMoves()` in the tracker (wait for the
board card moves before exiting).

### Two processes on the same files

What each store did before, and what changed:

| Store | Before | Now |
| --- | --- | --- |
| tickets (`tracker.ts`) | read from disk on every access, atomic writes | unchanged |
| settings, preferences | read on every access | unchanged |
| features (`features.ts`) | cached in memory forever | the cache checks the file's mtime+size; a file another process rewrote is read again, **into the same object** (a reference the flow holds across an await sees the new state). Writes use a per-pid tmp file |
| runs (`history.ts`, `runs.ts`) | all loaded at start; a `running` run became `stopped` | each run file carries its driver's pid. A run still `running` in a live process stays `running` for the others (read-only: its child and its parked questions belong to that process). `Runs.get` re-reads a run that is not running here when its file changed, and finds a run another process started after this one loaded the store; `forProject` picks up new files. A process writes back only the runs it spawned a turn of (`flush` used to rewrite them all) |

**The lease.** A run's end hooks only fire in the process that spawned it, so a feature with a run (or a
worktree/merge job) in flight is leased to that process: `feature.driver = { pid, by: 'ui'|'cli', at }`.
While the lease is live (the pid answers `kill 0`), the other process refuses every transition on it
(`take`, `replyLead`, `checkpoint`, `contest`, `merge`, `acceptance` → 409 "being driven by a cohorte
command in a terminal (pid N)"), `advance` and the PR poll skip it, and `recover()` (at start-up) leaves
it alone — before, a CLI start would have turned the UI's running feature into a CP2 "restarted". The
lease is dropped when the process has nothing of the feature in flight; a dead pid frees it. Between
runs — a checkpoint waiting, a PR open — nobody holds it, and either side may answer.

**The page hears of it** through `watchState` (engine.ts): every 1.5 s, the names+mtimes of each project's
features, tickets and runs folders; a change sends the same `flow` notice the UI's own writes send, and
the page refetches. Polling, not `fs.watch`: portable, and a vault on a synced drive does not always
deliver events. A CLI that is waiting at a checkpoint prompt watches the feature the same way: answered
on the page meanwhile, the prompt is dropped and the verb follows what the page started.

Known limits: a CLI killed with SIGKILL leaves its feature in `autopilot` until the next start of either
front end (the dead pid frees the lease, `recover()` opens CP2, as for a UI restart). Questions parked
by a run are only answerable in the process that runs it (they are not persisted); the other side sees
the feature leased.

### The verbs (`bin/flow.js`, dispatched from `bin/cli.js`)

Each verb is the transition a button of the page makes (`Flow.take`, `Flow.checkpoint`…), then it
**drives** what that transition started — the runs are children of this process, and a run's end is
what moves the flow on — until the flow rests on a person. All take `--project PATH` (default: the repo
of the current folder; a feature worktree resolves to its main checkout; the project is registered on
first use) and `--json` (the result on stdout, progress on stderr).

| Verb | Does |
| --- | --- |
| `ticket list [--status S]` / `ticket show <id>` | the tracker (local store or Obsidian notes) and each ticket's feature |
| `ticket create --title T [--body-file F] [--type] [--criteria]…` | `Flow.createTicket`: straight to the backlog, like "New tech ticket" |
| `ticket move <id> <status>` | from `discussion`/`validate` to `backlog`/`rejected` it is CP0 (`decideTicket`); anything else moves the note and the card (refused while another process drives its feature) |
| `take <ticket> [--yes] [--skip-docker-check]` | the Docker preflight and the gate confirmation the page asks for, then `Flow.take` (worktree, feature record with id = ticket id), then the lead's first turn, printed → CP1 |
| `lead <ticket> --note TEXT` | `Flow.replyLead` and the lead's next turn |
| `checkpoint <ticket> <action> [--note]` | `Flow.checkpoint`. CP1 `approve` (the lead freezes the spec, then the autopilot runs here), `correct` (= reply to the lead), `abandon`; CP2 `continue` `correct` `reframe` `abandon`; CP3 `approve` (ship → PR) `correct` `abandon` |
| `autopilot <ticket>` | the advance loop in the terminal: one line per stage start/end, the decider's decisions as they land, CP2/CP3 (and CP1) asked here; a feature in `autopilot` with nothing running is advanced; at `pr` the PR is checked once (merged ⇒ journal → acceptance note) |
| `merge <ticket>` | `Flow.merge` (`gh pr merge`), then the journal and the acceptance note → CP4 |
| `accept <ticket> ok\|not-quite [--note]` | `Flow.acceptance`; `not-quite` prints the follow-up PO conversation's first turn |

Mid-run questions go to the decider first, exactly as in the UI (same hook). What it hands over is asked
on the terminal with its options and the decider's reading; the answer goes through `Runs.respond` as
the page's would (so it becomes a preference and a decision on the record). Permission asks are asked
y/N. **No terminal** (stdin not a TTY, or `--no-interactive`; `--interactive` forces asking on a pipe):
the run is stopped and the feature parked at CP2 with the question in the reason, exit 3 — `cohorte
autopilot <id>` in a terminal resumes it (CP2 continue reruns the stage, which asks again). Ctrl-C parks
the same way.

Exit codes: 0 nothing waits on the developer (PR open, acceptance with the business, done) · 1 error ·
2 a checkpoint or the lead waits on the developer · 3 a question was parked · 4 another process drives
this feature.

### Tests

`scripts/test-cli-flow.mjs` (in `npm test`, CI and publish; skipped on Windows like `test-flow.mjs`) runs
a cohorte ui instance and drives the verbs against the same stand-ins for `claude` and `gh`
(`scripts/ci/flow-standins.mjs`, moved out of `test-flow.mjs` unchanged): ticket create/list/show/move →
take (CP1, exit 2) → checkpoint approve (freeze, build with a decided question, review, fix asks a
security question: parked, exit 3) → autopilot `--interactive` (CP2 continue, the question answered on
stdin while the UI gets 409 on abandon and on the lead, CP3 shown with the decisions, stdin closed ⇒
exit 2) → checkpoint approve (PR) → merge → acceptance note → accept ok. After each verb the running UI
is asked what it sees (a feature it had cached at CP1 shows CP2, the lead run the CLI started is
readable, a `flow` notice reaches the event stream), and a ticket filed on the page is listed and moved
from the CLI.

## What remains

- **Step 4, skills.** `/cohorte-po` runs `cohorte ticket create` (status `validate` would need a
  `--status` on create, or a `ticket move` after) once the requester confirms; `/cohorte-lead <ticket>`
  runs `cohorte ticket show <id> --json`, `cohorte take` when the ticket is not taken yet, and on the
  developer's approval `cohorte checkpoint <id> approve` — which today runs the autopilot in the
  foreground of the Bash tool call; a `--detach` (spawn `cohorte autopilot` as its own process, so the UI
  or another terminal can follow and answer it) is the missing piece for a long autopilot started from a
  session. `/cohorte-spec` accepting a ticket id as the feature id, `/cohorte-acceptance` reading the
  ticket, `cohorte new-project` for the founding chain. Docs: company-flow from the CLI.
- **Step 5, the reverse direction.** A spec frozen or a branch built in a plain session (no feature
  record) is still invisible to the flow: the UI should offer to adopt it (create the feature record from
  `specs/<id>.md` and the worktree, phase from the pipeline's reports via `pipelineOf`/`nextStep`).
- Questions parked in one process are not visible to the other; persisting pending items in the run file
  would let the page show (not answer) what a terminal is asking.
