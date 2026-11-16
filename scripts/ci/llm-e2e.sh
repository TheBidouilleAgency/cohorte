#!/usr/bin/env bash
#
# llm-e2e.sh — drive the REAL pipeline with a real model on a toy repo:
#   cohorte install → sync → /cohorte-build sum → /cohorte-review sum
# and assert on what lands on disk (code + tests, build.json, readiness.json, verdict.json) — never
# on prose. It is the only test that can catch a regression in the prompts themselves.
#
#   ANTHROPIC_API_KEY=… scripts/ci/llm-e2e.sh            (or a logged-in `claude` CLI)
#
# Costs a few dollars per run (two Sonnet-pinned commands + their subagents). Not in CI: run it by
# hand before a release that changes the commands' prompts.

set -uo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
command -v claude >/dev/null || { echo "llm-e2e: no claude CLI on PATH"; exit 2; }
work=${LLM_E2E_DIR:-$(mktemp -d)}
home="$work/home"; repo="$work/repo"; logs="$work/logs"
mkdir -p "$home" "$repo" "$logs"
fails=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; fails=$((fails + 1)); }

# Install into a throwaway config dir: commands, agents, workflows, core. The CLI's own login
# (HOME/.claude.json or ANTHROPIC_API_KEY) is untouched.
CLAUDE_CONFIG_DIR="$home/.claude" COHORTE_NO_VERSION_CHECK=1 node "$root/bin/cli.js" install </dev/null >"$logs/install.log" 2>&1 \
  && pass "cohorte install" || { fail "cohorte install"; cat "$logs/install.log"; exit 1; }

# --- the toy project -----------------------------------------------------------------
cd "$repo"
git init -q -b main
git config user.email e2e@example.invalid; git config user.name e2e
cat > package.json <<'EOF'
{ "name": "e2e-toy", "private": true, "type": "commonjs", "scripts": { "test": "node --test" } }
EOF
mkdir -p src specs
cat > PIPELINE.md <<'EOF'
# e2e-toy

```yaml pipeline-profile
name: e2e-toy
one_liner: A toy library used to test the cohorte pipeline end to end.
project:
  kind: library
package_manager: npm
surfaces:
  - key: lib
    path: src
    label: Library
    agent: lib
    tools: [Read, Write, Edit, Bash, Grep, Glob]
    model: sonnet
    test_cmd: node --test
    test_quiet_cmd: node --test --test-reporter=dot
    lint_cmd: ""
    typecheck_cmd: ""
    build_cmd: ""
    uses_design: false
commands:
  install: "true"
  test: node --test
  test_quiet: node --test --test-reporter=dot
  lint: ""
  typecheck: ""
contract:
  enabled: false
vcs:
  host: none
  default_branch: main
  feature_branch_prefix: feature/
isolation:
  enabled: false
design:
  enabled: false
retrieval:
  provider: none
rbac:
  enabled: false
release_notes:
  enabled: false
gate:
  default_branch: main
  deny: [git push --force, rm -rf]
  ask: []
  ask_on_default_branch: [git push]
  preflight:
    enabled: true
    agents: [cohorte-review]
    max_age_minutes: 30
```

## Conventions

### Shared
- CommonJS modules, no dependencies. Every exported function has a `node:test` test next to it.

### Surface: lib
- One function per file in `src/`, tested in `src/<name>.test.js`.

## Testing
- `node --test` must pass.
EOF
mkdir -p .claude
cat > .claude/gate-config.json <<'EOF'
{ "deny": ["git push --force", "rm -rf"], "ask": [], "ask_on_default_branch": ["git push"], "default_branch": "main",
  "preflight": { "enabled": true, "agents": ["cohorte-review"], "max_age_minutes": 30 } }
EOF
# The surface agent, rendered from the shipped template (the init step does exactly this).
tpl="$home/.claude/cohorte/pipeline/implementer.template.md"
mkdir -p .claude/agents
sed -e 's/<SURFACE_AGENT>/lib/g' -e 's/<SURFACE_LABEL>/Library/g' -e 's#<SURFACE_PATH>#src#g' \
    -e 's/<SURFACE_TOOLS>/Read, Write, Edit, Bash, Grep, Glob/g' -e 's/<SURFACE_MODEL>/sonnet/g' \
    -e 's/<PROJECT_NAME>/e2e-toy/g' -e 's/<SURFACE_EXTRA_NEVER>//g' -e 's/<SURFACE_DESIGN_INPUT>//g' \
    -e 's/<SURFACE_TDD_STEP1>/Write the failing node:test test first./g' \
    -e 's/<SURFACE_CONVENTIONS>/One function per file in src\/, tested in src\/<name>.test.js. CommonJS, no dependencies./g' \
    "$tpl" > .claude/agents/lib.md
cat > specs/sum.md <<'EOF'
---
feature_id: sum
title: Sum of two numbers
status: frozen
branch: feature/sum
created: 2026-01-01
migrations: false
reviewed_base:
reviewed_digest:
---

# Sum of two numbers

## 1. Goal & user story

Library users need `sum(a, b)` returning the sum of two finite numbers.

## 2. Scope

**In:** `src/sum.js` exporting `sum(a, b)`, with tests. **Out:** anything else.

## 3. Roles & permissions

None.

## 4. Data model & migrations

None.

## 5. CONTRACT (frozen)

`module.exports = sum` in `src/sum.js`. `sum(a: number, b: number): number` returns `a + b`.
Throws `TypeError('sum expects two finite numbers')` when either argument is not a finite number.

## 6. Surface tasks

- **lib** — implement `src/sum.js` and `src/sum.test.js` (happy path, a negative, the TypeError).

## 8. Design brief (the "spec return")

None (no UI).

## 9. Acceptance criteria / DoD

- [ ] `sum(2, 3) === 5`, `sum(-1, 1) === 0`
- [ ] non-finite input throws `TypeError` with the exact message
- [ ] `node --test` green

## 10. Assumptions & open questions

None.

## Rollback

Not applicable (no migrations).

## Remediation
EOF
printf 'node_modules/\n' > .gitignore
git add -A && git commit -q -m "toy repo"
CLAUDE_CONFIG_DIR="$home/.claude" COHORTE_NO_VERSION_CHECK=1 node "$root/bin/cli.js" sync . >"$logs/sync.log" 2>&1 \
  && pass "cohorte sync" || fail "cohorte sync"
git add -A && git commit -q -m "wire cohorte"

# --- the real model ---------------------------------------------------------------------
# The commands live in the throwaway install: point Claude Code at it for commands/agents/
# workflows via --add-dir is not enough (it reads ~/.claude), so copy them into the project.
mkdir -p .claude/commands
cp "$home/.claude/commands/"cohorte-*.md .claude/commands/
cp "$home/.claude/agents/"cohorte-*.md .claude/agents/
run() { # run <name> <prompt>
  local name=$1 prompt=$2
  claude -p "$prompt" --permission-mode acceptEdits \
    --allowedTools "Bash Read Write Edit Glob Grep Agent Task" \
    --max-turns 60 < /dev/null > "$logs/$name.log" 2>&1
  echo $?
}
rc=$(run build "/cohorte-build sum")
[ "$rc" = 0 ] && pass "/cohorte-build exits 0" || fail "/cohorte-build exits $rc"
[ -f src/sum.js ] && pass "the surface agent wrote src/sum.js" || fail "src/sum.js missing"
ls src/*.test.js >/dev/null 2>&1 && pass "…and a test file" || fail "no test file in src/"
node --test >"$logs/test.log" 2>&1 && pass "the built code passes its tests" || fail "node --test is red"
[ -f specs/reports/sum.readiness.json ] && pass "readiness.json written" || fail "readiness.json missing"
[ -f specs/reports/sum.build.json ] && pass "build.json written" || fail "build.json missing"

rc=$(run review "/cohorte-review sum")
[ "$rc" = 0 ] && pass "/cohorte-review exits 0" || fail "/cohorte-review exits $rc"
if [ -f specs/reports/sum.verdict.json ]; then
  v=$(node -p "require('./specs/reports/sum.verdict.json').verdict" 2>/dev/null)
  case "$v" in SHIP|REVISE|BLOCK) pass "verdict.json has a verdict ($v)";; *) fail "verdict.json verdict is '$v'";; esac
  [ "$v" = SHIP ] && grep -q '^reviewed_digest: [0-9a-f]\{16\}' specs/sum.md && pass "SHIP stamps the freshness digest" \
    || { [ "$v" != SHIP ] && pass "not SHIP ⇒ no stamp expected"; } || fail "SHIP without a freshness stamp"
else
  fail "verdict.json missing"
fi
[ -f .claude/preflight.ok ] && pass "the preflight ran and stamped" || fail "no preflight stamp"

echo ""
echo "logs: $logs"
if [ "$fails" -gt 0 ]; then echo "llm-e2e: $fails failure(s)"; exit 1; fi
echo "llm-e2e: OK"
