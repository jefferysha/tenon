#!/usr/bin/env bash
set -euo pipefail

# Exit 78 (EX_CONFIG) is the documented one-time skip: fixture status none names the current release.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
META="$ROOT/tools/fixtures/n-minus-one-release.json"
OUTPUT_ROOT="${1:?usage: prepare-n-minus-one-release.sh <empty-output-root>}"
PAYLOAD="$OUTPUT_ROOT/payload"
RETIRED_RELEASE_VERSION='^1\.(0\.[0-9]|1\.[0-5])$'

if [ -e "$PAYLOAD" ]; then
  printf 'N-1 payload 目标已存在，拒绝混入旧文件: %s\n' "$PAYLOAD" >&2
  exit 1
fi

current="$(node -p "require('$ROOT/package.json').version")"
fixture="$(node -e '
  const value = require(process.argv[1])
  const text = (key) => typeof value[key] === "string" && value[key] !== ""
  const stable = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
  if (value.schemaVersion === 3 && value.status === "none" && text("release") && text("reason")) {
    process.stdout.write(["none", value.release, value.reason].join("\t"))
  } else if (value.schemaVersion === 3 && value.status === "pinned"
    && ["tag", "pluginVersion", "gitCommit", "cliEntry", "cliSha256"].every(text)
    && stable.test(value.pluginVersion) && value.tag === "v" + value.pluginVersion) {
    process.stdout.write("pinned")
  } else {
    process.exit(2)
  }
' "$META")" || {
  printf 'N-1 fixture 结构非法: %s\n' "$META" >&2
  exit 1
}

if [ "${fixture%%$'\t'*}" = none ]; then
  IFS=$'\t' read -r _ skip_release skip_reason <<< "$fixture"
  if [ "$skip_release" = "v$current" ]; then
    printf 'N-1 skipped: %s %s\n' "$skip_release" "$skip_reason"
    exit 78
  fi
  printf 'N-1 一次性跳过只适用于 %s；当前 v%s 必须固定最近的正式版本\n' "$skip_release" "$current" >&2
  exit 1
fi

commit="$(node -p "require('$META').gitCommit")"
expected_cli="$(node -p "require('$META').cliSha256")"
cli_entry="$(node -p "require('$META').cliEntry")"
tag="$(node -p "require('$META').tag")"
version="$(node -p "require('$META').pluginVersion")"
release="$tag plugin@$version commit@$commit"

# A retired current version (the 1.x line before the reset) keeps its historical pin unchecked.
if [[ ! "$current" =~ $RETIRED_RELEASE_VERSION ]]; then
  if [[ "$version" =~ $RETIRED_RELEASE_VERSION ]]; then
    printf 'N-1 基线不能是已退役版本 %s\n' "$tag" >&2
    exit 1
  fi
  latest="$(git -C "$ROOT" tag -l 'v*' | node -e '
    const [current, pinned, retired] = process.argv.slice(1)
    const stable = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
    const greater = (left, right) => {
      const a = left.split(".").map(BigInt)
      const b = right.split(".").map(BigInt)
      for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index]
      return false
    }
    let latest = pinned
    for (const candidate of require("node:fs").readFileSync(0, "utf8").split("\n")) {
      const candidateVersion = candidate.slice(1)
      if (stable.test(candidate) && !new RegExp(retired).test(candidateVersion)
        && greater(current, candidateVersion) && greater(candidateVersion, latest)) latest = candidateVersion
    }
    process.stdout.write(latest)
  ' "$current" "$version" "$RETIRED_RELEASE_VERSION")"
  [ "$latest" = "$version" ] || {
    printf 'N-1 基线 %s 不是低于 v%s 的最近正式版本 v%s\n' "$tag" "$current" "$latest" >&2
    exit 1
  }
fi

entries=()
while IFS= read -r entry; do
  [ -n "$entry" ] && entries+=("$entry")
done < <(node -e '
  const value = require(process.argv[1])
  if (!Array.isArray(value.payloadEntries) || value.payloadEntries.length === 0) process.exit(2)
  for (const entry of value.payloadEntries) {
    if (typeof entry !== "string" || entry === "" || entry.startsWith("/") || entry.includes("..")) process.exit(3)
    process.stdout.write(`${entry}\n`)
  }
' "$META")

case "$cli_entry" in
  ""|/*|*".."*)
    printf 'N-1 CLI 入口非法: %s\n' "$cli_entry" >&2
    exit 1
    ;;
esac
printf '%s\n' "${entries[@]}" | grep -Fxq "$cli_entry" || {
  printf 'N-1 CLI 入口未包含在 payload 闭集: %s\n' "$cli_entry" >&2
  exit 1
}

git -C "$ROOT" cat-file -e "$commit^{commit}"
[ "$(git -C "$ROOT" rev-parse "$tag^{commit}")" = "$commit" ] || {
  printf 'N-1 tag 未绑定固定 commit: tag=%s commit=%s\n' "$tag" "$commit" >&2
  exit 1
}
mkdir -p "$PAYLOAD"
git -C "$ROOT" archive "$commit" -- "${entries[@]}" | tar -x -C "$PAYLOAD"

for entry in "${entries[@]}"; do
  [ -e "$PAYLOAD/$entry" ] || {
    printf 'N-1 payload 缺少固定入口: %s\n' "$entry" >&2
    exit 1
  }
done

cli="$PAYLOAD/$cli_entry"
actual_cli="$(node -e '
  const { createHash } = require("node:crypto")
  const { readFileSync } = require("node:fs")
  process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))
' "$cli")"
[ "$actual_cli" = "$expected_cli" ] || {
  printf 'N-1 CLI 摘要不匹配: expected=%s actual=%s\n' "$expected_cli" "$actual_cli" >&2
  exit 1
}

for manifest in .codex-plugin/plugin.json .claude-plugin/plugin.json; do
  actual_version="$(node -p "require('$PAYLOAD/$manifest').version")"
  [ "$actual_version" = "$version" ] || {
    printf 'N-1 manifest 版本不匹配: %s expected=%s actual=%s\n' "$manifest" "$version" "$actual_version" >&2
    exit 1
  }
done

printf 'N-1 release ready: %s\n' "$release"
printf 'N-1 CLI: %s\n' "$cli"
