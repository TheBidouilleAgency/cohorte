# migrations/config/

Configuration migrations (DESIGN §14 ".cohorte/", spec §14): numbered scripts that upgrade an older
`.cohorte/config.yaml` (or the state schema it points at) forward, never in place without a backup. State-store
migrations live beside the store contract (`@cohorte/persistence`); this directory is for the PROJECT
CONFIGURATION file itself, run by `cohorte migrate`.

`scripts/embed-assets.ts` copies this whole directory (and its sibling `migrations/` roots, if any are added
later) into `apps/cli/assets/migrations/**` and records it in `assets/manifest.json` (DESIGN 1.4 step 2).

This directory is empty at G0 on purpose: the config schema has not moved yet, so there is nothing to migrate
from. The first entry lands with the unit that first breaks config compatibility.
