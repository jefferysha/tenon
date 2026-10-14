#!/usr/bin/env bash
# trust-command.sh — source-only. hooks/gate.sh 的「这个命令段是不是在替用户做信任决定，或在改写 Tenon 的状态目录」识别：
# `tenon test trust`、前缀赋值 `TENON_TEST_TRUST=`，以及 `TENON_RUNTIME_HOME=` / `TENON_RUNTIME_ROOTS=` / `HOME=` / `XDG_STATE_HOME=` 的改写。
#
# 由 hooks/lib/protected-writes.sh 在命令段里出现 trust / TRUST / RUNTIME_HOME / RUNTIME_ROOTS / HOME= 字样，或整条命令同时有解释器名和
# 这些状态目录字样时才 source（见那里的 pipeline_segment_may_take_trust、pipeline_command_may_inline_trust 与 pipeline_load_trust_lib），
# 其余命令不付这份成本。单独成文件是因为这块识别自成一体——只读一个命令段（或整条命令），只写 PIPELINE_REFUSE_KIND 与 PIPELINE_SQUASHED——
# 而 protected-writes.sh 已经很长；与 ack-command.sh 从 gate.sh 拆出同理。
# 本文件缺失时，protected-writes.sh 对出现上述字样的命令段 / 命令按失败关闭拒绝（装得不完整是安装缺陷，放行信任决定才是危险的方向）；
# 发布时由 tools/verify-skills.sh 保证本文件随插件交付。
# 入口：pipeline_segment_takes_trust（命令段）与 pipeline_command_inline_takes_trust（整条命令里的解释器内联代码）。需要 protected-writes.sh
# 已定义 PIPELINE_REFUSE_KIND 与 PIPELINE_PY，并且只对出现上述字样的命令段 / 命令调用它们
# （入口条件的字样表在 protected-writes.sh 的 pipeline_segment_may_take_trust 与 pipeline_command_may_inline_trust，新增识别的字样要同步加在那里）。
# 纯 bash 3.2、线性：不 spawn 任何解释器，不用 eval，不用 grep / sed / awk。
# 这里只按名字拒绝 agent 设置运行时根目录变量，从不读取或解释它们的值；解释它们的只有 kernel resolveProductPaths
# （tools/check-architecture.mjs 因此单独放行本文件点名这两个变量）。

# 拒绝原因为 state 时的提示（protected-writes.sh 的 pipeline_refuse_test_record_write 打印它）。
PIPELINE_STATE_REFUSAL='Tenon 的状态目录（含测试信任存储）不能由 agent 改写（TENON_RUNTIME_HOME、TENON_RUNTIME_ROOTS，以及在 tenon 调用前改 HOME / XDG_STATE_HOME）；测试信任只能由你本人在自己的终端里确认（tenon test trust）'

# `HOME="a b" tenon …`：引号里的值含空格时，按空白切记号会把值的后半当成命令头，躲过「命令头是 tenon」的判断。
# 这里把 HOME= / XDG_STATE_HOME= 后面带引号（含 $'…'）的值压成一个记号 Q，结果放 PIPELINE_SQUASHED。
# 返回 1 = 一段里这样的值多得离谱（上限 16），调用方按拒处理。
PIPELINE_SQUASHED=''
pipeline_squash_home_values() { # $1=raw segment
  local text="${1:-}" pat before quote count=0 dollar='$' dq='"' sq="'"
  for pat in "HOME=$dq" "HOME=$sq" "HOME=$dollar$dq" "HOME=$dollar$sq"; do
    quote="${pat: -1}"
    while :; do
      case "$text" in *"$pat"*) ;; *) break ;; esac
      count=$((count + 1))
      [ "$count" -le 16 ] || return 1
      before="${text%%"$pat"*}"
      text="${text#*"$pat"}"
      case "$text" in *"$quote"*) text="${text#*"$quote"}" ;; *) text='' ;; esac
      text="${before}HOME=Q$text"
    done
  done
  PIPELINE_SQUASHED="$text"
}

# 信任决定只能由用户给（R6）：`tenon test trust`（含 node …/tenon.mjs test trust）与前缀赋值 TENON_TEST_TRUST=。
# 只在命令位置匹配——`grep "tenon test trust" docs/`、`git commit -m "…TENON_TEST_TRUST…"` 不是信任决定。
# 信任存储在 Tenon 的状态目录里（<stateRoot>/test-trust/），stateRoot 由环境变量决定：agent 若能给 tenon 调用指一个自造的状态目录，
# 就绕开了「信任只能由用户本人确认」。所以同一处、同样强度也拒（PIPELINE_REFUSE_KIND=state，提示文案不同）：
#   · TENON_RUNTIME_HOME= / TENON_RUNTIME_ROOTS=：前缀赋值与 export|declare|typeset|readonly|setenv，不论后面跑什么命令；
#   · HOME= / XDG_STATE_HOME=：export 一律拒；没有命令头的单独赋值（`HOME=x; tenon …`，HOME 本就在环境里，之后的命令都吃到它）也拒；
#     作为前缀赋值（含 env / sudo / command 等前缀词之后）只在同段的命令头是 tenon / tenon.mjs（或 node …/tenon.mjs）时拒，
#     `HOME=/tmp/x npm run check:docs` 这类不调用 tenon 的照常放行。
#     值边界静态分不清的写法（整个赋值被引号包住、值里带 ${…} / $(…)）由文件末尾的入口补一道保守兜底：同段有 tenon 记号就拒。
# 尽力而为、识别不到的写法：命令头被引号里的 `&&` 切到另一段的 `bash -c "a && tenon …"`、带参数的前缀词（`sudo -u root HOME=…`）、
# 字样被拼接 / 编码出来的解释器内联代码（`'TENON_'+'RUNTIME_HOME'`、`String.fromCharCode`，pipeline_command_inline_takes_trust 只认字面字样）、
# 内联开关之前带了「开关 + 单独一个值」的解释器调用（`node --require ./x.js -e …`、Python 的 `-W ignore -c …`、`perl -I lib -e …`，值被当成第一个非开关记号）、
# 新写脚本文件里对状态目录的改写：形态 8 的脚本扫描（protected-writes.sh 的 pipeline_script_names_protected）认脚本内容里的 TEST_TRUST 与
# `test trust`（拒绝原因 trust），但不扫 RUNTIME_HOME / RUNTIME_ROOTS / HOME=——测试隔离脚本（例如 tools/vitest.isolate-runtime-home.mjs）
# 合法地设置它们，扫了会误拦正常开发。
# 这里是逐记号的精确判定；值边界静态分不清的 HOME= 赋值由下面的 pipeline_segment_takes_trust 补一道保守兜底。
pipeline_segment_takes_trust_tokens() { # $1=raw segment
  local segment="${1:-}" token ch head='' seen_head=0 exporting=0 step=0 trust_seen=0 home_assign=0 IFS=$' \t'
  local -a toks
  case "$segment" in
    *HOME=*) pipeline_squash_home_values "$segment" || { PIPELINE_REFUSE_KIND=state; return 0; }; segment="$PIPELINE_SQUASHED" ;;
  esac
  segment="${segment//\\ /_}" # `HOME=/tmp/my\ dir`：转义空格不分记号
  for ch in '"' "'" '(' ')' '{' '}' '`'; do segment="${segment//$ch/ }"; done
  read -r -a toks <<< "$segment" || true
  [ "${#toks[@]}" -gt 0 ] || return 1
  for token in "${toks[@]}"; do
    if [ "$seen_head" = 0 ]; then
      case "$token" in
        TENON_TEST_TRUST=*) return 0 ;;
        TENON_RUNTIME_HOME=*|TENON_RUNTIME_ROOTS=*) PIPELINE_REFUSE_KIND=state; return 0 ;;
        HOME=*|XDG_STATE_HOME=*)
          [ "$exporting" = 1 ] && { PIPELINE_REFUSE_KIND=state; return 0; }
          home_assign=1; continue ;;
        export|declare|typeset|readonly|setenv) exporting=1; continue ;;
        [A-Za-z_]*=*|then|do|else|'!'|-*) continue ;;
      esac
      case "${token##*/}" in sudo|command|env|exec|nohup|time|nice|builtin|npx|pnpm|yarn|bunx|dlx) continue ;; esac
      if [ "$exporting" = 1 ]; then
        case "$token" in
          TENON_TEST_TRUST*) return 0 ;;
          TENON_RUNTIME_HOME*|TENON_RUNTIME_ROOTS*) PIPELINE_REFUSE_KIND=state; return 0 ;;
        esac
        continue
      fi
      seen_head=1
      head="${token##*/}"
      case "$head" in
        tenon|tenon.mjs) [ "$home_assign" = 1 ] && { PIPELINE_REFUSE_KIND=state; return 0; }; step=1 ;;
        node|nodejs|bash|sh|zsh|dash) step=0 ;;
        *) return 1 ;;
      esac
      continue
    fi
    case "$token" in -*) continue ;; esac
    case "$step" in
      0) case "${token##*/}" in
           tenon|tenon.mjs) [ "$home_assign" = 1 ] && { PIPELINE_REFUSE_KIND=state; return 0; }; step=1 ;;
           *) return 1 ;;
         esac ;;
      1) [ "$token" = test ] && step=2 || return 1 ;;
      2) [ "$token" = trust ] && { trust_seen=1; break; } || return 1 ;;
    esac
  done
  # 没有命令头的单独赋值：HOME / XDG_STATE_HOME 被改写后，同一命令里之后的 tenon 调用都吃到它。
  if [ "$seen_head" = 0 ] && [ "$home_assign" = 1 ]; then PIPELINE_REFUSE_KIND=state; return 0; fi
  # `tenon test trust --status` 只是看一眼是否已信任，不是信任决定。
  [ "$trust_seen" = 1 ] && case " ${toks[*]} " in *' --status '*) return 1 ;; *) return 0 ;; esac
  return 1
}

# 保守兜底的前半：这一段里有没有「值边界静态分不清」的 HOME= / XDG_STATE_HOME= 赋值记号。
# 逐记号判定把引号 / 括号 / 花括号都换成空格再按空白切，值里带空格或展开时，值的后半会被误当成命令头，tenon 调用就躲过了
# 「命令头是 tenon」的判断。两类写法：
#   · 整个赋值被引号包住：`env 'HOME=/tmp/a b' tenon …`、`"HOME=/tmp/a b" tenon …`（后半 `b` 成了命令头）；
#   · 值里带命令替换 / 参数展开：`HOME=${X}/y tenon …`、`HOME=$(pwd)/x tenon …`（括号 / 花括号换成空格后，里面的词成了命令头）。
# 这里看原始记号（只按空白切，引号等字符原样保留）：去掉记号开头的引号 / $ / 括号 / 花括号 / 反引号之后以 HOME= 或 XDG_STATE_HOME=
# 开头（MYHOME=、XDG_CONFIG_HOME= 这类别的变量名不算），并且「开头确有被去掉的字符」或「值里含引号 / $ / 括号 / 花括号 / 反引号 / 反斜杠」
# 才算存疑。值是干净字面量（`HOME=/tmp/x`）时边界是确定的，交给逐记号判定，不在这里多拦。
pipeline_home_value_doubtful() { # $1=squashed segment → 0 = 有存疑的赋值记号
  local token bare value IFS=$' \t'
  local -a raw
  read -r -a raw <<< "${1:-}" || true
  [ "${#raw[@]}" -gt 0 ] || return 1
  for token in "${raw[@]}"; do
    case "$token" in *HOME=*) ;; *) continue ;; esac
    bare="$token"
    while :; do
      case "$bare" in '"'*|"'"*|'$'*|'('*|'{'*|'`'*) bare="${bare:1}" ;; *) break ;; esac
    done
    case "$bare" in HOME=*|XDG_STATE_HOME=*) ;; *) continue ;; esac
    [ "$bare" = "$token" ] || return 0
    value="${bare#*=}"
    case "$value" in *'"'*|*"'"*|*'$'*|*'('*|*')'*|*'{'*|*'}'*|*'`'*|*'\'*) return 0 ;; esac
  done
  return 1
}

# `tenon` 作为独立的词出现：tenon、tenon.mjs、/usr/local/bin/tenon、'tenon'；不是 tenon-local、.tenon、mytenon 这类更长名字的一部分
# （Tenon 自己的仓库常检出在 …/tenon-local/…，按子串认会让带绝对路径又读 HOME 的内联代码全被误拦）。
pipeline_names_tenon_word() { # $1=text → 0 when it contains tenon as a word
  case "${1:-}" in
    tenon|tenon[!A-Za-z0-9_-]*|*[!A-Za-z0-9_.-]tenon|*[!A-Za-z0-9_.-]tenon[!A-Za-z0-9_-]*) return 0 ;;
  esac
  return 1
}

# 解释器内联代码里的信任 / 状态目录字样（整条命令的判定，不是命令段的）。上面逐记号的判定只认命令位置，而内联代码里的赋值与子进程调用躲得过它：
# `node -e "process.env.TENON_RUNTIME_HOME=…; execSync('tenon …')"`、Python 的 `-c "os.environ['TENON_TEST_TRUST']=…"`、
# `ruby -e "ENV['XDG_STATE_HOME']=…"`；内联代码里的 `;` 还会把代码切到后面的命令段里，按段看不全。所以看整条命令（shell 包装已展开），
# 同时满足下面两条就按 PIPELINE_REFUSE_KIND=state 拒：
#   · 有解释器内联代码：某个记号的路径末段是 $PIPELINE_PY 系列（Python 的各版本）/ node / nodejs / ruby / perl / php / lua / deno / bun / Rscript / osascript，
#     其后、第一个非开关记号（脚本路径、模块名）之前的开关里有内联代码开关（-c -e -E -p -r --eval，以及 -pe -ne -lc 这类合并写法）；
#     第一个非开关记号说明这个解释器跑的不是内联代码，之后别的命令的 -c / -e（`grep -c`、`grep -e`）与它无关；`bash -c` / `sh -c` 不在此列，它们已被展开后逐段判定；
#   · 整条命令出现 TEST_TRUST / RUNTIME_HOME / RUNTIME_ROOTS / XDG_STATE_HOME，或者同时出现独立的词 tenon（见 pipeline_names_tenon_word）与（trust 或 HOME）。
# 不区分字样在代码里还是在别处，宁多拒；没有 tenon 的 `node -e "console.log(process.env.HOME)"`、没有内联代码的 `grep -rn TENON_TEST_TRUST docs/` 照常放行。
# 入口条件（命令里有解释器名和上面的字样）在 protected-writes.sh 的 pipeline_command_may_inline_trust：那里的字样表只能比这里宽（它按子串认 tenon），新增字样要两处同步。
pipeline_command_inline_takes_trust() { # $1=decoded command
  local command="${1:-}" token seen_interp=0 IFS=$' \t\n"\'(){};|&`'
  local -a toks
  case "$command" in
    *TEST_TRUST*|*RUNTIME_HOME*|*RUNTIME_ROOTS*|*XDG_STATE_HOME*) ;;
    *tenon*)
      pipeline_names_tenon_word "$command" || return 1
      case "$command" in *trust*|*HOME*) ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
  # 引号 / 括号 / 花括号 / 反引号 / ;|& 和空白一起作分隔符，一次 read 切完（逐字符替换成空格在 bash 3.2 下对大命令是二次方的）。
  read -r -d '' -a toks <<< "$command" || true
  [ "${#toks[@]}" -gt 0 ] || return 1
  for token in "${toks[@]}"; do
    [ -n "$token" ] || continue # 相邻的非空白分隔符之间的空字段
    if [ "$seen_interp" = 1 ]; then
      case "$token" in
        -c|-e|-E|-p|-r|--eval|--eval=*|-[a-zA-Z]*[ce]) PIPELINE_REFUSE_KIND=state; return 0 ;;
        -*) continue ;;
      esac
      seen_interp=0 # 第一个非开关记号（脚本路径、模块名……）：这个解释器跑的不是内联代码；这个记号本身还可能是下一个解释器，往下再判一次
    fi
    case "${token##*/}" in
      "$PIPELINE_PY"|"$PIPELINE_PY"[0-9]*|node|nodejs|ruby|perl|php|lua|deno|bun|Rscript|osascript) seen_interp=1 ;;
    esac
  done
  return 1
}

# 入口。先走上面逐记号的精确判定（TENON_TEST_TRUST / TENON_RUNTIME_* / tenon test trust / 干净字面量的 HOME= 前缀赋值，结论与原因都不变），
# 它放行之后再补一道保守兜底：同一段里有存疑的 HOME= / XDG_STATE_HOME= 赋值记号（见 pipeline_home_value_doubtful），并且该段任一记号的
# 路径末段是 tenon / tenon.mjs，就按 PIPELINE_REFUSE_KIND=state 拒。静态分不清值的边界，所以宁多拒：命令里没有 tenon 记号的照常放行，
# 赋值记号后面跟别的命令、只在参数里提到 tenon 的干净写法（`HOME=/tmp/x grep tenon README.md`）也照常放行。
# 注意：PIPELINE_SQUASHED 是上面的 pipeline_segment_takes_trust_tokens 刚为这一段压好的结果（段里有 HOME= 字样时一定会压）。
pipeline_segment_takes_trust() { # $1=raw segment
  local segment="${1:-}" token ch IFS=$' \t'
  local -a toks
  pipeline_segment_takes_trust_tokens "$segment" && return 0
  case "$segment" in *HOME=*) ;; *) return 1 ;; esac
  pipeline_home_value_doubtful "$PIPELINE_SQUASHED" || return 1
  segment="$PIPELINE_SQUASHED"
  for ch in '"' "'" '(' ')' '{' '}' '`'; do segment="${segment//$ch/ }"; done
  read -r -a toks <<< "$segment" || true
  [ "${#toks[@]}" -gt 0 ] || return 1
  for token in "${toks[@]}"; do
    case "${token##*/}" in tenon|tenon.mjs) PIPELINE_REFUSE_KIND=state; return 0 ;; esac
  done
  return 1
}
