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
front end (the dead pid frees the lease, `recover()` opens CP2, as for a UI restart). (Questions parked
by a run used to be visible only in the process running it — fixed in the second round, below.)

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

## Second round (4.1.3 merged in): detach, parked questions, skills, adopt, founding

### Parked questions on disk, answered from either side

A run file now carries what its run parked on a person (`pending`: request id, kind, questions, the
decider's advice — not the tool input). Another process reading it (the page's inbox, `cohorte autopilot
--follow`) sees the question; `Runs.respond` on a run it does not drive writes the answer to
`<runs>/<projectId>/answers/<runId>.<requestId>.json`, and the driving process polls that folder for its
own runs with something pending (every 300 ms) and applies it as a human answer — so it becomes a
preference and a decision on the record exactly like a page answer. A terminal prompting for a question
drops the prompt when the answer arrives from elsewhere.

### `--detach`

`take`, `lead`, `checkpoint`, `autopilot`, `merge`, `adopt` with `--detach` re-run themselves as
`--driven` in a detached child (stdin closed, stdout/stderr to `<data>/drives/<projectId>/<id>.log`,
`<id>.json` = pid + log). The parent returns as soon as the child holds the feature's lease (or ended —
then it prints the log and the child's exit code). A driven drive never parks a question: it logs
`? waiting for an answer …` and waits; it stops at the next checkpoint (CP2/CP3 are on disk already, so
the page or another terminal answers them, and that answer drives the rest). `cohorte autopilot <id>
--follow` tails the log and asks the drive's parked questions on its own terminal; `--status` prints the
feature, the questions waiting, and the drive's last lines.

### The skills in a plain session

Every skill keeps its `cohorte ui` path unchanged (the context block present ⇒ the dashboard does the
writing) and says what to run without it — each call one plain command (validate-core checks every
`` `cohorte <verb> …` `` in core/commands for `&&`, pipes, `;`, redirects and `$(…)`, and that the
plain-session commands below are still there):

- `/cohorte-po` lists tickets with `cohorte ticket list --json` and files the ones the requester confirms
  with `cohorte ticket create --status validate …` (new: `--status validate` and every field of its
  block — CP0 still applies).
- `/cohorte-lead <ticket>` reads it with `cohorte ticket show --json`, takes it with `cohorte take <id>
  --no-lead` (new: the worktree and record without a lead run — the session is the lead; the feature is
  marked `sessionLead`), frames in the worktree, freezes on the developer's approval and runs `cohorte
  checkpoint <id> approve --detach` (for a `sessionLead` feature in framing, approve checks the spec is
  frozen and hands it to the autopilot), then tells them how to follow it (`--follow`, `--status`, the
  inbox, CP3).
- `/cohorte-spec <ticket id>` reuses the ticket id as the feature id, the ticket's criteria as the DoD,
  and links the frozen spec with `cohorte adopt <id>`.
- `/cohorte-acceptance` records the requester's answer with `cohorte accept <id> ok|not-quite --note`.
- `/cohorte-vision`, `/cohorte-foundation` relay `cohorte new-project` (start, then `--resume … reply|approve
  …` with the person's answers, `--identity github|"Name <email>"` before the foundations are approved).
- the kanban hand-move in `/cohorte-lead` is gone: `cohorte take` moves the card.

### `cohorte new-project`

The page's Founding (`FoundingFlow`, unchanged) driven from a terminal: `--idea`/`--stack`/`--existing`,
`--based-on`, then the conversation's turns and the checkpoints (`cp-vision`, `cp-foundation`,
`cp-scaffold`) asked on stdin — with the 4.1.2 identity check before the foundations are approved and the
skeleton retried (`github` or `Name <email>`, set in that repo only). Without a terminal it returns at the
first wait (exit 2) with the command to run next — which is how the skills relay it.

### Adopt — the reverse direction (step 5)

`Flow.adoptable` lists the specs, in the main checkout or a feature worktree (the worktree's copy wins),
that no live feature record follows; `Flow.adopt` creates the record: a draft is refused (freeze it, or
take the ticket); `frozen`/in progress opens the checkpoint `nextStep` would stop at (CP3 when the
reports say review and verify are clean) or CP2 "adopted — continue runs <stage> next"; `shipped` looks
the PR up and waits at `pr`; `merged` goes on to the journal and the acceptance note. The ticket of the
same id is linked, or created from the spec. A spec in the main checkout is adopted there, with a warning
(the stages then run in the main checkout). Surfaces: `cohorte adopt <id>`, `cohorte ticket list` (the
"started in a Claude Code session" list), `GET …/tickets` → `adoptable`, `POST …/adopt`, and an **Adopt**
card on the page's Tickets board. The feature page also says when a terminal drives the feature.

### Tests (second round)

`scripts/test-cli-flow.mjs` adds: `ticket create --status validate` with the PO's fields (CP0 on the page);
`checkpoint approve --detach` returning at once, its handed-over question read and answered from the
page's inbox/respond route, the drive reaching CP3 with the page's answer recorded, `--status`, then a
detached CP3 ship followed with `--follow`; `take --no-lead` + a session-frozen spec + `checkpoint
approve`; adopt from the CLI (frozen spec in a worktree → CP2, ticket created, draft refused, twice
refused) and from the page (reviewed + verified spec in the main checkout → CP3); the founding chain end
to end from `new-project --idea … --based-on … --interactive` (reply, approve, identity `github`,
approve, retry) to an ordinary project with its two tickets in the backlog. validate-core checks the
skills' plain-session commands.

## Third round: the review's fixes (these supersede the rounds above where they differ)

**Permission asks never cross processes.** Any process of the user — an agent's background shell — can
read a run file and write under the data dir, so a file can never stand for a person. `Runs.respond` on a
run another process drives refuses a permission ask (and a question the decider holds); the collector
applies only question answers, as `by: 'remote'` (`DecisionRecord.by` gains `remote`: listed at CP3 with
the decider's — "answered from elsewhere" — and confirmed by shipping, never learned as a preference).
The UI's respond route answers 409 for a permission of a run a terminal drives. A detached drive (no
terminal) that gets a permission ask parks the feature at CP2 with the ask in the reason. Defense in depth:
the gate denies every Bash or Write/Edit write under `<CLAUDE_CONFIG_DIR>/cohorte-ui/` (test-gate).

**Agents and people.** Every run Runs spawns carries `COHORTE_RUN_ID` / `COHORTE_RUN_PROJECT`; the CLI then
allows only `ticket list|show` and `autopilot --status`. A person's decisions — CP0 (`ticket move`), a
ticket straight to the backlog, CP3 approve, abandon, CP4 (`accept`), `merge`, `take-over`, the gate's ask on
`take` — need stdin to be a TTY and a typed `yes` (or the UI); from a pipe they exit 5 with the command to
type (`--interactive` and `--yes` are gone). (A one-time token for `--detach` was tried here and removed in the
fourth round: a file is forgeable.) CP1 approve
(and a reply), CP2 continue/correct may be relayed from a pipe with `--note "<the developer's words>"`,
recorded as a `remote` decision on the feature. The skills: `/cohorte-lead` relays CP1 with `--note`;
`/cohorte-acceptance` and `/cohorte-po` give the person the command (or the dashboard button) instead of
running it; the founding relays approve with `--note`, abandon is the person's. validate-core checks it
(no skill runs `accept` / `ticket move` itself).

**Process identity.** `proc.ts`: a holder is a pid **and** its start time (from `/proc` on Linux, `ps -o
lstart` elsewhere, to the second); alive = that pid exists and started then. EPERM no longer means alive
forever, and a reused pid is dead. Run files record `pidStart`; detached drives record their start.

**The lease is a lock file.** `lease.ts`: `<data>/leases/<project>/<feature>.lock`, created with `O_EXCL`
(two processes: one wins), holding pid + start; a stale one is moved aside by rename and replaced; released
when the holder has nothing of the feature in flight (runs, jobs, tracked hook work). Every transition
claims it first and re-reads the record in place; `advance`, the PR poll and `recover` take it or skip;
`startStage` refuses if another process holds it. `feature.driver` mirrors it for the page. `cohorte
take-over <id>` (typed `yes`) clears a stuck one; a feature left mid-run opens CP2.

**Adopt never runs on the default branch.** A spec only in the main checkout is refused with the way out
(take the ticket with `--no-lead` — it creates the worktree — move the spec there, approve CP1); the page's
Adopt card says so instead of offering the button.

**Tests.** test-cli-flow runs the person's decisions on a pseudo-terminal (`scripts/ci/pty-run.py`) and
checks each is refused from a pipe (exit 5) and from an agent (`COHORTE_RUN_ID`); CP1 relayed with a note
(recorded); a detached drive whose verify asks a permission → parked at CP2, never granted; the page's
answer to its question recorded `remote` and listed at a terminal's CP3; a stale lease (our pid, another
start) ignored, a live one (pid + start) kept with 409, `take-over`; adopt of a main-checkout spec refused.
vitest (`answers.test.ts`): a forged answer file does not approve a permission, another process cannot
answer one, a question crosses as `remote`, a decider-held one does not, runs carry `COHORTE_RUN_ID`, pid +
start identity, the lease (re-entrant, live holder refused, stale replaced). test-gate: writes under
`cohorte-ui/` denied.

## Fourth round: the second review

- **No authority in a background drive, none in a file.** The confirm token is gone. `--driven` has no power at
  all: its `confirm()` always refuses. For CP3 approve and merge with `--detach`, the TTY parent takes the
  decision itself — recorded on the feature as the developer's (`by: 'human'`) and in the append-only decision log
  (`<data>/human/<project>.jsonl`, humanlog.ts) — and leaves the step `pending`; the background drive
  (`autopilot <id> --driven`) only starts it, after `Flow.resume` finds the approval in the log. Abandon with
  `--detach` runs in the foreground.
- **Inside a run.** The gate (the hook inherits the run's env) denies state-changing `cohorte` verbs under any
  spelling, `COHORTE_*` tampering and pty helpers (test-gate). The CLI treats an empty `COHORTE_RUN_ID` as set and
  refuses when a live run's `claude` is among its ancestors (run files now carry `childPid`/`childStart`;
  `proc.ancestors`). CP1/CP2 relays are therefore possible only from sessions the user started.
- **The gate's write-deny** also covers `touch`, `mkdir`, `tar -C`/`-x` into the cwd, `git -C`/`git init|clone`
  targets, `$CLAUDE_CONFIG_DIR`; an unresolved target that names `cohorte-ui` is asked. Interpreters remain open —
  see "The security boundary" below.
- **File answers to questions**: never for the ship stage, nor for a question whose class (its header, or the
  decider's reading) is security, irreversible or cost (`remoteAnswerable`). A detached drive parks on those, as on
  a permission ask.
- **The lock** is written whole to a temp file and `link()`ed into place; an unreadable lock younger than 5 s is
  live (being written), older is stale.
- **Integrity.** When another process rewrote a feature record, the flow checks what it claims a person did
  against the decision log (CP3 → shipping/PR, PR → merging, a pending step, a decision `by: 'human'`). A record
  that fails is flagged `integrity: "changed outside cohorte: …"` (logged, shown on the page and in
  `ticket show`), and nothing automatic runs on it — no stage, no merge, no PR poll — until a person acts on it
  (a checkpoint, or `take-over`). Tickets are not checked: their notes are meant to be edited by hand (Obsidian).

## Fifth round: the final review

- **Integrity without false alarms.** A process that last saw a feature mid-autopilot and next sees it shipping
  looks for a CP3 approval in the decision log since it last saw the record (it may have missed the CP3); an
  adoption over an abandoned or failed record (logged as `adopt`) is not a jump past CP3 either.
- **No lease leak.** `replyLead` releases on every refusal (try/finally), `advance` releases when a run is
  already running; every other claim site was already wrapped.
- **Alive when unsure.** A process that exists but whose start time cannot be read (`ps` failed or timed out) is
  alive: a stolen live lease is worse than a stuck one, which `take-over` clears. Windows reads start times with
  PowerShell's `Get-Process`; where that fails too, the pid check stands and `take-over` is the recovery.
- **Locks on filesystems without hard links** (FAT, some network shares): `link()` failing with anything but
  EEXIST falls back to an O_EXCL create, then write + fsync; a reader in between sees a young unreadable lock, live.
  Detached drives spawn with `windowsHide`.
- **The run guard** also catches `npm exec|x cohorte …`, and inside a run a command whose name is computed at
  run time (`$c …`, `$(which cohorte) …`, `"$C" …`) is denied, not asked.
- **Relayed founding approvals keep the person's words**: `FoundingView.approvals` records each vision/foundations
  approval with `relayed` and the text (also handed to the next step, as before).
- **File answers need the decider's classification**: a question is answerable from another process only when the
  decider classified it (its advice) as neither security, irreversible nor cost — the asking agent's own header is
  not trusted alone.

## The security boundary

What holds, and what does not, against an agent of a cohorte run (a run's `claude` and everything it spawns):

- **With the default permissions** (the gate installed, Claude Code's prompts on, no broad allow rule): it cannot
  move the flow — every state-changing `cohorte` verb is denied by the gate and refused by the CLI (env, then
  ancestry); it cannot write the flow's state by the commands the gate parses; it cannot answer a permission ask,
  a ship-stage question or a security/irreversible/cost question; it cannot pass for a person (no pty, no TTY). It
  can answer its own ordinary questions through a file, visibly (`remote`, listed at CP3, never learned).
- **With broad interpreter permissions** (`python3`, `node`, a script it may write and run): it can write any
  file the user can, so it can forge a feature record, a ticket, the decision log, a lock. Parsing cannot close
  that, and nothing human-only depends on a file being unforgeable: shipping and merging run only in the process
  where the person approved (the page, a terminal's typed `yes`) or in the drive that terminal detached, after the
  approval is found in the log; a record edited past a person's checkpoint is flagged and frozen. What a
  determined agent with interpreter access can still do is forge BOTH the record and the log consistently, then
  wait for a drive of its own feature — i.e. the same power it has over the user's shell profile. The only real
  boundary there is not granting broad interpreter permissions to agents you would not trust with your account.
- Tickets (Obsidian notes) are not integrity-checked: they are meant for people to edit. A forged CP0 (backlog)
  lets a developer take a ticket the business did not validate — visible on the board, never acted on alone.

## What remains

- A drive killed with SIGKILL still leaves its feature in `autopilot` until the next start of either
  front end (`recover()` then opens CP2) or a `take-over`. The page could notice the dead holder on its
  watch tick and recover at once.
- The TTY rule keeps a person's decisions away from a pipe and from cohorte's own agents; it cannot stop a
  same-user program that fakes a terminal (a pty) — that is the gate's and Claude Code's permission
  prompts' job, as for any command the agent runs.
- `cohorte new-project` has no `--detach`: a skill relays it turn by turn, which is fine for the
  conversations, but the skeleton step can take minutes inside one Bash call (600000 ms timeout).
- A PO revision after filing (`ref` kept) has no CLI path: the note is edited by hand or on the page.
- Plain-session work that is only a branch without a spec is not adoptable (there is no phase to infer).
