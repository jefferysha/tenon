#!/usr/bin/env bash
# confirm-clear.sh — PostToolUse hook（matcher: AskUserQuestion|request_user_input）。
#
# agent 一旦用 AskUserQuestion 跟用户确认/收反馈了，就清掉纯交互 marker：
#   .pipeline-pending-confirm     解封 confirm 门（没有写入方，只保留兼容清理，不带归属）
#   .pipeline-pending-interaction[.<session_id>] 解封 interaction 门——只清归属本会话的 v2 标记（pending-marker.sh）：
#                                 本会话自己的分文件，以及归属它的没有会话的单文件；别的会话的提问解不开本会话的锁，
#                                 本会话的提问也解不开别的会话的分文件。
# review v2 marker 不可由这个 hook 直接删除：它对应 canonical receipt，只有用户答复中包含
# 显式批准语义时才调用 `tenon review acknowledge`（且只确认本会话任务的评审）。这样“要修改”这类回答不会误放行离开
# review phase。
#
# 答案判定：只看 tool_response.answers 里每个答案值本身（去掉「 (Recommended)」「（推荐）」后缀后整值等于放行语，
# 清单在 prompt-intent.sh；只认显式放行语 pipeline_text_is_explicit_approval_phrase，「可以」「好的」这类简短同意
# 只对对话回复有效，点选的答案不算），不在问题文本、选项说明或整段响应里找子串；
# 取不到 answers（宿主 schema 漂移、JSON 损坏）一律不确认评审（fail-closed），interaction 标记的解封语义不变。
#
# 清除范围与 gate/router 共用项目根定位：只接受 Git worktree、显式
# TENON_PROJECT_ROOT 或当前 cwd。这样子目录中的确认仍能解封当前 Git 项目，且绝不会清到
# 共享临时父目录的另一项目 marker。
#
# 纯 bash 热路径（CONTRACT §5.4：PostToolUse 每次工具后触发）：零解释器 / 外部 JSON 解析器 spawn。
# fail-safe：任何异常一律 exit 0，绝不打断。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

# Shared escape-aware parsing keeps quoted host payloads from changing which project marker is
# cleared. It remains Bash-only and preserves this hook's fail-open behaviour.
JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }

CWD="$(json_get cwd || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0

# 无共享 helper 的单文件旧安装保留 cwd fallback；当前安装一定经 helper 取得同一个项目根。
ROOT="$CWD"
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
if [ -r "$ROOT_HELPER" ]; then
  # shellcheck source=project-root.sh
  . "$ROOT_HELPER"
  ROOT="$(pipeline_project_root "$CWD" bootstrap changes || true)"
fi
[ -n "$ROOT" ] || exit 0
rm -f "$ROOT/.pipeline-pending-confirm" 2>/dev/null || true

# 会话归属要靠这几个 helper：缺任何一个就无法判定「本会话」，此时不碰 interaction 标记、不确认评审，照旧 exit 0。
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
[ -n "$HOOK_DIR" ] || exit 0
for helper in canonical-state.sh active-change.sh pending-marker.sh prompt-intent.sh review-ack.sh; do
  [ -r "$HOOK_DIR/$helper" ] || exit 0
  # shellcheck source=/dev/null
  . "$HOOK_DIR/$helper"
done
SESSION_ID="$(pipeline_hook_session_id "$INPUT")"

# 本会话完成了一次提问：只认领、清掉归属本会话的交互标记（旧格式标记在判定时被删除）。
CLAIM="$ROOT/.pipeline-pending-interaction.claim.$$"
if pipeline_claim_interaction_marker "$ROOT" "$SESSION_ID" "$CLAIM"; then
  rm -f "$CLAIM" 2>/dev/null || true
fi

# Hosts place AskUserQuestion answers in tool_response.answers (an object of answer strings).  Inspect only
# those values: question text and option labels often contain “确认继续” and must never be mistaken for consent.
case "$INPUT" in
  *\"tool_response\"*) RESPONSE_PART="${INPUT#*\"tool_response\"}" ;;
  *) exit 0 ;;
esac
if pipeline_json_object_any_value "$RESPONSE_PART" answers pipeline_text_is_explicit_approval_phrase; then
  pipeline_acknowledge_active_review "$ROOT" "$HOOK_DIR" manual "$SESSION_ID" || true
fi

exit 0
