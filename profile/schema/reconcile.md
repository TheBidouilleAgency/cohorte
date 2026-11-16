## Reconcile — bringing generated files up to the current core

`/cohorte-init-pipeline` is **one-time per project**. Afterwards, `/cohorte-update-pipeline` runs this procedure so a
core upgrade never requires re-running init — new pipeline features flow into the repo's generated
files automatically. It works because every generated artifact is a **deterministic function of
(current template × the profile's data)**; nothing needs re-detecting or re-interviewing.

1. **Profile top-up.** Diff `PIPELINE.md`'s machine block against the current
   `pipeline/PIPELINE.template.md`: every block/field the template has and the profile lacks is added
   with its documented default (e.g. `surfaces[].model: sonnet`, `retrieval.provider: serena`).
   **Ask only when a new field is a genuine human decision** (batch into ONE question set); never
   change a value the profile already sets; never rewrite the prose sections. `release_notes` is one
   such decision and must not be defaulted blind: detect a versioning tool / note-enforcing CI job per
   `/cohorte-init-pipeline` Phase 1, and if there is one, ask Phase 2's release-notes question (anchor
   package, language, bump policy, forbidden levels). No tool found ⇒ top up with `enabled: false`.
   Same for the 3.1 decisions: `commands.security` (ask init Phase 2's security question when a
   scanner is detected, else `[]`), `commands.dev_ready` / `smoke` / `e2e` / `migrate_down` +
   `verify.db` (ask the runtime-verification question when a dev server or e2e runner is detected,
   else leave `dev_ready` empty), and `project.kind` (top up as `web`; ask only if Phase 1 detection
   disagrees).
2. **Re-render agent frontmatter + body.** For each `surfaces[]` entry, re-render
   `<agents>/<agent>.md` from the current `implementer.template.md` per §Rendering (`<core>/pipeline/schema/rendering.md`). Safe by
   doctrine: rendered agents are regenerable artifacts — hand-written rules belong in `PIPELINE.md`
   §Conventions (which reconcile never touches), NOT in agent files, where they'd be clobbered here.
3. **Additive settings patch.** Run `<sync>` (it owns the gate hook, the pointer,
   `<state>/profile.json` and the `.gitignore` entries — so it runs AFTER step 1's top-up, and again
   if anything later edits the machine block), then bring `<state>/gate-config.json` and the `settings.json` permissions up
   to the current init spec (missing `allow` entries): add what's missing, never remove or rewrite
   existing/custom keys.
4. **Capability wiring.** If a top-up added a capability needing external setup (e.g. a `retrieval`
   provider whose MCP server isn't registered yet), run its wiring step from `/cohorte-init-pipeline` Phase 4.
   Even when nothing new was added, re-run the provider's health check (§Code retrieval, `<core>/pipeline/schema/retrieval.md`) — wiring
   rots (PATH changes, uninstalls, hand-edits) — and repair whatever fails.
5. **Global config seed.** If `<config>` is absent, seed it from the template
   (`profile/cohorte.config.template.yaml`) so the kanban + shared-vault config has a home. Never
   clobber an existing filled file; report what was seeded. Then **scrub the retired `telemetry:`
   block** if the file still carries one (every install seeded before 2.3.0 does): delete the block
   and its comment header, leaving the rest byte-identical. It is dead config — the sender is gone
   and nothing reads it — but a `telemetry.enabled: true` sitting in a file the human may open reads
   as "this is still sending", which is the one thing it must not imply. This is the single
   exception to "never rewrite the config": a targeted deletion of a block the core no longer
   defines, never a re-seed.
5b. **CI doctor pin.** If `.github/workflows/*.yml` runs `npx -y cohorte@<x> doctor`, bump `<x>` (both
   occurrences) to the installed core version.
6. **Kanban sync.** Run the §Kanban reconcile (`<core>/pipeline/schema/kanban.md`): link/create the project's board if configured, verify
   its columns, and backfill/sync cards from `specs/*.md`.
7. **Spec-template top-up.** `specs/_template.md` is seeded once at install and then **never**
   refreshed, so a repo keeps whatever front-matter the core shipped the day it was installed (a
   pre-1.6 copy's `status` comment still lists four states). Top it up the same way as the profile:
   add the **front-matter fields** the current `templates/spec.template.md` has and the repo's copy
   lacks, with their documented defaults, drop `loop_pass`/`loop_phase` (retired with the 2.2.0
   conversational loop driver), and refresh the `status:` comment. Never rewrite its body — the section list is the human's to shape,
   and some repos have deliberately trimmed it. Nothing breaks without this (the fields are written on
   demand when a driver needs them); it just keeps a new spec's front-matter honest about the states
   the pipeline can put it in.

8. **Local-artifact hygiene.** The pipeline's own runtime files must stay out of git:
   `<state>/preflight.ok`, `<state>/pipeline-metrics.jsonl`, `specs/reports/`. Add any missing entry to
   `.gitignore`, and **untrack** what a pre-2.0.0 install let slip in —
   `git rm --cached --ignore-unmatch <state>/preflight.ok` (repeat per stray path). The stamp is the
   one that actively breaks: it records the tree it verified, the commit carrying it moves HEAD past
   that tree, and the committed copy lands in every clone and worktree — so the phase gate ends up
   blocking clean trees and greening unchecked ones. Report what was untracked; the human commits it.

Re-running `/cohorte-init-pipeline` remains possible (it reconciles too) but is only *needed* when the stack
itself changes in ways `/cohorte-build` §1.5 can't auto-grow (e.g. package manager or contract mechanism swap).
