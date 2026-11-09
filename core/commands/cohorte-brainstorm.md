---
description: Interactive multi-persona panel that challenges and clarifies a feature idea before speccing.
argument-hint: [one-line idea (optional)]
---

You are facilitating an **interactive brainstorm** for a new feature. This runs in the main thread — a
back-and-forth with the human, NOT a one-shot. Do not write any files — the TWO exceptions are staging
the return at Finish (`specs/reports/<feature_id>-brainstorm.md`) and moving this feature's kanban card
at Finish, when a board is configured.

> Read `PIPELINE.md` §Personas (the panel) and §`rbac` first. If `rbac.enabled`, the panel must
> pressure-test the idea so it serves **every** role, not just admins.
>
> Also read `specs/_decisions.md` §Live if it exists (SCHEMA.md §Decisions) — one line per standing
> decision. The panel argues about the idea, not about settled ground: a persona that proposes
> something a live line already decided must be told so by another persona, and an idea that genuinely
> needs to overturn one must say which line, out loud, so the human decides it here rather than
> discovering the contradiction at `/cohorte-spec`.
>
> **Kanban** (SCHEMA.md §Kanban): every card move below is one call —
> `<core>/pipeline/scripts/kanban-move.sh auto <feature_id> <stage> [--title "<human title>"]`, with
> `auto` resolves the
> board from `<config>` itself and exits 0 with a `kanban: <reason>` line when
> none resolves — so **never decide "no board is configured" without running it**. Reading the Ideas
> column at Start still needs the board path: get it from a `kanban-move.sh` run, or grep the config
> for `boards[<PIPELINE name>]`.

Idea (may be empty): **$ARGUMENTS**

## Start

If the idea is empty: when a board is configured and its **Ideas** column has cards, list them (with any
sub-bullet notes as seed context) and let the human pick one — otherwise ask **"What are we building?"**.
Either way, wait. If the idea is non-empty, restate it in one line and confirm you've got it — and
**if `specs/reports/intake-<idea>.md` exists, read it FIRST**: it is `/cohorte-intake`'s staged seed
(who is asking with verbatim quotes, goals/non-goals, an open-questions list that is this panel's
agenda, prior art incl. any `_decisions.md` line the request contradicts). The panel argues against
the distillate, never against the bare slug.

## Run the panel

Role-play the roundtable defined in `PIPELINE.md` §Personas — each member with a job AND a personality
who challenges the idea from their angle. They must **disagree** with each other and the human; never
just transcribe. If the profile has no personas, use a default panel (PM · skeptical senior engineer ·
UX/product designer · security). When `rbac.enabled`, ensure a voice for each role so the feature isn't
single-role.

Each round: 2–4 named personas speak, surface tensions + open questions, then **ask the human a focused
question** and wait. Iterate until the idea is genuinely clear: scope, affected roles, rough data +
screens, risks, and what's explicitly out.

## Finish

When the human is satisfied, produce the **brainstorm return** by filling
`<core>/templates/brainstorm-return.md` and **staging it to
`specs/reports/<feature_id>-brainstorm.md`** (the gitignored buffer dir — `/cohorte-spec` reads it from there
when invoked with no paste). In chat print only a 3-line summary + the path. Tell them to run `/cohorte-spec`
— **recommend a `/clear` first**, the return is staged on disk (pasting it remains a fallback).

**Kanban:** settle the `feature_id` (kebab-case slug) the return carries — it is the card's join key
downstream. Then, in this order:

1. **If the human picked an Ideas card, tag it first.** Ideas cards are free text a human typed, with
   no `#<feature_id>` on them, and the move script joins on that tag: move before tagging and it
   finds nothing, creates a second card, and leaves the untagged original sitting in Ideas forever.
   One targeted Edit appending `  #<feature_id>` to that line, located by `grep -n`, never a full
   board read.
2. `<core>/pipeline/scripts/kanban-move.sh auto <feature_id> brainstorm --title "<human title>"` —
   which moves the (now tagged) card, or creates one under `--title` if the human typed a fresh
   idea. Read its output: `moved #…` or `kanban: <reason>`. Never assume either.
