#!/usr/bin/env bash
# active-change.sh — source-only resolver for the current user's explicitly selected, live Change.
#
# `.tenon/users/<slug>/local/active-change` is a per-user *selection* written by `tenon session activate`,
# never an mtime heuristic.  Hooks that append evidence or enforce a custom workflow DAG must use this
# resolver so a new conversation cannot borrow a different Change merely because it was modified most
# recently, and one user's selection never steers another user's hooks.  Callers source
# canonical-state.sh first; this helper validates the declared identity, the pointer and the selected
# state.  A missing identity means no selected Change.

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
