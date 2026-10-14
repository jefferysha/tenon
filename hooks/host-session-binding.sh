#!/usr/bin/env bash
# host-session-binding.sh — source-only exact host-session → live Change resolver.
#
# `tenon session activate <change> --host-session <id>` creates the binding.  Unlike the
# per-user `active-change` recovery candidate, this projection has conversation
# identity and is therefore safe to use when a normal-dialogue prompt explicitly asks to resume.
# Callers must source json-input.sh and canonical-state.sh first.

pipeline_host_session_change_name() { # $1=verified project root $2=host session id
  local root="${1:-}" session_id="${2:-}" binding body protocol bound_session change dir state size
  [ -n "$root" ] && [ -d "$root/openspec/changes" ] || return 1
  case "$session_id" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#session_id}" -le 128 ] || return 1

  binding="$root/.pipeline/terminal-sessions/$session_id.json"
  [ -f "$binding" ] && [ ! -L "$binding" ] && [ -r "$binding" ] || return 1
  size="$(wc -c < "$binding" 2>/dev/null || printf 0)"
  size="${size//[[:space:]]/}"
  case "$size" in ''|*[!0-9]*) return 1 ;; esac
  [ "$size" -le 4096 ] || return 1

  body="$(<"$binding")"
  protocol="$(pipeline_json_get_string "$body" protocol || true)"
  bound_session="$(pipeline_json_get_string "$body" session_id || true)"
  change="$(pipeline_json_get_string "$body" change || true)"
  [ "$protocol" = 'pipeline-terminal-session-v1' ] || return 1
  [ "$bound_session" = "$session_id" ] || return 1
  case "$change" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#change}" -le 128 ] || return 1

  dir="$root/openspec/changes/$change"
  [ -d "$dir" ] || return 1
  state="$(pipeline_state_source "$dir" || true)"
  [ -n "$state" ] && [ "$(pipeline_state_get "$state" archived)" != 'true' ] || return 1
  printf '%s' "$change"
}
