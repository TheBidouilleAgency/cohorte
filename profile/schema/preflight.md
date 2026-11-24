## Preflight — the deterministic phase gate

`/cohorte-review` starts by running `pipeline/scripts/preflight.sh` — a plain shell script (no
agent) that executes the profile's mechanical checks in order (typecheck → lint → tests, quiet
variants, then any `commands.security` scans — below) with all output redirected to `specs/reports/<id>.preflight.txt`:

- **Any check red** ⇒ the script prints the last 40 lines raw and exits 1. The command **aborts
  there: zero agents are spawned.** A reviewer dispatched onto code that doesn't compile burns its
  whole run rediscovering what `tsc` already printed for free — the failure goes straight to the
  human (or `/cohorte-fix`) instead.
- **Nothing ran** (no command given / every argument empty ⇒ exit 2, or the call was denied by the
  gate or the permission system) ⇒ the abort is `pipeline-misconfigured`, not a red preflight: a
  cohorte setup problem, the code was never judged. The message says so and points at
  `/cohorte-doctor` then `/cohorte-update-pipeline`; the loop leaves the spec status untouched.
- **All green** ⇒ the script stamps `<state>/preflight.ok` (`<epoch> <HEAD sha> <tree digest>` —
  local and **gitignored**; a versioned stamp describes the tree *before* its own commit and rides
  into every clone and worktree, which breaks the gate both ways).

`hooks/gate.py` enforces the stamp as a **phase gate** (the `preflight` block of `gate-config.json`,
generated from `gate.preflight`): an `Agent` (formerly `Task`) dispatch of a listed `subagent_type` (default
`cohorte-review`) with a missing/stale stamp — older than `max_age_minutes`, or the digest no longer
matches the working tree (`.claude` and `specs` excluded, so the pipeline's own writes and a
commit of already-verified code do not invalidate it) — gets an
"ask", so a lead can't accidentally skip the gate but a human can consciously override it. The gate
hook fires for **every** agent in the session, including subagents spawned by the Workflow runtime
(they run in `acceptEdits` whatever the session mode — Write/Edit auto-approved — but Bash and Agent
still pass through hooks). In `bypassPermissions` (headless runs) every gate "ask" is escalated to a
hard deny, because nobody is there to answer a prompt.

### Security scans — `commands.security`

`commands.security: []` is a list of shell commands, empty by default. The preflight runs them
**after** typecheck → lint → tests, in the same script call, into the same report. They are just
more arguments to `preflight.sh`. The caller passes a no-op marker, `: cohorte-security-scans`,
ahead of them. The marker shows up in the report as the line `$ : cohorte-security-scans`, which
opens the **security section**.

- **A scan is a gate like any other check.** A non-zero exit means a dependency advisory at the
  command's threshold or a secret in the feature's diff. It turns the preflight red, the review
  aborts, and no agent is spawned. So pick thresholds that the default branch passes today.
  Otherwise every review is blocked by debt the feature didn't add.
- **Green scans still leave output behind**, such as advisories below the threshold. The
  `cohorte-review` agent's security pass reads the security section, found by grepping for the
  marker. The threshold is the project's choice, so nothing below it blocks. An advisory on a
  dependency that the reviewer's own staged diff adds or bumps becomes one non-blocking
  `quality` finding. Advisories on untouched dependencies are ignored: they are neither findings
  nor backlog items.
- **Quoting.** Pass each command as one argument. Single-quote any command that contains `$`,
  a backtick or `\` (a `'` inside becomes `'\''`). Inside double quotes the calling shell would
  expand the command's own variables before `preflight.sh` ever ran it.
- **A command path must be static.** A command name computed at run time (`"$CORE/x.sh"`,
  `"${CLAUDE_CONFIG_DIR:-…}/…"`) gets **ask** from the gate hook, and ask becomes deny in
  headless runs. Write `~/.claude/cohorte/…`. If `CLAUDE_CONFIG_DIR` is set, write its literal
  value instead.
- **Secret scans target the feature only, never history.** Feature work is uncommitted until
  `/cohorte-ship`, so `gitleaks git`, `trufflehog git --since-commit …` and any other log-based
  scan see none of it, and a whole-history scan reports every old leak on every review. Scan the
  `feature-diff.sh --patch` output (`<core>/pipeline/schema/feature-diff.md`): untracked files are
  included, the base is the merge-base, and `.claude/` and `specs/` are excluded. Keep only the
  added lines (`grep '^+'`), so that a feature *removing* a secret does not fail. Write the patch
  only under `specs/reports/`: it is gitignored and excluded from both the stamp digest and the
  feature diff, so it changes neither. The recipe deletes it on a pass. On a hit it keeps
  `security-scan.patch` and `.patch.added`, because the scanner read only the added lines and its
  line numbers point into `.added`. Use the patch to find the file. Never pipe `feature-diff.sh`
  straight into the scanner. In `sh`, a pipeline's status is its last command's, so an exit 3
  (no base) would hand the scanner an empty input that passes.

**Detected defaults** `/cohorte-init-pipeline` proposes, one per detected manifest or tool.
Never add one silently. `<default_branch>` is filled in at init.

| Detected | Command | Threshold / scope |
| --- | --- | --- |
| `package-lock.json` | `npm audit --omit=dev --audit-level=high` | production deps, high+ |
| `pnpm-lock.yaml` | `pnpm audit --prod --audit-level high` | production deps, high+ |
| `yarn.lock` (Yarn ≥ 2) | `yarn npm audit --all --recursive --environment production --severity high` | all workspaces, transitive, production, high+ |
| `yarn.lock` (Yarn 1) | `yarn audit --groups dependencies --level high` | the exit code is a severity bitmask, so check it on the project before relying on it |
| `requirements*.txt` / `pyproject.toml` | `pip-audit -r requirements.txt` (or `pip-audit` in the project env) | no severity filter, so any known vuln is red |
| `go.mod` | `govulncheck ./...` | only vulnerabilities the code actually reaches |
| `Cargo.lock` | `cargo audit` | needs `cargo install cargo-audit` |
| `gitleaks` on PATH | `P=specs/reports/security-scan.patch; ~/.claude/cohorte/pipeline/scripts/feature-diff.sh --default <default_branch> --patch > "$P" \|\| exit 2; grep '^+' "$P" > "$P.added"; gitleaks stdin --redact --no-banner < "$P.added" && rm -f "$P" "$P.added"` | the feature diff only, secrets redacted from the report |
| `trufflehog` on PATH | the same line with `trufflehog stdin --fail --no-update --results=verified,unknown < "$P.added"` in place of `gitleaks …` | `--fail` exits 183 on a result. Without `--fail` it always exits 0 |

Offer at most one secret scanner. A scanner that isn't installed is not proposed. Say how to
install it, and let the human decide. The release agent's own check (no `.env` or credential
file staged at ship) still applies; these scans don't replace it.
