#!/usr/bin/env bash
# terminal-activity.sh — native host tool-hook → short-lived terminal liveness sidecar.
#
# This script deliberately does not infer a Change from the per-user `active-change`: that pointer is a
# repository-level recovery candidate and was the reason an unrelated normal conversation could
# make an old Change appear live. It writes only when `tenon session activate <change>
# --host-session <id>` previously created an exact session-to-Change binding. The output is
# dashboard-only observability; canonical workflow state, guards, and transitions never read it.
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }
json_escape() { pipeline_json_escape "$1"; }

SESSION_ID="$(json_get session_id || true)"
case "$SESSION_ID" in
  ''|*[!A-Za-z0-9_-]*) exit 0 ;;
esac
[ "${#SESSION_ID}" -le 128 ] || exit 0

CWD="$(json_get cwd || true)"
[ -n "$CWD" ] || CWD="$PWD"
[ -d "$CWD" ] || exit 0

ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
[ -r "$ROOT_HELPER" ] || exit 0
# shellcheck source=project-root.sh
. "$ROOT_HELPER"
PROOT="$(pipeline_project_root "$CWD" existing changes || true)"
[ -n "$PROOT" ] || exit 0

# The binding file itself is untrusted local input. Its narrow schema and regular-file checks
# prevent a caller from turning an arbitrary session id into a path or from following a link.
BINDING="$PROOT/.pipeline/terminal-sessions/$SESSION_ID.json"
[ -f "$BINDING" ] && [ ! -L "$BINDING" ] && [ -r "$BINDING" ] || exit 0
[ "$(wc -c < "$BINDING" 2>/dev/null || printf 0)" -le 4096 ] || exit 0
BINDING_INPUT="$(<"$BINDING")"
binding_get() { pipeline_json_get_string "$BINDING_INPUT" "$1"; }
[ "$(binding_get protocol || true)" = 'pipeline-terminal-session-v1' ] || exit 0
[ "$(binding_get session_id || true)" = "$SESSION_ID" ] || exit 0
CHANGE_NAME="$(binding_get change || true)"
case "$CHANGE_NAME" in ''|*[!A-Za-z0-9_-]*) exit 0 ;; esac
[ "${#CHANGE_NAME}" -le 128 ] || exit 0

STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
[ -r "$STATE_HELPER" ] || exit 0
# shellcheck source=canonical-state.sh
. "$STATE_HELPER"
CHANGE_DIR="$PROOT/openspec/changes/$CHANGE_NAME"
[ -d "$CHANGE_DIR" ] || exit 0
CHANGE_STATE="$(pipeline_state_source "$CHANGE_DIR" || true)"
[ -n "$CHANGE_STATE" ] && [ "$(pipeline_state_get "$CHANGE_STATE" archived)" != 'true' ] || exit 0

TURN_ID="$(json_get turn_id || true)"
case "$TURN_ID" in *[!A-Za-z0-9_.:-]*) TURN_ID='' ;; esac
TOOL_NAME="$(json_get tool_name || true)"
[ -n "$TOOL_NAME" ] || exit 0

# The heartbeat is local, volatile state: `openspec/.gitignore` keeps it out of git. `session activate`
# creates that file; create it here too (once, never overwritten) for projects bound before it existed.
# Content is byte-identical to kernel OPENSPEC_LOCAL_GITIGNORE.
if [ ! -L "$PROOT/openspec" ] && [ ! -e "$PROOT/openspec/.gitignore" ] && [ ! -L "$PROOT/openspec/.gitignore" ]; then
  ( set -C; printf '%s\n' '# Tenon local runtime state; Change documents in this directory stay tracked.' \
    '.pipeline-terminal-activity.*' > "$PROOT/openspec/.gitignore" ) 2>/dev/null || true
fi

TARGET="$CHANGE_DIR/.pipeline-terminal-activity.json"
[ ! -e "$TARGET" ] || { [ -f "$TARGET" ] && [ ! -L "$TARGET" ]; } || exit 0
TEMP="$(mktemp "$CHANGE_DIR/.pipeline-terminal-activity.XXXXXX" 2>/dev/null || true)"
[ -n "$TEMP" ] || exit 0
trap 'rm -f "$TEMP"' EXIT
chmod 600 "$TEMP" 2>/dev/null || exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
[ -n "$TS" ] || exit 0
if [ -n "$TURN_ID" ]; then
  TURN_FIELD=",\"turn_id\":\"$(json_escape "$TURN_ID")\""
else
  TURN_FIELD=''
fi
printf '{"protocol":"pipeline-terminal-activity-v1","change":"%s","session_id":"%s","heartbeat_at":"%s"%s}\n' \
  "$(json_escape "$CHANGE_NAME")" "$(json_escape "$SESSION_ID")" "$TS" "$TURN_FIELD" > "$TEMP" || exit 0

# rename(2) publishes a complete JSON record. A concurrent stale heartbeat can only replace
# another heartbeat for this exact Change/session binding, which is harmless for a liveness lease.
mv -f "$TEMP" "$TARGET" 2>/dev/null || exit 0
trap - EXIT
exit 0
