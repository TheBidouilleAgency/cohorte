# Live smoke runbook

The live suite is opt-in. It must never run in the normal unit, integration, or CI test commands.

## Run

```sh
COHORTE_LIVE=1 pnpm test:live
```

Before running it, a human maintainer must confirm the provider account, the fixture, and the budget. The suite
must use `auth status` and a tiny frozen spec; it must not read or print credential files. Quota header names and
provider error text are recorded as sanitized fixtures only, never tokens or authorization values.

Without `COHORTE_LIVE=1`, the suite is expected to skip the provider smoke with an explicit reason.

