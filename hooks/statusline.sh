#!/usr/bin/env bash
# statusline.sh — Claude Code statusLine 命令（BACKLOG #10）。
# 一行输出：<change> · <phase> [· 等:<门>…]，无 pipeline 项目/无活跃 change → 输出空。
#
# 接入（用户 settings.json）：
#   "statusLine": { "type": "command", "command": "bash <本仓路径>/hooks/statusline.sh" }
#
# 热路径红线（CONTRACT §5.4）：statusline 每次渲染都执行——纯 bash，绝不 spawn
# 任何解释器；canonical current 用共享 Bash helper 校验 digest+twin 后取 hookState，legacy YAML
# 只在 current 从未出现时兼容；fail-open：任何异常输出空 exit 0。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

# All baseline hooks consume host events through one escape-aware, Bash-only parser.
JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }

CWD="$(json_get cwd || json_get current_dir || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0

# 只绑定当前 Git/显式项目根，避免 statusline 在共享父目录显示另一项目的 Change。
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
[ -r "$ROOT_HELPER" ] || exit 0
# shellcheck source=project-root.sh
. "$ROOT_HELPER"
ROOT="$(pipeline_project_root "$CWD" existing changes || true)"
[ -n "$ROOT" ] || exit 0

# G1：canonical current 是 hook 真相源；helper 缺失只为单文件 legacy 安装保留 YAML fallback。
STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
if [ -r "$STATE_HELPER" ]; then
  # shellcheck source=canonical-state.sh
  . "$STATE_HELPER"
else
  pipeline_state_source() { [ -f "$1/.pipeline.yaml" ] && printf '%s' "$1/.pipeline.yaml"; }
  pipeline_state_get() {
    local v
    v="$(grep -m1 "^$2: " "$1" 2>/dev/null || true)"; v="${v#"$2: "}"
    case "$v" in '"'*'"') v="${v#\"}"; v="${v%\"}" ;; "'"*"'") v="${v#\'}"; v="${v%\'}" ;; esac
    printf '%s' "$v"
  }
fi
yget() { pipeline_state_get "$1" "$2"; }

# review marker is not a generic phase flag.  Only a v2 request bound to the explicitly selected
# Change may be rendered; an old entry-time marker or a request from another conversation must not
# make this statusline claim that the currently displayed Change is waiting on review.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
REVIEW_HELPER="$HOOK_DIR/review-ack.sh"
if [ -r "$REVIEW_HELPER" ]; then
  # shellcheck source=review-ack.sh
  . "$REVIEW_HELPER"
fi

review_marker_for_displayed_change() { # $1=marker $2=displayed change name
  local marked active
  [ -r "$REVIEW_HELPER" ] || return 1
  pipeline_review_marker_is_v2 "$1" || return 1
  marked="$(pipeline_review_marker_change "$1" || true)"
  [ -n "$marked" ] && [ "$marked" = "$2" ] || return 1
  active="$(pipeline_review_active_change_name "$ROOT" "$HOOK_DIR" || true)"
  [ -n "$active" ] && [ "$active" = "$marked" ]
}

# 最新活跃 change：canonical 存在时按 current.json mtime；仅未迁移 change 才看 YAML。
NAME="" PHASE="" BEST=0
for change_dir in "$ROOT"/openspec/changes/*; do
  [ -d "$change_dir" ] || continue
  f="$(pipeline_state_source "$change_dir" || true)"
  [ -n "$f" ] || continue
  [ "$(yget "$f" archived)" = "true" ] && continue
  # GNU `stat -f` 是文件系统状态模式（非 mtime），在 Linux 上会"成功"吐非数字，兜底永不触发
  # ——先试 GNU 语法（-c）+ 数字校验，而非只靠退出码判断。
  mt="$(stat -c %Y "$f" 2>/dev/null)"
  case "$mt" in ''|*[!0-9]*) mt="$(stat -f %m "$f" 2>/dev/null)" ;; esac
  case "$mt" in ''|*[!0-9]*) mt=0 ;; esac
  if [ "$mt" -ge "$BEST" ]; then
    BEST="$mt"
    NAME="$(basename "$change_dir")"
    PHASE="$(yget "$f" phase)"
  fi
done
[ -n "$NAME" ] || exit 0

# 新鲜门 marker → 等:<kind>。TTL 分级同 gate.sh / types.ts GATE_TTL_MS（BACKLOG #13，
# 对齐老内核：confirm 300s / review·interaction 1800s；边界 age ≤ TTL 仍新鲜）。
GATES=""
now="$(date +%s)"
for kind in confirm review interaction; do
  m="$ROOT/.pipeline-pending-$kind"
  [ -f "$m" ] || continue
  if [ "$kind" = review ]; then
    review_marker_for_displayed_change "$m" "$NAME" || continue
  fi
  case "$kind" in confirm) ttl=300 ;; *) ttl=1800 ;; esac
  # GNU `stat -f` 是文件系统状态模式（非 mtime），在 Linux 上会"成功"吐非数字，兜底永不触发
  # ——先试 GNU 语法（-c）+ 数字校验，而非只靠退出码判断。
  mt="$(stat -c %Y "$m" 2>/dev/null)"
  case "$mt" in ''|*[!0-9]*) mt="$(stat -f %m "$m" 2>/dev/null)" ;; esac
  case "$mt" in ''|*[!0-9]*) mt="$now" ;; esac
  [ $((now - mt)) -le "$ttl" ] && GATES="$GATES · 等:$kind"
done

printf '%s · %s%s\n' "$NAME" "${PHASE:-?}" "$GATES"
exit 0
