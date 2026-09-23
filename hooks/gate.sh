#!/usr/bin/env bash
# gate.sh — PreToolUse 统一交互门（lite 版，语义对齐老内核 pipeline-gate.sh）。
#
# 机制：项目根存在新鲜（TTL 分级，CONTRACT §2 / types.ts GATE_TTL_MS）的
#   .pipeline-pending-{confirm,review,interaction} 任一 marker → 对产出类工具 exit 2 + stderr 中文指引；
#   原生人类提问工具 AskUserQuestion / request_user_input 及其加载器 ToolSearch 是例外：它们只负责把决策交给用户，
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
#   解锁判定。默认 workflow / 无活跃 change / 非技能读取三者任一成立就直接跳过 node；Codex 读取
#   证据与 Claude Skill 事件保持语义等价但记账类型不同。
# 例外二（自审批检测）：工具输入命中宽召回候选（dashboard token 文件名，或 loopback 主机 + /api/）
#   时委托 `node .../tenon.mjs internal-self-approval` 做精确判定与记录。非候选只做 bash 字符串
#   匹配，不 spawn node。
# fail-open（绝不死锁）：stdin 解析失败 / cwd 不存在 / 任何异常 → 放行 exit 0。
# 强制常开（v5 T5 / 决议#2）：本交互门与 interactive-skill-gate.sh 安全门**不读**
#   .pipeline/hooks.json 阶段×hook 开关矩阵——配置里手写 "gate.<阶段>": false 一律无效
#   （server 写端点同样拒绝这两个 id），防误配置/AFK 把安全约束关掉；其余 hook 的开关
#   接线见 router.sh / breadcrumb.sh / skill-tracker.sh / session-start.sh 的 hook_disabled。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

# 自审批宽召回预筛（纯 bash、零 fork）：原始输入含 token 文件名，或同时含 loopback 主机与 /api/。
# 非候选在 AFK 下于此直接放行，热路径与原先「开头即 exit」只多一次 cat 与 case 匹配；
# 普通 `src/api/` 路径或远端 /api/ 不命中，HITL 下也不进入候选解析。
SELF_APPROVAL_RAW=0
case "$INPUT" in
  *dashboard-token.json*) SELF_APPROVAL_RAW=1 ;;
  *localhost*|*127.0.0.1*|*'[::1]'*)
    case "$INPUT" in *'/api/'*|*'\/api\/'*) SELF_APPROVAL_RAW=1 ;; esac
    ;;
esac
# 测试记录与基线只能由 `tenon test run` / `tenon test baseline` 写入：编辑类工具（Claude 的
# Write/Edit/MultiEdit/NotebookEdit，Codex 的 apply_patch）直接改这些文件会把「agent 自报通过」
# 重新变成可能，所以在 marker 逻辑之前就拒。纯 case 匹配、零 fork；shell 重定向不在本门覆盖范围内
# （已在 design §12 记为残余风险）。AFK 也照拒：它免除的是交互拦截，不是写入边界。
case "$INPUT" in
  *'.tenon/users/'*|*'.tenon\/users\/'*)
    case "$INPUT" in
      *'"tool_name":"Write"'*|*'"tool_name":"Edit"'*|*'"tool_name":"MultiEdit"'*|*'"tool_name":"NotebookEdit"'* \
      |*'"tool_name": "Write"'*|*'"tool_name": "Edit"'*|*'"tool_name": "MultiEdit"'*|*'"tool_name": "NotebookEdit"'* \
      |*'*** Add File: '*|*'*** Update File: '*|*'*** Delete File: '*)
        case "$INPUT" in
          *'/tests/'*|*'/baselines/'*|*'\/tests\/'*|*'\/baselines\/'*)
            printf '测试记录与基线只能由 tenon test run / tenon test baseline 写入\n' >&2
            exit 2
            ;;
        esac
        ;;
    esac
    ;;
esac

[ "${TENON_AFK:-}" = "1" ] && [ "$SELF_APPROVAL_RAW" = 0 ] && exit 0

# All realtime hooks use the same escape-aware parser. This keeps Codex's quoted
# `command_execution.command` and `exec.cmd` payloads on the exact same path as regular events.
JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }
json_command() { pipeline_json_get_command "$INPUT"; }
# Allowlist checks (read-only commands, review control) only ever accept short commands.  Bounding
# the decode keeps a huge heredoc from overrunning the host hook timeout, which a host treats as a
# non-blocking error, i.e. an allow; an over-long command is simply not allowlisted (fail closed).
json_command_short() { pipeline_json_get_command_bounded "$INPUT" 65536; }

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

# ── 自审批检测：宽召回候选（纯 bash）→ CLI 精确判定 ──
# hook 只回答「这次工具输入是否可能触碰 dashboard token 或本机控制 API」，不解析 curl 参数、
# 不跳过含 `$(` / `|` 的命令、不读 hook marker，也不自行推导 product state root：命令变体、
# token 真实路径与 canonical pending receipt 都由 `internal-self-approval` 在 Change 锁内判定，
# 没有 pending receipt 就零写入。候选文本只经 0600 临时文件传递，调用后立即删除；落盘记录只含
# 摘要与类别。
pipeline_self_approval_candidate() { # $1=tool name → candidate text（非候选输出空）
  local tool="${1:-}" key value text=''
  case "$tool" in
    Read|Grep|Glob|Search)
      for key in file_path path pattern glob; do
        value="$(pipeline_json_get_string "$INPUT" "$key" || true)"
        case "$value" in *dashboard-token.json*) text="$text $value" ;; esac
      done
      ;;
    *)
      value="$(json_command || true)"
      case "$value" in
        *dashboard-token.json*) text="$value" ;;
        *localhost*|*127.0.0.1*|*'[::1]'*)
          case "$value" in *'/api/'*) text="$value" ;; esac
          ;;
      esac
      ;;
  esac
  printf '%s' "${text# }"
}

pipeline_record_self_approval_candidate() { # $1=candidate text
  local candidate="${1:-}" hook_root bundle tool_use_id session identity
  [ -n "$candidate" ] && [ -n "$TENON_ROOT" ] || return 0
  hook_root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)}}"
  bundle="$hook_root/packages/cli/dist/tenon.mjs"
  [ -f "$bundle" ] && command -v node >/dev/null 2>&1 || return 0
  # JSON 只允许 escape 过的控制字符；其余控制字符替换为空格，候选匹配语义不受影响。
  candidate="${candidate//[[:cntrl:]]/ }"
  tool_use_id="$(json_get tool_use_id || true)"
  case "$tool_use_id" in *[!A-Za-z0-9_.:-]*) tool_use_id='' ;; esac
  session="$(json_get session_id || true)"
  identity="hook-parent:${PPID:-unknown};host:${HOSTNAME:-unknown};session:${session:-${TENON_HOST_SESSION_ID:-${CODEX_THREAD_ID:-unknown}}}"
  identity="${identity//[[:cntrl:]]/ }"
  SELF_APPROVAL_PAYLOAD="$(umask 077 && mktemp "${TMPDIR:-/tmp}/tenon-self-approval.XXXXXX" 2>/dev/null || true)"
  [ -n "$SELF_APPROVAL_PAYLOAD" ] || return 0
  # 候选可能含明文 bearer token。宿主超时发 HUP/INT/TERM 时，bash 会把 trap 推迟到前台子进程
  # 结束（CLI 可能在 Change 锁上等 10s），所以 node 放后台并 wait：信号立即打断 wait、删除 payload。
  trap 'rm -f "$SELF_APPROVAL_PAYLOAD" 2>/dev/null; exit 0' HUP INT TERM
  if chmod 600 "$SELF_APPROVAL_PAYLOAD" 2>/dev/null \
    && printf '{"candidate":"%s","tool_name":"%s","tool_use_id":"%s","process_or_host_identity":"%s"}\n' \
      "$(pipeline_json_escape "$candidate")" "$(pipeline_json_escape "$TOOL")" \
      "$tool_use_id" "$(pipeline_json_escape "$identity")" > "$SELF_APPROVAL_PAYLOAD" 2>/dev/null; then
    ( cd "$TENON_ROOT" && exec node "$bundle" internal-self-approval "$SELF_APPROVAL_PAYLOAD" ) >/dev/null 2>&1 &
    wait "$!" 2>/dev/null || true
  fi
  rm -f "$SELF_APPROVAL_PAYLOAD" 2>/dev/null || true
  trap - HUP INT TERM
  SELF_APPROVAL_PAYLOAD=""
}

SELF_APPROVAL_CANDIDATE=""
if [ "$SELF_APPROVAL_RAW" = 1 ]; then
  SELF_APPROVAL_CANDIDATE="$(pipeline_self_approval_candidate "$TOOL")"
  pipeline_record_self_approval_candidate "$SELF_APPROVAL_CANDIDATE"
fi

# AFK 逃生门（BACKLOG #7b，对齐老内核沙箱放行语义）：headless 自动化（Docker/CI）里
# 无人应答 AskUserQuestion，三门必死锁——显式 TENON_AFK=1 时整门放行；
# 不清 marker（人回来时门还在）。仅字面 "1" 生效，其它值一律不放行。
# 放行位于自审批检测之后：AFK 只免除拦截，不免除安全观测。
[ "${TENON_AFK:-}" = "1" ] && exit 0

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
  command="$(json_command_short || true)"
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
      # 观测已在 AFK 放行前按 canonical receipt 记录；这里只保留 HITL 下的拦截体验。
      # loopback 控制 API 调用不是严格只读命令，会落到下方通用拦截。
      case "$SELF_APPROVAL_CANDIDATE" in
        *dashboard-token.json*)
          printf '【Tenon 门】pending review 期间禁止读取 dashboard token；该行为已记录为安全信号。\n' >&2
          exit 2
          ;;
      esac
      # Acknowledgement is the only state-writing action that may pass a pending v2 gate.  The
      # command itself validates exact Change/phase/pending state under the canonical lock, so
      # allowing this narrow control surface cannot open unrelated writes.
      if is_review_control_command "$(json_command_short || true)"; then
        continue
      fi
    fi
    # 交互门的目的正是让 agent 向人提问。若把 AskUserQuestion / Codex 的
    # request_user_input 也拦住，会形成“必须先问、却不能发问”的自锁；它们的
    # PostToolUse handler 在拿到真实回答后才会清 marker，故此处只是精确放行，
    # 绝不删除 marker，也不放行任何写类工具。
    # ToolSearch 只加载延迟工具的 schema：Claude Code 里 AskUserQuestion 是延迟加载工具，
    # 必须先经 ToolSearch 载入才能调用；拦住它同样会形成“必须先问、却不能发问”的死锁。
    case "$TOOL" in
      AskUserQuestion|request_user_input|ToolSearch) continue ;;
    esac
    # 读取不会扩大权限，也不清 marker。允许它能让 Agent 在等待决定时继续核对事实，
    # 同时 state transition、外部副作用和任何未知动作仍 fail closed。
    pipeline_tool_is_read_only "$TOOL" && continue
    printf '【Tenon 门】检测到待处理交互标记 %s（%s 已被拦截）：请先把当前决策/产出交用户确认：调用 AskUserQuestion 提问（Claude Code 中它若尚未加载，先用 ToolSearch 查询 \"select:AskUserQuestion\" 载入；Codex 用 request_user_input），该交互完成后解封；等待期间 Read/Grep/Glob 等只读工具不受拦截。没有提问工具时，用户回复「确认继续」「继续执行」「同意继续」，或简短同意「继续」「可以」「同意」「好的」「按推荐」「按你的推荐」即解封（后者表示采纳推荐项）；拒绝（「不可以」「不同意」）、带条件（「继续，但……」）或其他回复不会解封。解封后再重发本次操作。\n' "$base" "$TOOL" >&2
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

# ── GSAP 动画门：写入含 GSAP 标记的代码前必须先读过对应官方技能 ──
# 与 skill DAG 门的区别：这条规则不属于某条工作流，default 同样适用。候选判定是纯 bash 子串匹配，
# 非候选工具输入一次 node 都不 spawn；判定本身委托 CLI（与 skill 门共用同一份步骤内技能证据）。
pipeline_enforce_motion_gate() {
  local mg_proot mg_change_dir mg_plugin_root mg_bundle mg_change_name mg_rc active_helper
  mg_proot="$TENON_ROOT"
  [ -n "$mg_proot" ] || return 0
  active_helper="$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
  if [ -r "$active_helper" ]; then
    # shellcheck source=active-change.sh
    . "$active_helper"
    mg_change_dir="$(pipeline_active_change_dir "$mg_proot" || true)"
  else
    mg_change_dir=""
  fi
  [ -n "$mg_change_dir" ] || return 0
  mg_plugin_root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)}}"
  mg_bundle="$mg_plugin_root/packages/cli/dist/tenon.mjs"
  [ -f "$mg_bundle" ] && command -v node >/dev/null 2>&1 || return 0
  mg_change_name="$(basename "$mg_change_dir")"
  # 同 skill 门：子 shell 里先 cd 到项目根再 spawn，否则 change 定位会落到调用方 cwd。
  ( cd "$mg_proot" && printf '%s' "$INPUT" | node "$mg_bundle" internal-motion-gate "$mg_change_name" )
  mg_rc=$?
  [ "$mg_rc" -eq 2 ] && return 2
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

# 文件编辑类工具：输入里出现 GSAP 标记才进动画门（纯 bash 判定，不命中就一次 fork 都没有）。
case "$TOOL" in
  Write|Edit|MultiEdit|NotebookEdit|apply_patch)
    case "$INPUT" in
      *gsap*|*GSAP*|*ScrollTrigger*|*useGSAP*)
        pipeline_enforce_motion_gate
        mg_rc=$?
        [ "$mg_rc" -eq 2 ] && exit 2
        ;;
    esac
    ;;
esac

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
    # Only a command naming a SKILL.md can be a skill read; skip decoding every other (possibly huge) one.
    if pipeline_json_is_command_tool "$TOOL" && case "$INPUT" in *SKILL.md*) true ;; *) false ;; esac; then
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
