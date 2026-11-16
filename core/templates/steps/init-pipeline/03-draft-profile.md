# /cohorte-init-pipeline · 03 Draft the profile

### Phase 3 — Draft the profile (show, don't write yet)

Assemble the full `PIPELINE.md` from `<core>/pipeline/PIPELINE.template.md`, filling the `yaml pipeline-profile`
block and every prose section from Phases 1–2 — including `project.kind` as confirmed in Phase 2
(and the `design`/`rbac` defaults it implied). **Keep it lean**: every stateless agent re-reads this
file on every dispatch, so its length is a per-dispatch token+latency tax — terse rule-shaped
conventions, no narration, no facts derivable from the code. **Show the human the drafted
`PIPELINE.md` in a fenced block and get a go-ahead** before writing.
