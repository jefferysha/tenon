#!/usr/bin/env bash
# review-ack.sh — source-only helpers for the review-gate v2 receipt protocol.
#
# A review marker is only a short-lived hook projection.  The canonical receipt lives in the
# selected Change, so a normal-dialogue confirmation must call `tenon review acknowledge`
# instead of deleting the marker itself.  Keeping this tiny policy here lets UserPromptSubmit,
# PostToolUse and PreToolUse agree on marker ownership without teaching any hot-path hook how to
# mutate Tenon state directly.

TENON_REVIEW_MARKER_PROTOCOL='pipeline-review-v2'

# Echo the Change encoded by a syntactically complete v2 marker.  Old three-line markers and
# malformed projections deliberately return non-zero; callers can retire only the former because
# canonical state, not a marker, now protects a review exit.
pipeline_review_marker_change() { # $1=marker path
  local marker="$1" first='' line='' phase='' change='' requested_at=''
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ -r "$marker" ] || return 1
  IFS= read -r first < "$marker" 2>/dev/null || [ -n "$first" ] || return 1
  [ "$first" = "$TENON_REVIEW_MARKER_PROTOCOL" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      phase=*) phase="${line#phase=}" ;;
      change=*) change="${line#change=}" ;;
      requested_at=*) requested_at="${line#requested_at=}" ;;
    esac
  done < "$marker"
  [ -n "$phase" ] && [ -n "$requested_at" ] || return 1
  case "$change" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  printf '%s' "$change"
}

# Echo the exact outgoing event a v2 marker was requested for.  A pre-event v2 marker yields ''
# (success); a malformed event value returns non-zero so callers never echo it into agent context.
pipeline_review_marker_event() { # $1=marker path
  local line='' event=''
  pipeline_review_marker_is_v2 "$1" || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in event=*) event="${line#event=}" ;; esac
  done < "$1"
  case "$event" in *[!A-Za-z0-9_-]*) return 1 ;; esac
  printf '%s' "$event"
}

pipeline_review_marker_is_v2() { # $1=marker path
  local first=''
  [ -f "$1" ] && [ ! -L "$1" ] && [ -r "$1" ] || return 1
  IFS= read -r first < "$1" 2>/dev/null || [ -n "$first" ] || return 1
  [ "$first" = "$TENON_REVIEW_MARKER_PROTOCOL" ]
}

# Is a review receipt open (requested, or acknowledged but not yet consumed by a transition) on
# this Change's current phase?  Either signal is enough: the v2 root marker naming the Change, or
# the review fields of its `.pipeline.yaml` projection bound to the canonical phase given in $2.
# The marker alone is not enough because confirm-clear-prompt may acknowledge the review (and
# remove the marker) concurrently with the router on the very prompt that says 「确认继续」.
# Read-only routing hint; never a gate decision.
pipeline_review_receipt_open() { # $1=project root $2=change name $3=canonical phase of that change
  local root="${1:-}" change="${2:-}" phase="${3:-}" yaml line key value gate_phase='' gate_status=''
  case "$change" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "$(pipeline_review_marker_change "$root/.pipeline-pending-review" 2>/dev/null || true)" = "$change" ] && return 0
  [ -n "$phase" ] || return 1
  yaml="$root/openspec/changes/$change/.pipeline.yaml"
  [ -f "$yaml" ] && [ ! -L "$yaml" ] && [ -r "$yaml" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      'review_gate_phase: '*|'review_gate_status: '*) ;;
      *) continue ;;
    esac
    key="${line%%: *}"
    value="${line#*: }"
    case "$value" in '"'*'"') value="${value#\"}"; value="${value%\"}" ;; "'"*"'") value="${value#\'}"; value="${value%\'}" ;; esac
    case "$key" in
      review_gate_phase) gate_phase="$value" ;;
      review_gate_status) gate_status="$value" ;;
    esac
  done < "$yaml"
  [ "$gate_phase" = "$phase" ] || return 1
  case "$gate_status" in pending|approved) return 0 ;; esac
  return 1
}

# The active pointer is an explicit per-session selection, never an mtime heuristic.  Resolve it
# before treating a root-level marker as relevant; an old Change must not lock an unrelated chat.
pipeline_review_active_change_name() { # $1=verified project root $2=hook directory
  local root="$1" hook_dir="$2" state_helper active_helper dir
  [ -n "$root" ] && [ -d "$root" ] || return 1
  state_helper="$hook_dir/canonical-state.sh"
  active_helper="$hook_dir/active-change.sh"
  [ -r "$state_helper" ] && [ -r "$active_helper" ] || return 1
  # shellcheck source=canonical-state.sh
  . "$state_helper"
  # shellcheck source=active-change.sh
  . "$active_helper"
  dir="$(pipeline_active_change_dir "$root" || true)"
  [ -n "$dir" ] || return 1
  printf '%s' "${dir##*/}"
}

# Return success only when the v2 projection belongs to the explicitly selected live Change and
# the stable CLI persisted the canonical approval receipt.  This function never deletes v2 marker
# files itself; `tenon review acknowledge` owns both the receipt and its projection.
pipeline_acknowledge_active_review() { # $1=root $2=hook directory [$3=delegated] [$4=host session id]
  local root="$1" hook_dir="$2" mode="${3:-manual}" host_session="${4:-}" marker expected active
  marker="$root/.pipeline-pending-review"
  expected="$(pipeline_review_marker_change "$marker" || true)"
  [ -n "$expected" ] || return 1
  active="$(pipeline_review_active_change_name "$root" "$hook_dir" || true)"
  [ -n "$active" ] && [ "$active" = "$expected" ] || return 1
  command -v tenon >/dev/null 2>&1 || return 1
  case "$mode" in
    delegated)
      case "$host_session" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
      [ "${#host_session}" -le 128 ] || return 1
      ( cd "$root" && TENON_HOST_SESSION_ID="$host_session" command tenon review acknowledge "$active" --delegated ) >/dev/null 2>&1
      ;;
    manual) ( cd "$root" && command tenon review acknowledge "$active" ) >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
