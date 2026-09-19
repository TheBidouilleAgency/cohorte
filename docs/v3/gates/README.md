# docs/v3/gates — one report per gate

A wave ends with a gate, run by that wave's integrator **alone**, after every other unit of the wave
(PLAN §5). The integrator writes `docs/v3/gates/G<n>.md`. Only integrators write in this directory.

## What a gate report contains

1. **Requests.** Every `docs/v3/requests/*.md` filed during the wave: applied or rejected, and why.
   A contract amendment names the contract, the units that read it, and the regenerated artifacts.
2. **Patches outside the structural paths.** The integrator may patch any file to make the tree green;
   each such patch is listed with the unit that owns the file.
3. **The exit check.** The exact command of the wave (`exitCheck` in `docs/v3/plan.json`) and the tail
   of its output. A gate is not passed while that command is red.
4. **The gate build.** `node scripts/build.ts --out .build/gate-<n>`: immutable once written, runnable
   offline, and what the next wave's E2E units execute (`COHORTE_E2E_BUILD_DIR`).
5. **The rollback checkpoint.** The directory printed by `node scripts/checkpoint.ts G<n>`: a binary
   patch of every tracked change against `HEAD` plus a tarball of the untracked files, written under
   `$COHORTE_CHECKPOINT_DIR`, outside the repository. Agents never commit on this branch, so this is
   the only way back to a gate. Restoring is three commands, recorded in the checkpoint's
   `manifest.json`.
6. **Deviations** accepted at the gate, with the DESIGN section they touch.
