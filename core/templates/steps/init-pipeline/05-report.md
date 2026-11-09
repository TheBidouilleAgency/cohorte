# /cohorte-init-pipeline · 05 Report

### Phase 5 — Report

Print: the install mode (bundled core under `.claude/` vs global core in `~/.claude/` + the committed
`<state>/pipeline.json` pointer), the files written/rendered, the surface→agent mapping, and the
tailored workflow line, e.g.
`/cohorte-brainstorm → /cohorte-spec → (design) → /cohorte-build <id> → test → /cohorte-review → /cohorte-ship`. Tell the human to sanity-check
`PIPELINE.md`, commit it, and run `/cohorte-brainstorm` to start a feature. Note that this was the one-time
setup: from now on `/cohorte-update-pipeline` both refreshes the core AND reconciles the generated files
(SCHEMA.md §Reconcile), and `/cohorte-build` auto-grows surfaces — re-running `/cohorte-init-pipeline` is only for deep
stack changes (package manager, contract mechanism, surface overhaul).
