# REVIEW REPORT

<!-- REFERENCE COPY — not read at runtime. The AUTHORITATIVE shape is inlined in
     core/agents/cohorte-review.md (§"Your return"), because an agent must not need a second
     file read to know its own output format. This file exists for humans reading the
     core; keep it byte-aligned with the agent, or delete both together.

     Everything in an HTML comment is guidance — do NOT emit it.
     The verdict rule is stated once, in the review agent's §Severity & verdict.
     CAPPED: max 20 findings, ONE line each (severity · file:line · type · concrete fix),
     ZERO code excerpts — file:line is enough, the source is on disk. Overflow ⇒ keep all
     CRITICAL/HIGH/security, fill by severity, close with one `+<n> more …` line.
     scripts/validate-core.mjs checks this file's headings against the agent's template. -->

feature_id: <feature_id> · scope: <surface.key>

| Severity | Count |
| -------- | ----- |
| CRITICAL | 0     |
| HIGH     | 0     |
| MEDIUM   | 0     |
| LOW      | 0     |

Verdict: <SHIP | REVISE | BLOCK>

## Findings

<!-- Every finding self-sufficient for a stateless agent; order by severity; "None." if none.
     The line format pastes straight into the spec's `## Remediation`. -->

- **[CRITICAL]** `<surface.path>/...:42` · spec-violation · <what's wrong vs spec §X> → **Fix:** <concrete change>
- **[HIGH]** `<path>:88` · quality · <issue> → **Fix:** <concrete change>
- **[HIGH]** `<path>:line` · security · <vuln> → **Fix:** <concrete change>
- **[MEDIUM]** `<path>:line` · complexity · yagni: <what> → **Fix:** <the cheaper form>

## Deferred

<!-- Real but out of this feature's scope (agent §Deferred): worst first, "None." if none, max 10.
     Counted in no severity row, never in the verdict — the lead routes them to the backlog. -->

- **[MEDIUM]** `<path>:line` · quality · <problem> → **Fix:** <concrete change> · out of scope: <why this feature does not own it>

## Notes

<!-- ONLY the RBAC / mobile-first assessment when the profile enables them; omit the section
     otherwise. Never list things verified clean. -->
