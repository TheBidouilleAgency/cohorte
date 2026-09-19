#!/usr/bin/env bash
# Builds the ephemeral project the README recording runs against.
#
# This is a RECORDING FIXTURE, not a demo repo: it is created in a temp dir,
# recorded, and deleted. Nothing about it is committed or maintained. It exists
# so the cast shows a realistic doctor report and spec board without publishing
# a real project's spec titles.
#
# Everything the recording prints is genuinely produced by bin/cli.js against
# this tree — no output is faked or hand-edited.
set -euo pipefail

DEST="${1:?usage: fixture.sh <dest-dir>}"
mkdir -p "$DEST"/{apps/api,apps/web,packages/shared-types/src,specs}
cd "$DEST"

cat > PIPELINE.md <<'PIPELINE'
# PIPELINE.md — acme-shop profile

```yaml pipeline-profile
name: acme-shop
one_liner: a storefront and its admin back-office
ui_language: English
package_manager: pnpm

vcs:
  host: github
  remote: acme/shop
  default_branch: main
  feature_branch_prefix: feature/
  patch_branch_prefix: fix/

repo:
  layout: monorepo
  workspace_tool: turborepo

retrieval:
  provider: none

surfaces:
  - key: backend
    path: apps/api
    label: backend (AdonisJS)
    agent: backend
    tools: [Read, Write, Edit, Bash, Grep, Glob]
    model: sonnet
    test_cmd: pnpm --filter api test
    test_quiet_cmd: pnpm --filter api test --reporter=dot
    lint_cmd: pnpm --filter api lint
    lint_quiet_cmd: pnpm --filter api lint --quiet
    format_cmd: pnpm --filter api format
    typecheck_cmd: pnpm --filter api exec tsc --noEmit
    build_cmd: ""
    uses_design: false
  - key: frontend
    path: apps/web
    label: frontend (React)
    agent: frontend
    tools: [Read, Write, Edit, Bash, Grep, Glob]
    model: sonnet
    test_cmd: pnpm --filter web test
    test_quiet_cmd: pnpm --filter web test --reporter=dot
    lint_cmd: pnpm --filter web lint
    lint_quiet_cmd: pnpm --filter web lint --quiet
    format_cmd: pnpm --filter web format
    typecheck_cmd: pnpm check-types
    build_cmd: pnpm --filter web build
    uses_design: false
  - key: shared
    path: packages/shared-types
    label: shared types & schemas
    agent: shared
    tools: [Read, Write, Edit, Bash, Grep, Glob]
    model: haiku
    test_cmd: pnpm --filter shared-types test
    test_quiet_cmd: pnpm --filter shared-types test --reporter=dot
    lint_cmd: pnpm --filter shared-types lint
    lint_quiet_cmd: pnpm --filter shared-types lint --quiet
    format_cmd: ""
    typecheck_cmd: pnpm --filter shared-types exec tsc --noEmit
    build_cmd: ""
    uses_design: false

contract:
  enabled: true
  mechanism: shared-types-zod
  path: packages/shared-types/src
  ext: ts
  index: packages/shared-types/src/index.ts
  authored_by: lead

release_notes:
  enabled: false
  tool: none

commands:
  install: pnpm install
  dev: pnpm dev
  lint: pnpm lint
  lint_quiet: pnpm lint --quiet
  format: pnpm format
  typecheck: pnpm check-types
  test: pnpm test
  test_quiet: pnpm test --reporter=dot
  migrate: "cd apps/api && node ace migration:run"
  make_migration: "cd apps/api && node ace make:migration"

rbac:
  enabled: false
  hierarchy: []

design:
  enabled: false
  provider: none

isolation:
  enabled: false

gate:
  default_branch: main
  deny:
    - "node ace migration:fresh"
    - "node ace db:wipe"
  ask:
    - "node ace migration:run"
    - "psql"
  ask_on_default_branch:
    - "git push"
    - "docker compose down"
  preflight:
    max_age_minutes: 30
```

## Conventions

- Every endpoint is covered by a functional test before it is written.
- User-facing copy is English; no hardcoded strings outside the i18n catalogue.
PIPELINE

# Three specs, in the three states the board distinguishes.
cat > specs/checkout-coupons.md <<'SPEC'
---
id: checkout-coupons
status: in-review
branch: feature/checkout-coupons
title: Apply coupon codes at checkout
---
SPEC

cat > specs/order-history.md <<'SPEC'
---
id: order-history
status: frozen
branch: feature/order-history
title: Customer order history page
---
SPEC

cat > specs/stock-badge.md <<'SPEC'
---
id: stock-badge
status: shipped
branch: feature/stock-badge
title: Low-stock badge on product cards
---
SPEC

cat > .gitignore <<'IGNORE'
node_modules/
.claude/preflight.ok
.claude/pipeline-metrics.jsonl
specs/reports/
IGNORE

# What /cohorte-init-pipeline derives from the profile's gate block.
mkdir -p .claude
cat > .claude/gate-config.json <<'GATE'
{
  "default_branch": "main",
  "deny": ["node ace migration:fresh", "node ace db:wipe"],
  "ask": ["node ace migration:run", "psql"],
  "ask_on_default_branch": ["git push", "docker compose down"],
  "preflight": { "max_age_minutes": 30 }
}
GATE

git init -q .
git add -A
git -c user.email=demo@example.com -c user.name=demo commit -qm "acme-shop"
