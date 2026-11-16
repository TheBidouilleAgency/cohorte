---
model: sonnet
description: Audit the existing codebase (or a domain) against PIPELINE.md conventions + TDD coverage; produce a prioritized refactor backlog.
argument-hint: [path or domain, default = whole repo]
---

You are the **lead**. Audit **$ARGUMENTS** (default: whole repo) to drive it to a clean base. Read +
analyze only — no fixes (those go through `/cohorte-refactor`).

> Read `.claude/profile.json` `commands` (the mechanical gates) and `surfaces` (the parsed `pipeline-profile` block; absent ⇒ read that block in `PIPELINE.md`), and `PIPELINE.md` §Conventions — plus
> `specs/_decisions.md` §Live if it exists (`<core>/pipeline/schema/decisions.md`): those standing decisions are part
> of the rulebook you audit against, and code that contradicts one is a finding like any other.
>
> **Workflow variant** (opt-in — `<core>/pipeline/schema/workflows.md`): on Claude Code ≥ 2.1.154 with workflows
> enabled, the human can ask to "run the audit workflow" (`<core>/workflows/audit.js` — one auditor
> per domain, concurrent). This conversational path stays the default and the fallback.

## 1. Mechanical gates (you run these — Bash)

Run the profile's checks **scoped to `$ARGUMENTS`** when a path/domain is given (lint/format/typecheck
on that path, tests via that surface's `test_cmd`); repo-wide only for the default whole-repo audit.
Use the quiet variants (`commands.lint_quiet`/`test_quiet`, else the `2>&1 | tail -40` fallback —
`<core>/pipeline/schema/output-discipline.md`) and redirect every command's output into
`specs/reports/audit-gates.txt` in ONE call — truncate it first (`: > specs/reports/audit-gates.txt`,
so a previous run's output is never read as this one's), then per command
`printf '\n$ %s\n' "<cmd>" >> specs/reports/audit-gates.txt; <cmd> >> specs/reports/audit-gates.txt 2>&1`
(a `>` per command would keep only the last one) — so the bulk never sits in your history, then grep
it for the `file:line` of every failure:
`commands.format` in check mode (e.g. `prettier --check .` / `ruff format --check`),
`commands.lint`, `commands.typecheck`, `commands.test`.

## 2. Convention + TDD audit (dispatch `cohorte-review` in audit mode)

Dispatch `cohorte-review` (read-only; static prompt first, variable slot last — prompt-cache prefix):
"Audit a target against `PIPELINE.md` (no spec — **audit mode**). Check conventions (§Conventions
per surface), TDD coverage (untested entry points / modules per surface), over-engineering (§8,
widened per your audit-mode rules — ranked biggest cut first, closing `net:` line), and — if the
profile enables them — mobile-first + design-system usage. Mechanical findings from the gates: read
`specs/reports/audit-gates.txt`. Emit a prioritized refactor backlog (capped finding-line format
from your instructions), grouped by domain (one group per surface + shared). — Target: `$ARGUMENTS`
(default: whole repo)."

## 3. Write the backlog — only the audited domains' sections

Merge mechanical + convention findings into one prioritized list per domain, each item:
`- [ ] <SEVERITY> · <file:line> · <rule|tdd|lint|format|type|security|complexity> · <concrete fix>`

`specs/refactor-backlog.md` is **shared state**, not this run's report: it holds other domains' items
and the `deferred:` lines `/cohorte-review` §3.5 parked there. So **rewrite only the `## <domain>`
sections this audit covered** — a scoped audit (`$ARGUMENTS` = one domain or path) touches that
domain's section and leaves every other section byte-for-byte as it is (ticked lines included); a
whole-repo audit rewrites every surface's section plus `shared`, and still keeps a section for a
domain the profile no longer has. Locate sections with `grep -n '^## '` and edit them in place (Edit
per section, or one `awk` that swaps the audited sections) — never regenerate the whole file from
this run's findings.

`complexity` items are the over-engineering cuts, ranked biggest first inside their domain — they are
the cheapest wins in the backlog (deleting code needs no new tests) but they never outrank a
security, correctness or `tdd` item.

**Carry over the deferred items** of every section you rewrite: `grep -n 'deferred:' specs/refactor-backlog.md`
and re-emit every **open** (`- [ ]`) match of that domain verbatim, tag included. Those lines were
put there by `/cohorte-review` §3.5 — a real finding a feature deliberately did not own — and an audit that
blindly overwrites a section is the one way they silently disappear. Already-ticked (`- [x]`) ones in a
rewritten section are done: drop them.

**Keep the in-flight refactor ticks** too: `/cohorte-refactor` §4 links what it cleared as
`- [x] … · refactor:<id>`, and until `specs/<id>.md` is `merged` that line is the backlog's only
pointer to where the work went (it is in review, or on an unmerged PR). So re-emit each such line
verbatim while its spec's `status` (one `grep '^status:'` per id) is not `merged`/`abandoned`, and
drop any new finding with the same `file` + problem (the fix is pending there, not missing). Spec
merged, abandoned or absent ⇒ drop the line like any ticked one — whatever survived is re-found.
Print a short summary (counts per domain + top items). Tell the human: refactor a domain with
`/cohorte-refactor <domain>`.
