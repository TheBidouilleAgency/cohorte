---
model: sonnet
description: Write the feature's entries in the learning journal — every finding, red check, correction and overridden decision as a reusable pattern — for /cohorte-retro to count.
argument-hint: <feature_id> [merged|abandoned]
---

You are the **lead**, closing feature **$ARGUMENTS** (the first word is the feature id; the second, when
present, says how it ended). The feature's mistakes are about to disappear with its report buffer. Your
job is to keep what they teach: one journal entry per thing the pipeline got wrong, written as a
**pattern** the next retro can count — never as this feature's story.

> Read `.claude/profile.json` `surfaces` (the parsed `pipeline-profile` block; absent ⇒ that block in
> `PIPELINE.md`) and skim `PIPELINE.md` §Conventions — each rule has a stable id (`SH-…`, or the
> surface's prefix) that an entry cites when a rule existed and was not followed.

## 1. Sources — all of them, bounded

Read only these, with offset-limited Reads or greps, never into your context whole:

- `specs/$ARGUMENTS.md` `## Remediation` — every round of review findings and how they were fixed;
- `specs/reports/$ARGUMENTS.md` and `.verdict.json` — the last review (findings, deferred items);
- `specs/reports/$ARGUMENTS.verify.json` — failing runtime checks, if any;
- `specs/reports/$ARGUMENTS.notes.md` — the implementers' assumptions, questions and **learnings**;
- `specs/reports/$ARGUMENTS.decisions.md` — written by `cohorte ui`: decisions taken mid-run (by the
  decider or the developer), the ones the developer **contested**, and the **corrections** they asked
  for at a checkpoint. A contested decision and a correction are the strongest signals there are: the
  pipeline did something its owner did not want.
- the PR's checks when `gh` is available (`gh pr checks` on the branch) — a red check that a fix round
  had to address.

Absent files are normal; say which sources existed.

## 2. Entries — patterns, not anecdotes

Keep an entry for: a CRITICAL/HIGH or security finding, a finding that took more than one round, a red
preflight or CI check, a correction asked by the developer, a contested decision, a trap an implementer
reported (environment, tooling, a misleading convention). Skip LOW nits and anything a formatter fixes.
Typical yield: 0–8 entries. Zero is a fine outcome for a clean feature.

Before writing, list the motifs already used: `grep -h '^- motif:' "$(dirname "$(git rev-parse --git-common-dir)")/.claude/journal/"*.md 2>/dev/null | sort | uniq -c`
— **reuse a motif rather than invent a synonym**: the motif is what the retro counts.

Write `$(dirname "$(git rev-parse --git-common-dir)")/.claude/journal/<YYYY-MM-DD>-$ARGUMENTS.md` — the
**main checkout's** journal (the worktree dies at teardown; the journal accumulates across features;
`cohorte sync` gitignores it — it is raw material, the ratified rules are what gets committed). One Bash
heredoc, creating the directory first. Each entry exactly:

```markdown
## $ARGUMENTS-<R1|CI1|H1|D1…>

- surface: <surface key | cross-surface>
- source: review | verify | ci | correction | contested-decision | implementer
- severity: blocking | major | minor
- motif: <stable kebab-case category, e.g. missing-authz-check, untested-error-path, contract-drift>
- what happened: <one or two sentences — the shape of the defect, never real data>
- rule that would have prevented it: <an imperative rule an implementer can follow and a reviewer can check, or "none">
- existing rule: <the §Conventions id that should have prevented it, or "none">
```

Never copy real data into an entry — no customer names, credentials, tokens, personal data, URLs with
secrets: describe the shape of the data, not the data.

## 3. Report

In your final message: the number of entries, their motifs, and — when the journal now holds the same
motif from **two or more** features, or 10+ entries no retro has processed — one line suggesting
`/cohorte-retro`. Do not run it.
