#!/usr/bin/env bash
# router.sh — UserPromptSubmit：项目级动态 Track 路由 + workflow breadcrumb/skill 注入。
#
# 冷路径从 effective Track Registry + manifest profile skills 生成 TENON_ROUTER_V5；默认 cache
# 位于 <canonical-project-root>/.pipeline/cache/router.v5.data。cache 是严格字段化的 hex 数据，
# 本脚本只逐行校验和 builtin 解码，绝不把项目 cache 当 shell 程序执行。
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

# 系统通知、自身回显、显式命令、纯讨论均不触发路由。局部快速修复交给 simple 风险轨，
# 不再作为绕过 Tenon 的 L5 口子。
case "$PROMPT" in
  *"<task-notification>"*|*"<task-id>"*|*"<output-file>"*|*"<workflow-state>"*|*"<tenon-router"*|*"<tenon-dispatch>"*) exit 0 ;;
esac
case "$PROMPT" in /*) exit 0 ;; esac

# Free 是显式执行意图，不是内容评分 Track。“提到 free”本身不够，必须带选择/执行语义；
# 这样“自由模式是什么”仍是纯讨论，而“我觉得应该用自由模式执行”不会被讨论前缀吞掉。
EXPLICIT_FREE_MODE='false'
case "$PROMPT" in
  *用自由模式*|*以自由模式*|*选择自由模式*|*自由模式执行*|*自由工作流执行*|*use-free-mode*|*use_free_mode*|*"use free mode"*|*track=free*) EXPLICIT_FREE_MODE='true' ;;
esac

if [ "$EXPLICIT_FREE_MODE" != "true" ]; then
  case "$PROMPT" in
    *如何使用*|*怎么用*|*是什么*|*为什么*|*解释*|*文档在哪*|*在哪里*|*意思是*|*我觉得*|*我感觉*|*你觉得*|*是不是*|*怎么样*|*看法*|*聊聊*|*讨论一下*|*有没有更好*) exit 0 ;;
  esac
  if printf '%s' "$PROMPT" | grep -qiE '^[[:space:]]*(what|why|how|when|where|who|can you (tell|explain|describe))\b'; then
    exit 0
  fi
fi

# Carry a strong, explicit continuous-execution authorisation through the normal-chat dispatch.
# The router does not itself create authority (there may be no Change yet); the Tenon root skill
# consumes this exact flag only after it has created or re-selected an exact Change and uses
# `tenon session activate --continuous --host-session <id>` to bind it safely.
CONTINUOUS_EXECUTION='false'
INTENT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/prompt-intent.sh"
if [ -r "$INTENT_HELPER" ]; then
  # shellcheck source=prompt-intent.sh
  . "$INTENT_HELPER"
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
# 当前用户的归档记录：整趟扫描只解析一次路径（与 archived=true 同等跳过）。
ARCHIVE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/task-archive.sh"
# shellcheck source=task-archive.sh
[ -r "$ARCHIVE_HELPER" ] && . "$ARCHIVE_HELPER"
declare -F pipeline_change_archived_for_user >/dev/null 2>&1 || pipeline_change_archived_for_user() { return 1; }
ARCHIVE_STORE=""
declare -F pipeline_task_archive_store >/dev/null 2>&1 && ARCHIVE_STORE="$(pipeline_task_archive_store "$PROOT" || true)"
for _change_dir in "$PROOT"/openspec/changes/*; do
  [ -d "$_change_dir" ] || continue
  f="$(pipeline_state_source "$_change_dir" || true)"
  [ -n "$f" ] || continue
  [ "$(yget "$f" archived)" = "true" ] && continue
  _change_name="${_change_dir##*/}"
  # change 名会进入 hook 的结构化输出和动态正则；只接受 CLI/状态机同一份路径契约。
  case "$_change_name" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  pipeline_change_archived_for_user "$ARCHIVE_STORE" "$_change_name" && continue
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
if [ -r "$INTENT_HELPER" ]; then
  # shellcheck source=prompt-intent.sh
  . "$INTENT_HELPER"
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
  if [ "$EXPLICIT_CHANGE_COUNT" -eq 1 ]; then
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
MANIFEST="$PLUGIN_ROOT/templates/manifest.yaml"
TRACKS_FILE="$PROOT/.pipeline/tracks.yaml"
if [ -f "$TRACKS_FILE" ]; then TRACKS_PRESENT=1; else TRACKS_PRESENT=0; fi
CACHE="${TENON_ROUTER_CACHE:-$PROOT/.pipeline/cache/router.v5.data}"
_CLI_BUNDLE="$PLUGIN_ROOT/packages/cli/dist/tenon.mjs"
_GEN_MJS="$PLUGIN_ROOT/hooks/router-gen.mjs"
# This release-owned digest is checked on every cache hit with bash builtins only. A unit test
# pins it to kernel.routerContractRevision(manifest), so builtin/skill/breadcrumb changes cannot
# silently retain a prior project cache even when plugin mtimes are older than that cache.
ROUTER_CONTRACT_REV="743507eef120b7ca7af5cb161af274e75d61d511ef329e720c82bd77e014fc99"

# Bash 3.2-compatible parallel arrays（不使用 associative array 或动态变量名）。
_router_clear_cache() {
  CACHE_ROOT="" CACHE_MANIFEST_SHA="" CACHE_REGISTRY_REV="" CACHE_TRACKS_PRESENT="" CACHE_CONTRACT_REV=""
  ROUTER_ORDERS=() ROUTER_PRIORITIES=() ROUTER_IDS=() ROUTER_ROUTABLES=() ROUTER_PATTERNS=() ROUTER_EXCLUDE_PATTERNS=() ROUTER_PROFILES=()
  ROUTER_MATRICES=() ROUTER_BUILTINS=() ROUTER_LABELS=() ROUTER_WORKFLOWS=()
  CACHE_BC_PHASES=() CACHE_BC_TEXTS=()
  CACHE_CELL_PHASES=() CACHE_CELL_PROFILES=() CACHE_CELL_KINDS=() CACHE_CELL_SOURCES=()
  CACHE_SKILL_PHASES=() CACHE_SKILL_PROFILES=() CACHE_SKILL_KINDS=() CACHE_SKILL_INDEXES=() CACHE_SKILL_TOKENS=()
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

_track_id_ok() {
  local value="$1"
  [ "${#value}" -le 32 ] || return 1
  case "$value" in
    ''|_all|[!a-z]*|*[!a-z0-9_-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# `workflowDefault` 会进入宿主可读的 dispatch 提示，不能让项目配置中的控制符或标签分隔符
# 打破该数据契约。workflow 定义自身仍由 kernel 校验；这里仅是 shell 边界的防御性收窄。
_workflow_default_ok() {
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

_router_load_cache() { # file expected-root expected-tracks-present expected-contract-revision
  local file="$1" expected_root="$2" expected_tracks="$3" expected_contract="$4"
  local line line_no=0 metadata_seen=0 previous_order=-1 stage=0 i found count
  local order priority id routable pattern exclude_pattern profile matrix builtin label workflow phase prose kind cell_source index token
  _router_clear_cache
  [ -f "$file" ] || return 1

  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    if [ "$line_no" -eq 1 ]; then
      [ "$line" = "TENON_ROUTER_V5" ] || { _router_clear_cache; return 1; }
      continue
    fi
    [ -n "$line" ] || { _router_clear_cache; return 1; }
    _split_cache_line "$line" || { _router_clear_cache; return 1; }

    case "${PARTS[0]}" in
      M)
        [ "$line_no" -eq 2 ] && [ "$metadata_seen" -eq 0 ] && [ "${#PARTS[@]}" -eq 7 ] \
          || { _router_clear_cache; return 1; }
        _hex_decode "${PARTS[1]}" || { _router_clear_cache; return 1; }
        CACHE_ROOT="$HEX_VALUE"
        _hex_ok "${PARTS[2]}" && [ "${#PARTS[2]}" -eq 64 ] \
          || { _router_clear_cache; return 1; }
        _hex_ok "${PARTS[3]}" && [ "${#PARTS[3]}" -ge 16 ] && [ "${#PARTS[3]}" -le 64 ] \
          || { _router_clear_cache; return 1; }
        case "${PARTS[4]}" in 0|1) ;; *) _router_clear_cache; return 1 ;; esac
        _hex_ok "${PARTS[5]}" && [ "${#PARTS[5]}" -eq 64 ] \
          || { _router_clear_cache; return 1; }
        CACHE_MANIFEST_SHA="${PARTS[2]}"
        CACHE_REGISTRY_REV="${PARTS[3]}"
        CACHE_TRACKS_PRESENT="${PARTS[4]}"
        CACHE_CONTRACT_REV="${PARTS[5]}"
        [ "$CACHE_ROOT" = "$expected_root" ] && [ "$CACHE_TRACKS_PRESENT" = "$expected_tracks" ] \
          && [ "$CACHE_CONTRACT_REV" = "$expected_contract" ] \
          || { _router_clear_cache; return 1; }
        metadata_seen=1
        ;;
      R)
        [ "$metadata_seen" -eq 1 ] && [ "$stage" -eq 0 ] && [ "${#PARTS[@]}" -eq 13 ] \
          || { _router_clear_cache; return 1; }
        order="${PARTS[1]}"; priority="${PARTS[2]}"
        _uint_ok "$order" && _uint_ok "$priority" || { _router_clear_cache; return 1; }
        [ "$order" -le 32 ] && [ "${#ROUTER_IDS[@]}" -lt 33 ] || { _router_clear_cache; return 1; }
        [ "$order" -gt "$previous_order" ] || { _router_clear_cache; return 1; }
        previous_order="$order"
        _hex_decode "${PARTS[3]}" || { _router_clear_cache; return 1; }; id="$HEX_VALUE"
        _track_id_ok "$id" || { _router_clear_cache; return 1; }
        routable="${PARTS[4]}"
        case "$routable" in 0|1) ;; *) _router_clear_cache; return 1 ;; esac
        _hex_decode "${PARTS[5]}" || { _router_clear_cache; return 1; }; pattern="$HEX_VALUE"
        _hex_decode "${PARTS[6]}" || { _router_clear_cache; return 1; }; exclude_pattern="$HEX_VALUE"
        if [ "$routable" = "1" ]; then
          [ -n "$pattern" ] || { _router_clear_cache; return 1; }
        else
          [ "$priority" -eq 0 ] && [ -z "$pattern" ] && [ -z "$exclude_pattern" ] \
            || { _router_clear_cache; return 1; }
        fi
        _hex_decode "${PARTS[7]}" || { _router_clear_cache; return 1; }; profile="$HEX_VALUE"
        [ -n "$profile" ] || { _router_clear_cache; return 1; }
        matrix="${PARTS[8]}"; builtin="${PARTS[9]}"
        case "$matrix" in 0|1) ;; *) _router_clear_cache; return 1 ;; esac
        case "$builtin" in 0|1) ;; *) _router_clear_cache; return 1 ;; esac
        _hex_decode "${PARTS[10]}" || { _router_clear_cache; return 1; }; label="$HEX_VALUE"
        [ -n "$label" ] || { _router_clear_cache; return 1; }
        _hex_decode "${PARTS[11]}" || { _router_clear_cache; return 1; }; workflow="$HEX_VALUE"
        _workflow_default_ok "$workflow" || { _router_clear_cache; return 1; }
        i=0
        while [ "$i" -lt "${#ROUTER_IDS[@]}" ]; do
          [ "${ROUTER_IDS[$i]}" != "$id" ] || { _router_clear_cache; return 1; }
          i=$((i + 1))
        done
        i="${#ROUTER_IDS[@]}"
        ROUTER_ORDERS[$i]="$order"; ROUTER_PRIORITIES[$i]="$priority"; ROUTER_IDS[$i]="$id"; ROUTER_ROUTABLES[$i]="$routable"
        ROUTER_PATTERNS[$i]="$pattern"; ROUTER_EXCLUDE_PATTERNS[$i]="$exclude_pattern"
        ROUTER_PROFILES[$i]="$profile"; ROUTER_MATRICES[$i]="$matrix"
        ROUTER_BUILTINS[$i]="$builtin"; ROUTER_LABELS[$i]="$label"; ROUTER_WORKFLOWS[$i]="$workflow"
        ;;
      B)
        [ "$metadata_seen" -eq 1 ] && [ "$stage" -le 1 ] && [ "${#PARTS[@]}" -eq 4 ] \
          || { _router_clear_cache; return 1; }
        stage=1
        _hex_decode "${PARTS[1]}" || { _router_clear_cache; return 1; }; phase="$HEX_VALUE"
        [ -n "$phase" ] || { _router_clear_cache; return 1; }
        _hex_decode "${PARTS[2]}" || { _router_clear_cache; return 1; }; prose="$HEX_VALUE"
        i=0
        while [ "$i" -lt "${#CACHE_BC_PHASES[@]}" ]; do
          [ "${CACHE_BC_PHASES[$i]}" != "$phase" ] || { _router_clear_cache; return 1; }
          i=$((i + 1))
        done
        i="${#CACHE_BC_PHASES[@]}"; CACHE_BC_PHASES[$i]="$phase"; CACHE_BC_TEXTS[$i]="$prose"
        ;;
      C)
        [ "$metadata_seen" -eq 1 ] && [ "$stage" -le 2 ] && [ "${#PARTS[@]}" -eq 6 ] \
          || { _router_clear_cache; return 1; }
        stage=2
        _hex_decode "${PARTS[1]}" || { _router_clear_cache; return 1; }; phase="$HEX_VALUE"
        _hex_decode "${PARTS[2]}" || { _router_clear_cache; return 1; }; profile="$HEX_VALUE"
        [ -n "$phase" ] && [ -n "$profile" ] || { _router_clear_cache; return 1; }
        kind="${PARTS[3]}"; cell_source="${PARTS[4]}"
        case "$kind" in M|R) ;; *) _router_clear_cache; return 1 ;; esac
        case "$cell_source" in P|A|E) ;; *) _router_clear_cache; return 1 ;; esac
        i=0
        while [ "$i" -lt "${#CACHE_CELL_PHASES[@]}" ]; do
          if [ "${CACHE_CELL_PHASES[$i]}" = "$phase" ] && [ "${CACHE_CELL_PROFILES[$i]}" = "$profile" ] \
            && [ "${CACHE_CELL_KINDS[$i]}" = "$kind" ]; then
            _router_clear_cache; return 1
          fi
          i=$((i + 1))
        done
        i="${#CACHE_CELL_PHASES[@]}"; CACHE_CELL_PHASES[$i]="$phase"; CACHE_CELL_PROFILES[$i]="$profile"
        CACHE_CELL_KINDS[$i]="$kind"; CACHE_CELL_SOURCES[$i]="$cell_source"
        ;;
      S)
        [ "$metadata_seen" -eq 1 ] && [ "$stage" -eq 2 ] && [ "${#PARTS[@]}" -eq 7 ] \
          || { _router_clear_cache; return 1; }
        _hex_decode "${PARTS[1]}" || { _router_clear_cache; return 1; }; phase="$HEX_VALUE"
        _hex_decode "${PARTS[2]}" || { _router_clear_cache; return 1; }; profile="$HEX_VALUE"
        kind="${PARTS[3]}"; index="${PARTS[4]}"
        [ -n "$phase" ] && [ -n "$profile" ] && _uint_ok "$index" || { _router_clear_cache; return 1; }
        case "$kind" in M|R) ;; *) _router_clear_cache; return 1 ;; esac
        _hex_decode "${PARTS[5]}" || { _router_clear_cache; return 1; }; token="$HEX_VALUE"
        [ -n "$token" ] || { _router_clear_cache; return 1; }
        found=0; i=0
        while [ "$i" -lt "${#CACHE_CELL_PHASES[@]}" ]; do
          if [ "${CACHE_CELL_PHASES[$i]}" = "$phase" ] && [ "${CACHE_CELL_PROFILES[$i]}" = "$profile" ] \
            && [ "${CACHE_CELL_KINDS[$i]}" = "$kind" ]; then
            [ "${CACHE_CELL_SOURCES[$i]}" != "E" ] || { _router_clear_cache; return 1; }
            found=1; break
          fi
          i=$((i + 1))
        done
        [ "$found" -eq 1 ] || { _router_clear_cache; return 1; }
        count=0; i=0
        while [ "$i" -lt "${#CACHE_SKILL_PHASES[@]}" ]; do
          if [ "${CACHE_SKILL_PHASES[$i]}" = "$phase" ] && [ "${CACHE_SKILL_PROFILES[$i]}" = "$profile" ] \
            && [ "${CACHE_SKILL_KINDS[$i]}" = "$kind" ]; then count=$((count + 1)); fi
          i=$((i + 1))
        done
        [ "$index" -eq "$count" ] || { _router_clear_cache; return 1; }
        i="${#CACHE_SKILL_PHASES[@]}"; CACHE_SKILL_PHASES[$i]="$phase"; CACHE_SKILL_PROFILES[$i]="$profile"
        CACHE_SKILL_KINDS[$i]="$kind"; CACHE_SKILL_INDEXES[$i]="$index"; CACHE_SKILL_TOKENS[$i]="$token"
        ;;
      *) _router_clear_cache; return 1 ;;
    esac
    line=""
  done < "$file"

  [ "$line_no" -ge 2 ] && [ "$metadata_seen" -eq 1 ] || { _router_clear_cache; return 1; }
  return 0
}

_router_regen() { # manifest root output
  local manifest="$1" root="$2" output="$3" cache_dir tmp
  command -v node >/dev/null 2>&1 || return 1
  [ -f "$manifest" ] && [ -d "$root" ] || return 1
  cache_dir="${output%/*}"
  [ "$cache_dir" != "$output" ] || cache_dir="."
  mkdir -p -- "$cache_dir" 2>/dev/null || return 1
  tmp="$(mktemp "$cache_dir/.router.v5.tmp.XXXXXX" 2>/dev/null)" || return 1

  if [ -f "$_CLI_BUNDLE" ] \
    && (cd "$root" && node "$_CLI_BUNDLE" _gen-router-sh "$manifest" "$root") > "$tmp" 2>/dev/null \
    && _router_load_cache "$tmp" "$root" "$TRACKS_PRESENT" "$ROUTER_CONTRACT_REV"; then
    if mv "$tmp" "$output" 2>/dev/null; then return 0; fi
    _router_clear_cache
  fi

  : > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; _router_clear_cache; return 1; }
  if [ -f "$_GEN_MJS" ] \
    && (cd "$root" && node "$_GEN_MJS" "$manifest" "$root") > "$tmp" 2>/dev/null \
    && _router_load_cache "$tmp" "$root" "$TRACKS_PRESENT" "$ROUTER_CONTRACT_REV"; then
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
if [ ! -f "$CACHE" ] || [ ! -f "$MANIFEST" ]; then
  CACHE_STALE=1
elif [ "$MANIFEST" -nt "$CACHE" ]; then
  CACHE_STALE=1
elif [ -f "$_CLI_BUNDLE" ] && [ "$_CLI_BUNDLE" -nt "$CACHE" ]; then
  # A plugin release can change builtin Track definitions without touching project tracks.yaml.
  CACHE_STALE=1
elif [ -f "$_GEN_MJS" ] && [ "$_GEN_MJS" -nt "$CACHE" ]; then
  CACHE_STALE=1
elif [ "$TRACKS_PRESENT" -eq 1 ] && [ "$TRACKS_FILE" -nt "$CACHE" ]; then
  CACHE_STALE=1
elif ! _router_load_cache "$CACHE" "$PROOT" "$TRACKS_PRESENT" "$ROUTER_CONTRACT_REV"; then
  # schema/root/tracks-presence mismatch 或逐行结构损坏。
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
[ "${#ROUTER_IDS[@]}" -gt 0 ] || exit 0

score_track() {
  local count
  count="$(printf '%s' "$PROMPT" | grep -ciE -- "$1" 2>/dev/null)" || count=0
  case "$count" in ''|*[!0-9]*) count=0 ;; esac
  printf '%s' "$count"
}

BEST_SCORE=0 BEST_PRIORITY=0 TRACK="" PROFILE="" MATRIX="" BEST_WORKFLOW="default"
i=0
while [ "$i" -lt "${#ROUTER_IDS[@]}" ]; do
  if [ "${ROUTER_ROUTABLES[$i]}" != "1" ]; then
    i=$((i + 1))
    continue
  fi
  EXCLUDED=0
  if [ -n "${ROUTER_EXCLUDE_PATTERNS[$i]}" ]; then
    EXCLUSION_SCORE="$(score_track "${ROUTER_EXCLUDE_PATTERNS[$i]}")"
    [ "$EXCLUSION_SCORE" -gt 0 ] && EXCLUDED=1
  fi
  if [ "$EXCLUDED" -eq 1 ]; then SCORE=0; else SCORE="$(score_track "${ROUTER_PATTERNS[$i]}")"; fi
  if [ "$SCORE" -gt 0 ] && {
    [ "$SCORE" -gt "$BEST_SCORE" ] \
      || { [ "$SCORE" -eq "$BEST_SCORE" ] && [ "${ROUTER_PRIORITIES[$i]}" -gt "$BEST_PRIORITY" ]; }
  }; then
    BEST_SCORE="$SCORE"
    BEST_PRIORITY="${ROUTER_PRIORITIES[$i]}"
    TRACK="${ROUTER_IDS[$i]}"
    PROFILE="${ROUTER_PROFILES[$i]}"
    MATRIX="${ROUTER_MATRICES[$i]}"
    BEST_WORKFLOW="${ROUTER_WORKFLOWS[$i]}"
  fi
  i=$((i + 1))
done

EXPLICIT_FREE_BOUND=0
if [ "$DISPATCH_INTENT" = "new" ] && [ "$EXPLICIT_FREE_MODE" = "true" ]; then
  i=0
  while [ "$i" -lt "${#ROUTER_IDS[@]}" ]; do
    if [ "${ROUTER_IDS[$i]}" = "free" ]; then
      TRACK="free"
      PROFILE="${ROUTER_PROFILES[$i]}"
      MATRIX="${ROUTER_MATRICES[$i]}"
      BEST_WORKFLOW="${ROUTER_WORKFLOWS[$i]}"
      EXPLICIT_FREE_BOUND=1
      break
    fi
    i=$((i + 1))
  done
fi

# 新任务由本轮文本评分选择 track；恢复已有 Change 时则反过来，以持久化状态中的
# track 为权威。否则用户只说“继续 catalog-flow-page”而未复述领域关键词，会在这里
# 被评分 0 静默吞掉，或被错误重算到另一个 track。仅接受当前 effective registry 中
# 的 id，既得到对应的 skill profile，也不把手改 state 原文透传到宿主上下文。
RESUME_TRACK_BOUND=0
if [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$CHANGE_TRACK" ]; then
  i=0
  while [ "$i" -lt "${#ROUTER_IDS[@]}" ]; do
    if [ "${ROUTER_IDS[$i]}" = "$CHANGE_TRACK" ]; then
      TRACK="${ROUTER_IDS[$i]}"
      PROFILE="${ROUTER_PROFILES[$i]}"
      MATRIX="${ROUTER_MATRICES[$i]}"
      BEST_WORKFLOW="${ROUTER_WORKFLOWS[$i]}"
      RESUME_TRACK_BOUND=1
      break
    fi
    i=$((i + 1))
  done
fi

if [ "$RESUME_TRACK_BOUND" -ne 1 ] && [ "$EXPLICIT_FREE_BOUND" -ne 1 ] && [ "$DISPATCH_INTENT" != "select" ] \
  && { [ "$BEST_SCORE" -le 0 ] || [ -z "$TRACK" ]; }; then
  exit 0
fi

# 多候选的泛化恢复本身就必须进入 pipeline 选择，不应因 prompt 没有领域关键词而
# 丢失。此时没有可安全猜测的 track，明确标为 unresolved 并禁用 profile skill 注入。
if [ "$DISPATCH_INTENT" = "select" ] && [ -z "$TRACK" ]; then
  TRACK="unresolved"
  PROFILE=""
fi

# A project-defined routable Track or a project-selected non-default workflow is a real
# project-level choice. The plugin-owned simple→simple pair is the only non-default built-in pair
# that is versioned policy rather than project configuration, so it must keep the direct lightweight
# route. The hook may recommend every other winner, but it must not silently bind that choice.
CUSTOM_SELECTION_AVAILABLE=0
i=0
while [ "$i" -lt "${#ROUTER_IDS[@]}" ]; do
  if [ "${ROUTER_ROUTABLES[$i]}" = "1" ] && { [ "${ROUTER_BUILTINS[$i]}" = "0" ] \
    || { [ "${ROUTER_WORKFLOWS[$i]}" != "default" ] \
      && ! { [ "${ROUTER_IDS[$i]}" = "simple" ] && [ "${ROUTER_WORKFLOWS[$i]}" = "simple" ]; }; }; }; then
    CUSTOM_SELECTION_AVAILABLE=1
    break
  fi
  i=$((i + 1))
done
SELECTION_REQUIRED=0
if [ "$DISPATCH_INTENT" = "new" ] && [ "$CUSTOM_SELECTION_AVAILABLE" = "1" ]; then
  SELECTION_REQUIRED=1
fi

EFF_PHASE="${CHANGE_PHASE:-open}"
if [ "$DISPATCH_INTENT" = "new" ] && [ "$BEST_WORKFLOW" = "simple" ]; then EFF_PHASE="change"; fi
case "$EFF_PHASE" in
  ''|*[!a-zA-Z0-9_-]*) EFF_PHASE=open ;;
esac

# Default manifest 的 breadcrumb / profile skill matrix 只描述 default workflow。恢复一个
# custom workflow 时若仍注入它们，宿主会看到一套与真实 DAG 不一致的“强制 skill”，并可能
# 先尝试错误的 skill；custom 图必须由 tenon 入口用 CLI/受控读取加载后再分派。
# router 热路径不解析项目 YAML，因此在这里宁可不臆造，保留 canonical workflow identity。
NON_DEFAULT_WORKFLOW_DISPATCH=0
if { [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$CHANGE_NAME" ] \
    && _workflow_default_ok "$CHANGE_WORKFLOW" && [ "$CHANGE_WORKFLOW" != "default" ]; } \
  || { [ "$DISPATCH_INTENT" = "new" ] && _workflow_default_ok "$BEST_WORKFLOW" \
    && [ "$BEST_WORKFLOW" != "default" ]; }; then
  NON_DEFAULT_WORKFLOW_DISPATCH=1
fi

# A selection dispatch has no canonical workflow yet.  It must suppress the default matrix just
# like a bound custom workflow, but it must not claim that an empty or suggested workflow is
# already the Change's immutable identity.  Keep those two states distinct in the user-facing
# contract: Tenon owns the selection, then subsequent resume turns own the bound workflow.
SUPPRESS_DEFAULT_MATRIX="$NON_DEFAULT_WORKFLOW_DISPATCH"
if [ "$SELECTION_REQUIRED" = "1" ]; then
  SUPPRESS_DEFAULT_MATRIX=1
elif [ "$TRACK" = "free" ]; then
  # `matrix:false` 对普通自定义 Track 只表示 dashboard 不可编辑，仍可继承其 profile。
  # free 则是唯一明确禁止注入领域 Track 矩阵的中性内建模式。
  SUPPRESS_DEFAULT_MATRIX=1
fi

BC="" REC="" MAND=""
if [ "$SUPPRESS_DEFAULT_MATRIX" = "0" ]; then
  i=0
  while [ "$i" -lt "${#CACHE_BC_PHASES[@]}" ]; do
    if [ "${CACHE_BC_PHASES[$i]}" = "$EFF_PHASE" ]; then BC="${CACHE_BC_TEXTS[$i]}"; break; fi
    i=$((i + 1))
  done
  i=0
  while [ "$i" -lt "${#CACHE_SKILL_PHASES[@]}" ]; do
    if [ "${CACHE_SKILL_PHASES[$i]}" = "$EFF_PHASE" ] && [ "${CACHE_SKILL_PROFILES[$i]}" = "$PROFILE" ]; then
      if [ "${CACHE_SKILL_KINDS[$i]}" = "R" ]; then
        if [ -n "$REC" ]; then REC="$REC, ${CACHE_SKILL_TOKENS[$i]}"; else REC="${CACHE_SKILL_TOKENS[$i]}"; fi
      else
        if [ -n "$MAND" ]; then MAND="$MAND, ${CACHE_SKILL_TOKENS[$i]}"; else MAND="${CACHE_SKILL_TOKENS[$i]}"; fi
      fi
    fi
    i=$((i + 1))
  done
fi

if [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$CHANGE_NAME" ]; then
  HDR="change=${CHANGE_NAME} · phase=${EFF_PHASE} · track=${TRACK}（状态绑定）"
  if [ "$CHANGE_WORKFLOW" = "simple" ]; then
    TAIL="已恢复 simple Change。必须立即调用 tenon，并只按内建 simple DAG 的当前 step 分派 skill；Todo 来自 change/verify/done/escalated，不读取 default tasks.md 或 OpenSpec 文档链。"
  elif [ "$TRACK" = "free" ]; then
    TAIL="已恢复自由模式 Change。必须立即调用 tenon，并只按绑定 Workflow '${CHANGE_WORKFLOW}' 的真实 DAG、skills、gates 与 OpenSpec contract 推进；不得叠加 PM/frontend/backend 的 profile 或技能矩阵。"
  else
    TAIL="已恢复 ${TRACK} Change。必须立即调用 Skill 工具的 tenon，由它分派当前相位的 OpenSpec 与阶段 skill；先按 tasks.md 的阶段任务建立/更新 Todo，勿先生成通用 Todo、勿绕过 Tenon 直接实现。按 ${EFF_PHASE} 相位纪律推进，勿自动 transition，产出交用户确认后再推进。"
  fi
elif [ "$DISPATCH_INTENT" = "select" ]; then
  HDR="疑似 track=${TRACK}（评分 ${BEST_SCORE}）· 恢复目标未选择"
  TAIL="用户明确要继续，但项目中有多个未选择的活跃 change。必须立即调用 Skill 工具的 tenon，让入口 skill 用 tenon list/status 列出候选并要求用户点名；严禁按 mtime 猜测，也严禁把它当作新任务创建。"
else
  if [ "$SELECTION_REQUIRED" = "1" ]; then
    HDR="疑似 track=${TRACK}（评分 ${BEST_SCORE}）· 独立新任务 · 发现项目自定义 Tenon workflow/track"
    TAIL="疑似 ${TRACK} Track 新任务。项目内已有 change 仅是显式恢复时的候选，严禁把它们绑定到本轮或复用其 phase/tasks。项目已声明自定义 routable Track：必须立即调用 Skill 工具的 tenon，由入口 skill 先根据下方推荐 pair 与候选 pair 询问用户选择 Track/workflow；在用户选择前严禁创建 Change、严禁假定 default。选定后才创建并激活独立 Change。"
  else
    HDR="疑似 track=${TRACK}（评分 ${BEST_SCORE}）· 独立新任务"
    if [ "$BEST_WORKFLOW" = "simple" ]; then
      TAIL="已命中严格边界内的 simple 任务。必须立即调用 tenon，创建并激活独立 simple Change，按 change → verify → done 的轻量 DAG 执行；不得生成 default 的 PM/前后端/OpenSpec 文档链。若执行中边界扩大，必须走 scope-expanded 并升级为新的 default Change。"
    elif [ "$TRACK" = "free" ]; then
      TAIL="用户已显式选择自由模式。必须立即调用 tenon，先复核 free Track 与精确 Workflow 的 allowed 关系，再创建独立 Change；只执行所选 Workflow 自己的 DAG、skills、gates 与 OpenSpec contract，不叠加 PM/frontend/backend profile，也不得把自由模式解释为跳过 Workflow。"
    else
      TAIL="疑似 ${TRACK} Track 新任务。项目内已有 change 仅是显式恢复时的候选，严禁把它们绑定到本轮或复用其 phase/tasks。默认选择 default workflow：必须立即调用 Skill 工具的 tenon，让入口 skill 创建并激活独立 Change、初始化 OpenSpec，并按 open 相位开始；不要先询问是否走工作流，也不要直接执行某个阶段 skill。仅当用户明确指定自定义 workflow 时才改用该 workflow。"
    fi
  fi
fi

if [ "$SELECTION_REQUIRED" = "1" ]; then
  TAIL="$TAIL 尚未选定自定义 workflow：不得把推荐 pair、空值或 default 当作已绑定身份，也不得注入 default 的 breadcrumb 或 skill matrix；必须先由 tenon 完成明确选择，再按所选图解析真实 DAG、OpenSpec 约束和依赖顺序。"
elif [ "$NON_DEFAULT_WORKFLOW_DISPATCH" = "1" ]; then
  if { [ "$DISPATCH_INTENT" = "new" ] && [ "$BEST_WORKFLOW" = "simple" ]; } \
    || { [ "$DISPATCH_INTENT" = "resume" ] && [ "$CHANGE_WORKFLOW" = "simple" ]; }; then
    TAIL="$TAIL simple workflow 是插件内建只读图；项目同名文件不可覆盖，router 不注入 default breadcrumb 或 skill matrix。"
  else
    TAIL="$TAIL 当前 Change 绑定自定义 workflow '${CHANGE_WORKFLOW}'：此路由器不会用 default 的 breadcrumb 或 skill 矩阵伪造该阶段要求；必须先调用 tenon，由它以 canonical state 与项目 workflow 图解析本阶段的真实 DAG、OpenSpec 约束和依赖顺序后再分派。"
  fi
fi
if [ "$CONTINUOUS_EXECUTION" = 'true' ]; then
  if [ -n "$HOST_SESSION_ID" ]; then
    TAIL="$TAIL 用户已在本轮明确授权后续连续执行。创建或精确恢复 Change 后，入口必须用 tenon session activate <change> --continuous --host-session ${HOST_SESSION_ID} 绑定授权；每个 phase 仍须完成真实 OpenSpec/skill/guard 证据，review 出口只能用 --delegated 写审计化确认，绝不跳过验证、发布或外部副作用边界。"
  else
    TAIL="$TAIL 用户表达了连续执行意图，但宿主没有提供可绑定的 host session id；不得创建持续授权投影，继续遵守逐项交互与 review 确认。"
  fi
fi

printf '\n<workflow-state>\nrouter: %s\n' "$HDR"
[ -n "$BC" ] && printf '%s\n' "$BC"
[ -n "$REC" ] && printf '推荐 skill：%s\n' "$REC"
[ -n "$MAND" ] && printf '本相位强制 skill：%s\n' "$MAND"
printf '%s\n</workflow-state>\n' "$TAIL"
DISPATCH_WORKFLOW="default"
if [ "$DISPATCH_INTENT" = "resume" ] && _workflow_default_ok "$CHANGE_WORKFLOW"; then
  # 已建 Change 的 workflow 是其不可变编排身份。恢复时必须从状态读取，而非按
  # 本轮 track scorer 的 default 重算；否则 custom workflow 会在第二轮被错误降级。
  DISPATCH_WORKFLOW="$CHANGE_WORKFLOW"
elif [ "$SELECTION_REQUIRED" = "1" ]; then
  DISPATCH_WORKFLOW="select"
elif [ "$DISPATCH_INTENT" = "new" ] && _workflow_default_ok "$BEST_WORKFLOW"; then
  DISPATCH_WORKFLOW="$BEST_WORKFLOW"
fi
printf '<tenon-dispatch>\naction: invoke-skill\nskill: tenon\nworkflow: %s\ntrack: %s\nintent: %s\ncontinuous_execution: %s\n' "$DISPATCH_WORKFLOW" "$TRACK" "$DISPATCH_INTENT" "$CONTINUOUS_EXECUTION"
[ -n "$HOST_SESSION_ID" ] && printf 'host_session_id: %s\n' "$HOST_SESSION_ID"
if [ "$SELECTION_REQUIRED" = "1" ]; then
  i=0
  while [ "$i" -lt "${#ROUTER_IDS[@]}" ]; do
    if [ "${ROUTER_IDS[$i]}" != "chat" ]; then
      printf 'candidate: track=%s;workflow=%s\n' "${ROUTER_IDS[$i]}" "${ROUTER_WORKFLOWS[$i]}"
    fi
    i=$((i + 1))
  done
  printf 'selection_required: true\nsuggested_track: %s\nsuggested_workflow: %s\n' "$TRACK" "$BEST_WORKFLOW"
fi
if [ "$DISPATCH_INTENT" = "resume" ] && [ -n "$CHANGE_NAME" ]; then
  printf 'change: %s\nphase: %s\ntodo_source: openspec/changes/%s/tasks.md\n' "$CHANGE_NAME" "$EFF_PHASE" "$CHANGE_NAME"
elif [ "$DISPATCH_INTENT" = "select" ]; then
  printf 'phase: select\ntodo_source: tenon-active-change-selection\n'
else
  if [ "$DISPATCH_WORKFLOW" = "simple" ]; then
    printf 'phase: change\ntodo_source: builtin-workflow:simple\n'
  else
    printf 'phase: open\ntodo_source: tenon-phase-template\n'
  fi
fi
printf 'required: true\n</tenon-dispatch>\n'
exit 0
