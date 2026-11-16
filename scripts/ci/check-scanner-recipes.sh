#!/usr/bin/env bash
#
# check-scanner-recipes.sh — run the `commands.security` recipes of profile/schema/preflight.md
# against REAL scanners, on throwaway fixtures. The recipes are flags typed from documentation;
# this is what proves a scanner still accepts them and exits the way the preflight relies on
# (non-zero = red, 0 = green). Needs network (advisory databases) and the scanners on PATH —
# so it runs in .github/workflows/scanners.yml, not in `npm test`.
#
#   scripts/ci/check-scanner-recipes.sh            # every scanner found on PATH
#
# A scanner that is not installed is reported SKIP; CI installs all of them.

set -uo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
FD="$root/scripts/feature-diff.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; fails=$((fails + 1)); }
skip() { echo "  - SKIP $1 (not installed)"; }
expect() { # expect <label> <want: 0|nonzero> <cmd…>
  local label=$1 want=$2; shift 2
  "$@" >"$work/out.log" 2>&1; local rc=$?
  if { [ "$want" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want" = nonzero ] && [ $rc -ne 0 ]; }; then
    pass "$label (exit $rc)"
  else
    fail "$label — expected $want, got exit $rc"; tail -15 "$work/out.log" | sed 's/^/      /'
  fi
}
newrepo() { # a git repo on main with one commit, then a feature branch
  local d="$work/$1"; mkdir -p "$d"; git -C "$d" init -q -b main
  git -C "$d" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  git -C "$d" switch -q -c feature; echo "$d"
}

# The secret-scan recipe, exactly as the table spells it (core path → this checkout's script).
secret_recipe() { # <repo> <scanner command reading "$P.added" on stdin>
  (cd "$1" && mkdir -p specs/reports && P=specs/reports/security-scan.patch \
    && { "$FD" --default main --patch > "$P" || exit 2; } \
    && grep '^+' "$P" > "$P.added"; eval "$2" < "$P.added" && rm -f "$P" "$P.added")
}
# A fake, well-formed AWS key pair (the AWS docs' own example values) and a GitHub-style token.
FAKE='aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"
aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
github_token = "ghp_xVd9pT8kQm3LzR7sNw2YbC4fH6jK1uE0aG5i"'

echo "secret scanners (feature diff only)"
if command -v gitleaks >/dev/null; then
  r=$(newrepo gl-hit); printf '%s\n' "$FAKE" > "$r/config.py"
  expect "gitleaks: a secret added by the feature is red" nonzero secret_recipe "$r" "gitleaks stdin --redact --no-banner"
  [ -f "$r/specs/reports/security-scan.patch.added" ] && pass "gitleaks: on a hit the evidence is kept" || fail "gitleaks: evidence removed on a hit"
  r=$(newrepo gl-clean); echo 'x = 1' > "$r/app.py"
  expect "gitleaks: a clean feature is green" 0 secret_recipe "$r" "gitleaks stdin --redact --no-banner"
  [ ! -f "$r/specs/reports/security-scan.patch" ] && pass "gitleaks: on a pass the patch is removed" || fail "gitleaks: patch left behind on a pass"
else skip gitleaks; fi
if command -v trufflehog >/dev/null; then
  r=$(newrepo th-clean); echo 'x = 1' > "$r/app.py"
  expect "trufflehog: the recipe's flags are accepted and a clean feature is green" 0 \
    secret_recipe "$r" "trufflehog stdin --fail --no-update --results=verified,unknown"
else skip trufflehog; fi

echo "dependency auditors"
if command -v npm >/dev/null; then
  d="$work/npm-vuln"; mkdir -p "$d"; (cd "$d" && npm init -y >/dev/null && npm install --package-lock-only --ignore-scripts lodash@4.17.15 >/dev/null 2>&1)
  expect "npm audit: a high-severity production advisory is red" nonzero sh -c "cd '$d' && npm audit --omit=dev --audit-level=high"
  d="$work/npm-ok"; mkdir -p "$d"; (cd "$d" && npm init -y >/dev/null && npm install --package-lock-only --ignore-scripts is-number@7.0.0 >/dev/null 2>&1)
  expect "npm audit: no advisory at the threshold is green" 0 sh -c "cd '$d' && npm audit --omit=dev --audit-level=high"
else skip npm; fi
if command -v pnpm >/dev/null; then
  d="$work/pnpm-vuln"; mkdir -p "$d"; (cd "$d" && echo '{"name":"x","version":"1.0.0","dependencies":{"lodash":"4.17.15"}}' > package.json && pnpm install --lockfile-only --ignore-scripts >/dev/null 2>&1)
  expect "pnpm audit: a high-severity production advisory is red" nonzero sh -c "cd '$d' && pnpm audit --prod --audit-level high"
else skip pnpm; fi
if command -v pip-audit >/dev/null; then
  d="$work/py"; mkdir -p "$d"; echo 'requests==2.19.0' > "$d/requirements.txt"
  expect "pip-audit: a known-vulnerable pin is red" nonzero pip-audit -r "$d/requirements.txt"
  echo "six==1.16.0" > "$d/requirements.txt"
  expect "pip-audit: a current pin is green" 0 pip-audit -r "$d/requirements.txt"
else skip pip-audit; fi
if command -v govulncheck >/dev/null && command -v go >/dev/null; then
  d="$work/go"; mkdir -p "$d"; (cd "$d" && go mod init example.com/x >/dev/null 2>&1 && printf 'package main\nfunc main() {}\n' > main.go)
  expect "govulncheck: a module with no reachable vulnerability is green" 0 sh -c "cd '$d' && govulncheck ./..."
else skip govulncheck; fi
if command -v cargo >/dev/null && cargo audit --version >/dev/null 2>&1; then
  d="$work/rs"; mkdir -p "$d/src"; printf '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n' > "$d/Cargo.toml"; echo 'fn main() {}' > "$d/src/main.rs"
  (cd "$d" && cargo generate-lockfile >/dev/null 2>&1)
  expect "cargo audit: a crate with no advisory is green" 0 sh -c "cd '$d' && cargo audit"
else skip "cargo audit"; fi

echo ""
if [ "$fails" -gt 0 ]; then echo "scanner recipes: $fails failure(s)"; exit 1; fi
echo "scanner recipes: OK"
