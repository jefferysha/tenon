#!/usr/bin/env bash
# step-progress.sh — PostToolUse hook（matcher Bash；脚本侧再做一次窄过滤）。
#
# 关键流转命令（tenon init / session activate / transition / step run <任务名>）成功后，在终端打印一行步骤清单：
#   {"systemMessage":"Tenon · <任务名>\n立项 ✓ → 调研 ● → …"}
# 清单由 `tenon workflow progress <任务名>` 给出，本脚本只做命令匹配与 JSON 包装，不执行命令内容。
#
# 纯 bash 热路径（CONTRACT §5 硬规则 4：PostToolUse shim 零解释器 spawn）：非命令工具、命令里没有上述子命令 + 任务名
# → exit 0，不起任何子进程；命中才调用一次 tenon。任务名只取匹配出的 [a-z0-9][a-z0-9-]*，其后的内容一律当文本。
# 任何异常（读不到命令、cwd 不可用、tenon 不在 PATH、tenon 失败或无输出）→ 无输出，exit 0。
# PostToolUse 只在命令成功时触发；失败的流转不打印，这一点依赖宿主语义（tool_response 没有退出码，hook 自己判断不了）。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"

TOOL="$(pipeline_json_get_string "$INPUT" tool_name || true)"
pipeline_json_is_command_tool "$TOOL" || exit 0

# 流转类命令都很短；超长命令（大 heredoc）只做一次有界扫描，超过上限就不打印。
COMMAND="$(pipeline_json_get_command_bounded "$INPUT" 65536 || true)"
[ -n "$COMMAND" ] || exit 0

# 命令边界：开头、分隔符（; & | ( 与引号，后者覆盖 `zsh -lc "tenon …"`）或空白；名字后必须是空白、分隔符或结尾，
# 这样 `demo_x`、`demo.v2`、`demo$(…)` 不会被截成 `demo`。子命令之间的空白用 [[:space:]]，换行也算。
SPACE='[[:space:]]'
QUOTE="'"
STEP_COMMAND="(^|[;&|(\"${QUOTE}]${SPACE}*|${SPACE})tenon${SPACE}+(init|session${SPACE}+activate|transition|step${SPACE}+run)${SPACE}+([a-z0-9][a-z0-9-]*)(${SPACE}|[;&|)<>\"${QUOTE}]|\$)"
[[ "$COMMAND" =~ $STEP_COMMAND ]] || exit 0
NAME="${BASH_REMATCH[3]}"
[ -n "$NAME" ] || exit 0

command -v tenon >/dev/null 2>&1 || exit 0

CWD="$(pipeline_json_get_cwd "$INPUT" || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0

LINE="$(cd "$CWD" 2>/dev/null && tenon workflow progress "$NAME" 2>/dev/null < /dev/null)" || exit 0
[ -n "$LINE" ] || exit 0

# 全角标点紧跟变量名时必须用 ${} 定界：本地 locale 下 bash 会把多字节字节当成标识符的一部分。
MESSAGE="Tenon · ${NAME}"$'\n'"${LINE}"
printf '{"systemMessage":"%s"}\n' "$(pipeline_json_escape "$MESSAGE")"
exit 0
