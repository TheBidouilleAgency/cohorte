# skills/

Embedded inline skills (spec §8, DESIGN §9 "skill registry" is out of V3.0 — inline skills only).

`scripts/embed-assets.ts` copies this whole directory into `apps/cli/assets/skills/**` and records it in
`assets/manifest.json` (DESIGN 1.4 step 2). A `SkillManifest` owner was one of the PLAN PC-11 holes DESIGN
amended for Wave 0; the skill files themselves land with the units that consume them (Wave 2+).

This directory is empty at G0 on purpose.
