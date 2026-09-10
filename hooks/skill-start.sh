#!/usr/bin/env bash
# skill-start.sh — PreToolUse hook（all tools; script-side narrow filter）。
#
# Skill 工具被调用且 pipeline 已明确选择一个 change 时，把「开始调用」append 进
#   openspec/changes/<name>/.pipeline-history.jsonl（一行一个 JSON）——kind=tool-start、raw="Skill: <skill 名>"。
# 与 skill-tracker.sh（PostToolUse，kind=tool = 完成态）配对：dashboard 据此把当前阶段的技能投影成
# idle / running / done；既有完成态判定只认 kind=tool，本行不会被当成完成证据。
#
# 纯 bash 热路径（CONTRACT §5.4）：零解释器 spawn，stdin JSON 只用 bash 字符串提取所需键。
# fire & forget：非 Skill 工具 / 无活跃 change / 异常 → exit 0。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }
json_escape() { pipeline_json_escape "$1"; }

STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
[ -r "$STATE_HELPER" ] || exit 0
# shellcheck source=canonical-state.sh
. "$STATE_HELPER"
yget() { pipeline_state_get "$1" "$2"; }
hook_disabled() { # $1=项目根 $2=hook id $3=阶段 → 0=该阶段已禁用
  [ -n "$1" ] && [ -n "$3" ] || return 1
  grep -Fq "\"$2.$3\": false" "$1/.pipeline/hooks.json" 2>/dev/null
}

TOOL="$(json_get tool_name || true)"
[ "$TOOL" = "Skill" ] || exit 0
NAME="$(json_get skill || true)"
[ -n "$NAME" ] || exit 0

CWD="$(json_get cwd || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0

ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
[ -r "$ROOT_HELPER" ] || exit 0
. "$ROOT_HELPER"
PROOT="$(pipeline_project_root "$CWD" existing changes || true)"
[ -n "$PROOT" ] || exit 0
[ -r "$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh" ] || exit 0
. "$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
CHANGE_DIR="$(pipeline_active_change_dir "$PROOT" || true)"
[ -n "$CHANGE_DIR" ] || exit 0
# 与 skill-tracker 同一开关：完成态证据被禁用的阶段，开始标记也没有意义。
CHANGE_STATE="$(pipeline_state_source "$CHANGE_DIR" || true)"
hook_disabled "$PROOT" skill-tracker "$(yget "$CHANGE_STATE" phase)" && exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
RAW="$(json_escape "Skill: $NAME")"
printf '{"ts":"%s","kind":"tool-start","raw":"%s"}\n' "$TS" "$RAW" >> "$CHANGE_DIR/.pipeline-history.jsonl" 2>/dev/null || true
exit 0
