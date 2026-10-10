#!/usr/bin/env bash
# auto-update.sh — opt-in native plugin refresh for the single packaged release.
#
# SessionStart invokes this helper only as a best-effort background task.  It does nothing unless
# `tenon setup --codex|--claude --auto-update` wrote the user-owned preference file.  A 24-hour
# timestamp bound avoids network work on every turn; the current session stays on its already loaded
# skill set, while the next session sees the refreshed plugin.
set -uo pipefail

[ -n "${HOME:-}" ] || exit 0
TENON_BIN="${TENON_STABLE_BIN:-$HOME/.local/bin/tenon}"
[ -x "$TENON_BIN" ] || exit 0

# The active release passes TENON_RUNTIME_CONFIG_ROOT through the stable bootstrap.  Keep the
# platform-native fallback for a SessionStart launched immediately after a fresh install.
if [ -n "${TENON_RUNTIME_CONFIG_ROOT:-}" ]; then
  CONFIG_BASE="$TENON_RUNTIME_CONFIG_ROOT"
elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
  CONFIG_BASE="$HOME/Library/Application Support/tenon/config"
else
  CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}/tenon"
fi
# 源码开发安装（tenon setup --from-source）写下 install-channel 标记：后台 update 会把它换回正式版，所以见标记就退出。
# 标记里的 release_id 与当前 active release 对不上（回滚、重装之后）说明标记陈旧，照常更新。
CHANNEL_FILE="$CONFIG_BASE/install-channel"
if [ -f "$CHANNEL_FILE" ] && [ ! -L "$CHANNEL_FILE" ]; then
  DEV_CHANNEL=""
  DEV_RELEASE=""
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      channel) DEV_CHANNEL="$value" ;;
      release_id) DEV_RELEASE="$value" ;;
    esac
  done < "$CHANNEL_FILE"
  if [ "$DEV_CHANNEL" = "dev" ] && { [ -z "${TENON_ACTIVE_RELEASE_ID:-}" ] || [ "${TENON_ACTIVE_RELEASE_ID}" = "$DEV_RELEASE" ]; }; then
    exit 0
  fi
fi
CONFIG="$CONFIG_BASE/auto-update.conf"
[ -f "$CONFIG" ] && [ ! -L "$CONFIG" ] || exit 0

HOST=""
ENABLED=""
while IFS='=' read -r key value; do
  case "$key" in
    host) HOST="$value" ;;
    enabled) ENABLED="$value" ;;
  esac
done < "$CONFIG"
case "$HOST:$ENABLED" in codex:true|claude:true) ;; *) exit 0 ;; esac

mkdir -p "$CONFIG_BASE" 2>/dev/null || exit 0
STAMP="$CONFIG_BASE/last-auto-update-${HOST}"
LOCK="$CONFIG_BASE/.auto-update-${HOST}.lock"

update_due() {
  local now old
  now="$(date +%s 2>/dev/null || printf '0')"
  old="$(stat -c %Y "$STAMP" 2>/dev/null || true)"
  case "$old" in ''|*[!0-9]*) old="$(stat -f %m "$STAMP" 2>/dev/null || printf '0')" ;; esac
  case "$old" in ''|*[!0-9]*) old=0 ;; esac
  case "$now" in ''|*[!0-9]*) now=0 ;; esac
  [ $((now - old)) -ge 86400 ]
}

update_due || exit 0

# `touch` alone has a check-then-act race.  A directory claim is atomic on the user-local
# filesystem; recheck after the claim so simultaneous SessionStart hooks cannot spawn two refreshes.
mkdir "$LOCK" 2>/dev/null || exit 0
cleanup_lock() { rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup_lock EXIT HUP INT TERM
update_due || exit 0

# Claim before spawning.  A transient marketplace error is recorded in the log and retried at the
# next daily window rather than creating a per-turn retry storm.
: > "$STAMP" 2>/dev/null || exit 0
LOG="$CONFIG_BASE/auto-update-${HOST}.log"
nohup env TENON_AUTO_UPDATE=1 "$TENON_BIN" update "--${HOST}" --yes --auto >>"$LOG" 2>&1 &
exit 0
