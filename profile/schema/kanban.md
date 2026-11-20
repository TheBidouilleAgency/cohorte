## Kanban — mirroring the pipeline onto an Obsidian board

An **optional, user-scoped** mirror of the dev flow: each pipeline stage moves a card across an
[Obsidian Kanban](https://github.com/mgmeyers/obsidian-kanban) board, one board per project. Config
lives in the consolidated global config `<config>` §`kanban` (NOT in
`PIPELINE.md` — the board path points at the user's personal vault, so it is machine-specific and must
not be committed). Everything below **no-ops silently** when the config is absent, `kanban.enabled` is
false, no board is configured for the current project, or the board file is missing — the pipeline never
blocks on the board.

**Config & board resolution.** `kanban.boards` is keyed by the project's `PIPELINE.md` `name`. To resolve
the current project's board: read `name` from `PIPELINE.md`, look up `kanban.boards[name]`. Found ⇒ the
board file is `<obsidian.vault_path>/<boards[name].board>`, its columns are `boards[name].columns` if
present else `kanban.columns`. Not found ⇒ kanban off for this project.

**Layouts.** Two board layouts exist, and every stage key works on both:

| Layout | Columns, in order | Who creates it |
| --- | --- | --- |
| `pipeline` | Ideas · Brainstorm · Spec · Ready to build · Building · Review · Fix · Ship · Shipped | `/cohorte-init-pipeline` (and every board made before 4.0) |
| `company` | Ideas · Discussion · To validate · business · Backlog · Framing · In progress · To validate · dev · PR open · Acceptance · Done | `cohorte ui` (Settings → Connect Obsidian) |

The company layout mirrors the company flow (`docs/guide/company-flow.md`): the business discusses and
validates tickets, a developer frames one with the lead, the autopilot builds it, the developer signs off,
the PR merges, the requester accepts. Each stage key resolves to a **list of candidate headings** — the
configured `columns` entry first, then the layout defaults (`building` → `Building` | `In progress`,
`ship` → `Ship` | `To validate · dev`, `shipped` → `Shipped` | `PR open`, …) — and `kanban-move.sh` takes
the first one the board actually has. So the pipeline commands move cards correctly on a company board
without any config change, and the company flow's keys (`discussion` · `validate` · `backlog` · `framing`
· `checkpoint` · `pr` · `acceptance` · `done`) land on the closest pipeline column of an older board.

**Ticket notes (company flow).** `cohorte ui` keeps each ticket as a markdown note in a `Tickets/` folder
next to the board (front-matter `id`, `title`, `type`, `status`, `requester`, `priority`, `size`, …,
`tags: [cohorte-ticket]`; sections Need · Value · Acceptance criteria · Out of scope · Notes · Acceptance
note · Feedback), and the card links to it: `- [ ] [[<folder>/Tickets/<id>|<title>]]  #<id>`. The ticket id
is the feature id, so the ticket's card and the spec's card are the same card. Edit a note by hand if you
like; the dashboard re-reads it.

**Card format.** A card is a Kanban list item under a `## <column>` heading:
`- [ ] <human title>  #<feature_id>`. The `#<feature_id>` tag is the join key between a card and its
`specs/<feature_id>.md`; it is how every stage finds *its* card (Grep the board for `#<id>`). Free-text
notes a human writes as sub-bullets under an Ideas card are seed context for `/cohorte-brainstorm`. Never touch
the trailing `%% kanban:settings … %%` block or the `kanban-plugin: board` front-matter.

Once shipped, `/cohorte-ship` appends the **PR number** to the card — `- [ ] <title> #<feature_id> — PR #<num>`.
The bare `#<num>` is what a board reader renders as a clickable link to the GitHub PR, so `/cohorte-ship` always
writes it when a PR was actually created.

**Move a card (the core op).** One call — the script does resolution AND the move outside the
agent's context (find, dedupe, sub-notes carried along, settings block preserved):

```
<core>/pipeline/scripts/kanban-move.sh auto <id> <stage> [--pr <num>] [--title <title>]
```

It creates
the card in the target column when none exists, keeps the first and drops duplicates, and appends
` — PR #<num>` with `--pr`.

**`auto` is not a convenience, it is the contract.** It reads `name` from `PIPELINE.md`, then
`kanban.enabled` / `obsidian.vault_path` / `boards[name]` from `<config>`
(override with `COHORTE_CONFIG`, or skip the profile with `--project <name>`), and it maps the
**stage key** (`ideas` · `brainstorm` · `spec` · `ready` · `building` · `review` · `fix` · `ship` ·
`shipped`) to that board's heading through `boards[name].columns` → `kanban.columns` → the built-in
default. An explicit `<board.md>` path and a literal heading both still work, for one-off and
non-pipeline moves.

**Never conclude "no board is configured" without running it.** The command that resolves nothing
prints `kanban: <reason>` — naming the missing link (no config file, `enabled: false`, no entry for
this project, vault unset, board file gone) — and exits **0**. A configured board that cannot be
moved is loud instead: exit 2 on usage, exit 3 on an unknown column — or on an explicit
`<board.md>` path that does not exist (under `auto`, a configured board file that is gone is one of
the `kanban: board file not found` no-ops above, exit 0). Both readings are printed, so a caller
reports which one it got. This exists because inference was the
actual failure mode: with only "no-op silently if no board" to go on, a fresh phase session (every
phase runs after a `/clear`) decided there was no board without ever opening the config, and cards
stopped moving mid-pipeline while every command still reported success.

**Fallback when the script is absent** (older core): do it by hand, but never read the whole board
into context — it grows with every feature ever tracked: `grep -n` for `#<id>` and the `## ` headings
to locate lines, then use offset-limited Reads + targeted Edits around the matches. Either way: one
card per `#<id>`, whole line moved tag-preserved, card created in the target column if missing.

**Tag before you move.** The join key is the `#<id>` tag, and an **Ideas** card a human typed by hand
does not have one. Moving it first finds nothing, creates a second card, and strands the original in
Ideas — so `/cohorte-brainstorm` appends the tag to the picked line before its first move.

**Stage → column**, used both by each pipeline command (to move its card live) and by backfill:

| Pipeline moment                         | Column          |
| --------------------------------------- | --------------- |
| human drops a raw idea (manual)         | `ideas`         |
| `/cohorte-brainstorm` picks it up               | `brainstorm`    |
| `/cohorte-spec` opens (draft)                   | `spec`          |
| `/cohorte-spec` freezes (`status: frozen`)      | `ready`         |
| `/cohorte-patch` triages / freezes              | `spec` → `ready` (card titled `[patch] <title>`, tag `#patch-<slug>`) |
| `/cohorte-refactor` freezes its round spec      | `ready` (card titled `[refactor] <domains>`, tag `#refactor-<domains>-<date>`) |
| `/cohorte-build`                                | `building`      |
| `/cohorte-review`                               | `review`        |
| `/cohorte-fix`                                  | `fix`           |
| loop workflow, per phase (`in-progress`) | `building` → `review` → `fix`, as each phase starts |
| a round gave up (`blocked`)             | `fix`           |
| `/cohorte-ship` starts                          | `ship`          |
| PR opened (`status: shipped`)           | `shipped` (+ `PR #<num>` on the card) |

**Backfill / sync from specs (reconcile).** `specs/*.md` is the source of truth. For each spec, read its
`feature_id` (front-matter or filename) and `status`, map `status`→column — `frozen`→`ready`,
`in-progress`→`building` (the phase is unknown from the status alone; the next live move corrects it),
`in-review`→`review`, `blocked`→`fix`, `shipped`/`merged`/`abandoned`→`shipped`, anything else / a spec with no
status→`spec` — then **full
sync**: card absent ⇒ add it in that column; card present ⇒ **move it** to that column so the board
always reflects the specs (this repositions cards the human may have moved by hand). Report cards
added vs. moved vs. already-correct.

**Create a board.** When linking a project with no board file yet: write
`<obsidian.vault_path>/<folder>/Tasks.md` with the `kanban-plugin: board` front-matter, one `## <heading>`
per configured column in pipeline order, and the closing `%% kanban:settings %%` block
(`{"kanban-plugin":"board","list-collapse":[false,…]}` with one `false` per column).
