#!/usr/bin/env bash
# session-start.sh — SessionStart：简短引导 + 三注入（BACKLOG #20）+ 插件资产校验（CONTRACT §5.7）。
#
# 三注入（语义对齐老仓 workflow-enforcer / pipeline-context-injector / openspec-injector 的 lite 化）：
#   ① 宪法：cat templates/workflow.md（相对插件根定位）
#   ② 当前项目 pipeline 上下文：cwd 上溯找 openspec/changes，列活跃 change 的 名字/相位/门状态
#   ③ openspec 目录存在时输出一段使用提示
# Shell 负责 SessionStart envelope 与 fail-open 注入；校验交给 tools/verify-skills.sh，后者的
# canonical provenance 段委托随包 Node CLI。任何一步失败静默跳过、绝不阻断会话，exit 恒 0。
# （fail-open——SessionStart 挂了会拖慢/卡死所有会话，宁可放行）。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

# A successful write here is host evidence that this exact Tenon release actually executed in a
# new SessionStart. The migration-only legacy bridge requires this marker before it removes an old
# plugin registration. It is deliberately user-local, contains no prompt or credential data, and
# never blocks SessionStart.
record_tenon_session_proof() {
  local state_root="${TENON_RUNTIME_STATE_ROOT:-}" release_root="${TENON_ACTIVE_RELEASE_ROOT:-}"
  local release_id="${TENON_ACTIVE_RELEASE_ID:-}" runtime_host="${TENON_RUNTIME_HOST:-}"
  local proof_dir tmp
  [ -n "$state_root" ] && [ -n "$release_root" ] || return 0
  case "$release_id" in sha256-*) ;; *) return 0 ;; esac
  case "${release_id#sha256-}" in *[!0-9a-f]*) return 0 ;; esac
  [ "${#release_id}" -eq 71 ] || return 0
  case "$runtime_host" in codex|claude|adapter|manual) ;; *) return 0 ;; esac
  [ -d "$release_root" ] || return 0
  proof_dir="$state_root/migration"
  umask 077
  mkdir -p "$proof_dir" 2>/dev/null || return 0
  tmp="$proof_dir/.tenon-session-loaded.$$"
  {
    printf 'version=2\n'
    printf 'loaded_at_epoch=%s\n' "$(date +%s 2>/dev/null || printf '0')"
    printf 'host=%s\n' "$runtime_host"
    printf 'release_id=%s\n' "$release_id"
    printf 'release_root=%s\n' "$release_root"
  } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 0; }
  mv "$tmp" "$proof_dir/tenon-session-loaded" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}
record_tenon_session_proof

# Codex treats stdout beginning with `[` or `{` as hook JSON.  The injected workflow context
# intentionally uses bracketed headings, so emitting it as plain stdout makes the host attempt to
# parse a Markdown heading as JSON and fail the whole SessionStart event.  Accumulate the context
# and publish the documented SessionStart envelope exactly once at the end instead.
SESSION_CONTEXT=""
SESSION_START_FORMAT="${TENON_SESSION_START_FORMAT:-codex-json}"

append_context() {
  SESSION_CONTEXT="${SESSION_CONTEXT}${1:-}"
}

append_file() { # $1=file $2=max-lines (0 = all)
  local file="$1" max_lines="${2:-0}" line="" count=0
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    SESSION_CONTEXT="${SESSION_CONTEXT}${line}"$'\n'
    count=$((count + 1))
    [ "$max_lines" = "0" ] || [ "$count" -lt "$max_lines" ] || break
  done < "$file"
}

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
if [ -r "$JSON_INPUT_HELPER" ]; then
  # shellcheck source=json-input.sh
  . "$JSON_INPUT_HELPER"
else
  # A verified release always contains the shared helper.  This tiny local path exists only for a
  # partially copied/corrupt payload: SessionStart must still return a valid envelope and basic
  # guidance instead of making Codex reject the entire session hook response.
  pipeline_json_get_string() { return 1; }
  pipeline_json_escape() {
    local value="${1:-}"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//$'\t'/\\t}"
    value="${value//$'\r'/\\r}"
    value="${value//$'\n'/\\n}"
    printf '%s' "$value"
  }
fi
json_escape() { pipeline_json_escape "$1"; }

emit_context() {
  [ -n "$SESSION_CONTEXT" ] || return 0
  case "$SESSION_START_FORMAT" in
    codex-json)
      printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(json_escape "$SESSION_CONTEXT")"
      ;;
    # Adapter shims explicitly request the reusable context body, then translate it into their
    # own native response protocol. This keeps content generation independent from host wire
    # formats and prevents one host's JSON envelope from being nested inside another's context.
    plain) printf '%s' "$SESSION_CONTEXT" ;;
    *) return 0 ;;
  esac
}

json_get() { pipeline_json_get_string "$INPUT" "$1"; }

PLUGIN_ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"
CWD="$(json_get cwd || true)"
[ -z "$CWD" ] && CWD="$PWD"

# Release updates are opt-in (`tenon setup --codex|--claude --auto-update`).  Keep SessionStart
# non-blocking: the helper only claims a once-per-day slot and backgrounds the host marketplace
# refresh; failure remains invisible to the workflow hook and is written to the user-owned log.
AUTO_UPDATE="$PLUGIN_ROOT/hooks/auto-update.sh"
[ -x "$AUTO_UPDATE" ] && "$AUTO_UPDATE" "$PLUGIN_ROOT" >/dev/null 2>&1 || true

# ── 项目根定位：只接受 cwd、显式根或 Git worktree 根，绝不从共同父目录借 OpenSpec。──
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
OS_ROOT=""
if [ -r "$ROOT_HELPER" ]; then
  # shellcheck source=project-root.sh
  . "$ROOT_HELPER"
  OS_ROOT="$(pipeline_project_root "$CWD" existing openspec || true)"
fi

# 顶层键提取：grep 首个 '^key: '，剥一层首尾同款引号（同 statusline.sh yget，单层去引号契约）
STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
if [ -r "$STATE_HELPER" ]; then
  . "$STATE_HELPER"
else
  pipeline_state_source() { [ -f "$1/.pipeline.yaml" ] && printf '%s' "$1/.pipeline.yaml"; }
  pipeline_state_get() { local v; v="$(grep -m1 "^$2: " "$1" 2>/dev/null || true)"; v="${v#"$2: "}"; case "$v" in '"'*'"') v="${v#\"}"; v="${v%\"}" ;; "'"*"'") v="${v#\'}"; v="${v%\'}" ;; esac; printf '%s' "$v"; }
fi
yget() { pipeline_state_get "$1" "$2"; }

# A review marker is a v2 projection of a canonical request, not a global "currently in review"
# badge.  Session context therefore shows it only when it belongs to the explicitly selected live
# Change; legacy entry-time markers and another Change's request cannot leak into a new dialog.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
REVIEW_HELPER="$HOOK_DIR/review-ack.sh"
if [ -r "$REVIEW_HELPER" ]; then
  # shellcheck source=review-ack.sh
  . "$REVIEW_HELPER"
fi

review_marker_for_active_change() { # $1=marker
  local marked active
  [ -r "$REVIEW_HELPER" ] || return 1
  pipeline_review_marker_is_v2 "$1" || return 1
  marked="$(pipeline_review_marker_change "$1" || true)"
  [ -n "$marked" ] || return 1
  active="$(pipeline_review_active_change_name "$OS_ROOT" "$HOOK_DIR" || true)"
  [ -n "$active" ] && [ "$active" = "$marked" ]
}

# 阶段×hook 开关（v5 T5 / 决议#2）：读 <项目根>/.pipeline/hooks.json（server 写端点落盘，
# canonical 一键一行 `"<hook>.<阶段>": false`，只存禁用项，见 packages/server/src/hooksConfig.ts）。
# 纯 bash（SessionStart 低频但仍守 §5.4 红线：零解释器/外部 JSON 解析器 spawn）：grep -F 定长匹配即可判定；
# 缺文件/缺键/手改格式漂移/损坏 JSON → 一律 fail-open 到启用（行为与本配置诞生之前完全一致）。
# gate.sh 交互门与 interactive-skill-gate.sh 安全门强制常开：不读本配置（server 写端点也拒绝这两个 id）。
hook_disabled() { # $1=项目根 $2=hook id $3=阶段 → 0=该阶段已禁用
  [ -n "$1" ] && [ -n "$3" ] || return 1
  grep -Fq "\"$2.$3\": false" "$1/.pipeline/hooks.json" 2>/dev/null
}

# 当前阶段只用于 SessionStart 开关与 AFK 静态提示，取 mtime 最新的非归档 change；它不是
# 会话绑定，真实恢复必须由 UserPromptSubmit 的明确意图判定。
# 同一趟顺手判定 v6 T5 AFK 首跑提示命中（活跃 change 的 automation 字段非 off/空）——复用本循环已在
# 做的文件遍历/archived 判断，不另起第二趟目录扫描（T5 TDD 要求③「无新增子进程 spawn」：另起一趟
# 会让本函数 stat/grep 调用数翻倍，实测在 40-change 项目上耗时从 ~0.65s 升到 ~0.96s，故合并进本循环）。
SS_PHASE=""
SS_AFK_HIT=""
[ -n "$OS_ROOT" ] && [ -f "$OS_ROOT/.pipeline/automation.json" ] && SS_AFK_HIT=1
if [ -n "$OS_ROOT" ] && [ -d "$OS_ROOT/openspec/changes" ]; then
  SS_BEST=0
  # 当前用户的归档记录：两趟扫描共用一次解析（与 archived=true 同等跳过）。
  SS_ARCHIVE_HELPER="$HOOK_DIR/task-archive.sh"
  # shellcheck source=task-archive.sh
  [ -r "$SS_ARCHIVE_HELPER" ] && . "$SS_ARCHIVE_HELPER"
  declare -F pipeline_change_archived_for_user >/dev/null 2>&1 || pipeline_change_archived_for_user() { return 1; }
  SS_ARCHIVE_STORE=""
  declare -F pipeline_task_archive_store >/dev/null 2>&1 && SS_ARCHIVE_STORE="$(pipeline_task_archive_store "$OS_ROOT" || true)"
  for change_dir in "$OS_ROOT"/openspec/changes/*; do
    [ -d "$change_dir" ] || continue
    f="$(pipeline_state_source "$change_dir" || true)"
    [ -n "$f" ] || continue
    [ "$(yget "$f" archived)" = "true" ] && continue
    pipeline_change_archived_for_user "$SS_ARCHIVE_STORE" "${change_dir##*/}" && continue
    # GNU `stat -f` 是文件系统状态模式（非 mtime），先试 GNU 语法（-c）+ 数字校验兜底（同各 hook）。
    mt="$(stat -c %Y "$f" 2>/dev/null)"
    case "$mt" in ''|*[!0-9]*) mt="$(stat -f %m "$f" 2>/dev/null)" ;; esac
    case "$mt" in ''|*[!0-9]*) mt=0 ;; esac
    if [ "$mt" -ge "$SS_BEST" ]; then SS_BEST="$mt"; SS_PHASE="$(yget "$f" phase)"; fi
    if [ -z "$SS_AFK_HIT" ]; then
      case "$(yget "$f" automation)" in
        ''|off) ;;
        *) SS_AFK_HIT=1 ;;
      esac
    fi
  done
fi
if [ -n "$OS_ROOT" ]; then
  hook_disabled "$OS_ROOT" session-start "$SS_PHASE" && exit 0
fi

# ── 简短引导（一行相位图 + 项目 GOAL.md 头两行，若有）──
append_context $'Tenon：7-phase 流水线已加载：open → explore → spec → build ⇄ verify → ship → archive。状态操作一律走 tenon CLI（status / get / set / transition / check），编排入口 skill：tenon。\n'
if [ -f "$CWD/GOAL.md" ]; then
  append_file "$CWD/GOAL.md" 2
fi

# ── 注入①：工作流宪法（templates/workflow.md，相对插件根；缺文件静默跳过）──
WF="$PLUGIN_ROOT/templates/workflow.md"
if [ -f "$WF" ]; then
  append_context $'\n[tenon 宪法 — '
  append_context "$WF"
  append_context $']\n'
  append_file "$WF"
  append_context $'[宪法完]\n'
fi

# ── 注入②：当前项目 pipeline 上下文（OS_ROOT/yget 已在文件头定位/定义，开关判定同源复用）──
if [ -n "$OS_ROOT" ] && [ -d "$OS_ROOT/openspec/changes" ]; then
  # 活跃 change 列表（archived != true）
  CTX=""
  for change_dir in "$OS_ROOT"/openspec/changes/*; do
    [ -d "$change_dir" ] || continue
    f="$(pipeline_state_source "$change_dir" || true)"
    [ -n "$f" ] || continue
    [ "$(yget "$f" archived)" = "true" ] && continue
    name="$(basename "$change_dir")"
    pipeline_change_archived_for_user "${SS_ARCHIVE_STORE:-}" "$name" && continue
    phase="$(yget "$f" phase)"
    track="$(yget "$f" track)"
    # 已确认、还没转换的评审回执：说清它已确认，别让模型再去索要「确认继续」（真机第四轮）。
    # 回执字段只在 .pipeline.yaml 投影里（canonical hookState 不带它们，同 review-ack.sh）。
    review_note=""
    if [ -f "$change_dir/.pipeline.yaml" ] \
      && [ "$(yget "$change_dir/.pipeline.yaml" review_gate_status)" = "approved" ] \
      && [ "$(yget "$change_dir/.pipeline.yaml" review_gate_phase)" = "$phase" ]; then
      review_note="；评审已确认（$(yget "$change_dir/.pipeline.yaml" review_gate_event)），照 tenon status ${name} --json 的 next transition"
    fi
    CTX="${CTX}  - ${name}（track=${track:-?}, phase=${phase:-?}${review_note}）
"
  done
  # 新鲜门 marker → 等:<kind>。TTL 分级同 gate.sh / types.ts GATE_TTL_MS（BACKLOG #13，
  # 对齐老内核：confirm 300s / review·interaction 1800s；边界 age ≤ TTL 仍新鲜）。
  GATES=""
  now="$(date +%s)"
  for kind in confirm review interaction; do
    m="$OS_ROOT/.pipeline-pending-$kind"
    [ -f "$m" ] || continue
    if [ "$kind" = review ]; then
      review_marker_for_active_change "$m" || continue
      # 回执已确认（approved）时 marker 只是残留投影，不是待处理的门。
      review_yaml="$OS_ROOT/openspec/changes/$(pipeline_review_marker_change "$m" || true)/.pipeline.yaml"
      [ -f "$review_yaml" ] && [ "$(yget "$review_yaml" review_gate_status)" = "approved" ] && continue
    fi
    case "$kind" in confirm) ttl=300 ;; *) ttl=1800 ;; esac
    # GNU `stat -f` 是文件系统状态模式（非 mtime），在 Linux 上会"成功"吐非数字，兜底永不触发
    # ——先试 GNU 语法（-c）+ 数字校验，而非只靠退出码判断。
    mt="$(stat -c %Y "$m" 2>/dev/null)"
    case "$mt" in ''|*[!0-9]*) mt="$(stat -f %m "$m" 2>/dev/null)" ;; esac
    case "$mt" in ''|*[!0-9]*) mt="$now" ;; esac
    [ $((now - mt)) -le "$ttl" ] && GATES="$GATES 等:$kind"
  done
  if [ -n "$CTX" ]; then
    append_context $'\n[Tenon 上下文 — '
    append_context "$OS_ROOT"
    append_context $'] 活跃 change：\n'
    append_context "$CTX"
    if [ -n "$GATES" ]; then
      append_context '  待处理交互门：'
      append_context "${GATES# }"
      append_context $'（会话开始时仍存在的 marker；写类工具会被 gate.sh 拦。等:review 由用户回复确认〔「确认继续」「继续执行」「继续」「可以」「按推荐」等〕解封，其余先 AskUserQuestion。之后以 tenon status <change> --json 的 step.review 为准）\n'
    fi
    append_context $'  上述均为恢复候选，未与本会话自动绑定；只有用户明确说“继续 <change>”或点名 change 才恢复。新目标会独立从 open 创建。\n'
  fi
fi

# ── 注入③：openspec 使用提示（openspec 目录存在才输出）──
if [ -n "$OS_ROOT" ]; then
  append_context $'\n[openspec 提示] 本项目使用 openspec：change 唯一状态在 openspec/changes/<name>/.pipeline-run/current.json，.pipeline.yaml 仅兼容投影（两者均勿手改，走 tenon CLI）；主 spec 在 openspec/specs/<capability>/spec.md，动某能力前先 Read 对应 spec；归档产物沉在 openspec/changes/archive/。\n'
fi

# ── v6 T5 / full-install 批2 P2-T2：AFK 首跑 + 技能就绪提示（轻量静态提示，不做真探测）──
#    SS_AFK_HIT 已在文件头「当前阶段」循环里顺手判定（.pipeline/automation.json 存在，或活跃 change 的
#    automation 字段非 off/空）；此处只管输出。刻意不做任何 docker/凭证/技能真探测——SessionStart
#    零阻断纪律下探测可能挂起（守零 spawn，只改文案不加探测）。指向 dashboard 就绪三灯（GET
#    /api/afk/readiness，v6 T4）**并**指向 `tenon doctor`——批2 A1 已给 doctor 补上缺技能检测与
#    保障生效面，v6 计划附录矛盾登记 1 的取舍在本批已消解，故回改指向该命令。
[ -n "$SS_AFK_HIT" ] && append_context $'\n[tenon] 检测到 AFK 自动化配置：AFK 就绪状态见 dashboard（就绪三灯）；技能齐全度/保障生效面跑 tenon doctor 核对。\n'

# ── 插件资产校验（fail-open：失败仅警告）──
VS="$PLUGIN_ROOT/tools/verify-skills.sh"
if [ -f "$VS" ]; then
  if ! bash "$VS" --quiet --root "$PLUGIN_ROOT" 1>&2; then
    printf '[tenon] 警告：插件资产校验未通过（存在悬空引用，明细见上；复跑：bash %s）。会话不阻断，但请尽快修复。\n' "$VS" >&2
  fi
else
  printf '[tenon] 警告：未找到 %s，跳过插件资产校验（CONTRACT §5.7 要求安装期校验）。\n' "$VS" >&2
fi

emit_context
exit 0
