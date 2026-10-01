#!/usr/bin/env bash
# tenon-verify action: run `tenon verify --ci` on the checked-out repository.
#
# All logic lives here (the composite action only wires inputs to environment variables), so the
# integration tests can run this exact script against a fixture repository. The script never fails
# the step itself: it records the verifier's exit code in the step outputs and the final step of the
# action turns a non-zero code into a failure, after the SARIF upload had its chance to run.
#
# Inputs (environment):
#   TENON_ACTION_PATH     directory of the action (github.action_path); the pinned CLI bundle ships
#                         inside the same release, three levels up
#   TENON_VERIFY_CLI      explicit path to a Tenon CLI entry (overrides the bundled one)
#   TENON_VERIFY_EXPECTED_VERSION   fail unless the CLI release matches
#   TENON_VERIFY_SINCE / _CHANGE / _ALL_OPEN / _STEP / _CANDIDATE / _REQUIRE_ANCHOR / _FETCH_NOTES
set -uo pipefail

workspace="${GITHUB_WORKSPACE:-$PWD}"
cd "$workspace" || { echo "::error::cannot enter workspace $workspace"; exit 1; }

emit() { [ -n "${GITHUB_OUTPUT:-}" ] && printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; return 0; }
fail() { echo "::error::$1"; emit exit-code 1; exit 0; }

cli="${TENON_VERIFY_CLI:-}"
if [ -z "$cli" ]; then
  [ -n "${TENON_ACTION_PATH:-}" ] || fail "tenon-verify: TENON_ACTION_PATH is not set"
  cli="$TENON_ACTION_PATH/../../../packages/cli/dist/tenon.mjs"
fi
[ -f "$cli" ] || fail "tenon-verify: Tenon CLI not found at $cli (use the action from a release tag, or pass the cli input)"

if [ -n "${TENON_VERIFY_EXPECTED_VERSION:-}" ]; then
  actual="$(node -e '
    const { readFileSync } = require("node:fs")
    const { dirname, join, resolve } = require("node:path")
    const root = resolve(dirname(process.argv[1]), "..", "..", "..")
    for (const file of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
      try { process.stdout.write(String(JSON.parse(readFileSync(join(root, file), "utf8")).version)); process.exit(0) } catch {}
    }
  ' "$cli" 2>/dev/null)"
  [ "$actual" = "$TENON_VERIFY_EXPECTED_VERSION" ] \
    || fail "tenon-verify: expected Tenon ${TENON_VERIFY_EXPECTED_VERSION} but the pinned CLI is ${actual:-unknown}"
fi

if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  echo "::warning::shallow checkout: Tenon needs the commit each task started from (actions/checkout with fetch-depth: 0); protected-file approvals cannot be checked without it"
fi

if [ "${TENON_VERIFY_FETCH_NOTES:-true}" = "true" ]; then
  # Notes are not part of a normal checkout. A missing ref just means nothing was anchored.
  git fetch --no-tags --quiet origin '+refs/notes/tenon:refs/notes/tenon' 2>/dev/null \
    || echo "tenon-verify: no refs/notes/tenon on origin (nothing anchored)"
fi

args=(verify --ci)
if [ -n "${TENON_VERIFY_CHANGE:-}" ]; then
  args+=(--change "$TENON_VERIFY_CHANGE")
elif [ "${TENON_VERIFY_ALL_OPEN:-false}" = "true" ]; then
  args+=(--all-open)
elif [ -n "${TENON_VERIFY_SINCE:-}" ]; then
  args+=(--since "$TENON_VERIFY_SINCE")
elif [ -n "${GITHUB_BASE_REF:-}" ]; then
  base="origin/$GITHUB_BASE_REF"
  git rev-parse --verify -q "$base^{commit}" >/dev/null 2>&1 \
    || git fetch --no-tags --quiet origin "+refs/heads/$GITHUB_BASE_REF:refs/remotes/$base" 2>/dev/null || true
  args+=(--since "$base")
else
  args+=(--all-open)
fi
[ -n "${TENON_VERIFY_STEP:-}" ] && args+=(--step "$TENON_VERIFY_STEP")
args+=(--candidate "${TENON_VERIFY_CANDIDATE:-error}")
[ "${TENON_VERIFY_REQUIRE_ANCHOR:-false}" = "true" ] && args+=(--require-anchor)

out="${RUNNER_TEMP:-$(mktemp -d)}/tenon-verify"
mkdir -p "$out"
rm -f "$out/tenon-verify.sarif" "$out/summary.md" "$out/report.json"

node "$cli" "${args[@]}" \
  --also "sarif=$out/tenon-verify.sarif" --also "markdown=$out/summary.md" --also "json=$out/report.json"
code=$?

if [ -f "$out/summary.md" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$out/summary.md" >> "$GITHUB_STEP_SUMMARY"
fi
emit exit-code "$code"
[ -f "$out/tenon-verify.sarif" ] && emit sarif-path "$out/tenon-verify.sarif"
[ -f "$out/summary.md" ] && emit summary-path "$out/summary.md"
[ -f "$out/report.json" ] && emit report-path "$out/report.json"
exit 0
