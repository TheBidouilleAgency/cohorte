## Deferred findings — real, but not this feature's problem

`/cohorte-review` ends on "zero blocking findings", so everything non-blocking used to be discarded with the
report. A **deferred** finding is one the reviewer judges true and **out of this feature's scope**
(pre-existing code the staged diff never touched, adjacent debt the spec never claims to fix). The
review agent returns them in their own `## Deferred` section — never in `findings` — each carrying its
own out-of-scope reason.

- They count in **no** severity row, enter **no** verdict, and are **never** cross-checked: a deferred
  item cannot cost a fix loop an iteration, and refuting one would spend an agent arguing about
  something that cannot change the outcome.
- **Not deferrable, ever:** anything the diff touched or introduced, any spec violation, any security
  issue on a path this feature adds, calls or modifies.
- `/cohorte-review` §3.5 routes them, **on every verdict**, into `specs/refactor-backlog.md` under the
  `## <domain>` heading of the owning surface, tagged `deferred:<feature_id>` — the same grouping
  `/cohorte-audit` writes, so `/cohorte-refactor <domain>` picks them up with no extra plumbing. Never into the spec's
  `## Remediation`, which is what `/cohorte-fix` re-dispatches.
- `/cohorte-audit` (both paths) **rewrites only the sections of the domains it audited**, carrying their
  open `deferred:` items over, and leaves every other domain's section untouched — overwriting the
  file with one run's items is the one way they silently vanish.
- The verdict JSON carries `deferred: <n>` (informational, outside `blocking`), so a driver can name
  them in its closing line without reading a report.
