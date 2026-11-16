## Measuring cost — what's slow vs what's expensive

`pipeline-metrics.jsonl` records **wall-clock seconds** per phase batch (§Specialization, `<core>/pipeline/schema/specialization.md`) — it tells you
what's SLOW. Tokens are recorded only where they can be read honestly: the **workflow paths**
(`loop.js`, `review.js`) stamp an approximate `tokens` field per batch from the runtime's own
counter (`budget.spent()` deltas), and the loop's return carries a per-round breakdown in its
`history`. The **conversational** commands still record none — a lead cannot reliably read a
subagent's token count, and a guessed number is worse than a missing one. `cohorte metrics` sums
whatever is stamped (a token-less line aggregates as 0, rendered as absent, never as "free").
For exact spend, use Claude Code's own accounting:

- **`/cost`** (built-in, zero setup) — reports per-**subagent** and per-**slash-command** share of your usage
  over the last 24 h / 7 d (e.g. _"Top subagents: frontend 7 %, backend 4 % · Top skills: /cohorte-build 1 %,
  /cohorte-review 1 %"_). That IS the per-phase ledger — approximate (share-of-total, machine-local, not exact
  tokens). Read it to see which surface/command actually dominates the bill before you tune a `model` tier.

**Lead context discipline — the silent bill.** The lead session's conversation history is re-sent as
input on EVERY turn; a session that spans spec→build→review→fix without clearing re-pays the
accumulated spec walk-through, handoffs, and reports on each turn. The pipeline is built so this is
never necessary: every phase handoff (spec, contract, diff, staged reports) lives on disk, so `/clear`
at each phase boundary is always safe — each command's closing line recommends it. Corollaries the
commands enforce: never paste a diff into a dispatch (agents compute their own, scoped); never echo a
staged report or design brief into chat; redirect bulky command output to a file and grep it.
