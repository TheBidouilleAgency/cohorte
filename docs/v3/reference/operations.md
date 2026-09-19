# Operations

Use `cohorte status --json` and `cohorte tail <run-id> --json` for automation. A run is resumable after host
failure; its snapshot pins the installed bundle, assets, prompts and runtime. Do not modify an active install or
its CAS. Run `cohorte doctor --json` before enabling a native sandbox or a live provider.

The fake runtime is the offline smoke path. Live provider tests are opt-in through `COHORTE_LIVE=1` and must use
the documented budget in `docs/v3/runbooks/live.md`.
