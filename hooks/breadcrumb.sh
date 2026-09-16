#!/usr/bin/env bash
# breadcrumb.sh — UserPromptSubmit 薄 shim：明确恢复时重提该 phase 面包屑。
#
# 缓存由 CLI 在 transition 时写 openspec/changes/<name>/.breadcrumb（CONTRACT §5.4）；
# 当前用户的 `active-change` 是恢复候选，不能把一个会话的旧任务注入另一个会话。
# 本 shim 仅在用户明确说继续/恢复或点名 change 时绑定候选；无候选时只有恰好一个
# 活跃 change 才可由明确恢复词使用。无缓存或新任务时静默 exit 0。
# 阶段×hook 开关（v5 T5 / 决议#2）：.pipeline/hooks.json 关掉当前阶段的 breadcrumb → 静默退出。
# 纯 bash 热路径：不 spawn 任何解释器/外部 JSON 解析器。
# fail-open：stdin 解析失败 → 回退 $PWD；任何异常 → 静默 exit 0。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

# Share the same decoder as router so quoted normal-dialogue prompts cannot cause breadcrumb and
# route selection to disagree about the user's intent.
JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }

CWD="$(json_get cwd || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0
PROMPT="$(json_get prompt || true)"

# 只绑定当前 Git/显式项目根，避免 /tmp 等共同父目录的 Change 注入无关会话。
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
[ -r "$ROOT_HELPER" ] || exit 0
# shellcheck source=project-root.sh
. "$ROOT_HELPER"
PROOT="$(pipeline_project_root "$CWD" existing changes || true)"
[ -n "$PROOT" ] || exit 0
CHANGES="$PROOT/openspec/changes"

INTENT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/prompt-intent.sh"
[ -r "$INTENT_HELPER" ] || exit 0
# shellcheck source=prompt-intent.sh
. "$INTENT_HELPER"
pipeline_prompt_should_skip_routing "$PROOT" "$PROMPT" && exit 0

STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
if [ -r "$STATE_HELPER" ]; then
  . "$STATE_HELPER"
else
  pipeline_state_source() { [ -f "$1/.pipeline.yaml" ] && printf '%s' "$1/.pipeline.yaml"; }
  pipeline_state_get() { local v; v="$(grep -m1 "^$2: " "$1" 2>/dev/null || true)"; v="${v#"$2: "}"; case "$v" in '"'*'"') v="${v#\"}"; v="${v%\"}" ;; "'"*"'") v="${v#\'}"; v="${v%\'}" ;; esac; printf '%s' "$v"; }
fi
yget() { pipeline_state_get "$1" "$2"; }

# dashboard/CLI 写下的当前用户 `active-change`（.tenon/users/<slug>/local/）是恢复候选。只有明确恢复意图才可拿它
# 注入本轮；否则即使存在 REAL_AGENT_TASK.md 也绝不能泄漏到一条独立新任务。
ACTIVE_NAME=""
ACTIVE_DIR=""
ACTIVE_STATE=""
ACTIVE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
# shellcheck source=active-change.sh
[ -r "$ACTIVE_HELPER" ] && . "$ACTIVE_HELPER"
declare -F pipeline_active_change_dir >/dev/null 2>&1 && ACTIVE_DIR="$(pipeline_active_change_dir "$PROOT" || true)"
if [ -n "$ACTIVE_DIR" ]; then
  ACTIVE_NAME="${ACTIVE_DIR##*/}"
  ACTIVE_STATE="$(pipeline_state_source "$ACTIVE_DIR" || true)"
fi

# 只有明确恢复才读取候选。helper 缺失时 fail-closed，避免旧上下文泄漏。
# A response choosing the pair offered by router belongs to that pending conversation turn.  It
# must never turn a generic “继续” in the reply into a repository-wide old-Change breadcrumb.
pipeline_prompt_is_workflow_selection "$PROMPT" && exit 0

RESUME_NAME=""
RESUME_DIR=""
RESUME_STATE=""

# 与 router 共享“完整点名优先”的语义。用户的 `active-change` 只是一条跨会话恢复候选；
# 用户在当前普通对话中指名另一个活跃 change 时，breadcrumb 也必须跟随该明确选择，
# 否则两个 UserPromptSubmit hook 会向模型注入相互矛盾的任务上下文。
EXPLICIT_COUNT=0
EXPLICIT_NAME=""
EXPLICIT_DIR=""
EXPLICIT_STATE=""
# 当前用户的归档记录：两趟扫描共用一次解析（与 archived=true 同等跳过）。
BC_ARCHIVE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/task-archive.sh"
# shellcheck source=task-archive.sh
[ -r "$BC_ARCHIVE_HELPER" ] && . "$BC_ARCHIVE_HELPER"
declare -F pipeline_change_archived_for_user >/dev/null 2>&1 || pipeline_change_archived_for_user() { return 1; }
BC_ARCHIVE_STORE=""
declare -F pipeline_task_archive_store >/dev/null 2>&1 && BC_ARCHIVE_STORE="$(pipeline_task_archive_store "$PROOT" || true)"
for change_dir in "$CHANGES"/*; do
  [ -d "$change_dir" ] || continue
  state="$(pipeline_state_source "$change_dir" || true)"
  [ -n "$state" ] || continue
  [ "$(yget "$state" archived)" = "true" ] && continue
  change_name="${change_dir##*/}"
  case "$change_name" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  pipeline_change_archived_for_user "$BC_ARCHIVE_STORE" "$change_name" && continue
  if pipeline_prompt_names_change "$PROMPT" "$change_name"; then
    EXPLICIT_COUNT=$((EXPLICIT_COUNT + 1))
    EXPLICIT_NAME="$change_name"
    EXPLICIT_DIR="$change_dir"
    EXPLICIT_STATE="$state"
  fi
done

if [ "$EXPLICIT_COUNT" -eq 1 ]; then
  RESUME_NAME="$EXPLICIT_NAME"
  RESUME_DIR="$EXPLICIT_DIR"
  RESUME_STATE="$EXPLICIT_STATE"
elif [ "$EXPLICIT_COUNT" -gt 1 ]; then
  exit 0
elif [ -n "$(json_get session_id || true)" ]; then
  SESSION_BINDING_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/host-session-binding.sh"
  if [ -r "$SESSION_BINDING_HELPER" ]; then
    # shellcheck source=host-session-binding.sh
    . "$SESSION_BINDING_HELPER"
    HOST_SESSION_ID="$(json_get session_id || true)"
    SESSION_CHANGE_NAME="$(pipeline_host_session_change_name "$PROOT" "$HOST_SESSION_ID" || true)"
    if [ -n "$SESSION_CHANGE_NAME" ] && pipeline_prompt_requests_resume "$PROMPT" "$SESSION_CHANGE_NAME"; then
      RESUME_NAME="$SESSION_CHANGE_NAME"
      RESUME_DIR="$CHANGES/$SESSION_CHANGE_NAME"
      RESUME_STATE="$(pipeline_state_source "$RESUME_DIR" || true)"
    fi
  fi
  # A host session id is a conversation boundary. If it has no valid binding, generic resume
  # remains unbound; only the explicit Change-name branch above may cross that boundary.
elif [ -n "$ACTIVE_NAME" ]; then
  if pipeline_prompt_requests_resume "$PROMPT" "$ACTIVE_NAME"; then
    RESUME_NAME="$ACTIVE_NAME"
    RESUME_DIR="$ACTIVE_DIR"
    RESUME_STATE="$ACTIVE_STATE"
  else
    exit 0
  fi
elif pipeline_prompt_requests_resume "$PROMPT" ""; then
  # 没有显式激活指针时，只有唯一活跃 change 可被泛化的“继续”恢复；多 change
  # 必须由 router/root skill 要求用户选择，绝不按 mtime 猜一个。
  sole_name=""
  sole_dir=""
  sole_state=""
  active_count=0
  for change_dir in "$CHANGES"/*; do
    [ -d "$change_dir" ] || continue
    state="$(pipeline_state_source "$change_dir" || true)"
    [ -n "$state" ] || continue
    [ "$(yget "$state" archived)" = "true" ] && continue
    sole_candidate="${change_dir##*/}"
    pipeline_change_archived_for_user "$BC_ARCHIVE_STORE" "$sole_candidate" && continue
    active_count=$((active_count + 1))
    sole_name="$sole_candidate"
    sole_dir="$change_dir"
    sole_state="$state"
  done
  if [ "$active_count" -eq 1 ]; then
    RESUME_NAME="$sole_name"
    RESUME_DIR="$sole_dir"
    RESUME_STATE="$sole_state"
  else
    exit 0
  fi
else
  exit 0
fi

newest="$RESUME_DIR/.breadcrumb"
if ! pipeline_hook_disabled "$PROOT" breadcrumb "$(yget "$RESUME_STATE" phase)" && [ -f "$RESUME_DIR/REAL_AGENT_TASK.md" ] && [ ! -L "$RESUME_DIR/REAL_AGENT_TASK.md" ] && [ -r "$RESUME_DIR/REAL_AGENT_TASK.md" ]; then
  printf '\n<pipeline-active-task>\nchange: %s\nphase: %s\n用户任务：\n' "$RESUME_NAME" "$(yget "$RESUME_STATE" phase)"
  cat "$RESUME_DIR/REAL_AGENT_TASK.md" 2>/dev/null
  printf '\n</pipeline-active-task>\n'
fi

[ -f "$newest" ] || exit 0

# ── 阶段×hook 开关（v5 T5 / 决议#2）：newest 所属 change 的阶段被配置禁用 → 静默退出 ──
NEWEST_CHANGE_DIR="$(dirname "$newest")"
NEWEST_STATE="$(pipeline_state_source "$NEWEST_CHANGE_DIR" || true)"
pipeline_hook_disabled "$PROOT" breadcrumb "$(yget "$NEWEST_STATE" phase)" && exit 0

cat "$newest" 2>/dev/null
exit 0
