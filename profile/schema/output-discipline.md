## Output discipline — quiet commands

A test runner's default output is written for a human watching a terminal: one line per test, banners,
timing tables. An agent pays input price for every one of those lines, on every turn they survive in its
context. The profile therefore stores **two forms of each noisy command**:

- `test_cmd` / `lint_cmd` — the full form, for a human running it by hand.
- `test_quiet_cmd` / `lint_quiet_cmd` (per surface) and `commands.test_quiet` / `commands.lint_quiet`
  (repo-wide) — the **bridled** form agents actually execute: dot/failures-only reporter
  (`--reporter=dot`, `--quiet`, `-q`, `--silent`, framework equivalent) so a green run costs lines,
  not pages, and a red run prints only the failures.

Rules for every consumer (implementers, preflight, `/cohorte-audit` gates, workflow agents):

1. Run the quiet variant when set.
2. Quiet variant empty/absent (older profile) ⇒ run `<full cmd> 2>&1 | tail -40` — never the bare
   command into your context.
3. Need the full log? Redirect it to a file and grep it; never print it.

`/cohorte-init-pipeline` **asks** for these variants (detected defaults offered first) instead of silently
storing a bare `pnpm test` as the thing agents execute; `/cohorte-update-pipeline` tops up older profiles.
