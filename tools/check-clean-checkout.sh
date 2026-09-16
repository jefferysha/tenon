#!/usr/bin/env bash
# Prove the suites that read the plugin root's Skills still pass without fetched upstream Skills.
#
# Upstream Skills are fetched into the plugin root by setup/update and are gitignored, so a clean
# clone (CI) has only the tracked ones while a developer checkout has 45 more. A suite that reads
# fetched bytes therefore passes locally and fails in CI. This check copies the tracked working tree
# into a temporary root——ignored paths are excluded by construction, exactly like a fresh clone——and
# runs the suites that touch the plugin root there.
#
# Honest limits, so nobody reads more into a pass than it proves:
#   · node_modules and the built bundles are borrowed from this working tree (CI builds them first);
#   · it runs the named suites below, not the whole CI list——CI on a real clone stays the full proof.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tenon-clean-checkout.XXXXXX")"

git -C "$ROOT" ls-files -z > "$WORK/.tracked"
rsync -a --files-from="$WORK/.tracked" --from0 "$ROOT/" "$WORK/tree/"
rm -f "$WORK/.tracked"
cd "$WORK/tree"

ln -s "$ROOT/node_modules" node_modules
# Compiled output is gitignored, and CLI sources import ../../kernel/dist/* directly, so a tracked
# tree cannot resolve them. CI runs `npm run build` before these suites; borrow that build instead
# of recompiling——this check is about Skill bytes, not about build integrity.
for pkg in "$ROOT"/packages/*/dist; do
  [ -d "$pkg" ] || continue
  dest="packages/$(basename "$(dirname "$pkg")")/dist"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$pkg" "$dest"
done

printf '[clean-checkout] tracked tree: %s\n' "$WORK/tree"
printf '[clean-checkout] skills present: %s\n' "$(find skills -maxdepth 1 -type d ! -name skills | wc -l | tr -d ' ')"

fail=0
run() {
  local name="$1"
  shift
  printf '[clean-checkout] %s\n' "$name"
  "$@" > "$WORK/$name.log" 2>&1 || {
    fail=1
    printf '[clean-checkout] FAIL %s (log: %s)\n' "$name" "$WORK/$name.log"
    tail -20 "$WORK/$name.log"
  }
}

run verify-skills bash tools/verify-skills.sh
run adapters bash tools/test-adapters.sh
run hooks bash tools/test-hooks.sh
run plugin-root-suites npx vitest run \
  packages/cli/src/internal-skill-gate-hook.integration.test.ts \
  packages/cli/src/runtime/stable-hook.integration.test.ts \
  packages/cli/src/workflow-skill-orchestration.integration.test.ts

if [ "$fail" -eq 0 ]; then
  rm -rf "$WORK"
  printf '[clean-checkout] OK — plugin-root suites pass without fetched upstream Skills\n'
else
  printf '[clean-checkout] retained tracked tree and logs: %s\n' "$WORK"
fi
exit "$fail"
