## Decisions — the transverse decision journal

`PIPELINE.md` is a **stack profile** (surfaces, commands, conventions); it says nothing about what this
project has *decided*. Without somewhere for those, every `/cohorte-spec` re-discovers or contradicts them.
`specs/_decisions.md` (from `core/templates/decisions.template.md`) is that place, deliberately small:

- **Append-only, one line per decision, ≤ ~160 chars:**
  `- <YYYY-MM-DD> · <area> · <decision> — because <reason> · <origin>`, where `<origin>` is the
  `feature_id` that decided it — or the originating command (`retro`) when no single feature owns
  it. Reversal never edits a line:
  append a superseding one (`· supersedes <date> <area>`) and move the old one to `## Superseded`. When
  `## Live` passes ~100 lines, sweep the superseded ones down.
- **Written by** `/cohorte-spec` at freeze (the decisions that outlive the feature — typically 0–3 lines, and
  zero is a normal outcome), `/cohorte-build` §1.5 when it adds or splits a surface, and
  `/cohorte-retro` §4 when the human ratifies a convention rule (one line per adopted rule).
- **Read by the deciding stages only** — `/cohorte-brainstorm` (so the panel argues about the idea, not about
  settled ground), `/cohorte-spec` (so a new spec does not silently un-decide something), `/cohorte-audit` (standing
  decisions are part of the rulebook it audits against).
- **Never read by implementers or reviewers.** They work from the frozen contract, which already tells
  them what to do; shipping them the rationale would cost `surfaces × dispatches` tokens per feature
  for a fact they cannot act on. This is what keeps the journal cheap enough to be worth having.
- The `_` prefix is load-bearing: `/cohorte-doctor`, the `cohorte specs` scanner and the kanban backfill all skip
  `specs/_*.md`, so the journal is never mistaken for a spec (no phantom card, no bogus stage).
