## Dead agents — silence is not a green light

A subagent can die mid-run: a rate limit, a transport error that outlived its retries, its own context
exhausted on a big surface. When it does it returns **nothing** — and nothing is byte-identical to
"finished, nothing to report". Every phase that fans out therefore does a **roll call** before it
integrates anything, because the default reading of silence is the most dangerous one available:

| phase | what a dead agent looks like | what the phase must do |
| --- | --- | --- |
| `/cohorte-build` | a surface with no handoff | retry it **once** alone (byte-identical prompt), then mark it `dead`, verify the tree with that surface's own quiet commands, never call the batch ok |
| `/cohorte-review` | a reviewer with no report ⇒ **zero findings** | retry once, then list the surface in `unreviewed` and refuse to score `SHIP` |
| `/cohorte-fix` | a re-dispatched agent with no handoff | retry once, then leave **every** one of its items `- [ ]` — a dead agent never ticks a box |
| workflows | `agent()` resolves to `null` | already enforced (`review.js` `unreviewedSurfaces`) — the doctrine started here |

Non-negotiables, in every phase:

- **Retry once, alone, byte-identical.** Most deaths are transient, and the other surfaces' work is
  already on disk — so recovery costs one agent, never a rebuild. Never retry an agent that answered.
- **Never speak for a dead agent.** You did not see its work: report what the *tree* says (quiet
  commands, redirected to a file, grepped), not what a handoff would have said.
- **Never let it reach a driver as clean.** `/cohorte-build` writes `dead[]` into
  `specs/reports/<id>.build.json`, `/cohorte-review` writes `unreviewed[]` into the verdict; a driver
  must abort on either *before* it reads `blocking`, since a dead reviewer makes
  `blocking == 0` a statement about code nobody read.
- **`unreviewed` is separate from `blocking` on purpose.** Faking a count in `blocking` to force a
  driver's hand would corrupt the one field the whole contract rests on; a driver reads them as two
  different facts — "what was found" and "what was covered".
- **Write the metrics line anyway** (`"<key>":"dead"`). An incomplete batch is exactly the batch worth
  recording; holding the append back "until it's complete" deletes the evidence that anything failed.
