# ADR-0011: Signing and distribution of external skills — out of V3.0, seam reserved

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 11
- **Design reference:** DESIGN.md §2.10 (`skills/`), §6.1, §9

## Context

Spec 8 defines a skill as knowledge for the model (manifest, Markdown, examples, optional deterministic checks) that cannot grant a system
permission by itself. Spec 28 places a signed skills marketplace/registry in V3.2+. Pi has its own skill mechanism, which would be an ambient
input outside Cohorte's snapshot.

## Decision

1. V3.0 knows two skill sources only: **shipped** (hashed in the asset manifest) and **project-local** (`.cohorte/skills/<id>/{SKILL.md,
   skill.yaml}`, hashed into the run snapshot and reported in the run plan).
2. Skills are selected deterministically by `ContextBuilder` and **inlined** in the doctrine tier; Pi's skill mechanism is never used.
3. A skill cannot grant a permission. Its manifest (`SkillManifest`, `@cohorte/config/schema`, published as `skill.schema.json`) declares
   `checks` as `{ name?, argv: string[] }[]` — spec 8's shell-string `command` becomes `argv`, because the product is argv-only (ADR-0024,
   deviation D-25). **In V3.0 skill checks are declarative only**: they are surfaced in the agent's context, they are never run by Cohorte
   on the skill's behalf, and they create no command rule. The only commands that exist are those of the (trusted) project config.
4. No external/remote skill source, no signature verification in V3.0. `skill.yaml` reserves `signature` and `source` so a registry can be
   added without a schema break.

## Consequences

- No supply-chain surface is added by skills in V3.0; everything a model reads is content-addressed and pinned for the run.
- Sharing skills across projects is copy-based until the registry exists.

## Revisit when

- The registry milestone starts (V3.2+) → decide the signature scheme (e.g. sigstore / npm provenance), trust roots, and an `ask` for unsigned sources.
- A skill format standard (Agent-Skills-compatible layouts) stabilises enough to be adopted verbatim.
