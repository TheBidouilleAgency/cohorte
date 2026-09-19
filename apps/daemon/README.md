# apps/daemon — not built in V3.0

There is no daemon in Cohorte 3.0, and this directory holds no code on purpose. It names a seam.

V3.0 runs one **detached run host per run** (`cohorte __host`, spawned by `cohorte run`/`resume`) and talks
to it through two durable, transport-free channels that live in the state store (DESIGN 4.7, ADR-0004):

- a **command inbox**: MAC-signed `CommandEnvelope`s written by one-shot CLI controllers and drained by the
  host at the top of its loop;
- an **event tail**: the hash-chained event log that any observer reads from a sequence number, without a
  lock and without being able to disturb the run.

Those two pieces are the kernel of a future local daemon: a long-lived process that owns several run hosts
and serves the same envelopes over a Unix socket (spec 17 names the transport; the envelopes and their
semantics are already transport-independent). Nothing in `packages/**` may assume that such a process
exists, and nothing may be added here before the design says so.

This directory has no `package.json`, so pnpm does not see it as a workspace package although
`pnpm-workspace.yaml` lists `apps/*`.
