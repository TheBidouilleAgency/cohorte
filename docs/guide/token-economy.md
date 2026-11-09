# Token economy

Multi-agent pipelines can burn tokens spectacularly: every agent re-reads context, every runner
dumps logs, every long-lived lead session re-pays its history each turn. Cohorte treats token
frugality as a design constraint, not an afterthought. This page collects every mechanism and the
habits that make them pay.

## The deterministic preflight — zero agents on red code

`/cohorte-review` (and the workflow variants) starts with
`pipeline/scripts/preflight.sh` — a plain shell script, **not an agent** — that runs the
profile's mechanical checks in order (typecheck → lint → tests, quiet variants), all output
redirected to `specs/reports/<id>.preflight.txt`:

- **Any check red** ⇒ it prints the raw last-40 lines and exits 1. The command **stops there:
  zero agents are spawned.** A reviewer dispatched onto code that doesn't compile burns its whole
  run rediscovering what `tsc` printed for free.
- **All green** ⇒ it stamps `<state>/preflight.ok` (`<epoch> <HEAD sha> <tree digest>`), which the
  gate hook enforces as a **phase gate**: a `review` dispatch with a missing or stale stamp (older
  than `gate.preflight.max_age_minutes`, or the code changed since) gets a confirmation prompt. A lead can't
  accidentally skip the gate; a human can consciously override it.

## Quiet commands — runners bridled at the profile level

A test runner's default output is written for a human terminal: one line per test, banners,
timing tables. An agent pays input price for every one of those lines, on every turn they survive
in its context. The profile therefore stores **two forms of each noisy command**:

| Field | Example | Who runs it |
| --- | --- | --- |
| `test_cmd` / `lint_cmd` | `pnpm --filter api test` | humans |
| `test_quiet_cmd` / `lint_quiet_cmd` | `pnpm --filter api test --reporter=dot` | agents, preflight |
| `commands.test_quiet` / `lint_quiet` | `pnpm test --reporter=dot` | repo-wide gates |

Rules for every consumer: run the quiet variant when set; when it's empty (older profile), run
`<full cmd> 2>&1 | tail -40` — never the bare command into context; need the full log? redirect
to a file and grep it. `/cohorte-init-pipeline` **asks** for these variants (detected defaults offered
first) instead of silently storing a bare `pnpm test`; `/cohorte-update-pipeline` tops up older profiles.

## The diff is computed once and staged

`/cohorte-review` runs **one** `git diff --stat`, groups changed paths by surface, and stages a full
patch **only for the touched surfaces** to `specs/reports/<id>.<surface>.diff`. Reviewers (which
have no Bash) read the artifact — hunks plus immediate context, opening a full source file only
when a finding demands it — instead of N agents each re-running git and re-reading whole files.

## Conventions baked at render time

Rendered surface agents carry their slice of `PIPELINE.md` §Conventions (`### Shared` + their own
`### Surface:` stanza + their §Testing lines) **baked into the agent file** at render. At runtime
an implementer reads only the profile's fenced machine block — never the prose. The trade: edit
conventions in `PIPELINE.md`, then let `/cohorte-update-pipeline` re-render (hand-editing the prose
without re-rendering leaves the baked copy stale — `/cohorte-doctor` and the agents themselves flag the
contradiction).

## Capped, excerpt-free reports

Everything agents return is schema-capped:

- **Review reports** — max **20 findings**, ONE line each
  (`severity · file:line · type · concrete fix`), **zero code excerpts** (the diff and source are
  on disk; `file:line` is enough for a stateless fixer). Overflow keeps every CRITICAL/HIGH/
  security finding and closes with one `+<n> more` line.
- **Implementer handoffs** — summary, migrations, test results, mismatches, TODOs. Never file
  lists (the lead has `git diff --stat`), never code excerpts.

## Byte-stable prompts — the prompt cache is real money

Dispatch prompts keep every volatile slot (feature id, paths, changed-file lists, remediation
items) **at the end** of an otherwise byte-identical template. Repeated dispatches — fix loops,
re-reviews, the next feature — hit the provider's prompt-cache prefix instead of re-paying the
instructions. The same is asked of you at the template level: freshness stamps, run ids, dates
live at the end of prompts, not the beginning.

## Lead context discipline — `/clear` at every boundary

The lead session's history is re-sent as input on **every turn**. A session spanning
spec → build → review → fix re-pays the accumulated walkthroughs each turn. The pipeline
makes this unnecessary: every phase handoff lives on disk, so **`/clear` at each boundary is
always safe** — each command's closing line tells you when. Corollaries the commands enforce on
themselves: never paste a diff into a dispatch (agents compute their own, scoped), never echo a
staged report into chat, redirect bulky output to a file and grep it.

**The same rule is why there is no in-session autonomous driver.** A slash command cannot `/clear`
itself, so an automated `/cohorte-review ⇄ /cohorte-fix` loop running *inside* your session would pile
the diff plus N review reports plus N contracts into a history re-sent at input price on every turn
— it would cost more than the automation saves. That is why every phase writes its result to a file
(`specs/reports/<id>.verdict.json` — a handful of numbers) rather than to the conversation: anything
driving the cycle from outside reads those, and your session stays small. A built-in driver shipped
until 2.2.0 and was retired; the file contract it used is still written on every run.

## Model routing — pay for judgment, not mechanics

- Mechanical **commands** pin `model: sonnet` in their frontmatter, so the lead's orchestration
  turns never bill at the session model (often Opus). Interactive commands (`/cohorte-brainstorm`,
  `/cohorte-spec`, `/cohorte-init-pipeline`) deliberately inherit.
- **Surface agents** pin their profile tier: `sonnet` by default (implementers mostly apply a
  frozen contract), `haiku` for purely mechanical surfaces, `inherit` only when a surface makes
  real design decisions worth the lead's model.
- **Fixed agents**: `review` sonnet · `release` haiku · `profile-reader` haiku.
- **Workflows** route every mechanical phase (profile read, preflight, staging, verify, report
  writing) to haiku explicitly.

`/cohorte-doctor` flags every missing or drifted pin — an unpinned agent silently falls back to the
session model on every dispatch.

## Retrieval instead of grep-and-read

With `retrieval.provider: serena` (default), agents get live LSP symbol navigation over MCP:
locate code by symbol, read only the definitions needed, trace references before changing a
shared shape — instead of Grep/Glob + whole-file reads. `graphify` (persistent knowledge graph)
suits very large or mixed code+docs repos; `none` falls back to grep. Wiring is a committed
`.mcp.json` entry with a PATH-proof launcher; `/cohorte-doctor` runs the health check.

## Measuring: what's slow vs what's expensive

- `<state>/pipeline-metrics.jsonl` records **wall-clock seconds** per phase batch — what's
  *slow*. It's the evidence required before splitting a bottleneck surface into specialized
  sub-surfaces (see `SCHEMA.md` §Specialization).
- The **workflow runs** (loop, review) also stamp an approximate **`tokens`** figure per batch,
  read from the runtime's own counter — `cohorte metrics` reports it per feature and per phase
  (`~Nk tok`). Conversational runs can't count tokens and stamp nothing; absent ≠ free.
- **`/cost`** (built-in) reports per-subagent and per-command share of usage — the *exact*
  ledger to read before tuning a `model` tier.

## The habit list

1. `/clear` between every two commands.
2. Let the preflight abort — don't "just quickly dispatch anyway".
3. Keep specs ≤ 300 lines; split features instead of growing novels.
4. Park LOW/MEDIUM nits to the refactor backlog instead of running fix cycles for them.
5. Read `/cost` before changing any model pin; read the metrics file before splitting a surface.
