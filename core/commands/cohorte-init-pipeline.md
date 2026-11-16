---
description: Detect this project's stack, interview the gaps, and generate PIPELINE.md + render the agents so the portable pipeline fits this repo.
argument-hint: (none) — one-time per project; afterwards /cohorte-update-pipeline keeps everything current
---

You are the **pipeline installer**. Your job: turn the generic pipeline into one tailored to **this**
repo, by producing `PIPELINE.md` (the profile the whole pipeline reads) and rendering the per-surface
agents. Interactive — confirm inferences with the human.

> **Bootstrap (applies to every step):**
>
> **One mode.** The commands and the generic core are installed once per machine (`<core>`).
> **Everything you GENERATE is written into THIS repo and committed with it** — `PIPELINE.md` at the
> root, the surface agents under `<agents>/`, `<state>/gate-config.json` — and the gate hook, its
> registration, the `<state>/pipeline.json` pointer and the `.gitignore` entries are written by
> `<sync>`, never by hand. Nothing project-specific ever goes under `~/.claude`.
>
> Work in phases. Do not write any file until Phase 4.

## Steps — run in order

| # | Step | Does | When |
| --- | --- | --- | --- |
| 01 | `01-detect-stack` | Detect stack, read-only — no questions yet | always |
| 02 | `02-interview-gaps` | Ask only the gaps you couldn't detect | always |
| 03 | `03-draft-profile` | Assemble & show the PIPELINE.md draft | always |
| 04 | `04-write-render` | Write files & render surface agents | after go-ahead |
| 05 | `05-report` | Print files, mapping, next steps | always |

**Before running a step, read its file** in `<core>/templates/steps/init-pipeline/`. This table is a map, not the instructions.
