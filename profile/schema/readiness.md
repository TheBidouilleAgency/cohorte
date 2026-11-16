## Readiness — the gate between a frozen spec and N implementers

`/cohorte-build` §1.6 scores the frozen spec on **implementability** before authoring the contract and before
dispatching anything, and writes `specs/reports/<id>.readiness.json`
(`verdict`: `READY` · `RESERVATIONS` · `NOT-READY`, plus `gaps[]`). It costs **zero extra agents** — the
lead already holds the spec, the profile and the reconciled surface list — which is the whole economics
of the step: a spec that cannot be built does not get cheaper by being built on N surfaces in parallel.

- Five checks: contract completeness · surface coverage · dependencies exist · residual ambiguity ·
  the design gate. Each maps to `NOT-READY` (a surface would have to invent the answer) or
  `RESERVATIONS` (a surface can proceed on a stated assumption).
- **`NOT-READY` aborts the build with no agent spawned** and sends the human to `/cohorte-spec`.
  A driver reads the same file and must stop rather than retry — it is the one outcome more passes
  cannot fix.
- **`RESERVATIONS` never blocks.** Each gap is inlined verbatim into the dispatch of the surface it
  affects, as an assumption the implementer must apply *and* flag in its handoff. A gate that stalled a
  sound build on a missing error case would cost more human round-trips than it saves.
