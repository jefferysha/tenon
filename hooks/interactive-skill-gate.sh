#!/usr/bin/env bash
# interactive-skill-gate.sh — PostToolUse hook（all tools; script-side narrow filter）。
#
# 让「交互式 skill」加载后强制守 L2.6 交互硬姿态：任何 gap / 分支 / 模糊点一律转成
# AskUserQuestion 问用户、批量问、迭代到清零，禁止自行假设糊弄。
#
# 机制（为什么 PostToolUse 而非 PreToolUse-block，对齐老仓 interactive-skill-gate.sh）：
#   交互式 skill 的「该问哪些问题 / 有哪些分支」写在 skill 内容里，必须先让它正常加载模型才知道要问什么。
#   故这里*不* block 加载，而是 skill 一加载完就双保险：
#     ① 软提醒：把 L2.6 硬姿态当 additionalContext 注入（non-blocking）——每轮重提，治长会话漂移。
#     ② 硬门：落 .pipeline-pending-interaction marker（gate.sh 在后续写类工具前物理挡住；
#        AskUserQuestion / Codex request_user_input 是唯一允许通过的询问工具），由其回答后的
#        confirm-clear 解封——形成「先问用户才放行」闭环。
#
# 中心清单（单一真相源）：lite manifest（templates/manifest.yaml，kernel-flow 所有）尚无
#   interactive_skills 字段且本 hook 无权改它，故清单内联在此（老仓原清单：manifest.yaml
#   interactive_skills: [brainstorming, grill-with-docs, prototype, huashu-design]）。新增交互式
#   skill 只改下面一处。plugin 前缀（superpowers: 等）自动剥离比对，裸名也命中。
#   grilling 是 default 流程里真正跑那场盘问的 skill；grill-with-docs 只是它的人工入口包装
#   （带 disable-model-invocation，不进强制表）。两者都留在清单里，自动与人工两条路同受这道硬门。
#
# 纯 bash 热路径（CONTRACT §5.4：PostToolUse 每次工具后触发）：零解释器 / 外部 JSON 解析器 spawn。
# fail-safe：非 Skill / 不在清单 / 解析异常 → 一律 exit 0 放行，绝不打断。
set -uo pipefail

# === 中心清单（内联单一真相源；空格分隔）===
INTERACTIVE_SKILLS="brainstorming grilling grill-with-docs prototype huashu-design"

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }
json_command() { pipeline_json_get_command "$INPUT"; }
json_escape() { pipeline_json_escape "$1"; }

TOOL="$(json_get tool_name || true)"
SKILLS=""
case "$TOOL" in
  Skill)
    SKILLS="$(json_get skill || true)"
    ;;
  *)
    pipeline_json_is_command_tool "$TOOL" || exit 0
    EVIDENCE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/skill-evidence.sh"
    [ -r "$EVIDENCE_HELPER" ] || exit 0
    # shellcheck source=skill-evidence.sh
    . "$EVIDENCE_HELPER"
    COMMAND="$(json_command || true)"
    SKILLS="$(pipeline_codex_skill_read_ids "$COMMAND" || true)"
    ;;
esac
[ -z "$SKILLS" ] && exit 0

# plugin 前缀（superpowers:brainstorming）→ 取冒号后末段比对；裸名也命中。一个 Codex
# exec 可能同时读到普通和交互式 skill，因此必须检查全部受信任读取，不能只看第一个。
MATCHED=""
while IFS= read -r SKILL; do
  [ -n "$SKILL" ] || continue
  SKILL_BASE="${SKILL##*:}"
  MATCH=0
  for s in $INTERACTIVE_SKILLS; do
    if [ "$SKILL_BASE" = "$s" ] || [ "$SKILL" = "$s" ]; then MATCH=1; break; fi
  done
  [ "$MATCH" -eq 1 ] || continue
  if [ -z "$MATCHED" ]; then
    MATCHED="$SKILL"
  else
    MATCHED="${MATCHED}"$'\n'"$SKILL"
  fi
done <<< "$SKILLS"
[ -n "$MATCHED" ] || exit 0
MATCHED_DISPLAY="${MATCHED//$'\n'/、}"

# === 硬门：落 .pipeline-pending-interaction（供 gate.sh 在写类工具前挡产出；人类提问工具精确放行）===
CWD="$(json_get cwd || true)"
[ -z "$CWD" ] && CWD="$PWD"
HOST_SESSION_ID="$(json_get session_id || true)"
case "$HOST_SESSION_ID" in ''|*[!A-Za-z0-9_-]*) HOST_SESSION_ID='' ;; esac
[ "${#HOST_SESSION_ID}" -le 128 ] || HOST_SESSION_ID=''
# 必须与 gate.sh 选到同一项目根。旧代码把 marker 写进子目录，gate 却在项目根读，导致
# 交互式 skill 的硬门悄然失效；共享 helper 同时避免跨普通父目录误写别的项目。
ROOT="$CWD"
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
if [ -r "$ROOT_HELPER" ]; then
  # shellcheck source=project-root.sh
  . "$ROOT_HELPER"
  ROOT="$(pipeline_project_root "$CWD" bootstrap changes || true)"
fi

# A user can explicitly authorise continuous execution for the selected live Change.  This narrow
# projection suppresses the repeat interaction marker caused by loading an interactive skill and
# records a possible delegated review acknowledgement.  Review evidence, phase guards,
# verification, publication and all ordinary gate semantics remain mandatory. Missing/malformed
# state deliberately falls back to the normal hard gate.
AUTONOMOUS=0
ACTIVE_CHANGE=''
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
AUTHORITY_HELPER="$HOOK_DIR/interaction-authority.sh"
STATE_HELPER="$HOOK_DIR/canonical-state.sh"
ACTIVE_HELPER="$HOOK_DIR/active-change.sh"
if [ -n "$ROOT" ] && [ -d "$ROOT" ] && [ -r "$AUTHORITY_HELPER" ] && [ -r "$STATE_HELPER" ] && [ -r "$ACTIVE_HELPER" ]; then
  # shellcheck source=interaction-authority.sh
  . "$AUTHORITY_HELPER"
  # shellcheck source=canonical-state.sh
  . "$STATE_HELPER"
  # shellcheck source=active-change.sh
  . "$ACTIVE_HELPER"
  ACTIVE_DIR="$(pipeline_active_change_dir "$ROOT" || true)"
  ACTIVE_CHANGE="${ACTIVE_DIR##*/}"
  if [ -n "$ACTIVE_DIR" ] \
    && pipeline_interaction_authority_for_change "$ROOT" "$ACTIVE_CHANGE" "$HOST_SESSION_ID"; then
    AUTONOMOUS=1
  fi
fi

# An interactive skill asks the user once per step visit. A later read of a skill the user already
# confirmed since entering this step (Codex re-reads a producer skill to record its document) must
# not lock the same decision again; a new visit to the step asks again. Pure bash on this hot path;
# missing state keeps the gate.
if [ "$AUTONOMOUS" -eq 0 ] && [ -n "${ACTIVE_DIR:-}" ] && [ -f "$ACTIVE_DIR/.pipeline-history.jsonl" ]; then
  ACTIVE_PHASE="$(pipeline_state_get "$(pipeline_state_source "$ACTIVE_DIR" || true)" phase 2>/dev/null || true)"
  if [ -n "$ACTIVE_PHASE" ]; then
    CONFIRMED_IN_VISIT=$'\n'
    while IFS= read -r HISTORY_LINE; do
      case "$HISTORY_LINE" in
        *'"kind":"transition"'*)
          case "$HISTORY_LINE" in *"\"to\":\"$ACTIVE_PHASE\""*) CONFIRMED_IN_VISIT=$'\n' ;; esac
          ;;
        *'"raw":"InteractionConfirmed: '*)
          CONFIRMED_SKILL="${HISTORY_LINE#*\"raw\":\"InteractionConfirmed: }"
          CONFIRMED_SKILL="${CONFIRMED_SKILL%%\"*}"
          CONFIRMED_IN_VISIT="${CONFIRMED_IN_VISIT}${CONFIRMED_SKILL##*:}"$'\n'
          ;;
      esac
    done < "$ACTIVE_DIR/.pipeline-history.jsonl"
    UNCONFIRMED=''
    while IFS= read -r SKILL; do
      [ -n "$SKILL" ] || continue
      case "$CONFIRMED_IN_VISIT" in *$'\n'"${SKILL##*:}"$'\n'*) continue ;; esac
      UNCONFIRMED="${UNCONFIRMED:+$UNCONFIRMED$'\n'}$SKILL"
    done <<< "$MATCHED"
    MATCHED="$UNCONFIRMED"
    MATCHED_DISPLAY="${MATCHED//$'\n'/、}"
    [ -n "$MATCHED" ] || exit 0
  fi
fi

if [ "$AUTONOMOUS" -eq 0 ]; then
  [ -n "$ROOT" ] && [ -d "$ROOT" ] && printf '%s\n' "$MATCHED_DISPLAY" > "$ROOT/.pipeline-pending-interaction" 2>/dev/null || true
fi

# === 软提醒：注入 L2.6 交互硬姿态（additionalContext，non-blocking）===
if [ "$AUTONOMOUS" -eq 1 ]; then
  CTX="$(cat <<EOF
【交互式 skill 自主执行授权 · Change=${ACTIVE_CHANGE} · host_session=${HOST_SESSION_ID} · 由 interactive-skill-gate 注入】
当前用户已明确授权当前 Change 连续执行。请完整执行刚加载的交互式 skill「${MATCHED_DISPLAY}」，采用保守、
可撤销、可审计的默认；把所有非硬性假设及其理由写入本阶段产物的 Assumptions/Decision Log。
这项授权允许在 review 产物、OpenSpec 文档读取收据和 phase guard 都真实通过后，使用
`tenon review acknowledge <change> --delegated` 留下可审计的委托确认；它不可跳过任何证据、
guard、验证、发布确认或任何外部副作用的独立边界。遇到会改变范围、安全、成本或外部状态的实质性
不确定性，暂停并明确报告；其余低风险细节按项目现状和既有规范推进。
EOF
)"
else
  CTX="$(cat <<EOF
【交互式 skill 硬姿态 · L2.6 · 由 interactive-skill-gate 注入】
你刚加载了交互式 skill「${MATCHED_DISPLAY}」。在产出任何东西、做任何分支/方案选择前，必须守住：
1. 任何分歧 / 分支选择 / gap / 模糊点 → 一律转成问题，用 AskUserQuestion 问用户，禁止自行假设糊弄（推荐答案放第一项标「(推荐)」+ 真实备选，别埋进散文求盖章）。
2. 当前能看到的 gap 一次性批量问（一次 ≤4 问，多了连发几轮）；用户答完重扫一遍，还有没清的（含答案引出的新 gap）就再来一轮——gap 清零才算这一步完成。别问 2 个就收、别挤牙膏。
3. 上游标「需立即澄清 / 高风险」的决断必须当场逼出明确答案，不许「都要 / 先这样 / 双边」糊弄收场。
4. 只有用户确实不在场、无法回答时，才退回按周边代码/上下文推断，并把所做假设写在产出顶部显式标注。
（本提醒对内联清单内所有交互式 skill 统一生效；交互后用 AskUserQuestion 即由 confirm-clear 解封 interaction 门。）
EOF
)"
fi

printf '{"additionalContext":"%s"}\n' "$(json_escape "$CTX")"
exit 0
