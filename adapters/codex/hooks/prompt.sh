#!/usr/bin/env bash
# adapters/codex/hooks/prompt.sh — Codex UserPromptSubmit 动态路由包装。
#
# 每次用户提交提示词时同时复用三个 baseline hook：
#   - confirm-clear-prompt.sh：仅在用户明确“确认继续/继续执行”时清 review marker；
#   - breadcrumb.sh：只在用户明确恢复时注入已选 Change 与持久化任务；
#   - router.sh：开发型普通对话直接派发 default pipeline 根 skill；
#     discussion / L5 快速修复仍不触发。
#
# 因此 default workflow 的派发不是仅停在 dashboard UI：root skill 创建/激活的
# 用户的 active-change 与 REAL_AGENT_TASK.md 只是恢复候选，只有用户明确继续/点名时才进入模型上下文；
# 新目标始终以 `intent: new` 进入独立 Change。wrapper 只包装 JSON，两个 baseline 脚本保持唯一业务真相源。
#
# 任何异常均 fail-open，绝不阻断用户输入。用法：
#   command = "<adapter>/hooks/prompt.sh UserPromptSubmit"
set -uo pipefail

EVENT="${1:-UserPromptSubmit}"
if [ -n "${2:-}" ]; then INPUT="$2"; else INPUT="$(cat 2>/dev/null || printf '{}')"; fi
[ -z "$INPUT" ] && INPUT='{}'

_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$_ROOT" ] || [ ! -f "$_ROOT/hooks/breadcrumb.sh" ] || [ ! -f "$_ROOT/hooks/router.sh" ]; then
  _ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../../.." 2>/dev/null && pwd || printf '%s' "$HOME/.claude")"
fi
export CLAUDE_PLUGIN_ROOT="$_ROOT"

BREADCRUMB="${TENON_CC_BREADCRUMB:-$_ROOT/hooks/breadcrumb.sh}"
ROUTER="${TENON_CC_ROUTER:-$_ROOT/hooks/router.sh}"
CONFIRM_CLEAR="${TENON_CC_CONFIRM_CLEAR:-$_ROOT/hooks/confirm-clear-prompt.sh}"
CONTEXT=""

append_context() {
  local piece="$1"
  [ -n "$piece" ] || return 0
  if [ -n "$CONTEXT" ]; then CONTEXT="${CONTEXT}"$'\n'; fi
  CONTEXT="${CONTEXT}${piece}"
}

# First process the actual user acknowledgement.  It has no stdout contract; a failure must never
# block normal conversation and therefore deliberately remains fail-open.
if [ -f "$CONFIRM_CLEAR" ]; then
  printf '%s' "$INPUT" | bash "$CONFIRM_CLEAR" >/dev/null 2>&1 || true
fi
if [ -f "$BREADCRUMB" ]; then
  PIECE="$(printf '%s' "$INPUT" | bash "$BREADCRUMB" 2>/dev/null || true)"
  append_context "$PIECE"
fi
if [ -f "$ROUTER" ]; then
  PIECE="$(printf '%s' "$INPUT" | bash "$ROUTER" 2>/dev/null || true)"
  append_context "$PIECE"
fi
[ -n "$CONTEXT" ] || exit 0

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"; s="${s//$'\r'/\\r}"; s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}
printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' \
  "$(json_escape "$EVENT")" "$(json_escape "$CONTEXT")"
exit 0
