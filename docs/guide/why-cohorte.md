# Why not just ask your agent?

Claude Code already writes the feature. Cursor already edits ten files. Every agent already has
subagents and a `.md` file where you can drop your conventions. So what is a pipeline for?

The honest answer: **for the second hour.** A coding agent is excellent at the first prompt of a
feature and progressively worse at everything after it — because what it knows lives in a
conversation, and a conversation degrades. Cohorte is the set of constraints that stop that
degradation. Each one below is a failure you have already had.

## "It forgot what we decided"

You spent twenty minutes agreeing on the shape of the API. Forty turns later the agent writes a
different one — not because it disagreed, but because the decision was in the chat, and the chat
is a lossy medium that gets summarised, truncated, and re-sent at input price on every turn.

**What Cohorte does instead:** the decision is frozen to a file. `/cohorte-spec` writes
`specs/<id>.md` — goal, scope, data model, contract, per-surface tasks, acceptance criteria — and
every agent's *first action* is to read it. Agents are stateless on purpose: there is nothing to
forget, because nothing is remembered. Reports go to `specs/reports/`, findings to the spec's
`## Remediation` checklist, metrics to `pipeline-metrics.jsonl`.

The observable consequence: **`/clear` between stages is always safe**, and recommended. If
clearing your context loses work, your state was in the wrong place.

## "The two halves don't fit"

You ask for a feature spanning API and UI. The agent writes the endpoint, then writes the client —
and invents a slightly different field name, or a nullable the other side doesn't expect. It
compiles on both sides and breaks between them.

**What Cohorte does instead:** the lead authors the **contract** (Zod schemas, OpenAPI, protobuf —
your profile decides) *before any implementer is dispatched*. Implementers import it read-only and
**never talk to each other**. That single invariant is what makes it safe to build both surfaces
in parallel rather than sequentially — the integration is agreed before the code exists, instead of
discovered after.

## "It edited a file I didn't want it to"

The agent needed a type, so it reached into the shared package. Something else broke. Or two
parallel agents wrote the same file and the second silently won.

**What Cohorte does instead:** **one owner per tree.** Each surface owns a disjoint path and may
touch nothing else — enforced in the rendered agent's own frontmatter, not asked for politely in a
prompt. Shared code gets its own single-owner surface. Nothing is ever edited by two agents.

## "It ran something it shouldn't have"

`migration:fresh` on the wrong database. A `git push --force`. A `rm -rf` with an unlucky variable.
Auto-approve is a spectrum and everyone eventually sets it too high.

**What Cohorte does instead:** `gate.py` is a real **blocking PreToolUse hook** — not an
instruction. It inspects every Bash command from every agent, subagents included, hard-denies the
destructive ones and confirm-gates the risky ones. It is **branch-aware**, so agents move fast on a
feature branch while your default branch stays protected. In unattended runs, confirms become
denies, because nobody is there to answer. And it matches deny patterns across an entire chained
command, so a hard-denied call can't ride behind a benign one that gets your single "yes".

See [Gate & permissions](/reference/gate).

## "The review said it was fine"

You ask the agent that just wrote the code whether the code is good. It says yes. This is not
dishonesty — it's the same context evaluating its own output against its own assumptions.

**What Cohorte does instead:** review is a **different, read-only agent** (no Write, no Bash) that
sees the frozen spec and the diff, not the conversation that produced them. CRITICAL and security
findings are then adversarially cross-checked by a second pass. And a review can't accidentally pass:
a reviewer that dies returns zero findings, which is byte-identical to a clean surface — so the
verdict logic checks `unreviewed` **before** `blocking`, in that order, on purpose.

## "Four agents just told me it doesn't compile"

You dispatch a review. Four agents spin up, read the codebase, and report that it doesn't compile —
something `tsc` would have told you for free in 800ms.

**What Cohorte does instead:** a deterministic **preflight** — a shell script, not an agent — runs
typecheck → lint → tests first. Red ⇒ it stops there, **zero agents spawned**. Green ⇒ it stamps a
digest the gate enforces as a phase gate. That is one mechanism among several: quiet command
variants, diffs computed once and staged to disk, capped report schemas, conventions baked into
agents at render time, byte-stable prompts for prompt-cache hits.

See [Token economy](/guide/token-economy).

## "We fixed this same thing last week"

The reviewer flags the same class of mistake on the same surface, feature after feature. You fix it
every time. Nothing upstream ever changes.

**What Cohorte does instead:** `/cohorte-retro` mines the accumulated findings — verdicts, the
specs' Remediation history, the deferred backlog — for repeating patterns, and turns the ones **you
ratify** into `§Conventions` rules. Adopted rules re-render the affected surface agents, so the
convention is baked into the implementer *before* it writes. A rule the reviewer enforces but the
implementer never saw is worth nothing; catching a finding is strictly more expensive than not
producing it.

## The shape of the claim

None of this is intelligence Cohorte adds to your agent. It's the opposite: it removes the
decisions an agent is bad at making under context pressure, and puts them in files, hooks, and
ownership boundaries — where they are cheap, inspectable, and don't degrade with conversation
length.

Which is also why it's **markdown, shell, and one Python hook**. Your app code never imports
anything from Cohorte. Delete the directory and your repo is unchanged.

## When you should *not* use it

- **A one-file change.** The overhead is real. `/cohorte-patch` exists as the cheap door for a bug
  fix — no brainstorm, no contract — and even that is more ceremony than editing the file yourself.
- **Exploration.** When you don't yet know what you're building, a frozen spec is the wrong tool.
  Explore conversationally, then `/cohorte-brainstorm` when there's something to pressure-test.
- **A codebase with no seams.** The pipeline's central promise is disjoint surfaces. If everything
  lives in one tree that everything else imports, there is nothing to parallelise —
  `/cohorte-audit` will tell you so honestly before you commit to it.
- **A runtime without real subagents.** That boundary *is* the isolation guarantee, so such a
  runtime is refused at install rather than degraded around.

Cohorte automates everything between the brainstorm, the spec freeze, and the ship confirmation —
and deliberately not those three.

Next: [What is Cohorte?](/guide/what-is-cohorte) for the architecture, or
[Getting started](/guide/getting-started) to install.
