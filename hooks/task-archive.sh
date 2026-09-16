#!/usr/bin/env bash
# task-archive.sh — source-only check for "this Change is 归档 for the current user".
#
# 归档 hides a task for one user only, so hooks must skip it exactly where they already skip a
# 完结（`archived=true`）Change: no resume, no evidence, no statusline entry. Other users are
# unaffected because the store is `.tenon/users/<slug>/local/archived.json`.
#
# The kernel serializer (kernel/src/workspace/task-archive.ts) writes canonical two-space JSON with
# `changes` at depth one, so a Change key is always the exact line `    "<name>": {`. That line is the
# ABI this grep matches — changing the serializer's indentation breaks these hooks.
# Pure bash 3.2 plus one grep: no node, no jq. Absent, non-regular, symlinked or oversized store →
# nothing is hidden (fail-open, same stance as the TypeScript reader).

_TENON_ARCHIVE_MAX_BYTES=1048576

if ! declare -F pipeline_user_local_dir >/dev/null 2>&1; then
  _TENON_ARCHIVE_USER_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/tenon-user.sh"
  # shellcheck source=tenon-user.sh
  [ -r "$_TENON_ARCHIVE_USER_HELPER" ] && . "$_TENON_ARCHIVE_USER_HELPER"
fi

# Resolve the store path once per hook run; callers pass it to pipeline_change_archived_for_user.
pipeline_task_archive_store() { # $1=project root → prints the store path or returns 1
  local local_dir store
  [ -n "${1:-}" ] || return 1
  declare -F pipeline_user_local_dir >/dev/null 2>&1 || return 1
  local_dir="$(pipeline_user_local_dir "$1")" || return 1
  [ -d "$local_dir" ] && [ ! -L "$local_dir" ] || return 1
  store="$local_dir/archived.json"
  [ -f "$store" ] && [ ! -L "$store" ] && [ -r "$store" ] || return 1
  printf '%s' "$store"
}

pipeline_change_archived_for_user() { # $1=store path (may be empty) $2=change name → 0 when hidden
  local store="${1:-}" name="${2:-}" size
  [ -n "$store" ] && [ -n "$name" ] || return 1
  case "$name" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  [ -f "$store" ] && [ ! -L "$store" ] || return 1
  size="$(wc -c <"$store" 2>/dev/null || printf '0')"
  [ "${size//[![:digit:]]/}" -le "$_TENON_ARCHIVE_MAX_BYTES" ] 2>/dev/null || return 1
  grep -q "^    \"$name\": {\$" "$store" 2>/dev/null
}
