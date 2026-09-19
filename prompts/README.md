# prompts/

Embedded agent prompts (spec §8 "inline skills", DESIGN §9 role scope cut: `implementer`, `fixer`, `reviewer`,
`security-reviewer` in V3.0; `architect`, `verifier`, `brainstormer`, `spec-author`, `tester`, `release-manager`,
`discoverer`, `reconciler` have their role ids reserved but no prompt yet).

`scripts/embed-assets.ts` copies this whole directory into `apps/cli/assets/prompts/**` and records it in
`assets/manifest.json` (DESIGN 1.4 step 2). Files here are content, not code: `scripts/check-prompts.ts` (`U4.09`)
checks them for transition/verdict vocabulary (spec 4.1); nothing under `prompts/**` is executed.

This directory is empty at G0 on purpose — the role prompts land with the units that use them (Wave 2+).
