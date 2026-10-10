#!/usr/bin/env bash
# gate.sh — PreToolUse 统一交互门（lite 版，语义对齐老内核 pipeline-gate.sh）。
#
# 机制：项目根存在新鲜（TTL 分级，CONTRACT §2 / types.ts GATE_TTL_MS）的
#   .pipeline-pending-{confirm,review,interaction} 任一 marker → 对产出类工具 exit 2 + stderr 中文指引
#   （interaction 按会话分文件 .pipeline-pending-interaction.<session_id>，只拦归属它的会话，见 pending-marker.sh）；
#   原生人类提问工具 AskUserQuestion / request_user_input 及其加载器 ToolSearch 是例外：它们只负责把决策交给用户，
#   不会绕过 marker 或写入产出；无 marker / 陈旧（顺手清掉）→ exit 0。
# TTL 分级（BACKLOG #13，对齐老内核 pipeline-gate.sh，勿改回统一值）：
#   - confirm 300s：正常流程同轮 AskUserQuestion 即清（秒级），300s 只是「漏确认」安全网。
#   - review / interaction 1800s：跨整个决策 phase（常 >5min），缩短会中途误清 → 绕过强制复核。
# marker 只从当前项目根读取：Git worktree / 显式 TENON_PROJECT_ROOT / 当前 cwd 三者之一。
#   绝不从普通父目录猜测项目根，避免共享 /tmp 下的外部 Change 拦截无关会话。
# 纯 bash 热路径（CONTRACT §5.4）：不 spawn 任何解释器/外部 JSON 解析器，
#   stdin JSON 只用 bash 字符串提取所需的键（cwd / tool_name；测试记录门另取写入目标路径与 shell 写入命令的目标）。
# 例外（Task 9，GOAL 清单 E）：非 default workflow 的 change 调用 Claude Skill 工具，或 Codex
#   读取当前插件内 SKILL.md 时，文件尾段委托 `node .../tenon.mjs internal-skill-gate` 做 skill DAG
#   解锁判定。默认 workflow / 无活跃 change / 非技能读取三者任一成立就直接跳过 node；Codex 读取
#   证据与 Claude Skill 事件保持语义等价但记账类型不同。
# 例外二（自审批检测，审计信号而非边界）：解码后的命令词可能触达本机 Dashboard 控制面（回环主机的各种写法
#   + Dashboard 端口、`tenon dashboard`、登录端点；解释器/路径首词时再读它所执行脚本里的相关行）时委托
#   `node .../tenon.mjs internal-self-approval` 做精确判定与记录。非候选只做 bash 字符串匹配，不 spawn node。
#   边界在 server：无凭证落盘、未登录请求 401、评审确认要浏览器会话 + 在场 nonce（docs/usage/security-model.md）。
# fail-open（绝不死锁）：stdin 解析失败 / cwd 不存在 / 任何异常 → 放行 exit 0。
# 强制常开（v5 T5 / 决议#2）：本交互门与 interactive-skill-gate.sh 安全门**不读**
#   .pipeline/hooks.json 阶段×hook 开关矩阵——配置里手写 "gate.<阶段>": false 一律无效
#   （server 写端点同样拒绝这两个 id），防误配置/AFK 把安全约束关掉；其余 hook 的开关
#   接线见 router.sh / breadcrumb.sh / skill-tracker.sh / session-start.sh 的 hook_disabled。
set -uo pipefail

# 热路径的固定成本：
#   · 固定 C locale：bash 3.2 在 UTF-8 locale 下每次 ${var:offset:length} / ${#var} 都按多字节字符遍历，几十 KB 的 Write /
#     apply_patch 载荷上单次取键要几毫秒；hook 只比较 ASCII 的键与路径，偏移与长度在同一个 locale 里自洽，按字节算即可。
#   · 本脚本所在目录用参数展开算，不再每次 fork 一个 dirname。
LC_ALL=C
GATE_DIR="${BASH_SOURCE[0]:-$0}"
case "$GATE_DIR" in */*) GATE_DIR="${GATE_DIR%/*}" ;; *) GATE_DIR=. ;; esac

INPUT="$(cat 2>/dev/null || printf '{}')"

# All realtime hooks use the same escape-aware parser. This keeps Codex's quoted
# `command_execution.command` and `exec.cmd` payloads on the exact same path as regular events.
JSON_INPUT_HELPER="$GATE_DIR/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }
json_command() { pipeline_json_get_command "$INPUT"; }
# Allowlist checks (read-only commands, review control) only ever accept short commands.  Bounding
# the decode keeps a huge heredoc from overrunning the host hook timeout, which a host treats as a
# non-blocking error, i.e. an allow; an over-long command is simply not allowlisted (fail closed).
json_command_short() { pipeline_json_get_command_bounded "$INPUT" 65536; }

# 测试体系的记录只能由 `tenon test …` 命令写入：编辑类工具（Claude 的 Write/Edit/MultiEdit/NotebookEdit，
# Codex 的 apply_patch）与 shell 命令直接改这些文件，会把「agent 自报通过 / 自己改计划、基线、已知失败」重新变成
# 可能，所以在 marker 逻辑之前就拒。受保护的路径：
#   · .tenon/users/<u>/{tests,baselines}：按用户的运行记录（v1 / v2 哈希链）与旧基线；
#   · .tenon/users/<u>/local/{test-seal.json,env.key}：本机封存文件（记录链头、批准、信任）与它的密钥；
#   · openspec/changes/<c>/test-plan.yaml 及其摘要台账 .pipeline-test-plan.json、评审冻结的待批准清单
#     .pipeline-review-waivers.json：任务测试计划；
#   · .tenon/tests/baselines/**、.tenon/tests/known-failures.yaml：项目共享的基线与已知失败清单。
# .tenon/tests/catalog.yaml 与 .pipeline/workflows/*.yaml 是人可编辑的配置，不在其内（它们的改动由评审门的
# 人工确认把关，见 kernel protected-files.ts）。
# 只看写入目标路径——Claude 取 tool_input 的 file_path / notebook_path，apply_patch 取补丁头
# `*** Add/Update/Delete File:` 与 `*** Move to:` 的路径，shell 命令取重定向目标与下列写入形态的目标——不看写入
# 内容：文档正文（含 heredoc 正文）里提到这些路径不是写记录。`tenon …` 调用与普通 git 操作（add / commit / diff /
# show / mv …）不是写入命令，照常放行。shell 写入形态（尽力而为、线性、bash 3.2）：
#   1 Python/perl/ruby/php/lua -c|-e 内联代码，2 node/deno/bun -e|-p 内联代码——命令名了受保护路径就拒；
#   3 curl -o/--output、wget -O；4 tar -x / unzip 解进受保护目录；5 git checkout|restore|reset|rm|clean … <受保护>；
#   6 git apply|am、patch（补丁文件或 heredoc 补丁头点名受保护路径）；7 同一命令里 NAME=值 赋值后的 $NAME / ${NAME}
#   （展开不了的变量目标在名了受保护路径的命令里按写入拒）；8 脚本文件：解释器或 ./x 运行的脚本点名受保护路径且不是
#   干净的 git 跟踪文件；9 xargs / parallel 接非只读命令、find 带 -exec|-delete 等；10 cp/mv/install/rsync/ln 的目标；
#   11 tee（含 sudo tee、>(tee f)）；12 各种重定向（>| &> 1> : > exec 3> { …; } >，含 heredoc 喂给解释器的正文）；
#   13 sed -i / perl -pi / awk -i inplace / truncate / dd of= / rm / shred / touch。
# 另有两条文字规则（只在命令位置匹配，grep 文档里的字样不算）：`tenon test trust` 与 `TENON_TEST_TRUST=` 前缀赋值
# 只能由用户在自己的终端里做（R6 的信任），agent 的 shell 调用一律拒。
# 无法静态认出的（路径由字符串拼接出来、变量来自别处、脚本被间接构造）在转换时检出：记录链头对不上本机封存、共享受保护
# 文件相对封存的写入记录被改动，见 kernel evaluate-v2。AFK 也照拒：它免除的是交互拦截，不是写入边界。
# 原始输入不含任何相关字样就不解析；解析全走 json-input.sh 的线性 helper（bash 3.2 下大补丁也不超时）。
# 实现在 hooks/lib/protected-writes.sh：只在原始输入里出现相关字样时才加载（见下面的预筛），其余调用不付这份解析成本。
PIPELINE_PY='pyth''on' # 红线自证要求 gate.sh 里不出现某个脚本语言解释器名的字面量（test-hooks.sh section 3），所以拆开写。

# Structural unwrapping only — nothing here is ever evaluated.  Hosts hand the same shell call over
# in several shapes: bare (`tenon …`), wrapped by the login shell (`/bin/zsh -lc "tenon …"`), and
# as a joined argv array (`bash -lc tenon …`, see pipeline_json_get_command).  Peel one wrapper so
# the matchers see one canonical command text.
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

# agent 不能自己手动确认评审：手动 `tenon review acknowledge`（不带 --delegated）经终端通道会批准冻结的豁免清单，而 hook
# 无法证明「人在场」。手动确认只在用户回复放行语时由 hook 自己写入（review-ack.sh 直接调 CLI，不经 PreToolUse），或由用户在
# Dashboard 确认；持续授权下用 --delegated，它不批准豁免。所以 agent 的 shell 调用里出现手动 acknowledge **任何时候**都拒——
# 不论有没有评审标记（评审标记 30 分钟后过期，过期后门不再拦，这条不能跟着失效），AFK 也照拒。
# 命令文本的还原与判定（还原顺序、标记字符、--delegated 口径、失败关闭的误拦范围、覆盖不到的写法）在 hooks/lib/ack-command.sh，
# 只在下面的预筛命中时才加载；这里只留预筛、加载与拒绝。

# 预筛与 hooks/lib/ack-command.sh 共用：acknowledge 的各个字母是否依次出现在文本里（花括号展开能拼出该词的必要条件）。
pipeline_text_may_spell_acknowledge() { # $1=text → 0 = 其中依次出现 acknowledge 的各个字母
  local rest="${1:-}" ch head
  # 先用三个单字母的 case 快速排除：绝大多数词没有 k / w / g（单星号通配线性，不会像多星号那样回溯）。
  case "$rest" in *k*) ;; *) return 1 ;; esac
  case "$rest" in *w*) ;; *) return 1 ;; esac
  case "$rest" in *g*) ;; *) return 1 ;; esac
  # 在第一个出现的字母处切开，取后半段接着找。不用 ${rest#*字母}：bash 3.2 下它对「到下一个出现处的距离」是平方级
  # （393 KB 里 k 在末尾时要 40 秒）；read 按分隔字符切一次是线性的。
  for ch in a c k n o w l e d g e; do
    case "$rest" in *"$ch"*) ;; *) return 1 ;; esac
    IFS="$ch" read -r -d '' head rest <<< "$rest" || true
  done
  return 0
}

pipeline_refuse_manual_acknowledge() {
  printf '【Tenon 门】禁止 agent 自己执行手动 tenon review acknowledge：手动确认会经终端通道批准冻结的豁免清单，而 hook 无法证明用户在场。手动确认只在用户回复放行语（「确认继续」「继续执行」等）时由 hook 写入，或由用户在 Dashboard 确认（需要打开页面时运行 tenon dashboard --open，由 server 替用户打开已登录的浏览器）；已有持续授权时用 tenon review acknowledge <change> --delegated，它不批准待批准的测试豁免。\n' >&2
  exit 2
}

# 判定库缺失是安装缺陷：预筛已经命中（命令很可能含手动确认），核实不了就按失败关闭拒绝；预筛没命中的调用不会走到这里。
pipeline_refuse_ack_lib_missing() { # $1=库路径
  printf '【Tenon 门】hooks/lib/ack-command.sh 缺失（%s），无法核实这条命令是否在执行手动 tenon review acknowledge，按失败关闭拒绝。请重新安装或更新 Tenon 插件（tenon update），让 hooks/lib/ 随插件一起安装。\n' "${1:-}" >&2
  exit 2
}

# 手动 acknowledge 的拒绝放在其它分支之前：后面的分支（受保护路径的写入判定、自审批候选提取）遇到超大命令会跑得很慢，
# hook 超时被宿主当非阻断错误放行，这条拒绝不能排在它们后面被一起拖过限时。
# 预筛只是性能捷径，不能比 pipeline_command_runs_manual_acknowledge（hooks/lib/ack-command.sh）本身更窄：
#   · 只有带命令字段的输入（pipeline_json_get_command 读的那几个键）才可能有命令，其余调用（大 Write 载荷等）不付这份成本；
#   · 命令里出现转义编码——原始 JSON 里 \x（$'\x61'）、\u / \U、反斜杠后跟八进制数字（$'\141'），或 \\\n（JSON 编码的反斜杠
#     续行，去掉反斜杠后会剩一个 n）——acknowledge 的字母可能不在原文里，一律解码；
#   · 否则看原文里 acknowledge 的各个字母是否依次出现（含它本身）：引号、反斜杠、$'…'、花括号展开把词拆开时，字母仍按序留在原文里，
#     所以这是必要条件。pipeline_text_may_spell_acknowledge 用 read 在每个字母处切一次往后找，线性；多星号的 case 通配在 bash 3.2 下
#     可能指数级、${rest#*字母} 对距离是平方级，都不用。
# 判定读命令的上限是 ACK_COMMAND_MAX = 64 KiB（编码后的字符数）。上限之内按上面的静态判定；超过上限的命令不解码、不逐字处理，只做
# 一次线性的字面检查：命令字段的原文含 acknowledge 就拦（不看 --delegated，这么大的命令不是正常的确认调用），不含就不判定。
# 为什么是 64 KiB：命令的 JSON 解码（json-input.sh，已有的线性成本）在密集引号 / 转义 / 反斜杠时约每 KB 20 ms，hooks.json 给 gate 5 秒；
# 本机 bash 3.2 实测，64 KiB 的最坏载荷整个 gate 约 1.6 秒，128 KiB 的最坏载荷（密集引号）约 3 秒，没有余量。
ACK_COMMAND_MAX=65536
ACK_CANDIDATE=0
case "$INPUT" in
  *'"command"'*|*'"cmd"'*|*'"argv"'*|*'"command_line"'*|*'"commandLine"'*)
    case "$INPUT" in
      *'\u'*|*'\U'*|*'\x'*|*'\'[0-7]*|*'\\\n'*) ACK_CANDIDATE=1 ;;
      *) ! pipeline_text_may_spell_acknowledge "$INPUT" || ACK_CANDIDATE=1 ;;
    esac
    ;;
esac
if [ "$ACK_CANDIDATE" = 1 ]; then
  if ACK_COMMAND="$(pipeline_json_get_command_bounded "$INPUT" "$ACK_COMMAND_MAX")"; then
    if [ -n "$ACK_COMMAND" ]; then
      # 与 json-input.sh 同目录的 lib/：只在这里（预筛命中且读到了命令）才加载这份还原与判定逻辑。
      ACK_LIB="${JSON_INPUT_HELPER%/*}/lib/ack-command.sh"
      [ -r "$ACK_LIB" ] || pipeline_refuse_ack_lib_missing "$ACK_LIB"
      # shellcheck source=lib/ack-command.sh
      . "$ACK_LIB"
      if pipeline_command_runs_manual_acknowledge "$ACK_COMMAND"; then pipeline_refuse_manual_acknowledge; fi
    fi
  elif [ "${#INPUT}" -gt "$ACK_COMMAND_MAX" ]; then
    case "$INPUT" in *acknowledge*) pipeline_refuse_manual_acknowledge ;; esac
  fi
fi

case "$INPUT" in
  *.tenon*|*test-plan*|*known-failures*|*review-waivers*|*baselines*|*test-seal*|*env.key*|*trust*|*TRUST*|*bash*|*sh\ *|*zsh*|*"$PIPELINE_PY"*|*node*|*ruby*|*perl*|*php*|*deno*|*bun*|*source*|*apply*|*patch*|*'./'*)
    # 与 json-input.sh 同目录的 lib/：只在这里（原始输入名了相关字样）才解析这份识别逻辑；缺失按本文件的 fail-open 约定放行，
    # 发布时由 tools/verify-skills.sh 保证它随插件一起交付。
    PIPELINE_PROTECTED_LIB="${JSON_INPUT_HELPER%/*}/lib/protected-writes.sh"
    [ -r "$PIPELINE_PROTECTED_LIB" ] || exit 0
    # shellcheck source=lib/protected-writes.sh
    . "$PIPELINE_PROTECTED_LIB"
    RECORD_TOOL="$(json_get tool_name || true)"
    RECORD_CWD="$(pipeline_json_get_cwd "$INPUT" || true)"
    [ -n "$RECORD_CWD" ] || RECORD_CWD="$PWD"
    case "$RECORD_TOOL" in
      Write|Edit|MultiEdit)
        pipeline_test_record_path "$(json_get file_path || true)" "$RECORD_CWD" && pipeline_refuse_test_record_write
        ;;
      NotebookEdit)
        pipeline_test_record_path "$(json_get notebook_path || true)" "$RECORD_CWD" && pipeline_refuse_test_record_write
        ;;
      *)
        RECORD_PATCH=''
        case "$INPUT" in
          *'*** Add File: '*|*'*** Update File: '*|*'*** Delete File: '*|*'*** Move to: '*)
            RECORD_PATCH="$(pipeline_patch_text || true)"
            # 命令类工具只有真的调用 apply_patch 才算补丁；heredoc 写文档里恰好出现补丁头不算。
            if pipeline_json_is_command_tool "$RECORD_TOOL"; then
              case "$RECORD_PATCH" in *apply_patch*) ;; *) RECORD_PATCH='' ;; esac
            fi
            ;;
        esac
        if [ -n "$RECORD_PATCH" ]; then
          while IFS= read -r RECORD_TARGET; do
            pipeline_test_record_path "$RECORD_TARGET" "$RECORD_CWD" && pipeline_refuse_test_record_write
          done < <(pipeline_patch_targets "$RECORD_PATCH")
        fi
        # shell 命令：Bash / command_execution / exec，以及没有 tool_name 或用别的名字带命令的宿主
        # （按命令文本判定，不依赖工具标签）。native apply_patch 的补丁正文不是 shell 命令。
        if [ "$RECORD_TOOL" != apply_patch ]; then
          RECORD_COMMAND="$(pipeline_json_get_command_bounded "$INPUT" 524288 || true)"
          if [ -n "$RECORD_COMMAND" ] && pipeline_shell_writes_record "$RECORD_COMMAND" "$RECORD_CWD"; then
            pipeline_refuse_test_record_write
          fi
        fi
        ;;
    esac
    ;;
esac

# AFK 下没有可执行载荷（没有 command / cmd / argv 字段）的工具调用不可能触达控制面，也不受本门约束：
# 直接放行。这是按「有没有可执行载荷」的结构判断，不是对内容做子串预筛；旧版本遗留的 token 文件名
# 仍放行到候选判定（读文件类工具没有载荷字段）。
if [ "${TENON_AFK:-}" = "1" ]; then
  case "$INPUT" in
    *command*|*cmd*|*argv*|*Command*|*dashboard-token*) ;;
    *) exit 0 ;;
  esac
fi

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
ROOT_HELPER="$GATE_DIR/project-root.sh"
TENON_ROOT=""
if [ -r "$ROOT_HELPER" ]; then
  # shellcheck source=project-root.sh
  . "$ROOT_HELPER"
  TENON_ROOT="$(pipeline_project_root "$CWD" bootstrap changes || true)"
fi

# ── 自审批检测：宽召回候选（纯 bash）→ CLI 精确判定 ──
# 这是审计信号，不是边界：边界在 server（无凭证落盘、未登录请求 401、评审确认要浏览器会话 + 在场 nonce）。
# hook 回答「这次工具调用是否可能触达本机 Dashboard 控制面」，判定基于**解码后的命令词**而不是原始 JSON：
#   · 回环主机的各种写法 + 一个端口（不再要求 `/api/`——旧首页正是在 `GET /` 发 token；端口是不是 Dashboard 的由 CLI 判定）；
#   · `tenon dashboard` / dashboard.mjs / 登录端点；
#   · 命令首词是解释器或路径时，再把它所执行脚本文件里相关的行并进来（`sh x.sh`、`./x`、解释器 + 脚本文件）。
# 不解析 curl 参数、不跳过含 `$(` / `|` 的命令、不读 hook marker，也不自行推导 product state root：
# 命令变体、Dashboard 真实端口与 canonical pending receipt 都由 `internal-self-approval` 在 Change 锁内判定，
# 没有 pending receipt 就零写入。候选文本只经 0600 临时文件传递，调用后立即删除；落盘记录只含摘要与类别。
pipeline_text_is_control_candidate() { # $1=text → 0 when it may reach the local Dashboard control surface
  local text="${1:-}" port="${TENON_DASHBOARD_PORT:-18765}"
  case "$text" in
    # 旧版本（< 0.3）的 token 文件名：文件已不存在，但仍在读它的进程值得记一笔。
    *dashboard-token*) return 0 ;;
    *tenon\ dashboard*|*tenon-dashboard*|*dashboard.mjs*|*/session/start*|*/api/session/open*) return 0 ;;
    *[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]*|*127.*|*'[::1]'*|*::1*|*0.0.0.0*|*2130706433*|*0[xX]7[fF]*|*0177.*|*017700000001*|\
    */dev/tcp/*|*::[fF][fF][fF][fF]:*|*0:0:0:0:0:0:0:1*) ;;
    *) return 1 ;;
  esac
  # 回环主机 + 任一端口（`:3000`、`nc host 18765`、`:$PORT` 展开）才值得交给 CLI 精确判定：hook 不推导 state root，
  # 不知道 server 实际监听哪个端口（默认值、TENON_DASHBOARD_PORT、pidfile 记录的都可能），所以这里只做宽召回，
  # 「是不是 Dashboard 的端口」由 CLI 对照这些端口判定。没有端口的（`grep localhost /etc/hosts`、`curl localhost/`）不召回。
  case "$text" in
    *"$port"*|*:[0-9]*|*[0-9][0-9][0-9][0-9]*|*:\$*|*TENON_DASHBOARD_PORT*) return 0 ;;
  esac
  return 1
}

pipeline_word_runs_code() { # $1=command word → 0 for interpreters / shells and path-like executables
  local base="${1##*/}"
  case "$base" in
    # `pytho[n]*` 而不是字面量：hot path 红线（tools/test-hooks.sh §3）按源码文本检查解释器名，这里只是在认「哪些命令首词是解释器」。
    pytho[n]*|node|nodejs|deno|bun|tsx|ts-node|ruby|perl|php|lua|bash|sh|zsh|dash|ksh|fish|csh|tcsh|\
    pwsh|osascript|swift|source|awk|gawk|expect|Rscript|java) return 0 ;;
  esac
  case "$1" in ./*|../*|/*|'~/'*) return 0 ;; esac
  return 1
}

# 命令首词是解释器（或路径）时，把它所执行的脚本文件（≤3 个、各读前 128 KiB）里与控制面相关的行摘出来。
# 只有解释器命令才会读文件；普通命令零 fork。摘录上限 8 KiB，避免把整份脚本塞进候选。
pipeline_script_operand_excerpt() { # $1=decoded command → 摘录文本（无则空）
  local command="${1:-}" segment word first trigger files=0 target excerpt out=''
  command="${command//&&/$'\n'}"
  command="${command//||/$'\n'}"
  command="${command//;/$'\n'}"
  command="${command//|/$'\n'}"
  set -f
  while IFS= read -r segment; do
    first=1
    trigger=0
    for word in $segment; do
      word="${word#[\"\']}"
      word="${word%[\"\']}"
      if [ "$first" = 1 ]; then
        case "$word" in *=*|env|sudo|nohup|time|exec|command|builtin|xargs) continue ;; esac
        first=0
        pipeline_word_runs_code "$word" && trigger=1
        # `./run.sh` 本身就是要执行的脚本。
        case "$word" in ./*|../*|/*|'~/'*) ;; *) continue ;; esac
      elif [ "$trigger" != 1 ]; then
        break
      fi
      case "$word" in -*|'') continue ;; esac
      case "$word" in
        /*) target="$word" ;;
        '~/'*) target="${HOME:-}/${word#'~/'}" ;;
        *) target="${CWD:-.}/$word" ;;
      esac
      [ -f "$target" ] && [ -r "$target" ] || continue
      files=$((files + 1))
      excerpt="$(head -c 131072 "$target" 2>/dev/null | LC_ALL=C grep -a -i -m 40 -E \
        'localhost|127\.|::1|0\.0\.0\.0|2130706433|0x7f|0177|017700000001|/dev/tcp|::ffff|18765|TENON_DASHBOARD_PORT|dashboard|/session/' \
        2>/dev/null | head -c 8192)"
      [ -n "$excerpt" ] && out="$out $excerpt"
      [ "$files" -ge 3 ] && break 2
    done
  done <<< "$command"
  set +f
  printf '%s' "$out"
}

pipeline_self_approval_candidate() { # $1=tool name → candidate text（非候选输出空）
  local tool="${1:-}" key value scripts text=''
  case "$tool" in
    # 文件编辑类工具没有可执行载荷：不去解码它的（可能几十 KB 的）内容里找 command 键。
    Write|Edit|MultiEdit|NotebookEdit) return 0 ;;
    Read|Grep|Glob|Search)
      for key in file_path path pattern glob; do
        value="$(pipeline_json_get_string "$INPUT" "$key" || true)"
        case "$value" in *dashboard-token*) text="$text $value" ;; esac
      done
      ;;
    *)
      value="$(json_command || true)"
      [ -n "$value" ] || return 0
      if pipeline_text_is_control_candidate "$value"; then
        text="$value"
      else
        scripts="$(pipeline_script_operand_excerpt "$value")"
        if [ -n "$scripts" ] && pipeline_text_is_control_candidate "$scripts"; then text="$value $scripts"; fi
      fi
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
if [ -n "$TENON_ROOT" ]; then
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
STATE_HELPER="$GATE_DIR/canonical-state.sh"
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

case "$GATE_DIR" in
  /*) HOOK_DIR="$GATE_DIR" ;;
  *) HOOK_DIR="$(cd "$GATE_DIR" 2>/dev/null && pwd || true)" ;;
esac
REVIEW_HELPER="$HOOK_DIR/review-ack.sh"
if [ -r "$REVIEW_HELPER" ]; then
  # shellcheck source=review-ack.sh
  . "$REVIEW_HELPER"
fi

# 会话 id 的校验与会话任务的解析都在 active-change.sh：在父 shell 里加载一次（不能在 $(…) 里调用，否则加载不留下）。
# helper 缺失返回 1，调用方按本文件 fail-open 总纲放行。
SESSION_HELPER_LOADED=0
load_session_helper() {
  [ "$SESSION_HELPER_LOADED" = 1 ] && return 0
  [ -r "$HOOK_DIR/active-change.sh" ] || return 1
  # shellcheck source=active-change.sh
  . "$HOOK_DIR/active-change.sh"
  SESSION_HELPER_LOADED=1
}

# A root-level marker used to be written merely by *entering* explore/spec/verify.  v2 marks an
# explicit review request and embeds its exact Change.  Retire legacy projections on sight: their
# old state has no canonical receipt, while transition now independently requires a new receipt to
# leave a review phase.  A v2 marker only applies to the conversation's own Change (resolved from the
# host session_id, not the shared pointer), so a review in another conversation cannot lock unrelated
# normal dialogue.
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
  # 本会话 id 与交互分支同一入口（pipeline_hook_session_id）：不合法的 id 按没给处理，不把原始值递给下游。
  load_session_helper || return 1
  active_change="$(pipeline_review_active_change_name "$TENON_ROOT" "$HOOK_DIR" "$(pipeline_hook_session_id "$INPUT")" || true)"
  [ -n "$active_change" ] && [ "$active_change" = "$marked_change" ]
}

# 交互标记按会话分文件（pending-marker.sh）：本会话该看的是自己的分文件与没有会话的单文件，别的会话的分文件不看。
# 项目根上有任何 .pipeline-pending-interaction* 才加载 helper（热路径上多数调用没有）；helper 缺失按 fail-open 放行。
# 设 INTERACTION_MARKERS = 本会话该看的交互标记文件，每行一个。
interaction_marker_paths() {
  local f any=''
  INTERACTION_MARKERS=''
  [ -n "$TENON_ROOT" ] || return 0
  for f in "$TENON_ROOT"/.pipeline-pending-interaction*; do
    if [ -e "$f" ] || [ -L "$f" ]; then any=1; break; fi
  done
  [ -n "$any" ] || return 0
  [ -r "$HOOK_DIR/pending-marker.sh" ] && load_session_helper || return 0
  # shellcheck source=pending-marker.sh
  . "$HOOK_DIR/pending-marker.sh"
  INTERACTION_MARKERS="$(pipeline_interaction_marker_candidates "$TENON_ROOT" "$(pipeline_hook_session_id "$INPUT")")"
}

# 交互标记 v2 只拦归属方：归属其它会话的标记不拦本会话；旧格式（含空文件）见到即删除、不拦截。
interaction_marker_relevant_to_session() { # $1=marker → 0=本会话被它拦
  pipeline_interaction_marker_owned "$1" "$TENON_ROOT" "$(pipeline_hook_session_id "$INPUT")"
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

pipeline_dashboard_open_port_ok() { # $1=segment → 0 unless a `--port` value is not plain digits
  local segment="${1:-}" port
  case "$segment" in *--port*) ;; *) return 0 ;; esac
  port="${segment##*--port }"
  port="${port%% *}"
  case "$port" in ''|*[!0-9]*) return 1 ;; esac
  return 0
}

# While a review is pending an agent may still run `tenon review request` and the delegated
# `tenon review acknowledge --delegated` (continuous authority; it approves no test waiver).  A manual
# acknowledgement is the user's: the hook writes it on a spoken approval phrase, or the user confirms in the
# Dashboard — the agent's own manual call is refused at the top of this file, marker or not.
# The decision is made on the command *text*, never on a host tool
# label: Cursor's shell event carries no `tool_name` at all, Cline reports `execute_command` and
# Amp reports its own tool ids, so requiring a baseline label here deadlocked the only sanctioned
# unlock path on those hosts and left users with exactly the moves the contract forbids (delete the
# marker) or defeats the gate (TTL wait, TENON_AFK=1).
# Matching is structural rather than a substring test, so this hole cannot be widened by chaining:
# every segment must itself be an unlock call or a `cd` hop, and a segment carrying a
# metacharacter (`acknowledge --delegated && rm -rf`, `acknowledge --delegated > file`) is refused outright.
# The `--delegated` wildcards below are plain text patterns and know nothing about quoting: `acknowledge c "x --delegated y"`
# matches them although that `--delegated` is a quoted argument, not the switch.  They never get the last word on that:
# the manual-acknowledge refusal at the top of this file (hooks/lib/ack-command.sh, which does read quotes) runs first on the
# same command text, marker or not, so a command it calls manual never reaches this table.  Keep it that way: this table
# is only the narrow allow list for what the top refusal already let through.
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
      # 注释符：`… acknowledge x # --delegated` 里的 --delegated 是注释，不是开关。
      tenon\ review\ acknowledge*'#'*) return 1 ;;
      # 手动 acknowledge 不在此列（见文件开头：agent 不能自己手动确认，已在更早处拒绝）；这里只认委托确认。
      tenon\ review\ acknowledge\ --delegated|tenon\ review\ acknowledge\ --delegated\ *|\
      tenon\ review\ acknowledge\ *\ --delegated|tenon\ review\ acknowledge\ *\ --delegated\ *|\
      tenon\ review\ request|tenon\ review\ request\ *)
        found=0 ;;
      # `tenon dashboard --open` asks the *server* to open the user's browser, already signed in: the
      # one-time login link is delivered by the server and never reaches this process, so it gives an
      # agent no session.  It is how a pending review reaches the only place a person can approve it.
      tenon\ dashboard\ --open|tenon\ dashboard\ --open\ --port\ [0-9]*|tenon\ dashboard\ --port\ [0-9]*\ --open)
        pipeline_dashboard_open_port_ok "$segment" || return 1
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

# 单个标记：它拦本次调用 → exit 2；不拦（陈旧、不归本会话、放行形态）→ return 0。
gate_check_marker() { # $1=kind $2=marker path
  local kind="$1" m="$2" ttl
  case "$kind" in confirm) ttl=300 ;; *) ttl=1800 ;; esac
  if fresh "$m" "$ttl"; then
    # 交互 / 确认 marker 约束的是「主线先问用户、再产出」。子代理（Claude Code 在子代理里触发的 hook 输入带
    # agent_id，宿主生成、主线伪造不了）没有提问工具，被它挡住只会停工——真机验收 F4：后台执行者连写自己的
    # 报告都被拦，主线只能等用户回复后替它补写。所以这两类 marker 不拦子代理的调用，也不清 marker；
    # 复核 marker（transition 之前的人工确认）不在此列，子代理照样被拦。
    if [ "$kind" != "review" ] && [ -n "$(json_get agent_id || true)" ]; then
      return 0
    fi
    if [ "$kind" = "interaction" ]; then
      interaction_marker_relevant_to_session "$m" || return 0
    fi
    if [ "$kind" = "review" ]; then
      review_marker_relevant_to_active_change "$m" || return 0
      # 观测已在 AFK 放行前按 canonical receipt 记录；这里只保留 HITL 下的拦截体验。
      # 触达控制面的命令不是严格只读命令，会落到下方拦截并给出更准的提示。
      case "$SELF_APPROVAL_CANDIDATE" in
        *dashboard-token*)
          printf '【Tenon 门】pending review 期间禁止读取 dashboard token；该行为已记录为安全信号。\n' >&2
          exit 2
          ;;
      esac
      # The delegated acknowledgement (and `review request`) are the only state-writing actions that may
      # pass a pending v2 gate.  The command itself validates exact Change/phase/pending state under the
      # canonical lock, so allowing this narrow control surface cannot open unrelated writes.
      if is_review_control_command "$(json_command_short || true)"; then
        return 0
      fi
    fi
    # 交互门的目的正是让 agent 向人提问。若把 AskUserQuestion / Codex 的
    # request_user_input 也拦住，会形成“必须先问、却不能发问”的自锁；它们的
    # PostToolUse handler 在拿到真实回答后才会清 marker，故此处只是精确放行，
    # 绝不删除 marker，也不放行任何写类工具。
    # ToolSearch 只加载延迟工具的 schema：Claude Code 里 AskUserQuestion 是延迟加载工具，
    # 必须先经 ToolSearch 载入才能调用；拦住它同样会形成“必须先问、却不能发问”的死锁。
    case "$TOOL" in
      AskUserQuestion|request_user_input|ToolSearch) return 0 ;;
    esac
    # 读取不会扩大权限，也不清 marker。允许它能让 Agent 在等待决定时继续核对事实，
    # 同时 state transition、外部副作用和任何未知动作仍 fail closed。
    pipeline_tool_is_read_only "$TOOL" && return 0
    if [ "$kind" = "review" ] && [ -n "$SELF_APPROVAL_CANDIDATE" ]; then
      printf '【Tenon 门】pending review 期间禁止访问本机 Dashboard 控制面（%s 已被拦截）：人工确认只能由用户本人在浏览器里完成，会话也只能由用户建立。需要打开页面时运行 tenon dashboard --open（由 server 替用户打开已登录的浏览器）；该行为已记录为安全信号。\n' "$TOOL" >&2
      exit 2
    fi
    printf '【Tenon 门】检测到待处理交互标记 %s（%s 已被拦截）：请先把当前决策/产出交用户确认：调用 AskUserQuestion 提问（Claude Code 中它若尚未加载，先用 ToolSearch 查询 \"select:AskUserQuestion\" 载入；Codex 用 request_user_input），该交互完成后解封；等待期间 Read/Grep/Glob 等只读工具不受拦截。没有提问工具时，用户回复「确认继续」「继续执行」「同意继续」，或简短同意「继续」「可以」「同意」「好的」「按推荐」「按你的推荐」即解封（后者表示采纳推荐项）；拒绝（「不可以」「不同意」）、带条件（「继续，但……」）或其他回复不会解封；放行语须是整条回复，夹在更长的文字里不算。解封后再重发本次操作。\n' "${m##*/}" "$TOOL" >&2
    exit 2
  fi
}

for kind in confirm review interaction; do
  if [ "$kind" = interaction ]; then
    interaction_marker_paths
    markers="$INTERACTION_MARKERS"
  else
    markers="$(resolve_marker ".pipeline-pending-$kind" || true)"
  fi
  [ -n "$markers" ] || continue
  # 标记路径逐行读自 fd 3：函数里的命令不会吃掉这份输入。
  while IFS= read -r marker <&3; do
    [ -n "$marker" ] && gate_check_marker "$kind" "$marker"
  done 3<<< "$markers"
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

  # 与其它 hook 共用已验证的项目根，并按宿主 session_id 解析本会话自己的任务，避免跨项目、按 mtime 或借用共享指针把 Skill DAG 错绑到别的会话的 Change。没有已选择 target 时不猜测，入口 skill 会在选定/创建后先 activate。
  sg_proot="$TENON_ROOT"
  [ -n "$sg_proot" ] || return 0
  active_helper="$GATE_DIR/active-change.sh"
  if [ -r "$active_helper" ]; then
    # shellcheck source=active-change.sh
    . "$active_helper"
    sg_change_dir="$(pipeline_session_change_dir "$sg_proot" "$(pipeline_hook_session_id "$INPUT")" || true)"
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
  active_helper="$GATE_DIR/active-change.sh"
  if [ -r "$active_helper" ]; then
    # shellcheck source=active-change.sh
    . "$active_helper"
    mg_change_dir="$(pipeline_session_change_dir "$mg_proot" "$(pipeline_hook_session_id "$INPUT")" || true)"
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
      EVIDENCE_HELPER="$GATE_DIR/skill-evidence.sh"
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
