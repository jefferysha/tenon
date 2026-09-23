#!/usr/bin/env bash
# test-nudge.sh — PostToolUse hook（all tools；脚本侧窄过滤）。
#
# agent 自己跑一遍声明过的测试命令时，提醒它那次运行不产生记录，必需测试只认 `tenon test run`。
# 这是软提醒（additionalContext），不是 PreToolUse 拦截：TDD 循环需要随手跑，只有记录才算证据。
#
# 纯 bash 热路径（CONTRACT §5 硬规则 4：PostToolUse shim 零解释器 spawn）：stdin JSON 只做字符串提取，
# 冻结计划只用 bash 正则扫描，且只看当前步骤（当前轨道）声明的测试。非命令工具 / 无活跃 change /
# 当前步骤无测试 / 没有匹配 → exit 0，无输出。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"

TOOL="$(pipeline_json_get_string "$INPUT" tool_name || true)"
pipeline_json_is_command_tool "$TOOL" || exit 0

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

# 只认当前步骤（且当前轨道）声明的测试：step = canonical phase，track = canonical track。
# 冻结计划里存的是整份工作流（所有轨道、所有步骤），整份扫描会把别的轨道的 `npm test` 当成本步测试。
STATE_SOURCE="$(pipeline_state_source "$CHANGE_DIR" || true)"
[ -n "$STATE_SOURCE" ] || exit 0
STEP="$(pipeline_state_get "$STATE_SOURCE" phase || true)"
TRACK="$(pipeline_state_get "$STATE_SOURCE" track || true)"
case "$STEP" in ''|*[!A-Za-z0-9_-]*) exit 0 ;; esac
case "$TRACK" in *[!a-z0-9_-]*) exit 0 ;; esac

# 计划是单行 JSON.stringify 输出；带引号的结构键不可能出现在 JSON 字符串内部（字符串里的引号必转义），
# 所以按结构片段切分是精确的。有 tracks 时顶层 steps 不参与（selectTrackBranchIr 同口径）：
# 未给 track 取第一条分支，给了就取同名分支，分支不存在则不提醒。
SCOPE="$PLAN_TEXT"
TRACKS_KEY='"tracks":{'
case "$SCOPE" in
  *"$TRACKS_KEY"*)
    SCOPE=${SCOPE#*"$TRACKS_KEY"}
    if [ -n "$TRACK" ]; then
      FIRST_BRANCH="\"$TRACK\":{"
      NEXT_BRANCH="]},\"$TRACK\":{"
      case "$SCOPE" in
        "$FIRST_BRANCH"*) SCOPE=${SCOPE#"$FIRST_BRANCH"} ;;
        *"$NEXT_BRANCH"*) SCOPE=${SCOPE#*"$NEXT_BRANCH"} ;;
        *) exit 0 ;;
      esac
    fi
    ;;
esac
# 步骤对象以 {"id":"<step>","label":" 开头（compileStep 键序固定，label 必填）；测试项是 {"id":…,"direction":…，
# 不会被误认为步骤边界。当前步骤片段截到下一个步骤开头为止。
STEP_START="{\"id\":\"$STEP\",\"label\":\""
case "$SCOPE" in *"$STEP_START"*) ;; *) exit 0 ;; esac
SCOPE=${SCOPE#*"$STEP_START"}
NEXT_STEP='\{"id":"[A-Za-z0-9_-]+","label":"'
if [[ "$SCOPE" =~ $NEXT_STEP ]]; then
  NEXT_STEP_TEXT="${BASH_REMATCH[0]}"
  SCOPE=${SCOPE%%"$NEXT_STEP_TEXT"*}
fi
case "$SCOPE" in *'"tests":['*) ;; *) exit 0 ;; esac

# 命令体放到最后才解码：当前步骤没声明测试（例如 free 轨道）时根本不碰可能很长的命令。
# 声明的测试命令都很短；超长命令（大 heredoc）只做一次有界扫描，超过上限就不提醒。
COMMAND="$(pipeline_json_get_command_bounded "$INPUT" 65536 || true)"
[ -n "$COMMAND" ] || exit 0
# 经 Tenon 跑的测试本身就是登记路径，不提醒。
case "$COMMAND" in *"tenon test "*) exit 0 ;; esac

# 执行的命令折叠空白后逐项比对；键序由 compileStepTests 钉死（id, direction, command 相邻）。
# 折叠用 read 一次切词再以单空格拼回：线性时间。旧的「循环替换双空格」在长 heredoc 上是平方级，
# 会让 PostToolUse 超时被宿主取消。
WORDS=()
read -r -d '' -a WORDS <<< "$COMMAND" || true
[ "${#WORDS[@]}" -gt 0 ] || exit 0
COLLAPSED="${WORDS[*]}"

IDS=""
REST="$SCOPE"
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
