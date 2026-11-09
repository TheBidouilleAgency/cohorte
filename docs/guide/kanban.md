# Kanban mirror (Obsidian)

An **optional, user-scoped** mirror of the dev flow: each pipeline stage moves a card across an
[Obsidian Kanban](https://github.com/mgmeyers/obsidian-kanban) board — one board per project.
Everything no-ops silently when it isn't configured; the pipeline never blocks on the board.

## Why user-scoped

The board lives in your **personal vault**, so its path is machine-specific — it belongs in the
global `~/.claude/cohorte.config.yaml`, never in the committed `PIPELINE.md`. Boards are keyed by
the project's profile `name`:

```yaml
obsidian:
  vault_path: "/Users/you/Vault"
kanban:
  enabled: true
  columns: { ideas: "Ideas", brainstorm: "Brainstorm", spec: "Spec", ready: "Ready to build",
             building: "Building", review: "Review", fix: "Fix", ship: "Ship", shipped: "Shipped" }
  boards:
    MyProject:
      board: "MyProject/Tasks.md"
```

Because the key is the profile `name`, **renaming a project unlinks its board**: the old key no
longer matches and the lookup legitimately finds nothing. `/cohorte-update-pipeline` detects the
orphaned entry and offers to re-key it; `kanban-move.sh --check` tells you where you stand.

Wired for you by `/cohorte-init-pipeline` (opt-in question) or `/cohorte-update-pipeline` — including creating
the board file with the right front-matter, one heading per column, and the plugin settings
block. Don't hand-edit the config; the `# cfg:` anchors in it are what the installer prompts
write to.

## Cards and the join key

A card is a list item under a `## <column>` heading:

```
- [ ] Invoice CSV export  #facture-export — PR #42
```

The `#<feature_id>` tag is the **join key** between the card and `specs/<feature_id>.md` — it's
how every stage finds *its* card. Free-text sub-bullets under an **Ideas** card are seed context
`/cohorte-brainstorm` picks up.

A `[<kind>]` prefix in the title is a **human convention, not a mechanism** — nothing parses it, and
you can use whatever set fits your board (`[chore]`, `[premium]`, `[base]`…). Cohorte only writes
one itself: `/cohorte-patch` titles its cards `[patch] <title>`, and reads the prefix back when it
offers the **Ideas** column, listing `[patch]` cards first. So a bug you drop in Ideas as
`- [ ] [patch] 500 on empty cart` is what `/cohorte-patch` picks up with no argument. Once shipped, `/cohorte-ship` appends the PR number — which `cohorte specs` reports
as a clickable link with live open/merged/closed status.

## Stage → column

| Pipeline moment | Column |
| --- | --- |
| human drops a raw idea | `ideas` |
| `/cohorte-brainstorm` picks it up | `brainstorm` |
| `/cohorte-spec` opens (draft) | `spec` |
| `/cohorte-spec` freezes | `ready` |
| `/cohorte-patch` triages, then freezes | `spec` → `ready` |
| `/cohorte-build` | `building` |
| `/cohorte-review` | `review` |
| `/cohorte-fix` | `fix` |
| a round is under way (`in-progress`) | `building` |
| a round gave up (`blocked`) | `fix` |
| `/cohorte-ship` starts | `ship` |
| PR opened | `shipped` (+ `PR #<num>`) |

## The move script

Commands move cards through the shipped script — the whole operation happens outside the agent's
context (find, dedupe, sub-notes carried along, settings block preserved):

```sh
<core>/pipeline/scripts/kanban-move.sh auto <id> <stage> [--pr <num>] [--title <title>]
```

It creates the card in the target column when none exists, keeps the first and drops duplicates.

`auto` is the important word. The script resolves the board itself — profile `name`, then
`kanban.enabled`, `obsidian.vault_path` and `boards[name]` — and maps the **stage key** to that
board's heading. When nothing resolves it prints `kanban: <reason>` and exits 0; a board that is
configured but unmovable exits non-zero. Commands are told to run it and report what it said, never
to decide for themselves that there is no board: that inference, in a fresh phase session that had
never opened the config, is what used to strand cards mid-pipeline while every stage still reported
success.

`kanban-move.sh --check` does the resolution alone — the quickest answer to "is this project's board
actually wired?". Every call site chains `|| true`, so a missing script is still silent;
`/cohorte-doctor` is what catches a half-copied core.

## Backfill / sync

`specs/*.md` is the source of truth. The reconcile (run by `/cohorte-update-pipeline`, and at board
creation) maps each spec's `status` to a column (`frozen`→ready, `in-review`→review,
`shipped`→shipped, else spec) and **fully syncs**: missing cards are added, existing cards are
*moved* to the right column — the board always reflects the specs, even where a human dragged
cards around.
