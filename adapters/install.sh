#!/usr/bin/env bash
# adapters/install.sh — 顶层平台投影派发器（lite，registry-driven）。
#
# 读 registry.yaml 按 --<cliFlag> dispatch 到各平台 configure 脚本。所有 --<flag> 从 registry
# cliFlag 字段派生（不另维护硬编码列表）——加平台只改 registry（D7/D14 填表非重写）。
#
# 用法:
#   adapters/install.sh --<platform>... [--target <dir>] [--dry-run] [--yes]
#   adapters/install.sh --list          # 列 registry 中可派发的平台
# platform flag（从 registry cliFlag 派生）: --codex / --cursor / ...
set -u

ADAPTERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$ADAPTERS_DIR/.." && pwd)"
REG="${TENON_REGISTRY:-$ADAPTERS_DIR/registry.yaml}"

G='\033[32m'; Y='\033[33m'; R='\033[31m'; Z='\033[0m'
info() { printf "${G}[install]${Z} %b\n" "$1"; }
warn() { printf "${Y}[install]${Z} %b\n" "$1"; }
err()  { printf "${R}[install]${Z} %b\n" "$1" >&2; }

# platforms: 块内平台 id（止于下一顶层 key，排除 planned:）
platform_ids() {
  awk '
    /^platforms:[[:space:]]*$/ { inp=1; next }
    /^[A-Za-z_].*:[[:space:]]*$/ { if(inp) inp=0 }
    inp && /^  - id: / { sub(/^  - id:[[:space:]]*/,""); print }
  ' "$REG"
}
reg_field() { # <id> <key>
  awk -v id="$1" -v key="$2" '
    $0 ~ "^  - id: " id "[[:space:]]*$" { inb=1; next }
    /^  - id: / { inb=0 }
    inb && $0 ~ ("^    " key ":") {
      line=$0; sub(/^    [A-Za-z_]+:[ ]*/,"",line);
      gsub(/^"/,"",line); gsub(/"$/,"",line); gsub(/^'\''/,"",line); gsub(/'\''$/,"",line);
      print line; exit
    }
  ' "$REG"
}
# cliFlag → platform id
resolve_flag() { # <flag>
  local pid
  while IFS= read -r pid; do
    [ "$(reg_field "$pid" cliFlag)" = "$1" ] && { printf '%s' "$pid"; return 0; }
  done < <(platform_ids)
  return 1
}

TARGET="$PWD"; DRY_RUN=0; ASSUME_YES=0; SELECTED=()
while [ $# -gt 0 ]; do
  case "$1" in
    --target)  TARGET="${2:?--target 需要目录}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    --list)
      info "registry 可派发平台:"
      while IFS= read -r pid; do
        printf '  --%s → %s (tier %s, configure %s)\n' \
          "$(reg_field "$pid" cliFlag)" "$pid" "$(reg_field "$pid" tier)" "$(reg_field "$pid" configure)"
      done < <(platform_ids)
      exit 0 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*)
      flag="${1#--}"; pid="$(resolve_flag "$flag" || true)"
      if [ -n "$pid" ]; then SELECTED+=("$pid"); shift
      else err "未知 platform flag: $1（见 --list）"; exit 2; fi ;;
    *) err "未知参数: $1"; exit 2 ;;
  esac
done

[ "${#SELECTED[@]}" -eq 0 ] && { err "未选平台。用 --<platform>（见 --list）。"; exit 2; }

rc=0
for pid in "${SELECTED[@]}"; do
  conf="$(reg_field "$pid" configure)"
  if [ -z "$conf" ] || [ ! -f "$REPO_ROOT/$conf" ]; then
    err "$pid configure 脚本缺失: ${conf:-（未登记）}"; rc=1; continue
  fi
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] $pid → $conf --target $TARGET"; continue; fi
  info "派发 $pid → $conf"
  extra=(); [ "$ASSUME_YES" = 1 ] && extra+=(--yes)
  # 空数组展开：`"${extra[@]:-}"` 会造出一个空字符串参数（installer 立刻「未知参数」exit 2）；
  # `"${extra[@]}"` 在 bash 3.2（macOS 自带）+ set -u 下又是 unbound variable。
  # `${extra[@]+"${extra[@]}"}` 是两边都安全的写法：空则零个参数，非空则逐个原样透传。
  bash "$REPO_ROOT/$conf" --target "$TARGET" ${extra[@]+"${extra[@]}"} || rc=1
done
exit "$rc"
