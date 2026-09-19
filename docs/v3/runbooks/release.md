# Release runbook

1. Run `pnpm verify`, `pnpm lint`, and `pnpm test:e2e` against the immutable build.
2. Run `pnpm test:live` only when a maintainer explicitly budgets and authorizes the provider smoke.
3. Review the generated protocol reference and schema compatibility fixtures.
4. Inspect the integration branch and release notes; do not publish from a dirty tree.
5. Perform the final real Cohorte-on-Cohorte smoke manually with a tiny frozen spec and human review.

