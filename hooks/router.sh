#!/usr/bin/env bash
# router.sh — UserPromptSubmit：项目级动态路由（工作流分支的 route）+ 新开发请求的评估分派。
#
# 路由数据来自「项目 → 全局存储 → 插件模板」三处工作流文件里每条带 route 的分支。冷路径生成 TENON_ROUTER_V6，
# 默认 cache 位于 <canonical-project-root>/.pipeline/cache/router.v6.data。cache 是严格字段化的 hex 数据，
# 本脚本只逐行校验和 builtin 解码，绝不把项目 cache 当 shell 程序执行。命中缓存时用 shell（head/printf/sha256，
# 不起解释器）重算全部工作流文件的摘要：任何一份文件内容变化都使缓存失效，保存工作流后的下一条消息即按新数据路由。
#
# fail-open（对 hook 调用方）/fail-closed（对 stale 数据）：任何定位、解析或生成错误都 exit 0；
# 但 stale 后生成失败的当轮绝不继续消费旧 cache。
set -uo pipefail

INPUT=""
while IFS= read -r _input_line || [ -n "$_input_line" ]; do
  if [ -n "$INPUT" ]; then INPUT="${INPUT}"$'\n'; fi
  INPUT="${INPUT}${_input_line}"
  _input_line=""
done

# Keep normal dialogue routing on the same escape-aware parser as the runtime hooks: a quoted
# user prompt must not be silently truncated before the track scorer sees it.
JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }

# A pasted multi-MB log must not push this hook past the host timeout: keep only the prompt's first
# and last 8 KiB before any parsing (pipeline_prompt_bound_input, prompt-intent.sh).
INTENT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/prompt-intent.sh"
if [ -r "$INTENT_HELPER" ]; then
  # shellcheck source=prompt-intent.sh
  . "$INTENT_HELPER"
  INPUT="$(pipeline_prompt_bound_input "$INPUT")" || exit 0
fi

PROMPT="$(json_get prompt || true)"
[ -n "$PROMPT" ] || exit 0
CWD="$(json_get cwd || true)"
[ -n "$CWD" ] || CWD="$PWD"
[ -d "$CWD" ] || exit 0
# A normal host conversation may opt into a dashboard liveness binding only through this exact
# host-provided id. It is not used for routing or workflow state, and malformed/unknown ids stay
# absent rather than falling back to the repo-global active Change pointer.
HOST_SESSION_ID="$(json_get session_id || true)"
case "$HOST_SESSION_ID" in ''|*[!A-Za-z0-9_-]*) HOST_SESSION_ID='' ;; esac
[ "${#HOST_SESSION_ID}" -le 128 ] || HOST_SESSION_ID=''

# 系统通知、自身回显、显式命令、纯讨论均不触发路由。
case "$PROMPT" in
  *"<task-notification>"*|*"<task-id>"*|*"<output-file>"*|*"<workflow-state>"*|*"<tenon-router"*|*"<tenon-dispatch>"*) exit 0 ;;
esac
case "$PROMPT" in /*) exit 0 ;; esac

# 纯讨论不建任务（原「对话」轨道承担的语义由这里的讨论判断承担）。
case "$PROMPT" in
  *如何使用*|*怎么用*|*是什么*|*为什么*|*解释*|*文档在哪*|*在哪里*|*意思是*|*我觉得*|*我感觉*|*你觉得*|*是不是*|*怎么样*|*看法*|*聊聊*|*讨论一下*|*有没有更好*) exit 0 ;;
esac
if printf '%s' "$PROMPT" | grep -qiE '^[[:space:]]*(what|why|how|when|where|who|can you (tell|explain|describe))\b'; then
  exit 0
fi

# Carry a strong, explicit continuous-execution authorisation through the normal-chat dispatch.
# The router does not itself create authority (there may be no Change yet); the Tenon root skill
# consumes this exact flag only after it has created or re-selected an exact Change and uses
# `tenon session activate --continuous --host-session <id>` to bind it safely.
CONTINUOUS_EXECUTION='false'
# prompt-intent.sh was already sourced above (INTENT_HELPER); only its readability gates the call here.
if [ -r "$INTENT_HELPER" ]; then
  [ "$(pipeline_prompt_approval_intent "$PROMPT" 2>/dev/null || true)" = 'authorize' ] \
    && CONTINUOUS_EXECUTION='true'
fi

STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
if [ -r "$STATE_HELPER" ]; then
  . "$STATE_HELPER"
else
  pipeline_state_source() { [ -f "$1/.pipeline.yaml" ] && printf '%s' "$1/.pipeline.yaml"; }
  pipeline_state_get() { local v; v="$(grep -m1 "^$2: " "$1" 2>/dev/null || true)"; v="${v#"$2: "}"; case "$v" in '"'*'"') v="${v#\"}"; v="${v%\"}" ;; "'"*"'") v="${v#\'}"; v="${v%\'}" ;; esac; printf '%s' "$v"; }
fi
yget() { pipeline_state_get "$1" "$2"; }

# 共享根策略：bootstrap 模式让未初始化的 Git 项目也可在正常开发对话中选择 default
# pipeline，同时绝不向任意父目录扫描/借用另一个项目的 OpenSpec 状态。
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
[ -r "$ROOT_HELPER" ] || exit 0
# shellcheck source=project-root.sh
. "$ROOT_HELPER"
PROOT="$(pipeline_project_root "$CWD" bootstrap changes || true)"
[ -n "$PROOT" ] || exit 0
if [ -r "$INTENT_HELPER" ] && pipeline_prompt_should_skip_routing "$PROOT" "$PROMPT"; then
  exit 0
fi

CHANGE_NAME="" CHANGE_PHASE="" CHANGE_TRACK="" CHANGE_WORKFLOW=""
SESSION_CHANGE_NAME="" SESSION_CHANGE_PHASE="" SESSION_CHANGE_TRACK="" SESSION_CHANGE_WORKFLOW=""
SOLE_CHANGE_NAME="" SOLE_CHANGE_PHASE="" SOLE_CHANGE_TRACK="" SOLE_CHANGE_WORKFLOW=""
ACTIVE_CHANGE_COUNT=0
ACTIVE_CHANGE_NAMES=() ACTIVE_CHANGE_PHASES=() ACTIVE_CHANGE_TRACKS=() ACTIVE_CHANGE_WORKFLOWS=()
BEST_MTIME=0
for _change_dir in "$PROOT"/openspec/changes/*; do
  [ -d "$_change_dir" ] || continue
  f="$(pipeline_state_source "$_change_dir" || true)"
  [ -n "$f" ] || continue
  [ "$(yget "$f" archived)" = "true" ] && continue
  _change_name="${_change_dir##*/}"
  # change 名会进入 hook 的结构化输出和动态正则；只接受 CLI/状态机同一份路径契约。
  case "$_change_name" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  ACTIVE_CHANGE_COUNT=$((ACTIVE_CHANGE_COUNT + 1))
  SOLE_CHANGE_NAME="$_change_name"
  SOLE_CHANGE_PHASE="$(yget "$f" phase)"
  SOLE_CHANGE_TRACK="$(yget "$f" track)"
  SOLE_CHANGE_WORKFLOW="$(yget "$f" workflow)"
  _change_index="${#ACTIVE_CHANGE_NAMES[@]}"
  ACTIVE_CHANGE_NAMES[$_change_index]="$SOLE_CHANGE_NAME"
  ACTIVE_CHANGE_PHASES[$_change_index]="$SOLE_CHANGE_PHASE"
  ACTIVE_CHANGE_TRACKS[$_change_index]="$SOLE_CHANGE_TRACK"
  ACTIVE_CHANGE_WORKFLOWS[$_change_index]="$SOLE_CHANGE_WORKFLOW"
  mt="$(stat -c %Y "$f" 2>/dev/null)"
  case "$mt" in ''|*[!0-9]*) mt="$(stat -f %m "$f" 2>/dev/null)" ;; esac
  case "$mt" in ''|*[!0-9]*) mt=0 ;; esac
  if [ "$mt" -ge "$BEST_MTIME" ]; then
    BEST_MTIME="$mt"
    CHANGE_NAME="${_change_dir##*/}"
    CHANGE_PHASE="$(yget "$f" phase)"
    CHANGE_TRACK="$(yget "$f" track)"
    CHANGE_WORKFLOW="$(yget "$f" workflow)"
  fi
done

# 建在 `.worktrees/<c>` 里的任务（`tenon init` 为新任务建的 worktree，状态不在主检出的 openspec/changes 里）：
# 单独成表，绝不并入上面的 ACTIVE_CHANGE_*——它们既不参与「新建还是选择」的判定，也不是主检出的唯一候选。
# 纯 bash（不起 git）：没有 .worktrees 目录时 glob 不展开，下面一个分支都不进，输出与没有这段时逐字相同。
WT_CHANGE_NAMES=() WT_CHANGE_PHASES=() WT_CHANGE_TRACKS=() WT_CHANGE_WORKFLOWS=() WT_CHANGE_PATHS=()
for _wt_change_dir in "$PROOT"/.worktrees/*/openspec/changes/*; do
  [ -d "$_wt_change_dir" ] || continue
  f="$(pipeline_state_source "$_wt_change_dir" || true)"
  [ -n "$f" ] || continue
  [ "$(yget "$f" archived)" = "true" ] && continue
  _change_name="${_wt_change_dir##*/}"
  case "$_change_name" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  # worktree 根会原样进入 dispatch 的结构化输出（`change_candidate: change=<n>;worktree_path=<p>` 是 `;` 分隔的
  # key=value 串）：含换行、尖括号、`;` 或 `=` 的路径不可信（会拆开 / 冒充键值），直接不收。
  _wt_root="${_wt_change_dir%/openspec/changes/*}"
  case "$_wt_root" in *$'\n'*|*$'\r'*|*"<"*|*">"*|*";"*|*"="*) continue ;; esac
  _change_index="${#WT_CHANGE_NAMES[@]}"
  WT_CHANGE_NAMES[$_change_index]="$_change_name"
  WT_CHANGE_PHASES[$_change_index]="$(yget "$f" phase)"
  WT_CHANGE_TRACKS[$_change_index]="$(yget "$f" track)"
  WT_CHANGE_WORKFLOWS[$_change_index]="$(yget "$f" workflow)"
  WT_CHANGE_PATHS[$_change_index]="$_wt_root"
done

# mtime 仅可用于展示/诊断，不能在多个活跃 change 中猜测当前会话。没有显式
# `active-change` 时，只有唯一活跃 change 才是可恢复候选。
if [ "$ACTIVE_CHANGE_COUNT" -eq 1 ]; then
  CHANGE_NAME="$SOLE_CHANGE_NAME"
  CHANGE_PHASE="$SOLE_CHANGE_PHASE"
  CHANGE_TRACK="$SOLE_CHANGE_TRACK"
  CHANGE_WORKFLOW="$SOLE_CHANGE_WORKFLOW"
else
  CHANGE_NAME=""
  CHANGE_PHASE=""
  CHANGE_TRACK=""
  CHANGE_WORKFLOW=""
fi

# Dashboard/CLI `session activate` writes the current user's recovery candidate
# (`.tenon/users/<slug>/local/active-change`, resolved by active-change.sh).
# It may win over mtime discovery, but it is never an implicit binding for an
# unrelated/new conversation; binding is decided below from the user prompt.
ACTIVE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
# shellcheck source=active-change.sh
[ -r "$ACTIVE_HELPER" ] && . "$ACTIVE_HELPER"
ACTIVE_DIR=""
declare -F pipeline_active_change_dir >/dev/null 2>&1 && ACTIVE_DIR="$(pipeline_active_change_dir "$PROOT" || true)"
if [ -n "$ACTIVE_DIR" ]; then
  ACTIVE_NAME="${ACTIVE_DIR##*/}"
  ACTIVE_STATE="$(pipeline_state_source "$ACTIVE_DIR" || true)"
  CHANGE_NAME="$ACTIVE_NAME"
  CHANGE_PHASE="$(yget "$ACTIVE_STATE" phase)"
  CHANGE_TRACK="$(yget "$ACTIVE_STATE" track)"
  CHANGE_WORKFLOW="$(yget "$ACTIVE_STATE" workflow)"
fi

# A project-level pointer cannot identify a Codex conversation.  Keep the old Change only when
# the user explicitly asks to continue it; a new objective must always start from open so the
# root skill can create an independent Change rather than inheriting stale phase/tasks context.
# With multiple active candidates and no selected pointer, a generic “continue” remains
# ambiguous and is surfaced to the root skill as `select`, never resolved by mtime.
INTENT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/prompt-intent.sh"
DISPATCH_INTENT="new"
# 恢复的任务只存在于 worktree 里时，它所在的绝对路径（dispatch 的 worktree_path）；WORKTREE_SELECT=1 = 选择候选来自 worktree 任务。
WORKTREE_PATH="" WORKTREE_SELECT=0
# 1 = this prompt approves the selected Change's open review receipt (confirm-clear-prompt writes it).
ROUTER_REVIEW_REPLY=0
if [ -r "$INTENT_HELPER" ]; then
  # shellcheck source=prompt-intent.sh
  . "$INTENT_HELPER"
  REVIEW_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/review-ack.sh"
  # shellcheck source=review-ack.sh
  [ -r "$REVIEW_HELPER" ] && . "$REVIEW_HELPER"
  router_confirms_open_review() { # $1=change $2=canonical phase → 0=prompt approves its open review
    local intent mine
    declare -F pipeline_review_receipt_open >/dev/null 2>&1 || return 1
    pipeline_prompt_rejects_resume "$PROMPT" && return 1
    intent="$(pipeline_prompt_approval_intent "$PROMPT" 2>/dev/null || true)"
    case "$intent" in confirm|contextual-confirm) ;; *) return 1 ;; esac
    # 回复只可能确认「本会话任务」的评审（与 confirm-clear-prompt 同一解析）：恢复后无绑定的会话、或共享指针指向别的会话
    # 任务时，不得被告知「本条回复是对 ${1} 的评审确认」——那条回执不会被写。宿主没给 session id 时保持旧行为。
    if [ -n "$HOST_SESSION_ID" ] && declare -F pipeline_session_change_dir >/dev/null 2>&1; then
      mine="$(pipeline_session_change_dir "$PROOT" "$HOST_SESSION_ID" || true)"
      [ "${mine##*/}" = "$1" ] || return 1
    fi
    pipeline_review_receipt_open "$PROOT" "$1" "$2"
  }
  SESSION_BINDING_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/host-session-binding.sh"
  if [ -n "$HOST_SESSION_ID" ] && [ -r "$SESSION_BINDING_HELPER" ]; then
    # shellcheck source=host-session-binding.sh
    . "$SESSION_BINDING_HELPER"
    SESSION_CHANGE_NAME="$(pipeline_host_session_change_name "$PROOT" "$HOST_SESSION_ID" || true)"
    if [ -n "$SESSION_CHANGE_NAME" ]; then
      _change_index=0
      while [ "$_change_index" -lt "${#ACTIVE_CHANGE_NAMES[@]}" ]; do
        if [ "${ACTIVE_CHANGE_NAMES[$_change_index]}" = "$SESSION_CHANGE_NAME" ]; then
          SESSION_CHANGE_PHASE="${ACTIVE_CHANGE_PHASES[$_change_index]}"
          SESSION_CHANGE_TRACK="${ACTIVE_CHANGE_TRACKS[$_change_index]}"
          SESSION_CHANGE_WORKFLOW="${ACTIVE_CHANGE_WORKFLOWS[$_change_index]}"
          break
        fi
        _change_index=$(( _change_index + 1 ))
      done
    fi
  fi
  # The root skill already owns a `track / workflow` selection response.  Do not overlay a stale
  # repository candidate just because the answer also says “继续/上一步”.
  pipeline_prompt_is_workflow_selection "$PROMPT" && exit 0
  # 用户在正常对话中完整点名某个活跃 change 时，它比 repo 级指针和泛化“继续”
  # 都更强。此前多 candidate 会先清空 CHANGE_NAME，导致 `继续 catalog-flow-page`
  # 退化为 ambiguous select；这里保留候选表并只接受唯一的精确命中。
  EXPLICIT_CHANGE_COUNT=0
  EXPLICIT_CHANGE_NAME="" EXPLICIT_CHANGE_PHASE="" EXPLICIT_CHANGE_TRACK="" EXPLICIT_CHANGE_WORKFLOW=""
  _change_index=0
  while [ "$_change_index" -lt "${#ACTIVE_CHANGE_NAMES[@]}" ]; do
    if pipeline_prompt_names_change "$PROMPT" "${ACTIVE_CHANGE_NAMES[$_change_index]}"; then
      EXPLICIT_CHANGE_COUNT=$((EXPLICIT_CHANGE_COUNT + 1))
      EXPLICIT_CHANGE_NAME="${ACTIVE_CHANGE_NAMES[$_change_index]}"
      EXPLICIT_CHANGE_PHASE="${ACTIVE_CHANGE_PHASES[$_change_index]}"
      EXPLICIT_CHANGE_TRACK="${ACTIVE_CHANGE_TRACKS[$_change_index]}"
      EXPLICIT_CHANGE_WORKFLOW="${ACTIVE_CHANGE_WORKFLOWS[$_change_index]}"
    fi
    _change_index=$(( _change_index + 1 ))
  done
  # 点名的任务只存在于 worktree 时（主检出一个都没点中）：同样是显式选择，dispatch 另带 worktree_path 让入口 skill 先切进去。
  WT_EXPLICIT_COUNT=0 WT_EXPLICIT_INDEX=-1
  _change_index=0
  while [ "$_change_index" -lt "${#WT_CHANGE_NAMES[@]}" ]; do
    if pipeline_prompt_names_change "$PROMPT" "${WT_CHANGE_NAMES[$_change_index]}"; then
      WT_EXPLICIT_COUNT=$((WT_EXPLICIT_COUNT + 1))
      WT_EXPLICIT_INDEX="$_change_index"
    fi
    _change_index=$(( _change_index + 1 ))
  done
  if [ "$EXPLICIT_CHANGE_COUNT" -eq 0 ] && [ "$WT_EXPLICIT_COUNT" -eq 1 ]; then
    CHANGE_NAME="${WT_CHANGE_NAMES[$WT_EXPLICIT_INDEX]}"
    CHANGE_PHASE="${WT_CHANGE_PHASES[$WT_EXPLICIT_INDEX]}"
    CHANGE_TRACK="${WT_CHANGE_TRACKS[$WT_EXPLICIT_INDEX]}"
    CHANGE_WORKFLOW="${WT_CHANGE_WORKFLOWS[$WT_EXPLICIT_INDEX]}"
    WORKTREE_PATH="${WT_CHANGE_PATHS[$WT_EXPLICIT_INDEX]}"
    DISPATCH_INTENT="resume"
  elif [ "$EXPLICIT_CHANGE_COUNT" -eq 0 ] && [ "$WT_EXPLICIT_COUNT" -gt 1 ]; then
    DISPATCH_INTENT="select"
    WORKTREE_SELECT=1
    CHANGE_NAME=""
    CHANGE_PHASE=""
    CHANGE_TRACK=""
    CHANGE_WORKFLOW=""
  elif [ "$EXPLICIT_CHANGE_COUNT" -eq 1 ]; then
    CHANGE_NAME="$EXPLICIT_CHANGE_NAME"
    CHANGE_PHASE="$EXPLICIT_CHANGE_PHASE"
    CHANGE_TRACK="$EXPLICIT_CHANGE_TRACK"
    CHANGE_WORKFLOW="$EXPLICIT_CHANGE_WORKFLOW"
    DISPATCH_INTENT="resume"
  elif [ "$EXPLICIT_CHANGE_COUNT" -gt 1 ]; then
    DISPATCH_INTENT="select"
    CHANGE_NAME=""
    CHANGE_PHASE=""
    CHANGE_TRACK=""
    CHANGE_WORKFLOW=""
  elif [ -n "$SESSION_CHANGE_NAME" ] && pipeline_prompt_requests_resume "$PROMPT" "$SESSION_CHANGE_NAME"; then
    # A host session binding has conversation identity and therefore wins over the repo-wide
    # pointer.  This prevents another conversation's `session activate` from hijacking “继续执行”.
    CHANGE_NAME="$SESSION_CHANGE_NAME"
    CHANGE_PHASE="$SESSION_CHANGE_PHASE"
    CHANGE_TRACK="$SESSION_CHANGE_TRACK"
    CHANGE_WORKFLOW="$SESSION_CHANGE_WORKFLOW"
    DISPATCH_INTENT="resume"
  elif [ -n "$CHANGE_NAME" ] && router_confirms_open_review "$CHANGE_NAME" "$CHANGE_PHASE"; then
    # 「确认继续」 answering this user's own review request is a continuation, not a new objective,
    # even when the host session was never bound (an entry skill that activated without
    # --host-session).  confirm-clear-prompt acknowledges the same receipt through the same
    # per-conversation resolution (pipeline_session_change_dir), so both hooks agree on which Change the confirmation belongs to.
    DISPATCH_INTENT="resume"
    ROUTER_REVIEW_REPLY=1
  elif [ -z "$HOST_SESSION_ID" ] && [ -n "$CHANGE_NAME" ] \
    && pipeline_prompt_requests_resume "$PROMPT" "$CHANGE_NAME"; then
    DISPATCH_INTENT="resume"
  elif [ -z "$HOST_SESSION_ID" ] && [ "$ACTIVE_CHANGE_COUNT" -gt 1 ] \
    && pipeline_prompt_requests_resume "$PROMPT" ""; then
    DISPATCH_INTENT="select"
    CHANGE_NAME=""
    CHANGE_PHASE=""
    CHANGE_TRACK=""
    CHANGE_WORKFLOW=""
  elif [ "$ACTIVE_CHANGE_COUNT" -eq 0 ] && [ "${#WT_CHANGE_NAMES[@]}" -gt 0 ] \
    && pipeline_prompt_requests_resume "$PROMPT" ""; then
    # 主检出没有自己的在途任务、用户却泛泛地说「继续」：能继续的只有 worktree 里的任务，把它们连同路径列为候选，
    # 要求用户点名——绝不按 mtime 猜。主检出另有在途任务时走上面的现有规则，不进这里。
    DISPATCH_INTENT="select"
    WORKTREE_SELECT=1
    CHANGE_NAME=""
    CHANGE_PHASE=""
    CHANGE_TRACK=""
    CHANGE_WORKFLOW=""
  else
    CHANGE_NAME=""
    CHANGE_PHASE=""
    CHANGE_TRACK=""
    CHANGE_WORKFLOW=""
  fi
else
  # Missing helper is a safety failure: do not leak a repo-level candidate into a new prompt.
  CHANGE_NAME=""
  CHANGE_PHASE=""
  CHANGE_TRACK=""
  CHANGE_WORKFLOW=""
fi

# 禁用判定必须早于任何冷生成解释器。
ROUTER_PHASE="${CHANGE_PHASE:-open}"
if pipeline_hook_disabled "$PROOT" router "$ROUTER_PHASE"; then exit 0; fi

PLUGIN_ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)}}"
# manifest 路径只用来给生成器定位插件的 templates/ 目录（其下 workflows/ 是随插件发布的模板）。
MANIFEST="$PLUGIN_ROOT/templates/manifest.yaml"
CACHE="${TENON_ROUTER_CACHE:-$PROOT/.pipeline/cache/router.v6.data}"
_CLI_BUNDLE="$PLUGIN_ROOT/packages/cli/dist/tenon.mjs"
_GEN_MJS="$PLUGIN_ROOT/hooks/router-gen.mjs"
# 三处工作流目录：项目、全局存储（配置根下，与 kernel resolveProductPaths 同一解析，见 tenon-user.sh）、插件模板。
# 配置根解析不出来时全局目录留空——摘要与缓存里的对不上，每轮都会重建，路由结果仍然正确。
SRC_PROJECT_DIR="$PROOT/.pipeline/workflows"
SRC_TEMPLATE_DIR="$PLUGIN_ROOT/templates/workflows"
SRC_GLOBAL_DIR=""
declare -F pipeline_config_root >/dev/null 2>&1 || {
  USER_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/tenon-user.sh"
  # shellcheck source=tenon-user.sh
  [ -r "$USER_HELPER" ] && . "$USER_HELPER"
}
if declare -F pipeline_config_root >/dev/null 2>&1; then
  _config_root="$(pipeline_config_root 2>/dev/null || true)"
  [ -z "$_config_root" ] || SRC_GLOBAL_DIR="$_config_root/workflows/.pipeline/workflows"
fi

# Bash 3.2-compatible parallel arrays（不使用 associative array 或动态变量名）。
_router_clear_cache() {
  CACHE_ROOT="" CACHE_DIGEST=""
  ROUTER_PRIORITIES=() ROUTER_WORKFLOWS=() ROUTER_TRACKS=() ROUTER_LABELS=() ROUTER_ROUTABLES=() ROUTER_FALLBACKS=()
  ROUTER_BUILTINS=() ROUTER_PATTERNS=() ROUTER_EXCLUDES=()
}

_uint_ok() { # unsigned JS-safe integer, canonical decimal spelling
  local value="$1" length
  case "$value" in
    0) return 0 ;;
    [1-9]) return 0 ;;
    [1-9][0-9]*) ;;
    *) return 1 ;;
  esac
  length="${#value}"
  [ "$length" -lt 16 ] && return 0
  [ "$length" -gt 16 ] && return 1
  [[ "$value" > "9007199254740991" ]] && return 1
  return 0
}

_hex_ok() {
  local value="$1"
  case "$value" in *[!0-9a-f]*) return 1 ;; esac
  [ $(( ${#value} % 2 )) -eq 0 ]
}

# 输出写入固定全局 HEX_VALUE；每个 byte 的 \xHH 只在 HH 已过 hex 白名单后交给 builtin printf。
_hex_decode() {
  local rest="$1" pair byte
  _hex_ok "$rest" || return 1
  HEX_VALUE=""
  while [ -n "$rest" ]; do
    pair="${rest:0:2}"
    rest="${rest:2}"
    [ "$pair" != "00" ] || return 1 # bash 字符串不能无损承载 NUL
    printf -v byte '%b' "\\x$pair" || return 1
    HEX_VALUE="${HEX_VALUE}${byte}"
  done
  return 0
}

# workflow / track 名会进入宿主可读的 dispatch 提示，不能让项目配置中的控制符或标签分隔符
# 打破该数据契约。名字自身仍由 kernel 校验；这里仅是 shell 边界的防御性收窄（与 kernel 缓存编码同一规则）。
_route_name_ok() {
  local value="$1"
  [ -n "$value" ] && [ "${#value}" -le 160 ] || return 1
  case "$value" in
    *[$' \t\r\n']*|*'<'*|*'>'*|*'|'*|*';'*|*'='*) return 1 ;;
  esac
  return 0
}

# PARTS 最后一格永远是 sentinel，因此尾部空字段也不会被 read 吞掉。
_split_cache_line() {
  PARTS=()
  IFS='|' read -r -a PARTS <<< "${1}|__TENON_END__"
  local last=$(( ${#PARTS[@]} - 1 ))
  [ "$last" -ge 0 ] && [ "${PARTS[$last]}" = "__TENON_END__" ]
}

# 格式（kernel router-cache.ts）：TENON_ROUTER_V6、一行 M|<hex root>|<摘要>、至多 64 行
# R|<序>|<优先级>|<hex workflow>|<hex track>|<hex label>|<可路由>|<兜底>|<内建>|<hex 匹配式>|<hex 排除式>。
# 任何不合规都清空并 return 1；未知记录类型一律拒绝（旧版缓存的 B / C / S 行因此整体作废）。
_router_load_cache() { # file expected-root
  local file="$1" expected_root="$2"
  local line line_no=0 metadata_seen=0 previous_order=-1 i
  local order priority workflow track label routable fallback builtin pattern exclude
  _router_clear_cache
  [ -f "$file" ] || return 1

  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    if [ "$line_no" -eq 1 ]; then
      [ "$line" = "TENON_ROUTER_V6" ] || { _router_clear_cache; return 1; }
      continue
    fi
    [ -n "$line" ] && [ "${#line}" -le 70000 ] || { _router_clear_cache; return 1; }
    _split_cache_line "$line" || { _router_clear_cache; return 1; }

    case "${PARTS[0]}" in
      M)
        [ "$line_no" -eq 2 ] && [ "$metadata_seen" -eq 0 ] && [ "${#PARTS[@]}" -eq 4 ] \
          || { _router_clear_cache; return 1; }
        _hex_decode "${PARTS[1]}" || { _router_clear_cache; return 1; }
        CACHE_ROOT="$HEX_VALUE"
        _hex_ok "${PARTS[2]}" && [ "${#PARTS[2]}" -eq 64 ] \
          || { _router_clear_cache; return 1; }
        CACHE_DIGEST="${PARTS[2]}"
        [ "$CACHE_ROOT" = "$expected_root" ] || { _router_clear_cache; return 1; }
        metadata_seen=1
        ;;
      R)
        [ "$metadata_seen" -eq 1 ] && [ "${#PARTS[@]}" -eq 12 ] || { _router_clear_cache; return 1; }
        order="${PARTS[1]}"; priority="${PARTS[2]}"
        _uint_ok "$order" && _uint_ok "$priority" || { _router_clear_cache; return 1; }
        [ "$order" -le 63 ] && [ "${#ROUTER_TRACKS[@]}" -lt 64 ] || { _router_clear_cache; return 1; }
        [ "$order" -gt "$previous_order" ] || { _router_clear_cache; return 1; }
        previous_order="$order"
        _hex_decode "${PARTS[3]}" || { _router_clear_cache; return 1; }; workflow="$HEX_VALUE"
        _route_name_ok "$workflow" || { _router_clear_cache; return 1; }
        _hex_decode "${PARTS[4]}" || { _router_clear_cache; return 1; }; track="$HEX_VALUE"
        _route_name_ok "$track" || { _router_clear_cache; return 1; }
        _hex_decode "${PARTS[5]}" || { _router_clear_cache; return 1; }; label="$HEX_VALUE"
        [ -n "$label" ] && [ "${#label}" -le 200 ] || { _router_clear_cache; return 1; }
        routable="${PARTS[6]}"; fallback="${PARTS[7]}"; builtin="${PARTS[8]}"
        case "$routable" in 0|1) ;; *) _router_clear_cache; return 1 ;; esac
        case "$fallback" in 0|1) ;; *) _router_clear_cache; return 1 ;; esac
        case "$builtin" in 0|1) ;; *) _router_clear_cache; return 1 ;; esac
        _hex_decode "${PARTS[9]}" || { _router_clear_cache; return 1; }; pattern="$HEX_VALUE"
        _hex_decode "${PARTS[10]}" || { _router_clear_cache; return 1; }; exclude="$HEX_VALUE"
        if [ "$routable" = "0" ]; then
          # 没有 route 的分支只能被点名，绝不带打分数据。
          [ "$priority" -eq 0 ] && [ "$fallback" = "0" ] && [ -z "$pattern" ] && [ -z "$exclude" ] \
            || { _router_clear_cache; return 1; }
        fi
        i=0
        while [ "$i" -lt "${#ROUTER_TRACKS[@]}" ]; do
          if [ "${ROUTER_WORKFLOWS[$i]}" = "$workflow" ] && [ "${ROUTER_TRACKS[$i]}" = "$track" ]; then
            _router_clear_cache; return 1
          fi
          i=$((i + 1))
        done
        i="${#ROUTER_TRACKS[@]}"
        ROUTER_PRIORITIES[$i]="$priority"; ROUTER_WORKFLOWS[$i]="$workflow"; ROUTER_TRACKS[$i]="$track"; ROUTER_LABELS[$i]="$label"
        ROUTER_ROUTABLES[$i]="$routable"; ROUTER_FALLBACKS[$i]="$fallback"; ROUTER_BUILTINS[$i]="$builtin"
        ROUTER_PATTERNS[$i]="$pattern"; ROUTER_EXCLUDES[$i]="$exclude"
        ;;
      *) _router_clear_cache; return 1 ;;
    esac
    line=""
  done < "$file"

  [ "$line_no" -ge 2 ] && [ "$metadata_seen" -eq 1 ] || { _router_clear_cache; return 1; }
  return 0
}

# 工作流文件的摘要字节流（kernel routerSourceDigest 的 shell 版，两边必须逐字节一致）：每份文件依次是
# `<范围>/<文件名>\n`、文件前 1 MiB 字节、`\n`；范围顺序 project、global、template，范围内按文件名字节序
# （LC_ALL=C 的 glob 序）；隐藏文件、符号链接、非普通文件忽略，每个目录最多 64 个。
_router_source_stream() {
  local scope dir file count
  for scope in project global template; do
    case "$scope" in
      project) dir="$SRC_PROJECT_DIR" ;;
      global) dir="$SRC_GLOBAL_DIR" ;;
      *) dir="$SRC_TEMPLATE_DIR" ;;
    esac
    [ -n "$dir" ] || continue
    count=0
    for file in "$dir"/*.yaml; do
      [ -f "$file" ] && [ ! -L "$file" ] || continue
      count=$((count + 1))
      [ "$count" -le 64 ] || break
      printf '%s/%s\n' "$scope" "${file##*/}"
      head -c 1048577 -- "$file"
      printf '\n'
    done
  done
  return 0
}

_router_sources_current() { # 0 = 缓存里的摘要与磁盘上的工作流文件内容一致；算不出摘要就当作不一致
  local observed
  declare -F pipeline_state_sha256 >/dev/null 2>&1 || return 1
  observed="$(_router_source_stream 2>/dev/null | pipeline_state_sha256 2>/dev/null)" || return 1
  observed="${observed%% *}"
  [ -n "$observed" ] && [ "$observed" = "$CACHE_DIGEST" ]
}

_router_regen() { # manifest root output
  local manifest="$1" root="$2" output="$3" cache_dir tmp
  command -v node >/dev/null 2>&1 || return 1
  [ -f "$manifest" ] && [ -d "$root" ] || return 1
  cache_dir="${output%/*}"
  [ "$cache_dir" != "$output" ] || cache_dir="."
  mkdir -p -- "$cache_dir" 2>/dev/null || return 1
  # The default cache is local runtime state: create the nested `.pipeline/.gitignore` once (noclobber,
  # never overwritten).  Content is byte-identical to kernel WORKFLOW_STATE_GITIGNORE.
  if [ "$cache_dir" = "$root/.pipeline/cache" ] && [ ! -L "$root/.pipeline" ] && [ ! -e "$root/.pipeline/.gitignore" ]; then
    ( set -C; printf '%s\n' '# Tenon local runtime state; shared configuration in this directory stays tracked.' \
      'cache/' 'terminal-sessions/' 'codex-skill-receipts.jsonl' > "$root/.pipeline/.gitignore" ) 2>/dev/null || true
  fi
  tmp="$(mktemp "$cache_dir/.router.v6.tmp.XXXXXX" 2>/dev/null)" || return 1

  if [ -f "$_CLI_BUNDLE" ] \
    && (cd "$root" && node "$_CLI_BUNDLE" _gen-router-sh "$manifest" "$root") > "$tmp" 2>/dev/null \
    && _router_load_cache "$tmp" "$root"; then
    if mv "$tmp" "$output" 2>/dev/null; then return 0; fi
    _router_clear_cache
  fi

  : > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; _router_clear_cache; return 1; }
  if [ -f "$_GEN_MJS" ] \
    && (cd "$root" && node "$_GEN_MJS" "$manifest" "$root") > "$tmp" 2>/dev/null \
    && _router_load_cache "$tmp" "$root"; then
    if mv "$tmp" "$output" 2>/dev/null; then return 0; fi
    _router_clear_cache
  fi

  rm -f "$tmp" 2>/dev/null
  _router_clear_cache
  return 1
}

LC_ALL=C
_router_clear_cache
CACHE_STALE=0
if [ ! -f "$CACHE" ]; then
  CACHE_STALE=1
elif [ -f "$_CLI_BUNDLE" ] && [ "$_CLI_BUNDLE" -nt "$CACHE" ]; then
  # A plugin release can change how the cache is encoded without touching any workflow file.
  CACHE_STALE=1
elif [ -f "$_GEN_MJS" ] && [ "$_GEN_MJS" -nt "$CACHE" ]; then
  CACHE_STALE=1
elif ! _router_load_cache "$CACHE" "$PROOT"; then
  # schema/root mismatch（含旧版 router.v5 缓存）或逐行结构损坏。
  CACHE_STALE=1
elif ! _router_sources_current; then
  # 项目、全局存储或插件模板里的某份工作流文件内容变了（或增删了文件）。
  CACHE_STALE=1
fi

if [ "$CACHE_STALE" -eq 1 ]; then
  _router_clear_cache
  if ! _router_regen "$MANIFEST" "$PROOT" "$CACHE"; then
    # 旧文件可留作诊断，但本轮内存态为空，立即结束。
    _router_clear_cache
    exit 0
  fi
fi

# ═══ HOT PATH（每轮命中缓存：严格 data parser + 动态打分；零 node/python/python3/jq）═══
[ "${#ROUTER_TRACKS[@]}" -gt 0 ] || exit 0

score_track() {
  local count
  count="$(printf '%s' "$PROMPT" | grep -ciE -- "$1" 2>/dev/null)" || count=0
  case "$count" in ''|*[!0-9]*) count=0 ;; esac
  printf '%s' "$count"
}

# ── 点名 ──
# 用户点名轨道（「用 backend 轨道」「track=pm」「use the frontend track」）、工作流（「用 design-system 工作流」
# 「--workflow X」）或二者的组合（`工作流:轨道`）比内容评分更强：是用户的直接选择，不评估、不要求再选。
# 只认缓存表里的 workflow / track（含没有 route、只能点名的分支）；点名多个或点名不存在的名字时回退评分并在输出里说明。
# 纯 bash =~，每条正则最多取 8 个匹配，不 spawn 任何进程。
# 只扫 prompt 首尾各 4 KiB：点名写在开头或结尾，粘贴的长日志不应让扫描随 prompt 长度变慢。
NAMED_ROW="" NAMED_WF="" NAMED_CONFLICT="" NAMED_UNKNOWN=""
NAMED_SCAN_TEXT="$PROMPT"
if [ "${#PROMPT}" -gt 8192 ]; then
  NAMED_SCAN_TEXT="${PROMPT:0:4096}"$'\n'"${PROMPT:$(( ${#PROMPT} - 4096 ))}"
fi
_router_find_row() { # $1=track token $2=workflow token（可空）→ NAMED_INDEX = 表中第一个匹配行（ASCII 大小写不敏感），无则 return 1
  local track="$1" workflow="${2:-}" idx=0 found=1
  NAMED_INDEX=""
  shopt -s nocasematch
  while [ "$idx" -lt "${#ROUTER_TRACKS[@]}" ]; do
    if [[ "${ROUTER_TRACKS[$idx]}" == "$track" ]] \
      && { [ -z "$workflow" ] || [[ "${ROUTER_WORKFLOWS[$idx]}" == "$workflow" ]]; }; then
      NAMED_INDEX="$idx"; found=0; break
    fi
    idx=$((idx + 1))
  done
  shopt -u nocasematch
  return "$found"
}
_router_find_workflow() { # $1=workflow token → NAMED_INDEX = 该工作流的第一行（规范拼写由行给出），无则 return 1
  local token="$1" idx=0 found=1
  NAMED_INDEX=""
  shopt -s nocasematch
  while [ "$idx" -lt "${#ROUTER_WORKFLOWS[@]}" ]; do
    if [[ "${ROUTER_WORKFLOWS[$idx]}" == "$token" ]]; then NAMED_INDEX="$idx"; found=0; break; fi
    idx=$((idx + 1))
  done
  shopt -u nocasematch
  return "$found"
}
_router_named_negated() { # $1=text before the match → 0 when the naming is negated
  local before="$1"
  while :; do
    case "$before" in *' '|*$'\t') before="${before%?}" ;; *) break ;; esac
  done
  case "$before" in
    *不|*别|*勿|*不要|*不用|*无需|*没|*"不要再"|*"don't"|*"do not"|*"not"|*"never"|*"Don't"|*"Do not"|*"Not"|*"Never") return 0 ;;
  esac
  return 1
}
_router_note_row() { # $1=行下标；已有不同的一行 → 记为冲突
  local idx="$1"
  if [ -z "$NAMED_ROW" ]; then
    NAMED_ROW="$idx"
  elif [ "$NAMED_ROW" != "$idx" ]; then
    NAMED_CONFLICT="${NAMED_CONFLICT:-${ROUTER_TRACKS[$NAMED_ROW]}}、${ROUTER_TRACKS[$idx]}"
  fi
}
_router_note_workflow() { # $1=行下标（取它的 workflow）；已有不同的工作流 → 记为冲突
  local name="${ROUTER_WORKFLOWS[$1]}"
  if [ -z "$NAMED_WF" ]; then
    NAMED_WF="$name"
  elif [ "$NAMED_WF" != "$name" ]; then
    NAMED_CONFLICT="${NAMED_CONFLICT:-$NAMED_WF}、$name"
  fi
}
_router_scan_named() { # $1=ERE $2=捕获组下标 $3=track|workflow
  local re="$1" group="$2" kind="$3" rest="$NAMED_SCAN_TEXT" match token before rounds=0
  while [ "$rounds" -lt 8 ] && [[ $rest =~ $re ]]; do
    rounds=$((rounds + 1))
    match="${BASH_REMATCH[0]}"
    token="${BASH_REMATCH[$group]}"
    before="${rest%%"$match"*}"
    rest="${rest#*"$match"}"
    [ -n "$token" ] || continue
    _router_named_negated "$before" && continue
    if [ "$kind" = "track" ] && _router_find_row "$token" ""; then
      _router_note_row "$NAMED_INDEX"
    elif [ "$kind" = "workflow" ] && _router_find_workflow "$token"; then
      _router_note_workflow "$NAMED_INDEX"
    elif [ -z "$NAMED_UNKNOWN" ] && [ "${#token}" -le 32 ]; then
      NAMED_UNKNOWN="$token"
    fi
  done
}
_router_scan_pair() { # `工作流:轨道` 写法（如 default:backend）：两段都是表里的才算点名；工作流对、轨道不对时记为未知
  local re='(^|[^A-Za-z0-9_:-])([A-Za-z][A-Za-z0-9_-]*):([a-z][a-z0-9_-]*)' rest="$NAMED_SCAN_TEXT" match before rounds=0 wf tr
  while [ "$rounds" -lt 8 ] && [[ $rest =~ $re ]]; do
    rounds=$((rounds + 1))
    match="${BASH_REMATCH[0]}"
    wf="${BASH_REMATCH[2]}"; tr="${BASH_REMATCH[3]}"
    before="${rest%%"$match"*}"
    rest="${rest#*"$match"}"
    _router_named_negated "$before" && continue
    _router_find_workflow "$wf" || continue
    if _router_find_row "$tr" "$wf"; then
      _router_note_row "$NAMED_INDEX"
    elif [ -z "$NAMED_UNKNOWN" ] && [ "${#wf}" -le 32 ] && [ "${#tr}" -le 32 ]; then
      NAMED_UNKNOWN="${wf}:${tr}"
    fi
  done
}

_router_scan_labels() { # 「用后端轨道」：动词 + 行的 label + 轨道 / 赛道 / track；label 按字面量匹配（与 id 相同的不重复扫）
  local idx=0 label match before
  local lead='(走|使用|选用|选择|采用|切换到|切到|改用|改走|换成|换到|用|选|按)[[:space:]]*' trail='[[:space:]]*(轨道|赛道|[Tt]rack|TRACK)'
  while [ "$idx" -lt "${#ROUTER_LABELS[@]}" ]; do
    label="${ROUTER_LABELS[$idx]}"
    if [ "$label" != "${ROUTER_TRACKS[$idx]}" ] && [[ $NAMED_SCAN_TEXT =~ $lead"$label"$trail ]]; then
      match="${BASH_REMATCH[0]}"
      before="${NAMED_SCAN_TEXT%%"$match"*}"
      _router_named_negated "$before" || _router_note_row "$idx"
    fi
    idx=$((idx + 1))
  done
}

BOUND_IDX=-1 RESTRICT_WF=""
if [ "$DISPATCH_INTENT" = "new" ]; then
  _router_scan_named '(走|使用|选用|选择|采用|切换到|切到|改用|改走|换成|换到|用|选|按)[[:space:]]*([A-Za-z][A-Za-z0-9_-]*)[[:space:]]*(轨道|赛道|track|Track|TRACK)' 2 track
  _router_scan_named '([Tt]rack|TRACK|轨道)[[:space:]]*(=|:|：)[[:space:]]*([A-Za-z][A-Za-z0-9_-]*)' 3 track
  _router_scan_named '--track[[:space:]]+([A-Za-z][A-Za-z0-9_-]*)' 1 track
  _router_scan_named '(^|[^A-Za-z])([Uu]se|[Uu]sing|[Cc]hoose|[Pp]ick|[Ss]elect|[Gg]o with|[Ss]witch to)[[:space:]]+(the[[:space:]]+)?([A-Za-z][A-Za-z0-9_-]*)[[:space:]]+([Tt]rack|TRACK)' 4 track
  _router_scan_named '(走|使用|选用|选择|采用|切换到|切到|改用|改走|换成|换到|用|选|按)[[:space:]]*([A-Za-z][A-Za-z0-9_-]*)[[:space:]]*(工作流|workflow|Workflow|WORKFLOW)' 2 workflow
  _router_scan_named '([Ww]orkflow|WORKFLOW|工作流)[[:space:]]*(=|:|：)[[:space:]]*([A-Za-z][A-Za-z0-9_-]*)' 3 workflow
  _router_scan_named '--workflow[[:space:]]+([A-Za-z][A-Za-z0-9_-]*)' 1 workflow
  _router_scan_named '(^|[^A-Za-z])([Uu]se|[Uu]sing|[Cc]hoose|[Pp]ick|[Ss]elect|[Gg]o with|[Ss]witch to)[[:space:]]+(the[[:space:]]+)?([A-Za-z][A-Za-z0-9_-]*)[[:space:]]+([Ww]orkflow|WORKFLOW)' 4 workflow
  _router_scan_pair
  _router_scan_labels
  if [ -z "$NAMED_CONFLICT" ]; then
    if [ -n "$NAMED_ROW" ]; then
      if [ -n "$NAMED_WF" ] && [ "${ROUTER_WORKFLOWS[$NAMED_ROW]}" != "$NAMED_WF" ]; then
        NAMED_CONFLICT="${ROUTER_WORKFLOWS[$NAMED_ROW]}:${ROUTER_TRACKS[$NAMED_ROW]}、${NAMED_WF}"
      else
        BOUND_IDX="$NAMED_ROW"
      fi
    elif [ -n "$NAMED_WF" ]; then
      # 只点名了工作流：它只有一条分支（平铺工作流）就直接用；有多条分支则只在它的分支里评分。
      _wf_rows=0 _wf_first=-1 _idx=0
      while [ "$_idx" -lt "${#ROUTER_WORKFLOWS[@]}" ]; do
        if [ "${ROUTER_WORKFLOWS[$_idx]}" = "$NAMED_WF" ]; then
          _wf_rows=$((_wf_rows + 1))
          [ "$_wf_first" -ge 0 ] || _wf_first="$_idx"
        fi
        _idx=$((_idx + 1))
      done
      if [ "$_wf_rows" -eq 1 ]; then BOUND_IDX="$_wf_first"; else RESTRICT_WF="$NAMED_WF"; fi
    fi
  fi
fi

# ── 选出轨道 ──
TRACK="" TRACK_WF="" TRACK_BASIS="score" SCORE_SHOWN=0
ASSESS_REQUIRED=0 SELECTION_REQUIRED=0 SEL_IDX=-1
CAND=()
if [ "$DISPATCH_INTENT" = "resume" ]; then
  # 恢复已有 Change 时以持久化状态中的 track 为权威：用户只说“继续 X”而未复述领域关键词，不能被评分 0 静默吞掉，
  # 也不能被错误重算到另一个 track。在途的旧任务（standard / simple / 对话 / 自由）的轨道不在表里，所以只做字符集校验，
  # 不把手改 state 的任意原文透传到宿主上下文。
  if _route_name_ok "$CHANGE_TRACK"; then TRACK="$CHANGE_TRACK"; TRACK_BASIS="state"; else TRACK="unresolved"; TRACK_BASIS="none"; fi
elif [ "$DISPATCH_INTENT" = "select" ]; then
  # 多候选的泛化恢复本身就必须进入 pipeline 选择，不应因 prompt 没有领域关键词而丢失。
  # 此时没有可安全猜测的 track，明确标为 unresolved。
  TRACK="unresolved"; TRACK_BASIS="none"
elif [ "$BOUND_IDX" -ge 0 ]; then
  SEL_IDX="$BOUND_IDX"; TRACK_BASIS="user-named"
else
  # 路由只决定「是不是开发请求、属于哪个领域」，不按关键词决定轻重：
  #  · 重型信号 = 轻量分支自己的排除词命中（不论轻量关键词是否命中）→ 直接走领域重型轨道，不评估、不列轻量；
  #  · 没有重型信号、领域行与轻量行属于同一个工作流 → 带 assess: required，候选为「轻量 + 该领域行」，
  #    由 agent 在建任务前评估（产品调研这类请求是否评估，由轻量排除词的数据决定）；
  #  · 只有轻量命中、没有领域行 → 同样评估，候选为「轻量 + 兜底行」；
  #  · 最高分并列，或最高分落在自定义工作流的分支 → selection_required（领域行在别的工作流时不加轻量候选）；
  #  · 被排除词挡掉、又没有分支认领 → 落到声明了 fallback 的分支。
  # 打分是按行计数的 grep -ciE；没有 route 的分支（routable=0）从不进入打分。
  LITE_IDX=-1 FALLBACK_IDX=-1 ANY_BLOCKED=0 LITE_BLOCKED=0 BEST_IDX=-1 BEST_SCORE=0 TOP_COUNT=0
  ROW_SCORES=()
  i=0
  while [ "$i" -lt "${#ROUTER_TRACKS[@]}" ]; do
    ROW_SCORES[$i]=0
    if [ "${ROUTER_ROUTABLES[$i]}" = "1" ] \
      && { [ -z "$RESTRICT_WF" ] || [ "${ROUTER_WORKFLOWS[$i]}" = "$RESTRICT_WF" ]; }; then
      if [ "${ROUTER_FALLBACKS[$i]}" = "1" ] && [ "$FALLBACK_IDX" -lt 0 ]; then FALLBACK_IDX="$i"; fi
      if [ "${ROUTER_WORKFLOWS[$i]}" = "default" ] && [ "${ROUTER_TRACKS[$i]}" = "lite" ]; then LITE_IDX="$i"; fi
      EXCLUDED=0
      if [ -n "${ROUTER_EXCLUDES[$i]}" ] && [ "$(score_track "${ROUTER_EXCLUDES[$i]}")" -gt 0 ]; then EXCLUDED=1; fi
      if [ "$EXCLUDED" -eq 1 ] && [ "$i" -eq "$LITE_IDX" ]; then LITE_BLOCKED=1; fi
      if [ -n "${ROUTER_PATTERNS[$i]}" ]; then
        HITS="$(score_track "${ROUTER_PATTERNS[$i]}")"
        if [ "$EXCLUDED" -eq 0 ]; then
          ROW_SCORES[$i]="$HITS"
        elif [ "$HITS" -gt 0 ]; then
          # 请求本身命中了该行的关键词、却被它自己的排除词挡掉：是开发请求，只是带重型信号。
          ANY_BLOCKED=1
        fi
      fi
    fi
    i=$((i + 1))
  done
  # 领域轨道 = 除轻量外得分最高的行（同分比优先级，再比表中顺序）。
  i=0
  while [ "$i" -lt "${#ROUTER_TRACKS[@]}" ]; do
    if [ "$i" -ne "$LITE_IDX" ] && [ "${ROW_SCORES[$i]}" -gt 0 ]; then
      if [ "$BEST_IDX" -lt 0 ] || [ "${ROW_SCORES[$i]}" -gt "$BEST_SCORE" ] \
        || { [ "${ROW_SCORES[$i]}" -eq "$BEST_SCORE" ] && [ "${ROUTER_PRIORITIES[$i]}" -gt "${ROUTER_PRIORITIES[$BEST_IDX]}" ]; }; then
        BEST_IDX="$i"; BEST_SCORE="${ROW_SCORES[$i]}"
      fi
    fi
    i=$((i + 1))
  done
  i=0
  while [ "$i" -lt "${#ROUTER_TRACKS[@]}" ]; do
    if [ "$i" -ne "$LITE_IDX" ] && [ "$BEST_IDX" -ge 0 ] && [ "${ROW_SCORES[$i]}" -eq "$BEST_SCORE" ]; then TOP_COUNT=$((TOP_COUNT + 1)); fi
    i=$((i + 1))
  done
  LITE_HIT=0
  [ "$LITE_IDX" -ge 0 ] && [ "${ROW_SCORES[$LITE_IDX]}" -gt 0 ] && LITE_HIT=1
  if [ "$BEST_IDX" -ge 0 ]; then
    SEL_IDX="$BEST_IDX"; SCORE_SHOWN="$BEST_SCORE"
    if [ "$LITE_IDX" -ge 0 ] && [ "$LITE_BLOCKED" -eq 0 ] \
      && [ "${ROUTER_WORKFLOWS[$BEST_IDX]}" = "${ROUTER_WORKFLOWS[$LITE_IDX]}" ]; then
      ASSESS_REQUIRED=1
    fi
  elif [ "$LITE_HIT" -eq 1 ]; then
    ASSESS_REQUIRED=1; SCORE_SHOWN="${ROW_SCORES[$LITE_IDX]}"
    if [ "$FALLBACK_IDX" -ge 0 ]; then SEL_IDX="$FALLBACK_IDX"; else SEL_IDX="$LITE_IDX"; fi
  elif [ "$ANY_BLOCKED" -eq 1 ] && [ "$FALLBACK_IDX" -ge 0 ]; then
    SEL_IDX="$FALLBACK_IDX"; SCORE_SHOWN=1
  elif [ -n "$RESTRICT_WF" ]; then
    # 点名了多分支工作流、却没有任何分支命中：让用户在它的分支里选，不替他猜。
    SELECTION_REQUIRED=1; TRACK="unresolved"; TRACK_WF="$RESTRICT_WF"; TRACK_BASIS="user-named"
  fi
  if [ "$SEL_IDX" -ge 0 ]; then
    if [ "$TOP_COUNT" -gt 1 ] || [ "${ROUTER_BUILTINS[$SEL_IDX]}" = "0" ]; then SELECTION_REQUIRED=1; fi
    # 候选 pair：评估时轻量排第一；要求选择时再列出其余命中的行和兜底行，让用户有真实可选的东西。
    _cand_add() { # $1=行下标，去重，至多 8 条
      local _c=0
      [ "$1" -ge 0 ] && [ "${#CAND[@]}" -lt 8 ] || return 0
      while [ "$_c" -lt "${#CAND[@]}" ]; do [ "${CAND[$_c]}" != "$1" ] || return 0; _c=$((_c + 1)); done
      CAND[${#CAND[@]}]="$1"
    }
    [ "$ASSESS_REQUIRED" -eq 1 ] && _cand_add "$LITE_IDX"
    _cand_add "$SEL_IDX"
    if [ "$SELECTION_REQUIRED" -eq 1 ]; then
      i=0
      while [ "$i" -lt "${#ROUTER_TRACKS[@]}" ]; do
        [ "${ROW_SCORES[$i]}" -le 0 ] || [ "$i" -eq "$LITE_IDX" ] || _cand_add "$i" # 轻量只在评估时作为候选
        i=$((i + 1))
      done
      _cand_add "$FALLBACK_IDX"
    fi
  elif [ "$SELECTION_REQUIRED" -eq 1 ]; then
    i=0
    while [ "$i" -lt "${#ROUTER_TRACKS[@]}" ] && [ "${#CAND[@]}" -lt 8 ]; do
      [ "${ROUTER_WORKFLOWS[$i]}" != "$RESTRICT_WF" ] || CAND[${#CAND[@]}]="$i"
      i=$((i + 1))
    done
  fi
fi
if [ "$SEL_IDX" -ge 0 ]; then
  TRACK="${ROUTER_TRACKS[$SEL_IDX]}"; TRACK_WF="${ROUTER_WORKFLOWS[$SEL_IDX]}"
fi

if [ "$DISPATCH_INTENT" = "new" ] && [ -z "$TRACK" ]; then
  # 没有任何分支命中，但这条请求带着「在改代码」的记号（源码路径 / 反引号代码 / 函数调用 / 函数、模块、测试、
  # 缺陷、报错等词）：别悄悄放过去不治理，给一行提示。纯讨论在更前面已经早退；这里只是兜底，不替代路由。
  if printf '%s' "$PROMPT" | grep -qiE -- '([A-Za-z0-9_./-]+\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|cc|cpp|h|cs|swift|vue|svelte|sh|sql|css|scss|html)([^A-Za-z0-9]|$))|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*\([^)]*\)|(^|[^a-z])(function|method|class|module|endpoint|component|test|tests|bug|error|exception|crash|regression|compile|lint)([^a-z]|$)|函数|方法|模块|接口|组件|测试|缺陷|报错|崩溃|异常|编译|代码|脚本|源码'; then
    printf '\n<workflow-state>\nrouter: 未命中任何轨道规则，但这条请求像是在改代码，当前不会被 Tenon 治理。确实要改代码就先调用 tenon 评估改动范围（读相关代码、列出预计要改的文件，运行 tenon assess --files <文件…>），再用 tenon init <名字> --workflow default --track lite（轻量）或领域重型轨道创建，并 tenon session activate 后再动手；纯问答或讨论请忽略这一行。\n</workflow-state>\n'
  fi
  exit 0
fi

EFF_PHASE="${CHANGE_PHASE:-open}"
case "$EFF_PHASE" in
  ''|*[!a-zA-Z0-9_-]*) EFF_PHASE=open ;;
esac

# 已建任务的恢复：无 OpenSpec 文档链的任务（轻量轨道，以及在途的旧 standard / simple）没有 tasks.md，
# 待办清单取自冻结计划的步骤标签。
RESUME_PLAN_TODO=0
if [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$CHANGE_NAME" ]; then
  case "$CHANGE_WORKFLOW:$CHANGE_TRACK" in
    standard:*|simple:*|default:lite) RESUME_PLAN_TODO=1 ;;
  esac
fi

if [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$CHANGE_NAME" ]; then
  HDR="change=${CHANGE_NAME} · phase=${EFF_PHASE} · track=${TRACK}（状态绑定）"
  if [ "$RESUME_PLAN_TODO" -eq 1 ]; then
    TAIL="已恢复 ${TRACK} Change（无 OpenSpec 文档链）。必须立即调用 tenon，并只按冻结工作流当前 step 的 step.next 执行；Todo 来自 tenon workflow plan 的步骤标签，不读取 tasks.md 或 OpenSpec 文档链。"
  else
    TAIL="已恢复 ${TRACK} Change。必须立即调用 Skill 工具的 tenon，由它按 tenon status <change> --json 的 step.next 执行当前步骤；先按 tasks.md 的阶段任务建立/更新 Todo，勿先生成通用 Todo、勿绕过 Tenon 直接实现。按 ${EFF_PHASE} 相位纪律推进，勿自动 transition，产出交用户确认后再推进。"
  fi
elif [ "$DISPATCH_INTENT" = "select" ]; then
  HDR="疑似 track=${TRACK}（评分 ${SCORE_SHOWN}）· 恢复目标未选择"
  if [ "$WORKTREE_SELECT" = "1" ]; then
    TAIL="用户明确要继续，但能继续的任务都建在各自的 worktree 里（候选与路径见下方 change_candidate）。必须立即调用 Skill 工具的 tenon，让入口 skill 列出这些候选及路径并要求用户点名；用户点名后先切进该任务的 worktree 再恢复。严禁按 mtime 猜测，也严禁把它当作新任务创建。"
  else
    TAIL="用户明确要继续，但项目中有多个未选择的活跃 change。必须立即调用 Skill 工具的 tenon，让入口 skill 用 tenon list/status 列出候选并要求用户点名；严禁按 mtime 猜测，也严禁把它当作新任务创建。"
  fi
else
  if [ "$TRACK_BASIS" = "user-named" ] && [ "$TRACK" != "unresolved" ]; then
    TRACK_LABEL="track=${TRACK}（用户点名）"
    TRACK_TASK_PHRASE="用户点名 ${TRACK_WF}/${TRACK} 的新任务"
  else
    TRACK_LABEL="疑似 track=${TRACK}（评分 ${SCORE_SHOWN}）"
    TRACK_TASK_PHRASE="疑似 ${TRACK} 新任务"
  fi
  # 平铺工作流（轨道 id 就是工作流名）建任务不用 --track。
  INIT_ARGS="--workflow ${TRACK_WF} --track ${TRACK}"
  [ "$TRACK" != "$TRACK_WF" ] || INIT_ARGS="--workflow ${TRACK_WF}"
  if [ "$SELECTION_REQUIRED" -eq 1 ]; then
    HDR="${TRACK_LABEL} · 独立新任务 · 需要用户选择 workflow/track"
    TAIL="${TRACK_TASK_PHRASE}。项目内已有 change 仅是显式恢复时的候选，严禁把它们绑定到本轮或复用其 phase/tasks。最高分并列，或最高分落在项目自定义 workflow 的分支：必须立即调用 Skill 工具的 tenon，由入口 skill 先根据下方候选 pair 询问用户选择 workflow/track；在用户选择前严禁创建 Change、严禁假定 default。选定后才创建并激活独立 Change。"
  elif [ "$ASSESS_REQUIRED" -eq 1 ]; then
    HDR="${TRACK_LABEL} · 独立新任务 · 需先评估改动范围"
    # 选轻量时也要记下领域：候选里除轻量外的那条轨道（同在 default 里才能当 --domain），升级为重型任务时靠它直接给出新任务的轨道。
    LITE_ARGS="--workflow default --track lite" LITE_NOTE=""
    if [ "$TRACK_WF" = "default" ] && [ "$TRACK" != "lite" ]; then
      LITE_ARGS="$LITE_ARGS --domain ${TRACK}"
      LITE_NOTE="；选轻量时必须带上 --domain ${TRACK}（即下方 candidate 里的领域轨道），轻量任务之后越过边界要升级时靠它直接给出新任务的轨道"
    fi
    TAIL="${TRACK_TASK_PHRASE}。项目内已有 change 仅是显式恢复时的候选，严禁把它们绑定到本轮或复用其 phase/tasks。这是开发请求，既没有点名轨道也没有重型信号，轻重由改动范围决定而不是关键词：必须立即调用 Skill 工具的 tenon，在建任务前读相关代码、列出预计要改的文件，运行 tenon assess --files <文件…>，把评估结果与推荐（候选见下方 candidate）摆给用户确认；用户确认后才 tenon init <名字> ${INIT_ARGS} 或轻量轨道（${LITE_ARGS}）创建并激活独立 Change${LITE_NOTE}，持续执行模式直接采用评估的推荐。轻量任务没有 OpenSpec 文档链，只有验证一道评审门；探针显示越过轻量边界时照 step.next 走 scope-expanded，再新建重型任务并 tenon set <新任务> depends_on <本任务>。"
  else
    HDR="${TRACK_LABEL} · 独立新任务"
    TAIL="${TRACK_TASK_PHRASE}。项目内已有 change 仅是显式恢复时的候选，严禁把它们绑定到本轮或复用其 phase/tasks。必须立即调用 Skill 工具的 tenon，让入口 skill 用 tenon init <名字> ${INIT_ARGS} 创建并激活独立 Change，并按 open 相位开始；不要先询问是否走工作流，也不要绕过 tenon 直接加载某个技能。"
  fi
fi

if [ "$SELECTION_REQUIRED" -eq 1 ]; then
  TAIL="$TAIL 尚未选定 workflow：不得把推荐 pair、空值或 default 当作已绑定身份；必须先由 tenon 完成明确选择，再按所选图解析真实 DAG、OpenSpec 约束和依赖顺序。"
elif [ "$DISPATCH_INTENT" = "resume" ] && [ "$RESUME_PLAN_TODO" -eq 0 ] && [ -n "$CHANGE_NAME" ] \
  && _route_name_ok "$CHANGE_WORKFLOW"; then
  case "$CHANGE_WORKFLOW" in
    default) ;;
    *) TAIL="$TAIL 当前 Change 绑定自定义 workflow '${CHANGE_WORKFLOW}'：router 不推断它的阶段要求；必须先调用 tenon，由它以 canonical state 与项目 workflow 图解析本阶段的真实 DAG、OpenSpec 约束和依赖顺序后再分派。" ;;
  esac
fi
if [ -n "$WORKTREE_PATH" ]; then
  TAIL="$TAIL 该任务建在 worktree 里（见 dispatch 的 worktree_path）：先切进该目录（Claude Code 用 EnterWorktree 的 path；Codex 请用户在该目录开新会话），再执行 tenon session activate 恢复。"
fi
# Real session, round 4: after 「按推荐」 the receipt was written, yet the resume text above ("产出交用户
# 确认后再推进") led the agent to say the gate still waited for 「确认继续」.  The two hooks run
# concurrently, so this names the reply and points at the canonical status instead of asserting success.
if [ "$ROUTER_REVIEW_REPLY" = "1" ] && [ -n "$CHANGE_NAME" ]; then
  TAIL="$TAIL 本条回复就是对 ${CHANGE_NAME} 待决评审的确认（「确认继续」「继续执行」「继续」「可以」「同意」「好的」「按推荐」都算）：评审回执由 confirm-clear-prompt 在本轮写入（见 <tenon-review-confirmed>），不要再让用户说「确认继续」。以 tenon status ${CHANGE_NAME} --json 的 step.review 与 next 为准：review.status=approved 时直接照 next transition。"
fi
if [ "$TRACK_BASIS" = "user-named" ] && [ "$TRACK" != "unresolved" ]; then
  TAIL="$TAIL 工作流/轨道 ${TRACK_WF}/${TRACK} 由用户在消息里点名，以点名为准：创建 Change 时用 ${INIT_ARGS}，不得按内容评分改成其他轨道，也不要求评估。"
elif [ -n "$NAMED_CONFLICT" ]; then
  TAIL="$TAIL 用户消息同时点名了多个轨道或工作流（${NAMED_CONFLICT}），无法确定以哪个为准，本轮回退为内容评分；请先向用户确认。"
elif [ -n "$NAMED_UNKNOWN" ]; then
  TAIL="$TAIL 用户点名的 ${NAMED_UNKNOWN} 不在本项目的轨道 / 工作流列表中，本轮回退为内容评分；请告诉用户可用的 workflow:track 并确认。"
fi
if [ -n "$HOST_SESSION_ID" ] && [ "$CONTINUOUS_EXECUTION" != 'true' ]; then
  # Only a host-session binding lets the next turn's 「继续」 find this conversation's Change.
  TAIL="$TAIL 激活 Change 时必须带本会话 id：tenon session activate <change> --host-session ${HOST_SESSION_ID}；不带它，下一轮的「继续/确认继续」认不出本会话的任务。"
fi
if [ "$CONTINUOUS_EXECUTION" = 'true' ]; then
  if [ -n "$HOST_SESSION_ID" ]; then
    TAIL="$TAIL 用户已在本轮明确授权后续连续执行。创建或精确恢复 Change 后，入口必须用 tenon session activate <change> --continuous --host-session ${HOST_SESSION_ID} 绑定授权；每个 phase 仍须完成真实 OpenSpec/skill/guard 证据，review 出口只能用 --delegated 写审计化确认，绝不跳过验证、发布或外部副作用边界。"
  else
    TAIL="$TAIL 用户表达了连续执行意图，但宿主没有提供可绑定的 host session id；不得创建持续授权投影，继续遵守逐项交互与 review 确认。"
  fi
fi

printf '\n<workflow-state>\nrouter: %s\n' "$HDR"
printf '%s\n</workflow-state>\n' "$TAIL"
DISPATCH_WORKFLOW="default"
if [ "$DISPATCH_INTENT" = "resume" ] && _route_name_ok "$CHANGE_WORKFLOW"; then
  # 已建 Change 的 workflow 是其不可变编排身份。恢复时必须从状态读取，而非按
  # 本轮 track scorer 的 default 重算；否则 custom workflow 会在第二轮被错误降级。
  DISPATCH_WORKFLOW="$CHANGE_WORKFLOW"
elif [ "$SELECTION_REQUIRED" -eq 1 ]; then
  DISPATCH_WORKFLOW="select"
elif [ "$DISPATCH_INTENT" = "new" ] && _route_name_ok "$TRACK_WF"; then
  DISPATCH_WORKFLOW="$TRACK_WF"
fi
printf '<tenon-dispatch>\naction: invoke-skill\nskill: tenon\nworkflow: %s\ntrack: %s\ntrack_basis: %s\nintent: %s\ncontinuous_execution: %s\n' "$DISPATCH_WORKFLOW" "$TRACK" "$TRACK_BASIS" "$DISPATCH_INTENT" "$CONTINUOUS_EXECUTION"
[ -n "$HOST_SESSION_ID" ] && printf 'host_session_id: %s\n' "$HOST_SESSION_ID"
if [ "$ASSESS_REQUIRED" -eq 1 ]; then
  printf 'assess: required\n'
fi
if [ "$ASSESS_REQUIRED" -eq 1 ] || [ "$SELECTION_REQUIRED" -eq 1 ]; then
  c=0
  while [ "$c" -lt "${#CAND[@]}" ]; do
    printf 'candidate: workflow=%s;track=%s\n' "${ROUTER_WORKFLOWS[${CAND[$c]}]}" "${ROUTER_TRACKS[${CAND[$c]}]}"
    c=$((c + 1))
  done
fi
if [ "$SELECTION_REQUIRED" -eq 1 ]; then
  printf 'selection_required: true\n'
  if [ "$TRACK" != "unresolved" ]; then
    printf 'suggested_track: %s\nsuggested_workflow: %s\n' "$TRACK" "$TRACK_WF"
  fi
fi
if [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$CHANGE_NAME" ] && [ "$RESUME_PLAN_TODO" -eq 1 ]; then
  # 没有 OpenSpec 文档链，也就没有 tasks.md；Todo 来自冻结计划的步骤标签。
  printf 'change: %s\nphase: %s\ntodo_source: tenon-workflow-plan\n' "$CHANGE_NAME" "$EFF_PHASE"
elif [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$CHANGE_NAME" ]; then
  printf 'change: %s\nphase: %s\ntodo_source: openspec/changes/%s/tasks.md\n' "$CHANGE_NAME" "$EFF_PHASE" "$CHANGE_NAME"
elif [ "$DISPATCH_INTENT" = "select" ]; then
  printf 'phase: select\ntodo_source: tenon-active-change-selection\n'
else
  printf 'phase: open\ntodo_source: tenon-workflow-plan\n'
fi
# 任务建在 worktree 里：点名恢复的带上它的绝对路径，入口 skill 先切进去再恢复；泛泛的「继续」把 worktree 任务列为候选。
if [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$WORKTREE_PATH" ]; then
  printf 'worktree_path: %s\n' "$WORKTREE_PATH"
fi
if [ "$DISPATCH_INTENT" = "select" ] && [ "$WORKTREE_SELECT" = "1" ]; then
  _change_index=0
  while [ "$_change_index" -lt "${#WT_CHANGE_NAMES[@]}" ]; do
    printf 'change_candidate: change=%s;worktree_path=%s\n' "${WT_CHANGE_NAMES[$_change_index]}" "${WT_CHANGE_PATHS[$_change_index]}"
    _change_index=$(( _change_index + 1 ))
  done
fi
printf 'required: true\n</tenon-dispatch>\n'
exit 0
