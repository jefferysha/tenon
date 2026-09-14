#!/usr/bin/env bash
# gate.sh — PreToolUse 统一交互门（lite 版，语义对齐老内核 pipeline-gate.sh）。
#
# 机制：项目根存在新鲜（TTL 分级，CONTRACT §2 / types.ts GATE_TTL_MS）的
#   .pipeline-pending-{confirm,review,interaction} 任一 marker → 对产出类工具 exit 2 + stderr 中文指引；
#   原生人类提问工具 AskUserQuestion / request_user_input 是唯一例外：它们只负责把决策交给用户，
#   不会绕过 marker 或写入产出；无 marker / 陈旧（顺手清掉）→ exit 0。
# TTL 分级（BACKLOG #13，对齐老内核 pipeline-gate.sh，勿改回统一值）：
#   - confirm 300s：正常流程同轮 AskUserQuestion 即清（秒级），300s 只是「漏确认」安全网。
#   - review / interaction 1800s：跨整个决策 phase（常 >5min），缩短会中途误清 → 绕过强制复核。
# marker 只从当前项目根读取：Git worktree / 显式 TENON_PROJECT_ROOT / 当前 cwd 三者之一。
#   绝不从普通父目录猜测项目根，避免共享 /tmp 下的外部 Change 拦截无关会话。
# 纯 bash 热路径（CONTRACT §5.4）：不 spawn 任何解释器/外部 JSON 解析器，
#   stdin JSON 只用 bash 字符串提取所需两键（cwd / tool_name）。
# 例外（Task 9，GOAL 清单 E）：非 default workflow 的 change 调用 Claude Skill 工具，或 Codex
#   读取当前插件内 SKILL.md 时，文件尾段委托 `node .../tenon.mjs internal-skill-gate` 做 skill DAG
#   解锁判定——这是本文件唯一会 spawn 解释器的分支。默认 workflow / 无活跃 change / 非技能读取
#   三者任一成立就直接跳过 node；Codex 读取证据与 Claude Skill 事件保持语义等价但记账类型不同。
# fail-open（绝不死锁）：stdin 解析失败 / cwd 不存在 / 任何异常 → 放行 exit 0。
# 强制常开（v5 T5 / 决议#2）：本交互门与 interactive-skill-gate.sh 安全门**不读**
#   .pipeline/hooks.json 阶段×hook 开关矩阵——配置里手写 "gate.<阶段>": false 一律无效
#   （server 写端点同样拒绝这两个 id），防误配置/AFK 把安全约束关掉；其余 hook 的开关
#   接线见 router.sh / breadcrumb.sh / skill-tracker.sh / session-start.sh 的 hook_disabled。
set -uo pipefail

# AFK 逃生门（BACKLOG #7b，对齐老内核沙箱放行语义）：headless 自动化（Docker/CI）里
# 无人应答 AskUserQuestion，三门必死锁——显式 TENON_AFK=1 时整门放行；
# 不清 marker（人回来时门还在）。仅字面 "1" 生效，其它值一律不放行。
[ "${TENON_AFK:-}" = "1" ] && exit 0

INPUT="$(cat 2>/dev/null || printf '{}')"

# All realtime hooks use the same escape-aware parser. This keeps Codex's quoted
# `command_execution.command` and `exec.cmd` payloads on the exact same path as regular events.
JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }
json_command() { pipeline_json_get_command "$INPUT"; }

# Every host spells the working directory differently (flat `cwd`, Cursor `workspace_roots`,
# Cline `workspaceRoots`, Amp `workspaceRoot`); normalise them all before falling back to $PWD.
# The fallback is the dangerous branch: the hook process cwd is usually not the project root, so a
# missed shape resolves no marker and this gate returns a *normal* allow — which no host-side
# `failClosed` can catch, because nothing crashed.
CWD="$(pipeline_json_get_cwd "$INPUT" || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0
TOOL="$(json_get tool_name || true)"
[ -z "$TOOL" ] && TOOL="?"

# Marker 与 active Change 都只能落在当前 Git/显式项目根。marker 可能在 OpenSpec Change
# 创建前就存在，因此这里用 bootstrap 根；该模式只返回 Git 根或 cwd 自身，绝不扫描普通父目录。
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
TENON_ROOT=""
if [ -r "$ROOT_HELPER" ]; then
  # shellcheck source=project-root.sh
  . "$ROOT_HELPER"
  TENON_ROOT="$(pipeline_project_root "$CWD" bootstrap changes || true)"
fi

# yget：读 canonical hookState；current 从未出现时才兼容 YAML 顶层 key——逐字复用
# hooks/router.sh / hooks/skill-tracker.sh 同名函数，本文件之前不需要读状态字段，
# Task 9（非 default workflow 的 skill DAG 判定）新增才要用。
STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
if [ -r "$STATE_HELPER" ]; then
  . "$STATE_HELPER"
else
  pipeline_state_source() { [ -f "$1/.pipeline.yaml" ] && printf '%s' "$1/.pipeline.yaml"; }
  pipeline_state_get() { local v; v="$(grep -m1 "^$2: " "$1" 2>/dev/null || true)"; v="${v#"$2: "}"; case "$v" in '"'*'"') v="${v#\"}"; v="${v%\"}" ;; "'"*"'") v="${v#\'}"; v="${v%\'}" ;; esac; printf '%s' "$v"; }
fi
yget() { pipeline_state_get "$1" "$2"; }

# marker 新鲜？存在且 age ≤ TTL（第 2 参，秒；缺省 1800）→ 0；陈旧（age > TTL）→ 清掉并 1；不存在 → 1。
# 边界与老内核 fresh() 一致：-gt 才陈旧（age == TTL 仍新鲜）。TTL 值同 types.ts GATE_TTL_MS。
fresh() {
  local m="$1" ttl="${2:-1800}" now mt
  [ -f "$m" ] || return 1
  now="$(date +%s)"
  # GNU `stat -f` 是「文件系统状态」模式（%m=挂载点字符串），非文件 mtime——在 Linux 上会
  # "成功"但吐非数字，导致 || 兜底永不触发。先试 GNU 语法（-c，BSD stat 不识别该 flag 会真
  # 报错退出）+ 数字校验兜底，而非只靠退出码判断（真机 Linux CI 抓出，本机 macOS 测不出）。
  mt="$(stat -c %Y "$m" 2>/dev/null)"
  case "$mt" in ''|*[!0-9]*) mt="$(stat -f %m "$m" 2>/dev/null)" ;; esac
  case "$mt" in ''|*[!0-9]*) mt="$now" ;; esac
  if [ $((now - mt)) -gt "$ttl" ]; then
    rm -f "$m" 2>/dev/null
    return 1
  fi
  return 0
}

# marker 只从已验证项目根读取，返回找到的路径（stdout），找不到返回 1。
resolve_marker() {
  local base="$1"
  [ -n "$TENON_ROOT" ] && [ -f "$TENON_ROOT/$base" ] || return 1
  printf '%s' "$TENON_ROOT/$base"
}

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
REVIEW_HELPER="$HOOK_DIR/review-ack.sh"
if [ -r "$REVIEW_HELPER" ]; then
  # shellcheck source=review-ack.sh
  . "$REVIEW_HELPER"
fi

# A root-level marker used to be written merely by *entering* explore/spec/verify.  v2 marks an
# explicit review request and embeds its exact Change.  Retire legacy projections on sight: their
# old state has no canonical receipt, while transition now independently requires a new receipt to
# leave a review phase.  A v2 marker only applies to the explicitly selected Change, so an old
# review in another conversation cannot lock unrelated normal dialogue.
review_marker_relevant_to_active_change() { # $1=marker → 0=blockable v2 marker
  local marker="$1" marked_change active_change
  [ -r "$REVIEW_HELPER" ] || return 1
  if ! pipeline_review_marker_is_v2 "$marker"; then
    rm -f "$marker" 2>/dev/null || true
    return 1
  fi
  marked_change="$(pipeline_review_marker_change "$marker" || true)"
  if [ -z "$marked_change" ]; then
    rm -f "$marker" 2>/dev/null || true
    return 1
  fi
  active_change="$(pipeline_review_active_change_name "$TENON_ROOT" "$HOOK_DIR" || true)"
  [ -n "$active_change" ] && [ "$active_change" = "$marked_change" ]
}

# Resolve the one product-owned dashboard token path used by the server.  This mirrors
# resolveProductPaths() without asking the hot hook to execute an interpreter.  The inherited
# root contract is checked first because it is the installer-selected source of truth.
pipeline_dashboard_token_path() {
  local state_root=''
  if [ -n "${TENON_RUNTIME_ROOTS:-}" ]; then
    state_root="$(pipeline_json_get_string "$TENON_RUNTIME_ROOTS" stateRoot || true)"
    [ -n "$state_root" ] && { printf '%s/dashboard-token.json' "${state_root%/}"; return 0; }
  fi
  if [ -n "${TENON_RUNTIME_HOME:-}" ]; then
    case "$TENON_RUNTIME_HOME" in /*) printf '%s/state/dashboard-token.json' "${TENON_RUNTIME_HOME%/}"; return 0 ;; esac
  fi
  case "$(uname -s 2>/dev/null || true)" in
    Darwin) [ -n "${HOME:-}" ] && printf '%s/Library/Application Support/tenon/state/dashboard-token.json' "${HOME%/}" ;;
    *)
      state_root="${XDG_STATE_HOME:-${HOME:-}/.local/state}/tenon"
      [ -n "$state_root" ] && printf '%s/dashboard-token.json' "${state_root%/}"
      ;;
  esac
}

pipeline_command_reads_dashboard_token() { # $1=decoded command
  local command="${1:-}" token_path="" command_name=""
  [ -n "$command" ] || return 1
  command="$(pipeline_unwrap_shell_wrapper "$command")"
  pipeline_command_has_shell_metachars "$command" && return 1
  token_path="$(pipeline_dashboard_token_path || true)"
  [ -n "$token_path" ] || return 1
  command_name="${command%% *}"
  case "$command_name" in cat|head|tail|less|more|stat|file|sed|grep|rg) ;; *) return 1 ;; esac
  # The token must be an exact final argument. Quoted paths are required when the product path
  # contains spaces; the unquoted form is accepted only when it is itself one argument.
  case "$command" in
    *"\"$token_path\""|*"'$token_path'"|*" $token_path") return 0 ;;
  esac
  return 1
}

pipeline_command_writes_review_api() { # $1=decoded command
  local command="${1:-}"
  [ -n "$command" ] || return 1
  command="$(pipeline_unwrap_shell_wrapper "$command")"
  pipeline_command_has_shell_metachars "$command" && return 1
  case "$command" in curl\ *|wget\ *) ;; *) return 1 ;; esac
  # GET is deliberately excluded. Explicit mutating method or body flags are required; the
  # endpoint and Change name are then checked as one exact localhost allowlist.
  if [[ "$command" != *' -X POST '* && "$command" != *' --request POST '* \
    && "$command" != *' -X PUT '* && "$command" != *' --request PUT '* \
    && "$command" != *' -X PATCH '* && "$command" != *' --request PATCH '* \
    && "$command" != *' -X DELETE '* && "$command" != *' --request DELETE '* \
    && "$command" != *' --data '* && "$command" != *' --data-raw '* \
    && "$command" != *' --data-binary '* && "$command" != *' -d '* \
    && "$command" != *' --post-data '* && "$command" != *' --post-file '* ]]; then
    return 1
  fi
  [[ "$command" =~ (^|[[:space:]\'\"])(https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/api/change/[A-Za-z0-9_-]+/(decisions|transition)(\?[^[:space:]\'\"]*)?)([[:space:]\'\"]|$) ]]
}

pipeline_record_pending_review_observation() { # $1=change $2=signal kind
  local change="${1:-}" kind="${2:-}" bundle payload identity hook_root
  [ -n "$change" ] && [ -n "$kind" ] || return 0
  hook_root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)}}"
  bundle="$hook_root/packages/cli/dist/tenon.mjs"
  [ -f "$bundle" ] && command -v node >/dev/null 2>&1 || return 0
  payload="$(mktemp "${TMPDIR:-/tmp}/tenon-self-approval.XXXXXX" 2>/dev/null || true)"
  [ -n "$payload" ] || return 0
  identity="hook-parent:${PPID:-unknown};host:${HOSTNAME:-unknown};session:${TENON_HOST_SESSION_ID:-${CODEX_THREAD_ID:-unknown}}"
  printf '{"kind":"%s","process_or_host_identity":"%s"}\n' \
    "$(pipeline_json_escape "$kind")" "$(pipeline_json_escape "$identity")" > "$payload" 2>/dev/null || return 0
  ( cd "$TENON_ROOT" && node "$bundle" internal-self-approval "$change" "$payload" ) >/dev/null 2>&1 || true
  rm -f "$payload" 2>/dev/null || true
}

# Shared metacharacter rejection.  Anything in this set can turn a read or a control command into
# a write (redirection, chaining, substitution), so both allowlists below refuse to match a segment
# that still contains one.
pipeline_command_has_shell_metachars() { # $1=command segment
  case "${1:-}" in
    *$'\n'*|*$'\r'*|*'>'*|*'<'*|*'|'*|*';'*|*'&'*|*'`'*|*'$('*) return 0 ;;
  esac
  return 1
}

# Structural unwrapping only — nothing here is ever evaluated.  Hosts hand the same shell call over
# in several shapes: bare (`tenon …`), wrapped by the login shell (`/bin/zsh -lc "tenon …"`), and
# as a joined argv array (`bash -lc tenon …`, see pipeline_json_get_command).  Peel one wrapper so
# the matcher below sees one canonical command text.
# hooks/skill-evidence.sh has a similar helper on purpose: that one is part of the *evidence* path
# and must stay strict about which read shapes count, so widening it here would widen skill
# evidence acceptance as a side effect.
pipeline_unwrap_shell_wrapper() { # $1=raw command → inner command text (unchanged when not wrapped)
  local command="${1:-}" shell flag prefix inner
  for shell in /bin/zsh /bin/bash /bin/sh zsh bash sh; do
    for flag in -lc -c; do
      prefix="$shell $flag "
      case "$command" in
        "$prefix"*)
          inner="${command#"$prefix"}"
          case "$inner" in
            '"'*'"') inner="${inner#\"}"; inner="${inner%\"}" ;;
            "'"*"'") inner="${inner#\'}"; inner="${inner%\'}" ;;
          esac
          printf '%s' "$inner"
          return 0
          ;;
      esac
    done
  done
  printf '%s' "$command"
}

# `tenon review acknowledge` is the contract's single writing path out of a pending review
# (adapters/contract.md §2).  The decision is made on the command *text*, never on a host tool
# label: Cursor's shell event carries no `tool_name` at all, Cline reports `execute_command` and
# Amp reports its own tool ids, so requiring a baseline label here deadlocked the only sanctioned
# unlock path on those hosts and left users with exactly the moves the contract forbids (delete the
# marker) or defeats the gate (TTL wait, TENON_AFK=1).
# Matching is structural rather than a substring test, so this hole cannot be widened by chaining:
# every segment must itself be an unlock call or a `cd` hop, and a segment carrying a
# metacharacter (`acknowledge && rm -rf`, `acknowledge > file`) is refused outright.
is_review_control_command() { # $1=decoded command
  local command="${1:-}" segment found=1
  [ -n "$command" ] || return 1
  command="$(pipeline_unwrap_shell_wrapper "$command")"
  command="${command//&&/$'\n'}"
  command="${command//||/$'\n'}"
  command="${command//;/$'\n'}"
  while IFS= read -r segment; do
    while [ "${segment# }" != "$segment" ]; do segment="${segment# }"; done
    while [ "${segment#	}" != "$segment" ]; do segment="${segment#	}"; done
    while [ "${segment% }" != "$segment" ]; do segment="${segment% }"; done
    [ -n "$segment" ] || continue
    pipeline_command_has_shell_metachars "$segment" && return 1
    case "$segment" in
      tenon\ review\ acknowledge|tenon\ review\ acknowledge\ *|\
      tenon\ review\ request|tenon\ review\ request\ *)
        found=0 ;;
      # A leading `cd <dir>` only positions the acknowledgement; it writes nothing and agents
      # routinely pin the project root that way.
      cd\ *) ;;
      *) return 1 ;;
    esac
  done <<< "$command"
  return "$found"
}

# Strict ActionEffect tracer bullet.  This is intentionally an allowlist rather than a
# denylist: pending interaction may not turn an unknown tool or shell expression into a write.
# Shell metacharacters are rejected before command matching; quoted metacharacters may therefore
# produce a conservative false negative (blocked read), never a false positive write.
pipeline_command_is_strict_read_only() { # $1=decoded command
  local command="${1:-}"
  [ -n "$command" ] || return 1
  pipeline_command_has_shell_metachars "$command" && return 1
  while [ "${command# }" != "$command" ]; do command="${command# }"; done
  while [ "${command#	}" != "$command" ]; do command="${command#	}"; done

  case "$command" in
    pwd|pwd\ *|ls|ls\ *|rg\ *|grep\ *|head\ *|tail\ *|wc\ *|cat\ *|stat\ *|file\ *|realpath\ *|\
    test\ *|'['\ *|command\ -v\ *)
      return 0 ;;
    sed\ -n\ *|sed\ --quiet\ *|sed\ --silent\ *)
      return 0 ;;
    find\ *)
      case "$command" in
        *" -delete"*|*" -exec"*|*" -execdir"*|*" -ok"*|*" -okdir"*|*" -fprint"*|*" -fls"*)
          return 1 ;;
      esac
      return 0 ;;
    git\ status|git\ status\ *|git\ diff|git\ diff\ *|git\ log|git\ log\ *|git\ show|git\ show\ *|\
    git\ rev-parse\ *|git\ branch\ --show-current|git\ worktree\ list|git\ worktree\ list\ *)
      return 0 ;;
    tenon\ list|tenon\ list\ *|tenon\ status\ *|tenon\ get\ *|tenon\ inbox|\
    tenon\ inbox\ *|tenon\ document\ status\ *)
      return 0 ;;
  esac
  return 1
}

pipeline_tool_is_read_only() { # $1=tool name
  local tool="${1:-}" command
  case "$tool" in
    Read|Glob|Grep|Search|WebSearch|web_search|view_image|list_mcp_resources|read_mcp_resource)
      return 0 ;;
  esac
  pipeline_json_is_command_tool "$tool" || return 1
  command="$(json_command || true)"
  pipeline_command_is_strict_read_only "$command"
}

for kind in confirm review interaction; do
  base=".pipeline-pending-$kind"
  m="$(resolve_marker "$base" || true)"
  [ -n "$m" ] || continue
  case "$kind" in confirm) ttl=300 ;; *) ttl=1800 ;; esac
  if fresh "$m" "$ttl"; then
    if [ "$kind" = "review" ]; then
      review_marker_relevant_to_active_change "$m" || continue
      if pipeline_command_reads_dashboard_token "$(json_command || true)"; then
        pipeline_record_pending_review_observation "$(pipeline_review_marker_change "$m" || true)" "token-file-read"
        printf '【Tenon 门】pending review 期间禁止读取 dashboard token；该行为已记录为安全信号。\n' >&2
        exit 2
      elif pipeline_command_writes_review_api "$(json_command || true)"; then
        pipeline_record_pending_review_observation "$(pipeline_review_marker_change "$m" || true)" "localhost-control-write"
      fi
      # Acknowledgement is the only state-writing action that may pass a pending v2 gate.  The
      # command itself validates exact Change/phase/pending state under the canonical lock, so
      # allowing this narrow control surface cannot open unrelated writes.
      if is_review_control_command "$(json_command || true)"; then
        continue
      fi
    fi
    # 交互门的目的正是让 agent 向人提问。若把 AskUserQuestion / Codex 的
    # request_user_input 也拦住，会形成“必须先问、却不能发问”的自锁；它们的
    # PostToolUse handler 在拿到真实回答后才会清 marker，故此处只是精确放行，
    # 绝不删除 marker，也不放行任何写类工具。
    case "$TOOL" in
      AskUserQuestion|request_user_input) continue ;;
    esac
    # 读取不会扩大权限，也不清 marker。允许它能让 Agent 在等待决定时继续核对事实，
    # 同时 state transition、外部副作用和任何未知动作仍 fail closed。
    pipeline_tool_is_read_only "$TOOL" && continue
    printf '【Tenon 门】检测到待处理交互标记 %s（%s 已被拦截）：请先把当前决策/产出交用户确认。支持 AskUserQuestion 的宿主可在该交互后解封；Codex 用户可用自然语言明确同意当前问题，系统会绑定当前待办并解封，再重发本次操作。\n' "$base" "$TOOL" >&2
    exit 2
  fi
done

# ── 非 default workflow 的 skill DAG 解锁判定（Task 9，GOAL 清单 E）：委托进 CLI 判定 ──
# Claude 的 Skill tool 与 Codex 对当前插件 `<root>/skills/<id>/SKILL.md` 的受控读取都走这条
# 判定；普通 Bash 命令不会命中 helper，因此不被 custom workflow 的 skill DAG 误拦。若 Codex
# 读取了与本插件 bundled id 同名、但位于全局/项目目录的 SKILL.md，先标为 shadowed：这不是
# evidence，也不能绕过 DAG；已激活 Change 时必须明确拦下，迫使宿主加载 tenon 包内版本。
# Process one resolved skill without making the surrounding command a single-skill bottleneck.
# A batched Codex read must be blocked if *any* bundled dependency is still locked or any bundled
# id is loaded from an untrusted global/project path.
pipeline_enforce_skill_gate() {
  local skill_id="${1:-}" skill_origin="${2:-}" sg_proot sg_change_dir sg_state_source sg_workflow
  local sg_plugin_root sg_bundle sg_change_name sg_rc active_helper
  [ -n "$skill_id" ] || return 0

  # 与其它 hook 共用已验证的项目根和显式选择，避免跨项目或按 mtime 把 Skill DAG
  # 错绑到旧 Change。没有已选择 target 时不猜测，入口 skill 会在选定/创建后先 activate。
  sg_proot="$TENON_ROOT"
  [ -n "$sg_proot" ] || return 0
  active_helper="$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
  if [ -r "$active_helper" ]; then
    # shellcheck source=active-change.sh
    . "$active_helper"
    sg_change_dir="$(pipeline_active_change_dir "$sg_proot" || true)"
  else
    sg_change_dir=""
  fi
  [ -n "$sg_change_dir" ] || return 0

  sg_state_source="$(pipeline_state_source "$sg_change_dir" || true)"
  sg_workflow="$(yget "$sg_state_source" workflow)"
  # The same packaged skill may also exist in ~/.agents or another plugin. A normal Codex command
  # read from that foreign path is neither a safe completion receipt nor an acceptable substitute
  # for tenon's version. Refuse it before the default/custom split so default workflow is
  # protected too; no active Change means no interception.
  if [ "$skill_origin" = "shadowed-read" ]; then
    printf "【pipeline 门】skill '%s' 必须从已安装的 tenon 插件加载；检测到同名非插件 SKILL.md。Codex 请调用 'tenon:%s'，不要读取全局或项目副本。\n" "$skill_id" "$skill_id" >&2
    return 2
  fi

  [ -n "$sg_workflow" ] || return 0
  sg_plugin_root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)}}"
  sg_bundle="$sg_plugin_root/packages/cli/dist/tenon.mjs"
  [ -f "$sg_bundle" ] && command -v node >/dev/null 2>&1 || return 0
  sg_change_name="$(basename "$sg_change_dir")"
  # 子 shell 里先 cd 到项目根（sg_proot）再 spawn：CLI 的 deps.cwd = process.cwd()
  # （main.ts），change 定位靠 <cwd>/openspec/changes/<name> 拼出来——不 cd 的话 node
  # 继承的是 gate.sh 自己的 cwd（可能是任意调用方目录，不是项目根），会把 change 定位
  # 到错误路径导致 store.read 抛 ENOENT，被内部 catch 静默 fail-open 成误放行。
  ( cd "$sg_proot" && node "$sg_bundle" internal-skill-gate "$sg_change_name" "$skill_id" )
  sg_rc=$?
  # fail-open 对齐文件头总纲：只有明确的"拦截"信号（exit 2）才真拦；node/bundle 崩溃
  # 等其它非零 code 一律不当真、继续放行，绝不因本机制自身故障变相锁死用户。
  [ "$sg_rc" -eq 2 ] && return 2
  return 0
}

pipeline_list_has_skill_id() {
  local list="${1:-}" wanted="${2:-}" item
  [ -n "$wanted" ] || return 1
  while IFS= read -r item; do
    [ "$item" = "$wanted" ] && return 0
  done <<< "$list"
  return 1
}

TRUSTED_SKILL_IDS=""
SHADOW_SKILL_IDS=""
case "$TOOL" in
  Skill)
    SKILL_ID="$(json_get skill || true)"
    [ -n "$SKILL_ID" ] && pipeline_enforce_skill_gate "$SKILL_ID" "skill-tool"
    sg_rc=$?
    [ "$sg_rc" -eq 2 ] && exit 2
    ;;
  *)
    if pipeline_json_is_command_tool "$TOOL"; then
      EVIDENCE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/skill-evidence.sh"
      if [ -r "$EVIDENCE_HELPER" ]; then
        # shellcheck source=skill-evidence.sh
        . "$EVIDENCE_HELPER"
        SG_COMMAND="$(json_command || true)"
        TRUSTED_SKILL_IDS="$(pipeline_codex_skill_read_ids "$SG_COMMAND" || true)"
        SHADOW_SKILL_IDS="$(pipeline_codex_any_skill_read_ids "$SG_COMMAND" || true)"
      fi
    fi
    ;;
esac

# Every trusted asset read in the same command has an independent DAG check.  This is critical for
# a custom workflow whose parallel batch reads several skills at once: allowing only the first id
# would silently bypass a locked second id.
while IFS= read -r SKILL_ID; do
  [ -n "$SKILL_ID" ] || continue
  pipeline_enforce_skill_gate "$SKILL_ID" "bundled-read"
  sg_rc=$?
  [ "$sg_rc" -eq 2 ] && exit 2
done <<< "$TRUSTED_SKILL_IDS"

# A non-plugin path that carries any bundled id is a shadow attempt even when the same command also
# contains a valid bundled read.  Do not let the valid first read mask the untrusted second one.
while IFS= read -r SKILL_ID; do
  [ -n "$SKILL_ID" ] || continue
  pipeline_list_has_skill_id "$TRUSTED_SKILL_IDS" "$SKILL_ID" && continue
  pipeline_plugin_has_skill_id "$SKILL_ID" || continue
  pipeline_enforce_skill_gate "$SKILL_ID" "shadowed-read"
  sg_rc=$?
  [ "$sg_rc" -eq 2 ] && exit 2
done <<< "$SHADOW_SKILL_IDS"
exit 0
