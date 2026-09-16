#!/usr/bin/env bash
# test-nudge.sh — PostToolUse hook（all tools；脚本侧窄过滤）。
#
# agent 自己跑一遍声明过的测试命令时，提醒它那次运行不产生记录，必需测试只认 `tenon test run`。
# 这是软提醒（additionalContext），不是 PreToolUse 拦截：TDD 循环需要随手跑，只有记录才算证据。
#
# 纯 bash 热路径（CONTRACT §5 硬规则 4：PostToolUse shim 零解释器 spawn）：stdin JSON 只做字符串提取，
# 冻结计划只用 bash 正则扫描。非命令工具 / 无活跃 change / 没有匹配 → exit 0，无输出。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"

TOOL="$(pipeline_json_get_string "$INPUT" tool_name || true)"
pipeline_json_is_command_tool "$TOOL" || exit 0
COMMAND="$(pipeline_json_get_command "$INPUT" || true)"
[ -n "$COMMAND" ] || exit 0
# 经 Tenon 跑的测试本身就是登记路径，不提醒。
case "$COMMAND" in *"tenon test "*) exit 0 ;; esac

CWD="$(pipeline_json_get_cwd "$INPUT" || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0

HOOK_DIR="$(dirname "${BASH_SOURCE[0]:-$0}")"
for helper in project-root.sh canonical-state.sh active-change.sh; do
  [ -r "$HOOK_DIR/$helper" ] || exit 0
  # shellcheck source=/dev/null
  . "$HOOK_DIR/$helper"
done
PROOT="$(pipeline_project_root "$CWD" existing changes || true)"
[ -n "$PROOT" ] || exit 0
CHANGE_DIR="$(pipeline_active_change_dir "$PROOT" || true)"
[ -n "$CHANGE_DIR" ] || exit 0

PLAN="$CHANGE_DIR/.pipeline-workflow-plan.json"
[ -f "$PLAN" ] && [ ! -L "$PLAN" ] && [ -r "$PLAN" ] || exit 0
# 1 MiB 上限：冻结计划正常只有几十 KB，异常大的文件不值得在热路径里扫。
PLAN_SIZE=0
while read -r size _; do PLAN_SIZE="$size"; break; done <<< "$(wc -c < "$PLAN" 2>/dev/null || echo 0)"
[ "$PLAN_SIZE" -le 1048576 ] || exit 0
PLAN_TEXT="$(<"$PLAN")"

# 执行的命令折叠空白后逐项比对；键序由 compileStepTests 钉死（id, direction, command 相邻）。
COLLAPSED="${COMMAND//$'\n'/ }"
COLLAPSED="${COLLAPSED//$'\t'/ }"
while [[ "$COLLAPSED" == *"  "* ]]; do COLLAPSED="${COLLAPSED//  / }"; done

IDS=""
REST="$PLAN_TEXT"
PATTERN='"id":"([A-Za-z0-9_-]{1,64})","direction":"[A-Za-z0-9_-]{1,64}","command":"((\\.|[^"\\])*)"'
while [[ "$REST" =~ $PATTERN ]]; do
  ID="${BASH_REMATCH[1]}"
  RAW="${BASH_REMATCH[2]}"
  REST="${REST#*"${BASH_REMATCH[0]}"}"
  DECLARED="${RAW//\\\"/\"}"
  DECLARED="${DECLARED//\\\\/\\}"
  [ -n "$DECLARED" ] || continue
  case "$COLLAPSED" in
    *"$DECLARED"*)
      case " $IDS " in *" $ID "*) ;; *) IDS="${IDS:+$IDS }$ID" ;; esac
      ;;
  esac
done
[ -n "$IDS" ] || exit 0

CHANGE_NAME="${CHANGE_DIR##*/}"
FIRST_ID="${IDS%% *}"
# 全角标点紧跟变量名时必须用 ${} 定界：本地 locale 下 bash 会把多字节字节当成标识符的一部分。
MESSAGE="<tenon-test-nudge>命令对应测试 ${IDS}；自行运行不计入登记，执行 tenon test run ${CHANGE_NAME} ${FIRST_ID}</tenon-test-nudge>"
printf '{"additionalContext":"%s"}\n' "$(pipeline_json_escape "$MESSAGE")"
exit 0
