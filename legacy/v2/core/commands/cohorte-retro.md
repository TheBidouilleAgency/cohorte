---
description: Mine the accumulated review findings across features for repeating patterns, and turn the ones the human ratifies into PIPELINE.md §Conventions rules the next build already follows.
argument-hint: [last <n> | all]  (default: every feature with a report on disk)
---

You are running the **retrospective**. Every review this pipeline has run left structured
residue on disk — verdicts, Remediation rounds, deferred backlog items. A finding that shows up
once is a bug; the same finding shape across features is a **missing rule**, and the pipeline
has a place for rules the implementers actually read: `PIPELINE.md` §Conventions, baked into
each surface agent at render time. This command closes that loop: findings → patterns →
ratified rules → re-rendered agents. The next build then never produces the finding again —
which is cheaper than any number of review rounds catching it.

> Read `PIPELINE.md` §`pipeline-profile` (`surfaces`, and skim the existing §Conventions
> stanzas — a rule that already exists is a finding about *enforcement*, not a missing rule)
> and `specs/_decisions.md` §Live. _Skip the re-read if already in context and unmodified._

## 1. Collect — mechanical, redirected, no judgment yet

Scope: `all` (default), or `last <n>` features by spec mtime. In as few Bash calls as possible,
**always redirected to `specs/reports/retro-scan.txt` and grepped — never into your context**:

- `specs/reports/*.verdict.json` — per feature: `blocking_items` (normalized identities),
  `severity`, per-surface counts. The freshest machine record, one per feature.
- Every non-`_` spec's `## Remediation` section — the **persistent** history (verdict.json is
  overwritten per round; Remediation accumulates, and collapsed rounds still carry their
  count line). Grep the item lines: `- [x?] <SEVERITY> · <file:line> · <kind> · <fix>`.
- `specs/refactor-backlog.md` — the `deferred:<id>` tagged items: debt reviews kept finding
  but no feature owned.

A repo with fewer than two features' worth of residue ⇒ say the retro has nothing statistical
to stand on yet, name what exists, and stop — one feature's findings are that feature's story,
not a pattern.

## 2. Patterns — what repeats, with the evidence attached

A **pattern** is a finding shape that recurs where recurrence means something:

- same `kind` × same surface across **≥ 2 features** (e.g. `security` findings on `backend`
  twice running — the strongest signal there is);
- the same file/module named by findings from **≥ 2 features** (a hotspot no single fix loop
  owns);
- the same *fix wording* family recurring (e.g. three "add the authz check" fixes = one
  missing authorization convention);
- a `deferred:` cluster in one domain — debt the reviews keep re-discovering because no rule
  makes the implementers avoid adding to it.

For each pattern, produce: the evidence lines **verbatim** (`<feature> · <severity> · <file> ·
<problem/fix>`), the count, and ONE drafted convention rule — **rule-shaped**: a sentence an
implementer can follow and a reviewer can test a diff against, placed under `### Shared` or the
owning `### Surface: <key>`. Not advice ("be careful with auth") — a rule ("every route under
`apps/api/src/routes/` calls `authorize()` before its handler; no exceptions without a spec
§5 note"). Skip any pattern the existing §Conventions already covers — report those separately
as **enforcement gaps** (the rule exists and reviews keep finding violations: that is input for
the human, not a new rule).

## 3. Ratify — the human picks; nothing lands without them

Present a compact table: pattern → evidence count → drafted rule → target stanza. Then **stop
and ask** which to adopt (all / some / none — none is a fine outcome and says the rulebook fits
the codebase). Rules are standing law every future dispatch pays tokens to carry: the human
decides what becomes law, exactly as they freeze specs.

## 4. Apply — and keep the baked slices honest

For each adopted rule, in this order:

1. Append it to `PIPELINE.md` §Conventions under its stanza (create the `### Surface: <key>`
   stanza if absent; keep it rule-shaped, one line each).
2. **Re-render every affected surface agent** per SCHEMA.md §Rendering step 2 — the
   `<SURFACE_CONVENTIONS>` slice is **baked at render time**, so a §Conventions edit without a
   re-render produces the worst outcome available: reviewers (who read the prose live) enforce
   a rule implementers (who carry the stale bake) have never seen, and every future review
   round re-finds the pattern this retro just paid to close. If you cannot re-render on this
   runtime, say so and route to `/cohorte-update-pipeline` (its reconcile step 2 re-renders) —
   but then the rule is **pending**, and you say that too.
3. Append ONE line per adopted rule to `specs/_decisions.md` §Live (SCHEMA.md §Decisions):
   `- <date> · conventions · <rule, compressed> — because <kind>×<n> across <features> · retro`.
   A retro rule is a standing decision; the journal is where the next `/cohorte-spec` learns it
   without re-mining the reports.

In chat print ONLY: patterns found / adopted / skipped (one line each), enforcement gaps, which
agents were re-rendered (or the pending route), and the decisions lines appended. The evidence
stays in `specs/reports/retro-scan.txt`. **Recommend a `/clear`** — everything that matters is
now in `PIPELINE.md`, the rendered agents, and the journal.
