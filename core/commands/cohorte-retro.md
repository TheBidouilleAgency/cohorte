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

> Read `.claude/profile.json` `surfaces` (the parsed `pipeline-profile` block; absent ⇒ read that block in `PIPELINE.md`), and skim `PIPELINE.md`'s existing §Conventions
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
- **The learning journal** — `$(dirname "$(git rev-parse --git-common-dir)")/.claude/journal/*.md`
  (not `processed/`), one file per feature, written by `/cohorte-learn` when a feature merged or was
  abandoned. It is the richest source: besides review findings it carries red CI and preflight checks,
  **corrections the developer asked for at a checkpoint**, **decisions the developer contested** (the
  autopilot's decider chose, they disagreed) and implementer traps. Grep its `- motif:`, `- source:`,
  `- severity:`, `- existing rule:` and `- rule that would have prevented it:` lines — the motif is the
  counting key.
- The rules already rejected — `specs/_decisions.md` lines with `· conventions · rejected` — so a rule the
  human turned down is never proposed again unless new evidence changes the case (say so when it does).

Normalise synonym motifs first (`missing-authz` and `authz-check-missing` are one motif) and say
which you merged. A repo with fewer than two features' worth of residue ⇒ say the retro has nothing statistical
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
  makes the implementers avoid adding to it;
- the same journal **motif** across ≥ 2 features, or a single **blocking** one (a security finding, a
  contested irreversible decision) — one occurrence is enough when the cost was that high;
- the same **correction** or **contested decision** twice — the developer keeps steering the pipeline
  the same way: that is a preference the rules should carry, so it stops being asked or redone.

For each pattern, produce: the evidence lines **verbatim** (`<feature> · <severity> · <file> ·
<problem/fix>`), the count, and ONE drafted convention rule — **rule-shaped**: a sentence an
implementer can follow and a reviewer can test a diff against, placed under `### Shared` or the
owning `### Surface: <key>`. Not advice ("be careful with auth") — a rule ("every route under
`apps/api/src/routes/` calls `authorize()` before its handler; no exceptions without a spec
§5 note"). **Prefer a check to a sentence.** When the pattern can be caught mechanically — a lint rule, a test, a
grep in `commands.preflight`/CI — propose that instead of (or alongside) a prose rule, as a concrete
change the human can turn into a tech ticket. Prose rules cost tokens on every dispatch forever; a check
costs nothing and never drifts.

A pattern the existing §Conventions already covers is an **enforcement gap**: the rule exists and the
journal or reviews still cite it (`existing rule: <id>`, or a `[<id>]` review citation). It is not a new
rule — it is a rule that **does not work**. Propose ONE of: reword it (sharper, testable), move it into a
check, move it to the surface whose agent keeps breaking it, or retire it. Never just repeat it.

## 3. Ratify — the human picks; nothing lands without them

Present a compact table first: pattern → evidence count → drafted rule (or check, or rework) →
target stanza. Then put each proposal to the human **one at a time** with AskUserQuestion — the exact
rule text, its evidence count and target in the question — options: **Ratify** · **Ratify with a change**
(they type it) · **Reject** · **Later**. None ratified is a fine outcome and says the rulebook fits the
codebase. Rules are standing law every future dispatch pays tokens to carry: the human decides what
becomes law, exactly as they freeze specs.

## 4. Apply — and keep the baked slices honest

For each adopted rule, in this order:

1. Append it to `PIPELINE.md` §Conventions under its stanza (create the `### Surface: <key>`
   stanza if absent; keep it rule-shaped, one line each), **with a stable id**:
   `- **SH-<nnn>** — <rule>` under `### Shared`, `- **<KEY>-<nnn>** — <rule>` under a surface (`<KEY>` =
   the surface key upper-cased, e.g. `BACKEND-003`). Next number = the highest id of that prefix + 1; an id
   is never reused, even after its rule is retired. A reworked rule keeps its id; a retired one is deleted
   with its reason in the decisions line below.
2. **Re-render every affected surface agent** per `<core>/pipeline/schema/rendering.md` step 2 — the
   `<SURFACE_CONVENTIONS>` slice is **baked at render time**, so a §Conventions edit without a
   re-render produces the worst outcome available: reviewers (who read the prose live) enforce
   a rule implementers (who carry the stale bake) have never seen, and every future review
   round re-finds the pattern this retro just paid to close. If you cannot re-render on this
   runtime, say so and route to `/cohorte-update-pipeline` (its reconcile step 2 re-renders) —
   but then the rule is **pending**, and you say that too.
3. Append ONE line per adopted rule to `specs/_decisions.md` §Live (`<core>/pipeline/schema/decisions.md`):
   `- <date> · conventions · <id> <rule, compressed> — because <motif>×<n> across <features> · retro`.
   A retro rule is a standing decision; the journal is where the next `/cohorte-spec` learns it
   without re-mining the reports. **A rejected proposal gets its line too**:
   `- <date> · conventions · rejected: <rule, compressed> — because <the human's reason> · retro`, so the
   next retro does not propose it again.
4. **Archive the journal entries you processed** (ratified, rejected or "not a pattern"): move their files
   to `.claude/journal/processed/` in the main checkout (`mkdir -p` then `mv`, one Bash call). Entries
   marked **Later** stay where they are and count again next time.

In chat print ONLY: patterns found / adopted / skipped (one line each), enforcement gaps, which
agents were re-rendered (or the pending route), and the decisions lines appended. The evidence
stays in `specs/reports/retro-scan.txt`. **Recommend a `/clear`** — everything that matters is
now in `PIPELINE.md`, the rendered agents, and the journal.
