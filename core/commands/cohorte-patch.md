---
description: Triage a bug and freeze a minimal patch spec — the cheap entry into the pipeline for a fix, no brainstorm, no contract.
argument-hint: [bug description / stack trace / issue text — or empty to pick from the kanban]
---

You run the **patch triage** in the main thread — interactive, with the human. This is the bug-fix
entry point: it produces `specs/patch-<slug>.md` and stops. Everything after it is the normal
pipeline (`/cohorte-build` → `/cohorte-review` → `/cohorte-fix`* → `/cohorte-ship`), unchanged — the
patch spec is a spec, so those commands consume it as-is. Splitting it this way is the point: each
phase is a fresh session with the artifact on disk, instead of one long thread paying for the whole
cycle at input price on every turn.

Bug (may be empty): **$ARGUMENTS**

> Read `PIPELINE.md` §`pipeline-profile` first: `surfaces` (paths — this is what you map the bug onto)
> and `vcs`. _Skip the re-read if it's already in your context this session and unmodified since._
> Do NOT read `specs/_decisions.md`: a bug fix decides nothing transverse, and the journal is for
> decisions that outlive a feature.
>
> **Kanban** (SCHEMA.md §Kanban): two moves, and their **order is load-bearing** — §1 settles the
> slug and moves the card to `spec`, §4 moves it to `ready` at freeze. Both are one call to
> `<core>/pipeline/scripts/kanban-move.sh auto patch-<slug> <stage> [--title "[patch] <human title>"]`.
> The slug is settled first precisely because the move needs it: a card cannot be joined on an id
> that doesn't exist yet. `auto` resolves the board from the config itself and exits 0
> with a `kanban: <reason>` line when there is none — so **never decide "no board is configured"
> without running it**. Reading the Ideas column at §1 still needs the board path: get it from a
> `kanban-move.sh` run, or grep the config for `boards[<PIPELINE name>]`.

## 1. Get the bug

If `$ARGUMENTS` is non-empty, restate it in one line and confirm you've got it — and if it is
(or names) a slug with a staged `specs/reports/intake-<slug>.md`, **read that file first**: it is
`/cohorte-intake`'s distillate (symptom, repro with inferred steps labeled, environment, suspected
surfaces, severity signal), so this triage starts loaded instead of re-asking. Keep intake's slug —
its kanban card is already tagged `#patch-<slug>` and titled `[patch] …`, exactly what the move
below joins on.

If it is empty: when a board is configured and its **Ideas** column has cards, list them (with any
sub-bullet notes as context) — **cards titled `[patch]` first**, since those are the ones a human
filed as bugs — and let the human pick one. Otherwise ask **"What's broken?"**. Either way, wait.

Then **settle the id, before anything moves.** Derive `<slug>` (kebab-case, from the symptom —
`500-on-empty-cart`, not `bug-42`) and confirm it. The `feature_id` is **`patch-<slug>`**, prefix
included: it is the join key for the kanban card, the spec filename, the branch and every later
command, so the prefix is part of the id itself, not decoration on the card.

**Kanban, in this order:**

1. **If the human picked an Ideas card, tag it FIRST.** Ideas cards are free text with no
   `#<feature_id>`, and the move script joins on that tag: move before tagging and it finds nothing,
   creates a second card, and strands the untagged original in Ideas forever. One targeted Edit
   appending `  #patch-<slug>` to that line, located by `grep -n` — never a full board read.
2. `<core>/pipeline/scripts/kanban-move.sh auto patch-<slug> spec --title "[patch] <human title>"` —
   which moves the (now tagged) card, or creates one under `--title` if the human typed a fresh bug.
   Report what it printed — `moved #…` or `kanban: <reason>` — never a guess about which happened.

## 2. Triage — three questions, not an interview

`/cohorte-spec` walks a template section by section because a feature has to be *designed*. A bug is
already specified by reality; your job is to pin it down, not to explore it. Ask only what you
genuinely cannot infer from the input, batched into ONE message:

1. **Repro** — the shortest deterministic path to the symptom. No repro ⇒ ask whether they want you
   to go find one first (a diagnosis session, no spec) or to freeze it as a hypothesis and let the
   implementer confirm. Never invent a repro to fill the section.
2. **Expected behaviour** — often the whole spec. "It should 404, not 500" is a complete contract.
3. **Blast radius** — what must NOT change. This becomes §7 Out of scope, and it is what stops a fix
   from becoming a refactor.

Then locate it yourself — do not make the human do it. Use the retrieval provider if one is wired,
else grep for the symptom's strings/identifiers. Read only the files the trail actually names.
Report the suspected `file:line` in one line and let them confirm or correct it.

## 3. Map it onto surfaces — as many as it takes

Match the suspected cause and the fix's blast radius against `surfaces[].path`. **A patch is not
capped at one surface**: a bug that spans an API validator and the form feeding it is one bug with
one repro, and splitting it into two specs would give each half a contract it doesn't have. List the
surfaces you're claiming, one line each, with why.

**The one escalation that is not a judgment call:** if the fix needs **new** contract surface area —
a new endpoint, a new shared type, a new field crossing surfaces — stop. That is a feature wearing a
bug's clothes, and §5 is the only channel that keeps two surfaces in agreement about a shape that
doesn't exist yet. Say so plainly and send the human to `/cohorte-spec`. Changing an **existing**
contract entry is fine: describe the delta in §5 and continue.

## 4. Freeze the patch spec

Write `specs/patch-<slug>.md` from `<core>/templates/patch.template.md` with `status: frozen`, filled
from §§1–3. **Create the file — do not ask the human to.** Budget: **~60 lines**. A patch spec that
wants 200 is a feature or a refactor — say which and route it (`/cohorte-spec`, or an item on
`specs/refactor-backlog.md`).

Two sections carry the weight, and both are cheap to get wrong:

- **§4 Regression test** — name the test file and what it asserts. It replaces §5 as the thing the
  reviewer checks the diff against, so "add a test" is not enough: say what fails today and why. A
  patch whose test can only be written after the cause is found says exactly that.
- **§5/§9 keep the feature spec's numbers** (contract delta, acceptance). `review.md` and
  `implementer.template.md` name "contract §5, acceptance §9" verbatim — renumbering them here would
  silently point both agents at the wrong section. The template already does this; don't "fix" it.

**Postcondition:** `grep -q '^status: frozen' specs/patch-<slug>.md` — if it fails the freeze didn't
land; fix it before pointing the human at `/cohorte-build`. Chain the second kanban move onto that
same Bash call — `kanban-move.sh auto patch-<slug> ready` (the card is already tagged and on the
board from §1, so this one needs no `--title`) — and report what it printed: `moved #…` or
`kanban: <reason>`, never a guess.

## 5. Hand off

Print the spec path, the surfaces, and the branch to cut: `<prefix>patch-<slug>`, where `<prefix>` is
`vcs.patch_branch_prefix` — falling back to `fix/` on a profile that predates the key. If `isolation.enabled`
and the fix is big enough to want its own worktree, mention `scripts/new-feature.sh patch-<slug>`;
most patches don't need it.

Then: `/cohorte-build patch-<slug>` — and **recommend a `/clear` first**. The spec is on disk; the
lead's triage history is re-sent at input price on every turn it survives, and `/cohorte-build`
re-reads everything it needs.
