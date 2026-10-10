#!/usr/bin/env bash
# active-change.sh — source-only resolver for the current user's explicitly selected, live Change.
#
# `.tenon/users/<slug>/local/active-change` is a per-user *selection* written by `tenon session activate`,
# never an mtime heuristic.  Hooks that append evidence or enforce a custom workflow DAG must use this
# resolver so a new conversation cannot borrow a different Change merely because it was modified most
# recently, and one user's selection never steers another user's hooks.  Callers source
# canonical-state.sh first; this helper validates the declared identity, the pointer and the selected
# state.  A missing identity means no selected Change.
#
# 共享指针按用户共享：并行会话谁最后 `tenon session activate` 谁就是指针。拦截、代为确认与记证据的 hook
# 因此不能直接用 pipeline_active_change_dir，而要用本文件的 pipeline_session_change_dir：它先看本会话自己的
# 会话绑定（.pipeline/terminal-sessions/<id>.json），只有宿主没给 session_id、或指针指向的 Change 无人绑定时
# 才回退指针。pipeline_active_change_dir 保留给只做「恢复候选」的 router / breadcrumb。

if ! declare -F pipeline_user_local_dir >/dev/null 2>&1; then
  _TENON_ACTIVE_USER_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/tenon-user.sh"
  # shellcheck source=tenon-user.sh
  [ -r "$_TENON_ACTIVE_USER_HELPER" ] && . "$_TENON_ACTIVE_USER_HELPER"
fi

if ! declare -F pipeline_change_archived_for_user >/dev/null 2>&1; then
  _TENON_ARCHIVE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/task-archive.sh"
  # shellcheck source=task-archive.sh
  [ -r "$_TENON_ARCHIVE_HELPER" ] && . "$_TENON_ARCHIVE_HELPER"
fi

pipeline_active_change_dir() { # $1=verified project root -> exact non-archived Change dir
  local root="$1" local_dir pointer name dir state
  [ -n "$root" ] && [ -d "$root/openspec/changes" ] || return 1
  declare -F pipeline_user_local_dir >/dev/null 2>&1 || return 1
  local_dir="$(pipeline_user_local_dir "$root")" || return 1
  [ -d "$local_dir" ] && [ ! -L "$local_dir" ] || return 1
  pointer="$local_dir/active-change"
  [ -f "$pointer" ] && [ ! -L "$pointer" ] && [ -r "$pointer" ] || return 1

  # Command substitution removes only trailing newlines.  Anything else (including an embedded
  # newline, path separator, or control character) fails the deliberately narrow name contract.
  name="$(<"$pointer")"
  case "$name" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  dir="$root/openspec/changes/$name"
  [ -d "$dir" ] || return 1
  state="$(pipeline_state_source "$dir" || true)"
  [ -n "$state" ] && [ "$(pipeline_state_get "$state" archived)" != "true" ] || return 1
  # 归档（对当前用户隐藏）与完结（archived=true）同等对待：不作为可恢复的选择。
  if declare -F pipeline_change_archived_for_user >/dev/null 2>&1; then
    pipeline_change_archived_for_user "$(pipeline_task_archive_store "$root" || true)" "$name" && return 1
  fi
  printf '%s' "$dir"
}

if ! declare -F pipeline_json_get_string >/dev/null 2>&1; then
  _TENON_ACTIVE_JSON_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
  # shellcheck source=json-input.sh
  [ -r "$_TENON_ACTIVE_JSON_HELPER" ] && . "$_TENON_ACTIVE_JSON_HELPER"
fi

if ! declare -F pipeline_host_session_change_name >/dev/null 2>&1; then
  _TENON_ACTIVE_BINDING_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/host-session-binding.sh"
  # shellcheck source=host-session-binding.sh
  [ -r "$_TENON_ACTIVE_BINDING_HELPER" ] && . "$_TENON_ACTIVE_BINDING_HELPER"
fi

# 会话绑定目录只增不删，热路径不能随它线性变慢。超过上限就无法证明「没有别的会话绑定它」，
# 保守按「已被别的会话绑定」处理（本会话判为没有任务：不拦、不代确认、不记证据）。
PIPELINE_SESSION_SCAN_MAX=1024

# 宿主 session_id 能不能当文件名与绑定键用：只认字母数字与 _-，长度 1-128（与 host-session-binding.sh 同一契约）。
pipeline_valid_session_id() { # $1=candidate session id → 0=usable as a binding key
  case "${1:-}" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -le 128 ]
}

# 各 hook 取会话 id 的唯一入口：打印通过校验的 id；宿主没给或不合法打印空（始终返回 0，调用方按空处理）。
pipeline_hook_session_id() { # $1=hook input JSON → host session id on stdout, empty when absent or illegal
  local id
  id="$(pipeline_json_get_string "${1:-}" session_id || true)"
  pipeline_valid_session_id "$id" && printf '%s' "$id"
  return 0
}

# 0 = 另一个会话已绑定 $2 这个 Change（或绑定数量多到无法证明没有）。
# 纯 bash、无 fork：每个文件只做一次有界读取（≤4096 字符）与字符串判定；符号链接、超大、损坏、
# session_id 与文件名不符、协议名不对的文件都不算绑定。
_pipeline_change_bound_to_other_session() { # $1=root $2=change name $3=this session id
  local dir="$1/.pipeline/terminal-sessions" change="$2" own="$3" file base body count=0
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  for file in "$dir"/*.json; do
    count=$((count + 1))
    [ "$count" -le "$PIPELINE_SESSION_SCAN_MAX" ] || return 0
    [ -f "$file" ] && [ ! -L "$file" ] && [ -r "$file" ] || continue
    base="${file##*/}"
    base="${base%.json}"
    [ "$base" != "$own" ] || continue
    pipeline_valid_session_id "$base" || continue
    body=''
    IFS= read -r -d '' -n 4097 body < "$file" || true
    [ "${#body}" -le 4096 ] || continue
    case "$body" in *"\"$change\""*) ;; *) continue ;; esac
    [ "$(pipeline_json_get_string "$body" protocol || true)" = 'pipeline-terminal-session-v1' ] || continue
    [ "$(pipeline_json_get_string "$body" session_id || true)" = "$base" ] || continue
    [ "$(pipeline_json_get_string "$body" change || true)" = "$change" ] || continue
    return 0
  done
  return 1
}

# 本会话任务：所有拦截、代为确认与记证据的 hook 的唯一解析（router / breadcrumb 只做恢复候选，不用它）。
#   1. 有合法 session_id 且有本会话绑定 → 绑定的 Change；
#   2. 有合法 session_id、无本会话绑定，而共享指针指向的 Change 已被别的会话绑定 → 无（返回 1）；
#   3. 其余（没给 / 不合法的 session_id；指针指向的 Change 无人绑定）→ 共享指针（旧行为）。
# 调用方须先 source canonical-state.sh（pipeline_state_source / pipeline_state_get）。
pipeline_session_change_dir() { # $1=verified project root $2=host session id → Change dir on stdout; status 1 = none
  local root="${1:-}" session_id="${2:-}" bound pointer name
  [ -n "$root" ] && [ -d "$root/openspec/changes" ] || return 1
  if pipeline_valid_session_id "$session_id" \
    && declare -F pipeline_host_session_change_name >/dev/null 2>&1 \
    && declare -F pipeline_json_get_string >/dev/null 2>&1; then
    bound="$(pipeline_host_session_change_name "$root" "$session_id" || true)"
    if [ -n "$bound" ]; then
      printf '%s' "$root/openspec/changes/$bound"
      return 0
    fi
    pointer="$(pipeline_active_change_dir "$root" || true)"
    [ -n "$pointer" ] || return 1
    name="${pointer##*/}"
    _pipeline_change_bound_to_other_session "$root" "$name" "$session_id" && return 1
    printf '%s' "$pointer"
    return 0
  fi
  pipeline_active_change_dir "$root"
}
