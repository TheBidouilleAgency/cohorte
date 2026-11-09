---
description: Interactively capture a frozen feature spec (or apply a review return) into specs/<id>.md.
argument-hint: [paste brainstorm return OR review report]
---

You run the **spec** step in the main thread — interactive, with the human. Pasted input below:

**$ARGUMENTS**

> Read `PIPELINE.md` first: `contract` (mechanism/path — so §5 names the right schema types),
> `design.enabled` (whether §8 matters), and §Conventions. Use `specs/_template.md` as the section list.
>
> **Decision journal** (SCHEMA.md §Decisions): read `specs/_decisions.md` §Live if it exists — one
> line per standing decision, so it is cheap. It is the ONLY place the project's transverse rules
> live; a spec that contradicts one silently un-decides it. Absent ⇒ nothing to honour yet.
>
> **Kanban** (SCHEMA.md §Kanban): when the spec opens, run
> `<core>/pipeline/scripts/kanban-move.sh auto <feature_id> spec --title "<human title>"`; on freeze
> (`status: frozen`, Mode A), the same call with `ready`. `auto` resolves the board from the config itself and exits 0 with a
> `kanban: <reason>` line when there is none — so **never decide "no board is configured" without
> running it**.

Detect the mode from the pasted content:

## Mode A — new spec (input is a brainstorm return, or empty)

1. If empty, look for a staged brainstorm return first — `specs/reports/*-brainstorm.md` (where
   `/cohorte-brainstorm` stages its output); one match ⇒ read it and confirm, several ⇒ ask which. None ⇒
   ask the human to paste the return (or describe the feature) and wait.
2. Derive a `feature_id` (kebab-case slug). Confirm it.
2b. **Size budget — a spec is a contract, not a novel.** Target ≤ ~300 lines; hard-think at 500.
   Every implementer re-reads the whole spec on every first build, so each extra line is paid
   `surfaces × dispatches` times. If the feature genuinely needs more, that's the signal it is TWO
   features: propose a split (e.g. `<id>-core` + `<id>-admin`, each independently shippable, the
   second consuming the first's contract) and let the human pick. Trim the usual bloat before
   writing: exhaustive UI walkthroughs (the design brief carries those), restated conventions
   (PIPELINE.md carries those), speculative edge cases nobody asked for.
3. Walk the human through each section of `specs/_template.md`, **section by section**, with focused
   questions. The critical one is **§5 API CONTRACT** — pin down every endpoint/interface (method, path,
   auth/role, request fields with types/validation, success envelope + data shape, and every error case),
   and name the exact schema/types that will live in the contract file (`contract.path/<id>.<ext>` in the
   profile's `mechanism`). Don't move on until frontend and backend could each build from it with zero
   further questions. _If `contract.enabled` is false, capture the interface precisely in prose instead._
4. Capture the **design brief** content (only if `design.enabled` / the feature has UI): screens,
   states, components, responsive notes — it will be authored to `specs/design/<id>.md` in step 6;
   spec §8 carries only a short summary + the pointer `> full brief: specs/design/<id>.md` (so
   non-design surfaces never re-read the full brief on every dispatch).
4b. **New-surface heads-up.** If the feature clearly introduces an area no existing `surfaces[].path`
   owns (a new service/app/top-level module), note it in the spec (a line in the relevant task section:
   `> needs new surface: <proposed key/path>`). Don't render agents here — `/cohorte-build` §1.5 auto-reconciles
   it. This is just so the human isn't surprised when `/cohorte-build` proposes a new agent.
5. When the human validates, **freeze**: write `specs/<id>.md` (`status: frozen`, front-matter filled).
   Create the file — do not ask the human to. **Postcondition:** `grep -q '^status: frozen' specs/<id>.md`
   — if it fails the freeze didn't land; fix it before pointing the human at `/cohorte-build`.
5b. **Record the transverse decisions — the journal, not a summary.** Walk what the interview settled
   and keep ONLY the decisions that **outlive this feature**: a rule the next spec would otherwise
   re-litigate or contradict (auth model, id/naming scheme, where a kind of state lives, an error
   convention, a deliberate non-goal that binds future features). Typical yield: **0–3 lines**; zero
   is a normal, healthy outcome for a feature that decided nothing new — never invent lines to fill
   the section. Append them to `specs/_decisions.md` §Live (create the file from
   `<core>/templates/decisions.template.md` on first use), each exactly:
   `- <YYYY-MM-DD> · <area> · <decision> — because <reason> · <feature_id>`
   - **Never** duplicate what §5, `PIPELINE.md` §Conventions or the code already states — the journal
     carries the *non-obvious rule*, not the feature's content. A line that restates a spec section is
     a line every future `/cohorte-spec` pays for and learns nothing from.
   - **Contradicting an existing line** is allowed but never silent: tell the human which line this
     feature overrides, get their go-ahead, then append the new line with
     `· supersedes <YYYY-MM-DD> <area>` and move the old one to `## Superseded`.
   - Append with one `>>` Bash call, not a full-file rewrite (the file is append-only, and reading it
     back to re-write it is the one way to make a bounded file expensive).
6. Author the **design brief** — `specs/design/<id>.md`, rendered via
   `<core>/templates/design-brief.md`.
   _Only if `design.enabled` / the feature has UI; skip entirely for a backend-only feature._
   - **Write it to `specs/design/<id>.md`** (the authored artifact, versioned with the spec; spec §8
     holds the summary + pointer). Create the file — do not ask the human to. Keep it in the
     `specs/design/` subfolder, **not** `specs/<id>....md`: the `specs/*.md` glob that drives the
     kanban backfill and `/cohorte-doctor` is non-recursive, so a brief in the subfolder never gets mistaken
     for a spec (no phantom card, no bogus stage). Overwrite it on every freeze.
   - Print ONLY the path + a one-line summary — never echo the brief into chat (it would sit in this
     session's history; echo it only if the human asks). Tell the human: copy it from
     `specs/design/<id>.md` into the design tool (if any — typically a fresh design project for this
     feature), then run `/cohorte-build <id>` and hand its design gate the resulting page link(s) — a full
     `https://claude.ai/design/p/<projectId>?file=<file>` link carries its own project + page, no
     profile change needed. (They can also paste the links into the spec's `design_files` themselves.)
     **Recommend a `/clear` before `/cohorte-build`** — the frozen spec + `specs/design/<id>.md` are the whole
     handoff.

## Mode B — review return (input is a REVIEW REPORT)

1. Read the report — pasted as input, or (whenever nothing is pasted) read from
   `specs/reports/<id>.md`, where `/cohorte-review` stages its last report. Identify `feature_id` from its
   header; open `specs/<id>.md`.
2. Append each finding to the spec's **`## Remediation`**, one per line:
   `- [ ] <severity> · <file:line> · <spec-violation|quality|security|complexity> · <concrete fix>`
   (Keep prior items; add the new round under a dated/numbered subheading.)
3. If a finding implies the **contract** must change, update §5 and flag it so the lead re-authors the
   contract file.
4. Set `status: in-review`. Tell the human to run `/cohorte-build <id>` to re-dispatch fresh agents.
   **Recommend a `/clear` before `/cohorte-build`** — the spec is the whole handoff.

In both modes the spec is the single source of truth; agents are stateless and read only it + the diff.
