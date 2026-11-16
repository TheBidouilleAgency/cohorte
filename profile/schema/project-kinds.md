## Project kinds — `project.kind` presets

`project.kind` (`web` · `api` · `cli` · `library` · `mobile` · `data` · `other`) tells the pipeline
what the repo **delivers**, so the spec's DoD, the review's checks and the design step fit it. It is
detected by `/cohorte-init-pipeline` (01) and confirmed there (02). **Absent ⇒ `web`** — the
behaviour every profile had before the field existed. The spec **`kind`** (`feature` · `patch` ·
`refactor`, front-matter) is a different axis: what one change *is*, not what the repo is.

**Read only your section.** `/cohorte-spec` (§9 defaults) and the review agent (checks) Grep `^## `
here and Read the one `## <kind>` range. On `web` the review agent does not open this file at all.

### Detection (init 01) — first match wins, top to bottom

| signal | kind |
| --- | --- |
| a UI framework (react, vue, svelte, angular, next, nuxt…) in any app surface — even beside a `bin` or a server | `web` |
| `react-native`, `expo`, `*.xcodeproj` / `Package.swift` app target, Android `build.gradle` app, `flutter` | `mobile` |
| `dbt_project.yml`, Airflow/Dagster/Prefect DAGs, a notebooks-first tree, warehouse SQL as the product | `data` |
| a `bin` entry (`package.json` `bin`, `[project.scripts]`, `cmd/*`, `[[bin]]`) and no UI deps | `cli` |
| a published package (`exports`/`main` + no `private: true`, a PyPI/crates manifest) with no app entry | `library` |
| a server framework (express, fastify, nestjs, adonis, django, fastapi, rails, net/http) and no UI | `api` |
| none of the above | `other` |

A mixed monorepo resolves to the **first row it matches** (an app with a UI is `web` even when it also
ships a CLI). The kind also decides two init defaults: where the design row below says **no**, init
sets `design.enabled: false` and every `uses_design: false`, and skips the design question; where
RBAC is **no**, it defaults `rbac.enabled: false`. The build gate, `/cohorte-align-ds` and spec §8
already key off those flags — nothing else reads the kind for design.

| kind | design step | RBAC / mobile-first checks (review 5–6) |
| --- | --- | --- |
| `web` | yes | RBAC if `rbac.enabled`; mobile-first if `uses_design` |
| `mobile` | yes | RBAC if `rbac.enabled`; screen-size + platform layout if `uses_design` |
| `api` | no | RBAC if `rbac.enabled`; no mobile-first |
| `cli` · `library` · `data` · `other` | no | neither |

## web

- **DoD:** the spec template's five lines as they are — nothing to add.
- **Review:** checks 5–6 exactly as the agent states them. No extra checks.

## api

- **DoD** (add): `- [ ] No breaking change to an existing endpoint (removed field, narrowed type, new required input, changed status) — or the version bump / deprecation is stated`
  · `- [ ] Error responses follow the existing envelope and status conventions`.
  Drop the mobile-first line.
- **Review:** skip 6. Add **API compatibility** — a diff that removes or renames a response field,
  tightens a request type, adds a required parameter or changes a status code on an existing route is
  a CRITICAL `spec-violation` unless the spec states the break.

## cli

- **DoD** (add): `- [ ] --help text covers every new flag/subcommand` · `- [ ] Exit codes documented and tested (0 success, non-zero per failure class)`
  · `- [ ] Results on stdout, diagnostics on stderr — nothing else on stdout`. Drop the mobile-first line.
- **Review:** skip 5–6. Add **CLI discipline** — a new flag missing from `--help`, an error path that
  exits 0, or log/progress output on stdout is a HIGH `quality` finding; a renamed or removed flag is a
  CRITICAL break unless the spec states it.

## library

- **DoD** (add): `- [ ] Every new public export documented (doc comment or README)` · `- [ ] Semver impact stated (patch / minor / major)`
  · `- [ ] No breaking change to the public API without a major bump`. Drop the mobile-first line and
  the `ui_language` line.
- **Review:** skip 5–6. Add **public-API compatibility** — a removed/renamed export, a narrowed
  parameter type or a changed return shape is a CRITICAL `spec-violation` unless the spec states a
  major bump; an undocumented new export is MEDIUM.

## mobile

- **DoD** (add): `- [ ] Platform matrix stated and covered (iOS / Android, min OS versions)` · `- [ ] Offline / flaky-network behaviour defined`
  · `- [ ] New permissions declared and requested at point of use`. Replace the mobile-first line with
  `- [ ] Layout holds on the smallest supported screen`.
- **Review:** 5 as stated; 6 reads as small-screen/safe-area layout rather than `sm:/md:` breakpoints.
  Add — a permission used without its manifest/Info.plist entry, or a network call with no offline or
  error state, is a HIGH `quality` finding.

## data

- **DoD** (add): `- [ ] Idempotent — a re-run produces the same result, no duplicates` · `- [ ] Backfill path stated (or "not needed" and why)`
  · `- [ ] Schema evolution is additive; downstream consumers named`. Drop the mobile-first line.
- **Review:** skip 5–6. Add — a non-idempotent write (plain `INSERT` with no merge key, append without
  dedupe), a dropped/renamed column with downstream readers, or a model with no test/assertion is a
  HIGH `quality` finding (CRITICAL when it loses data).

## other

- **DoD:** the template's lines minus mobile-first; add what the spec's §1 makes verifiable.
- **Review:** skip 5–6. No extra checks.
