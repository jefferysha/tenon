#!/usr/bin/env bash
# interaction-authority.sh — source-only, Change-bound continuous-execution authority.
#
# A normal-chat user can explicitly authorise the agent to continue a selected Change without
# repeating the same interactive-skill questions.  That authority is deliberately a small,
# versioned hook projection rather than a global switch: it is valid only when it names the
# currently selected live Change, is fail-closed on malformed input, and records whether the user
# delegated the review acknowledgement after the review evidence has been produced.  It never
# skips evidence, guards, verification, or external/publication authority.

TENON_INTERACTION_AUTHORITY_PROTOCOL='pipeline-interaction-authority-v2'
if ! declare -F pipeline_user_local_dir >/dev/null 2>&1; then
  _TENON_AUTHORITY_USER_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/tenon-user.sh"
  # shellcheck source=tenon-user.sh
  [ -r "$_TENON_AUTHORITY_USER_HELPER" ] && . "$_TENON_AUTHORITY_USER_HELPER"
fi

# The projection lives in the current user's `.tenon/users/<slug>/local/authority`, so another user's
# authority can never unlock this user's gates.  A missing declared identity means no authority.
pipeline_interaction_authority_path() { # $1=verified project root
  local dir
  [ -n "$1" ] && declare -F pipeline_user_local_dir >/dev/null 2>&1 || return 1
  dir="$(pipeline_user_local_dir "$1")" || return 1
  printf '%s/authority' "$dir"
}

pipeline_interaction_authority_valid_name() { # $1=Change name
  case "$1" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  return 0
}

# Host session ids are supplied by the host, never invented from repository state.
pipeline_interaction_authority_valid_session() { # $1=host session id
  case "$1" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -le 128 ]
}

# Prints one requested field from a complete authority projection.  Unknown/duplicate fields are
# rejected so a partial write, a stale old format, or an operator typo cannot silently widen scope.
pipeline_interaction_authority_value() { # $1=authority marker path $2=change|host_session
  local marker="$1" requested="$2" first='' line='' line_number=0 change='' host_session='' scope='' review='' issued_at=''
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ -r "$marker" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    if [ "$line_number" -eq 1 ]; then
      first="$line"
      [ "$first" = "$TENON_INTERACTION_AUTHORITY_PROTOCOL" ] || return 1
      continue
    fi
    case "$line" in
      change=*)
        [ -z "$change" ] || return 1
        change="${line#change=}"
        ;;
      host_session=*)
        [ -z "$host_session" ] || return 1
        host_session="${line#host_session=}"
        ;;
      scope=*)
        [ -z "$scope" ] || return 1
        scope="${line#scope=}"
        ;;
      review=*)
        [ -z "$review" ] || return 1
        review="${line#review=}"
        ;;
      issued_at=*)
        [ -z "$issued_at" ] || return 1
        issued_at="${line#issued_at=}"
        ;;
      *) return 1 ;;
    esac
  done < "$marker"
  [ "$line_number" -ge 2 ] || return 1
  pipeline_interaction_authority_valid_name "$change" || return 1
  pipeline_interaction_authority_valid_session "$host_session" || return 1
  [ "$scope" = 'interactive-skills' ] || return 1
  case "$review" in required|delegated) ;; *) return 1 ;; esac
  case "$issued_at" in ''|*[!0-9TZ:.-]*) return 1 ;; esac
  case "$requested" in
    change) printf '%s' "$change" ;;
    host_session) printf '%s' "$host_session" ;;
    *) return 1 ;;
  esac
}

pipeline_interaction_authority_change() { # $1=authority marker path
  pipeline_interaction_authority_value "$1" change
}

pipeline_interaction_authority_host_session() { # $1=authority marker path
  pipeline_interaction_authority_value "$1" host_session
}

# True only for the caller's exact active Change and host session.  A projection for a previous
# Change or another conversation remains harmless until it is replaced or explicitly revoked.
pipeline_interaction_authority_for_change() { # $1=root $2=live Change name $3=host session id
  local path encoded encoded_session
  pipeline_interaction_authority_valid_name "$2" || return 1
  pipeline_interaction_authority_valid_session "$3" || return 1
  path="$(pipeline_interaction_authority_path "$1" || true)"
  [ -n "$path" ] || return 1
  encoded="$(pipeline_interaction_authority_change "$path" || true)"
  encoded_session="$(pipeline_interaction_authority_host_session "$path" || true)"
  [ "$encoded" = "$2" ] && [ "$encoded_session" = "$3" ]
}

pipeline_interaction_authority_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null
}

# Publish a complete projection with a same-directory temporary file.  The marker is policy
# metadata, not a security boundary (the repository belongs to the user), but this avoids readers
# observing a half-written authority and keeps malformed data fail-closed.
pipeline_write_interaction_authority() { # $1=root $2=live Change name $3=host session id
  local root="$1" change="$2" host_session="$3" dir marker tmp now
  [ -d "$root" ] || return 1
  pipeline_interaction_authority_valid_name "$change" || return 1
  pipeline_interaction_authority_valid_session "$host_session" || return 1
  dir="$(pipeline_ensure_user_local_dir "$root" || true)"
  [ -n "$dir" ] || return 1
  marker="$dir/authority"
  [ ! -L "$marker" ] || return 1
  now="$(pipeline_interaction_authority_now || true)"
  [ -n "$now" ] || return 1
  tmp="$marker.$$"
  [ ! -e "$tmp" ] && [ ! -L "$tmp" ] || return 1
  (
    umask 077
    printf '%s\n' "$TENON_INTERACTION_AUTHORITY_PROTOCOL"
    printf 'change=%s\n' "$change"
    printf 'host_session=%s\n' "$host_session"
    printf 'scope=interactive-skills\n'
    printf 'review=delegated\n'
    printf 'issued_at=%s\n' "$now"
  ) > "$tmp" || return 1
  [ ! -L "$marker" ] || { rm -f "$tmp" 2>/dev/null || true; return 1; }
  mv -f "$tmp" "$marker" 2>/dev/null
}

# Revocation is intentionally Change-bound too: switching to another selected Change cannot delete
# a previous Change's audit projection merely by saying "resume questions" in the new conversation.
pipeline_revoke_interaction_authority() { # $1=root $2=live Change name $3=host session id
  local marker
  marker="$(pipeline_interaction_authority_path "$1" || true)"
  [ -n "$marker" ] || return 1
  pipeline_interaction_authority_for_change "$1" "$2" "$3" || return 1
  rm -f "$marker" 2>/dev/null
}

# Keep an auditable, privacy-preserving record.  We deliberately record the resulting policy, not
# the whole user prompt, and reuse the existing per-Change history ledger rather than inventing a
# second event store.
pipeline_record_interaction_authority_event() { # $1=root $2=live Change name $3=enabled|revoked $4=host session id
  local root="$1" change="$2" action="$3" host_session="$4" dir history now
  pipeline_interaction_authority_valid_name "$change" || return 1
  pipeline_interaction_authority_valid_session "$host_session" || return 1
  case "$action" in enabled|revoked) ;; *) return 1 ;; esac
  dir="$root/openspec/changes/$change"
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  history="$dir/.pipeline-history.jsonl"
  [ ! -L "$history" ] || return 1
  now="$(pipeline_interaction_authority_now || true)"
  [ -n "$now" ] || return 1
  printf '{"ts":"%s","kind":"prompt","raw":"interaction-authority:%s scope=interactive-skills review=delegated host_session=%s"}\n' \
    "$now" "$action" "$host_session" >> "$history"
}
