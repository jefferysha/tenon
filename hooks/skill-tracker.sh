#!/usr/bin/env bash
# skill-tracker.sh — PostToolUse hook（all tools; script-side narrow filter）。
#
# Skill 工具被调用且 pipeline 已明确选择一个 change 时，把该次调用 append 进
#   openspec/changes/<name>/.pipeline-history.jsonl（一行一个 JSON，CONTRACT §1）——
# kind=tool、raw="Skill: <skill 名>"（Claude first-class skill）或
# "CodexSkillRead: <skill 名>"（Codex host-observed bundled SKILL.md read）。二者绝不混称；
# 后者只接受当前插件根的只读 SKILL.md 命令，供文档账本和自定义 workflow skill DAG 审计。
# 兼容旁挂：若日后 matcher 扩到 Agent/Task，按 subagent_type 记 raw="<Tool>: <name>"（防御性，不改行为）。
#
# 纯 bash 热路径（CONTRACT §5.4：PostToolUse 每次工具后触发）：零解释器 / 外部 JSON 解析器 spawn，
# stdin JSON 只用 bash 字符串提取所需键。fire & forget：非目标工具 / 无活跃 change / 异常 → exit 0。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }
json_command() { pipeline_json_get_command "$INPUT"; }
# JSON 字符串体转义（单行合法 JSON）——skill 名一般无特殊字符，仍防御性转义防写坏 JSONL
json_escape() { pipeline_json_escape "$1"; }

STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
if [ -r "$STATE_HELPER" ]; then
  . "$STATE_HELPER"
else
  pipeline_state_source() { [ -f "$1/.pipeline.yaml" ] && printf '%s' "$1/.pipeline.yaml"; }
  pipeline_state_get() { local v; v="$(grep -m1 "^$2: " "$1" 2>/dev/null || true)"; v="${v#"$2: "}"; case "$v" in '"'*'"') v="${v#\"}"; v="${v%\"}" ;; "'"*"'") v="${v#\'}"; v="${v%\'}" ;; esac; printf '%s' "$v"; }
fi
yget() { pipeline_state_get "$1" "$2"; }

# 阶段×hook 开关（v5 T5 / 决议#2）：读 <项目根>/.pipeline/hooks.json（server 写端点落盘，
# canonical 一键一行 `"<hook>.<阶段>": false`，只存禁用项，见 packages/server/src/hooksConfig.ts）。
# 纯 bash 热路径（CONTRACT §5.4：零解释器/外部 JSON 解析器 spawn）：grep -F 定长匹配即可判定；缺文件/缺键/
# 手改格式漂移/损坏 JSON → 一律 fail-open 到启用（行为与本配置诞生之前完全一致）。
# gate.sh 交互门与 interactive-skill-gate.sh 安全门强制常开：不读本配置（server 写端点也拒绝这两个 id）。
hook_disabled() { # $1=项目根 $2=hook id $3=阶段 → 0=该阶段已禁用
  [ -n "$1" ] && [ -n "$3" ] || return 1
  grep -Fq "\"$2.$3\": false" "$1/.pipeline/hooks.json" 2>/dev/null
}

CWD="$(json_get cwd || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0

TOOL="$(json_get tool_name || true)"
RAW_TOOL="$TOOL"
NAMES=""
case "$TOOL" in
  Skill)
    NAMES="$(json_get skill || true)"
    ;;
  Agent|Task)
    NAMES="$(json_get subagent_type || true)"
    ;;
  *)
    pipeline_json_is_command_tool "$TOOL" || exit 0
    # Only a command naming a SKILL.md can be a skill read; skip decoding every other (possibly huge) one.
    case "$INPUT" in *SKILL.md*) ;; *) exit 0 ;; esac
    EVIDENCE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/skill-evidence.sh"
    [ -r "$EVIDENCE_HELPER" ] || exit 0
    # shellcheck source=skill-evidence.sh
    . "$EVIDENCE_HELPER"
    COMMAND="$(json_command || true)"
    # Codex can read several packaged SKILL.md files inside one completed exec.  Preserve every
    # trusted id so a later phase cannot lose a document/DAG receipt merely because it was second.
    NAMES="$(pipeline_codex_skill_read_ids "$COMMAND" || true)"
    RAW_TOOL="CodexSkillRead"
    ;;
esac
[ -z "$NAMES" ] && exit 0

# ── 定位已选择 change：根边界由共享 helper 统一，绝不按 mtime 借用旧 Change。──
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
[ -r "$ROOT_HELPER" ] || exit 0
# shellcheck source=project-root.sh
. "$ROOT_HELPER"
PROOT="$(pipeline_project_root "$CWD" existing changes || true)"
[ -n "$PROOT" ] || exit 0
[ -r "$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh" ] || exit 0
# shellcheck source=active-change.sh
. "$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
CHANGE_DIR="$(pipeline_active_change_dir "$PROOT" || true)"
[ -n "$CHANGE_DIR" ] || exit 0

# ── 阶段×hook 开关（v5 T5 / 决议#2）：当前 change 阶段被配置禁用 → 零副作用退出 ──
CHANGE_STATE="$(pipeline_state_source "$CHANGE_DIR" || true)"
hook_disabled "$PROOT" skill-tracker "$(yget "$CHANGE_STATE" phase)" && exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
SESSION_ID="$(json_get session_id || true)"
TOOL_USE_ID="$(json_get tool_use_id || true)"
CHANGE_NAME="${CHANGE_DIR##*/}"
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd -P || true)"
BUNDLE="$PLUGIN_ROOT/packages/cli/dist/tenon.mjs"
while IFS= read -r NAME; do
  [ -n "$NAME" ] || continue
  RAW="$(json_escape "$RAW_TOOL: $NAME")"
  printf '{"ts":"%s","kind":"tool","raw":"%s"}\n' "$TS" "$RAW" >> "$CHANGE_DIR/.pipeline-history.jsonl" 2>/dev/null || true
  # A native Skill PostToolUse is the start of the governed skill application. Seal its host
  # identity and canonical StepVisit synchronously so later question and document events can bind
  # the same invocation. Bare history remains compatibility-only and can never mint completion.
  if [ "$RAW_TOOL" = "Skill" ] && [ -n "$SESSION_ID" ] && [ -n "$TOOL_USE_ID" ] \
    && command -v node >/dev/null 2>&1 && [ -f "$BUNDLE" ]; then
    (
      cd "$PROOT" || exit 0
      node "$BUNDLE" internal-native-skill-receipt \
        "$CHANGE_NAME" "$NAME" "$SESSION_ID" "$TOOL_USE_ID" "$TS"
    ) >/dev/null 2>&1 || true
  fi
done <<< "$NAMES"

exit 0
