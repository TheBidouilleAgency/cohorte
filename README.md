# Cohorte V3

Install the Python CLI from PyPI (not the legacy npm package):

```bash
uv tool install 'cohorte-engine==1.0.0a3'
cohorte --version
```

User documentation: [VitePress site](https://thebidouilleagency.github.io/cohorte/)
([sources](docs/index.md)). Only to preview the documentation site locally, run
`npm ci --prefix docs && npm run dev --prefix docs`. npm does not install the Python CLI.

For Python dev releases, see [the release runbook](docs/RELEASING.md).

Cohorte is a local, evidence-driven workflow engine for official coding-agent clients. This
repository is a Python 3.12 rewrite built at the repository root. It does not depend on the former
TypeScript/Pi implementations.

The current pre-release provides the deterministic core, bounded feature and Patch
workflows, and overlap-aware Fleet execution:
strict contracts, a pure workflow reducer, SQLite persistence, immutable artifacts, project
discovery, DAG validation, isolated Git worktrees, controlled checks, independent read-only review,
a review/fix loop, a JSON-RPC stdio bridge, and a CLI. Codex authentication and live execution are
capability-gated. A Claude Agent SDK adapter is available through the optional `claude` dependency
and `agent_defaults.provider: claude`; a bounded single-surface Claude workflow has passed live
build, checks and review on Darwin arm64.
Passive `auth status claude` checks the native CLI without exposing credentials. An explicit
`auth verify claude --live` probe is available after confirming the account to use.
The connected native account passed the Claude SDK smoke, structured read, workspace edit,
outside-write denial, a guarded read-only write denial, and CLI cancellation/pause/resume probes.
G0 remains partial: the full login interaction and safe native session recovery inside a workflow
are not yet qualified.
Both adapters now persist common turn, tool and usage events for workflow runs. The event payloads
contain provider, phase, access and bounded metadata, without prompts, responses, commands or file
paths. SDK token accounting can differ, and Claude's reported cost is an estimate rather than a
provider billing statement.

```bash
uv sync --all-extras
uv run cohorte doctor
uv run cohorte --json init /path/to/project
uv run cohorte --json status
uv run pytest
```

From a project directory, the guided CLI needs no project ID or JSON flags:

```bash
cohorte init .
cohorte profile show
cohorte profile edit
cohorte status
cohorte intake
cohorte intake --continue FEATURE_ID
cohorte brainstorm --from-intake FEATURE_ID
cohorte brainstorm
cohorte brainstorm --continue FEATURE_ID
cohorte brief show FEATURE_ID
cohorte spec
cohorte start
```

`init` inventories pnpm/npm workspaces, including nested package patterns, internal dependencies,
root checks and shared files. It returns the stored profile on repeat runs. Review its questions
and edit the stored JSON profile before relying on it for a workflow; `cohorte init . --refresh`
explicitly replaces edits with a fresh discovery. `cohorte profile apply reviewed.json` applies a
validated profile from a file, with a revision check. The guided brainstorm asks for the idea,
audience, observed problem, desired outcome and constraints, then prints a short synthesis. Its
full brief remains stored in Cohorte and can be read with `cohorte brief show FEATURE_ID` without
rerunning the panel. If the panel raises blocking questions, the terminal can collect answers and
run another round immediately. `cohorte brainstorm --continue FEATURE_ID` resumes later from the
latest brief, preserving the earlier answers and linking revisions. For scripts, use
`cohorte --json brief show FEATURE_ID` to read the complete stored document, or
`cohorte --json brainstorm --continue FEATURE_ID --answer '...' --live` for one follow-up round.
The generated commands are candidates: confirm service setup and migrations before running
project-wide checks in a monorepo.

`status` shows the current project's features, runs and pending run decisions. `intake` captures
text, a file or a URL, then stores follow-up answers and the chosen route in linked revisions.
`brainstorm --from-intake FEATURE_ID` carries those answers and source provenance into the panel.
`spec` collects multiple surfaces, scenarios and criteria, keeps unanswered questions open, and
shows the exact candidate hash before an explicit freeze decision. A later brief can be attached
to an existing draft without erasing its scenarios or criteria. `start` verifies the frozen spec
and approved profile snapshot before asking to launch a live worktree run. The explicit file-based
commands remain available for automation. See the [CLI experience audit](docs/CLI-UX-AUDIT.md).
These newer guided flows require a release newer than `1.0.0a4`; verify the installed version with
`cohorte --version` before using them in another project.

For external context, set `integrations.retrieval.provider` to `serena` or `graphify` in the
project profile. Serena needs the installed `serena` MCP executable. Graphify-Labs needs the
`graphify` optional extra and a prebuilt `<repo>/graphify-out/graph.json`; for a code-only graph,
run `graphify extract <repo> --code-only --no-cluster --out <repo>` explicitly before retrieval.
Both providers fail visibly when unavailable; file fallback requires
`integrations.retrieval.fallback_to_files: true`. Figma design snapshots use a file or node URL in
`integrations.design.source` and a locally supplied `FIGMA_ACCESS_TOKEN` with
`file_content:read` scope. The token is never part of the profile. To verify a real Figma snapshot
without printing its contents, run `python tests/live/verify_figma_snapshot.py --source <file-or-node-url>`
in a shell where the token is already set, or enter it at the hidden prompt.

Prepare a feature with independent product, architecture and QA sessions, then approve the exact
completed spec before freezing it:

```bash
cohorte --json --data-dir /path/to/data brainstorm PROJECT_ID \
  --feature-id safe-export --idea "Add a safe run export" \
  --answer "Keep data local and require atomic output" \
  --repo /path/to/project --output brief.json --live
cohorte --json --data-dir /path/to/data spec-freeze-request draft.json \
  --profile project.json --repo /path/to/project
cohorte --json --data-dir /path/to/data approve REQUEST_ID
cohorte --json --data-dir /path/to/data spec-freeze draft.json \
  --profile project.json --repo /path/to/project \
  --decision-id DECISION_ID --output frozen.json
```

The brainstorm keeps each native session reference, contribution and disagreement. Freeze rejects
incomplete drafts and approvals for a different spec hash, profile, reference set or generated plan.

Run the disposable Codex vertical with the included frozen example:

```bash
cohorte --json loop examples/g1/spec.json \
  --profile examples/g1/profile.json \
  --repo /path/to/disposable/repository \
  --worktrees /tmp/cohorte-worktrees \
  --run-id demo-1 \
  --live
```

Run several frozen feature specs as an overlap-aware fleet:

```bash
cohorte --json fleet specs/feature-a.json specs/feature-b.json \
  --profile project.json \
  --repo /path/to/disposable/repository \
  --worktrees /tmp/cohorte-fleet-worktrees \
  --fleet-id release-train-1 \
  --live
```

Fleet computes the cross-feature dependency graph, parallelizes disjoint features, serializes
overlapping write sets, integrates each candidate in order and reruns its declared checks after the
base changes.

Capture a ticket, freeze a bounded patch, and run it with a pre-existing regression:

For a guided preparation after `intake` routes the request to `patch`, run
`cohorte patch-spec --from-intake FEATURE_ID` and review the generated `patch.json`.

```bash
cohorte --json --data-dir /path/to/data intake PROJECT_ID --file ticket.txt
cohorte --json --data-dir /path/to/data patch-spec \
  --source-artifact-id SOURCE_ID --source-revision 1 \
  --profile project.json --patch-id fix-total --title "Fix total" \
  --reproduction "Run the regression test" --observed "It returns 6" \
  --expected "It returns 5" --surface python --write-path calc.py \
  --check regression --in-scope "Correct total" --rollback "Revert calc.py" \
  --output patch.json
cohorte --json --data-dir /path/to/data patch patch.json \
  --profile project.json --repo /path/to/repository \
  --worktrees /tmp/cohorte-patch-worktrees --run-id patch-1 --live
```

Patch refuses to build unless every declared automatic regression is red on the original commit.
The agent can edit only the frozen patch paths; the same checks and an independent review then gate
the candidate-bound ship request.

The command creates a branch and isolated worktree, but does not commit, push, open a pull request,
or modify the source checkout.

Runs checkpoint every completed phase in SQLite. After an interrupted controller process, resume the
same worktree with:

```bash
cohorte --json --data-dir /path/to/data resume RUN_ID --live
```

`pause RUN_ID` and `cancel RUN_ID` are cooperative: an active provider turn finishes, then Cohorte
records the completed phase boundary and stops before starting another phase.

Delivery remains separately authorized:

```bash
cohorte --json --data-dir /path/to/data approve REQUEST_ID
cohorte --json --data-dir /path/to/data ship RUN_ID --live
cohorte --json --data-dir /path/to/data delivery-status RUN_ID --live --watch
```

`ship` rechecks the candidate hash and remote base, creates a commit with a run marker, pushes without
force, then confirms the GitHub PR or GitLab MR through the provider CLI. Every effect is journaled
before execution and reconciled on retry. It never merges or deploys.

When `integrations.release_notes.enabled` is `true` in the project profile, `ship` appends a
release-notes section to the PR/MR description. Its optional `heading` defaults to `Release notes`;
its optional `template` defaults to `{title}\n\n{problem}`. Templates may use only `{title}`,
`{problem}`, and `{acceptance}` (a bulleted list). Notes are omitted when the integration is
disabled, and do not modify the reviewed candidate.

Inspect and apply a bounded V2 metadata migration with an explicit rollback point:

```bash
cohorte --json --data-dir /path/to/data migrate \
  --from-v2 /path/to/v2-copy --plan migration-plan.json
cohorte --json --data-dir /path/to/data migrate --apply migration-plan.json
cohorte --json --data-dir /path/to/data migrate --rollback /path/from/apply/backup.bak
```

The plan contains exact hashes, mappings, exclusions, losses and ambiguities. Apply fails if a
source changed, imports no credentials or active run, and stores specs as historical artifacts that
require V3 validation before build.

Run the persistent local service used by protocol clients:

```bash
cohorte --json --data-dir /path/to/data service start
cohorte --json --data-dir /path/to/data service status
cohorte --json --data-dir /path/to/data service stop
```

On POSIX this uses a private Unix socket and verifies the connecting process belongs to the same
user. On Windows it uses a local named pipe with a DACL restricted to the current user SID. No
network port is opened. The lifecycle passes on GitHub-hosted Windows 3.12 and 3.13; release support
still requires real-host and slow-client qualification.

By default, Cohorte stores configuration and state outside target repositories using platform
standard directories. Pass `--config-dir` and `--data-dir` for isolated automation. Cohorte never
stores provider tokens.

See [the implementation status](docs/IMPLEMENTATION.md), [qualification matrix](docs/qualification/README.md)
and [protocol reference](docs/PROTOCOL.md).
