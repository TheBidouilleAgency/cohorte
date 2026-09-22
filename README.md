# Cohorte V3

Cohorte is a local, evidence-driven workflow engine for official coding-agent clients. This
repository is a Python 3.12 rewrite built at the repository root. It does not depend on the former
TypeScript/Pi implementations.

The current Codex-only pre-release provides the deterministic core, bounded feature and Patch
workflows, and overlap-aware Fleet execution:
strict contracts, a pure workflow reducer, SQLite persistence, immutable artifacts, project
discovery, DAG validation, isolated Git worktrees, controlled checks, independent read-only review,
a review/fix loop, a JSON-RPC stdio bridge, and a CLI. Codex authentication and live execution are
capability-gated. Claude remains disabled until a compatible account and pinned runtime have been
validated.

```bash
uv sync --all-extras
uv run cohorte doctor
uv run cohorte --json init /path/to/project
uv run cohorte --json status
uv run pytest
```

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
network port is opened. Windows runtime support remains under qualification.

By default, Cohorte stores configuration and state outside target repositories using platform
standard directories. Pass `--config-dir` and `--data-dir` for isolated automation. Cohorte never
stores provider tokens.

See [the implementation status](docs/IMPLEMENTATION.md) and [protocol reference](docs/PROTOCOL.md).
