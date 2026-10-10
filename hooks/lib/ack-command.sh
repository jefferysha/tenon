#!/usr/bin/env bash
# ack-command.sh — source-only. hooks/gate.sh 拒绝 agent 自己执行手动 `tenon review acknowledge`（不带 --delegated）的静态判定：
# 把命令文本还原成 shell 执行前的样子，再按命令段、按词认出 tenon → review → 确认子命令的链条。
#
# gate.sh 只在预筛命中时才加载本文件（命令字段里 acknowledge 的各个字母依次出现，或带转义编码，见 gate.sh 的 ACK_CANDIDATE），
# 其余调用不付这份成本。本文件缺失时，预筛已命中的命令按失败关闭拒绝（装得不完整是安装缺陷，拒绝手动确认是安全的方向；
# 这也意味着缺库时字母凑得上的长命令都会被拒），预筛没命中的照常放行；发布时由 tools/verify-skills.sh 保证本文件随插件交付。
# 入口：pipeline_command_runs_manual_acknowledge。需要 gate.sh 已定义 pipeline_text_may_spell_acknowledge（预筛也用它）。
# 纯 bash 3.2、线性：热路径不 spawn 任何解释器，不用 eval，不用 grep / sed / awk。
#
# 判定只看命令文本（不看宿主工具标签）；尽力而为。手动确认经终端通道会批准冻结的豁免清单，而 hook 无法证明「人在场」，
# 所以 agent 的 shell 调用里出现手动确认任何时候都拒（不论有没有评审标记，AFK 也照拒）；持续授权下的 --delegated 不批准豁免，放行。
#
# ── 还原顺序（固定，不能调换）──
#   0. 外层 shell 包装：整条命令是 `<shell> [-lc|-c] "整串"`（Codex 的 /bin/zsh -lc "…"）且整串里没有同种引号时，取出整串当命令；
#   1. JSON 转义的 ASCII：json-input.sh 对 \uXXXX 不解码，原样留成 \\uXXXX，这里把码点 0x04–0x7e 的 ASCII 字符还原
#      （\u0000–\u0003 与 \u007f 不还原：NUL 放不进 bash 字符串，\u0001 是 bash 3.2 内部的转义标记，\u0002 \u0003 是下面的标记字符）；
#   2. 转义编码：\xHH、\NNN（1–3 位八进制）、\uHHHH、\UHHHHHHHH 还原成 ASCII 字符（码点范围同上）。$'…' 里才是转义，这里不分
#      引号上下文一律还原（只会让更多命令进入状态机判定）；
#   3. 反斜杠续行（反斜杠与换行一起去掉）、反斜杠、单双引号、$'…' / $"…" 引号前的 $；
#   4. 花括号展开（bash 与 zsh 都展开）：对含 { 与 , 或 .. 的词做有界展开（逗号组、嵌套、多组、单字母序列 {x..y}，展开顺序与 shell 一致）；
#      没认出的带步长写法（{x..y..N} 等）原样留着，字母能依次拼出确认子命令就按下面的超预算规则处理；
#   5. *acknowledge* 的快速判断（必须在还原之后：词中拆开的写法原文里没有这个词）；
#   6. 按 & | ; ( ) { } < > ` 与换行拆命令段，每段按词走状态机。
# 所以 ackn""owledge、a'c'knowledge、ackno\wledge、$'ack'nowledge、$'\x61'cknowledge、$'\141'cknowledge、ack\⏎nowledge、
# ack{n,}owledge、{tenon,review,acknowledge}，命令名与 review 也拆开的 ten""on re'view，都和整词写法一样判定。
#
# ── 标记字符 ──
#   · PIPELINE_MARK（\002）：反斜杠、转义编码、花括号展开还原出来的字符前面垫一个。只用来判断「是不是 --delegated 开关」，
#     其它判断先把标记去掉。不用 \001 / \177：那是 bash 3.2 内部的转义标记，放进模式替换会出错；
#   · PIPELINE_QMARK（\003）：一个参数里的空白会让它在后面被切成几个词，参数延续部分的词前面垫一个——带空白的引号串里的每个词
#     （"x --delegated y" 变成 QMARKx QMARK--delegated QMARKy），以及被反斜杠转义的空白之后接着的词（a\ b 的 b）。
#     带这个标记的词是别的参数的一部分，不是独立的词，更不是 tenon 的开关。
#
# ── 状态机与 --delegated 口径 ──
#   命令段的首个命令词（跳过 NAME=值 赋值）是 tenon 入口（tenon / tenon.mjs / src/main.ts，取路径末段；npx 一类的包名
#   tenon@版本 / @tenon/cli[@版本]），或是包装器 / 解释器 /
#   复合命令关键字（此时在整段里找 tenon 入口）；入口之后依次是 review、确认子命令。review 的定义是 `review <sub> [name]` 加
#   --event / --delegated / --as / --reason 四个选项，commander 允许选项出现在 sub 之前，所以 review 之后：
#   · 带值选项 --as / --event / --reason 的下一个词是它的值（不是 sub，也不是开关）；`--` 之后全是位置参数；
#   · 第一个位置参数就是 sub：它是 acknowledge → 确认；是别的词（request / revoke / 任何别的）→ 这条 review 不是确认；
#   · 值或位置参数带 QMARK（占了几个词、看不出边界），或引号核对做不了（见下），就不再按「第一个位置参数」判断：段里出现
#     acknowledge 词就算确认（失败关闭）；
#   · --delegated 是开关的条件：原词恰好是 --delegated（不带任何标记），不在 `--` 之后，不是带值选项的值，确认子命令那个词也不带
#     QMARK。不含空白的整词引号（"--delegated"、--deleg""ated）照常算开关；带空白的引号串里的、转义空白连起来的、反斜杠 / 转义编码 /
#     花括号拼出来的、确认子命令在引号串里而 --delegated 在串外的，一律不算开关；
#   · 引号区间按 shell 的规则核对（区间外遇到哪种引号就开启哪种，区间里只有同种引号能关闭它，另一种引号是字面字符）。核对做不了的
#     三种情况——引号字符紧跟在反斜杠 / 转义编码还原出的字符之后（字面引号）、带空白的引号区间跨行、引号字符超过 1000 个（逐片扫描
#     在 bash 3.2 下每片约 0.1 ms）或区间里单片超过 1024 字符——这条命令的 --delegated 开关一律不认，带值选项的值也不再按「占一个词」处理。
#
# ── 失败关闭的取舍（宁可误拦，不可漏拦；以下写法会被误拦，tools/test-hooks.sh 里有「已知误拦」表固定住现状）──
#   · 还原不分引号上下文，所以引号里的 "{tenon,review,acknowledge}" 这种本不展开的写法也按展开判定；
#   · 花括号展开有预算（200 个词、每词 128 个结果、总步数 20000）。超出预算的词、没认出的带步长花括号词，只要命令里出现
#     acknowledge，或某个没展开的词的字母能依次拼出它，就按手动确认拦（链条核实不了）；所以 echo ack{n..n..1}owledge 也被拦；
#   · 首个命令词是包装器时在整段里找 tenon 入口，名单里的包装器后面跟的引号串被拆成词链，所以 timeout 5 rg 'tenon review
#     acknowledge' docs、find -exec grep -l '…' {} +、env FOO=1 echo tenon review acknowledge 这类只是提到的写法也被拦；
#     heredoc 正文里行首就是 tenon review acknowledge 的行同理（命令段按换行拆开，正文行被当成命令）；
#   · 非开头的 shell -c 包装里的委托确认（sudo bash -c '…--delegated'、ssh host '…--delegated'）：确认子命令在引号串里，--delegated
#     不算开关，被拦。整条命令以 `bash -c '…'` / `/bin/zsh -lc "…"` 开头、且整串里没有同种引号的写法会先取出整串，照常放行委托确认；
#   · 含转义引号（\" \'）、引号字符超过 1000 个的命令，--delegated 一律不认；
#   · 值或位置参数占了几个词（带空白的引号串、转义空白）的写法，sub 之前出现 acknowledge 词就按确认拦。
#
# ── 读取上限 ──
#   gate.sh 读命令的上限是 ACK_COMMAND_MAX（64 KiB 编码后的字符）：命令的 JSON 解码在密集引号 / 转义时约每 KB 20 ms，hooks.json 给
#   gate 5 秒，本机实测 64 KiB 的最坏载荷整个 gate 约 1.5 秒。超过上限的命令不进本文件，gate.sh 只做一次线性的字面检查：原文含
#   acknowledge 就拦（不看 --delegated），不含就不判定。
#
# ── 仍覆盖不到的写法（不宣称覆盖）──
#   变量或命令替换拼出的字符串（含 eval、printf 拼出的命令名与子命令）、别名与 shell 函数、脚本文件里的调用、脚本语言解释器内联程序
#   （-c / -e）里构造的调用、靠文件系统展开的通配符路径（/usr/lo*/bin/tenon）、名单外的启动器（没列进 pipeline_word_wraps_command
#   的包装器与解释器）、超过 64 KiB 且原文不含 acknowledge 字样的命令里的拆分 / 编码写法。这是挡住 agent 顺手自批的一道门，真正的
#   边界是 CLI 与 server 对「人在场」的要求。
#
# ── 线性处理 ──
#   bash 3.2 的 `${text//模式/替换}` 对匹配个数是平方级（几万个引号的命令要跑几分钟），而 hook 超时会被宿主当非阻断错误放行，
#   所以不用全局替换去引号，而是用 `read -a` 按分隔字符一次切开，丢掉空片，再用空 IFS 一次拼回（含空串的数组直接拼会漏出
#   bash 3.2 内部的 \177 标记，所以空片要先丢）。`${text:偏移:1}` 在 bash 3.2 下每次都要复制整个字符串，不用来逐字符扫描整条命令
#   （花括号展开只对不超过 256 字符的单个词这么做）。

PIPELINE_MARK=$'\002' # 反斜杠、转义编码、花括号展开还原出来的字符前面垫它
PIPELINE_QMARK=$'\003' # 带空白的引号串里的词前面垫它

pipeline_strip_chars() { # $1=text $2=要去掉的字符（都是非空白字符）→ _PIPELINE_STRIPPED
  local text="${1:-}" IFS part last
  local -a pieces kept
  _PIPELINE_STRIPPED="$text"
  IFS="${2:-}"
  read -r -d '' -a pieces <<< "$text" || true
  last=$((${#pieces[@]} - 1))
  [ "$last" -ge 0 ] || return 0
  pieces[$last]="${pieces[$last]%$'\n'}" # here-string 补的换行落在最后一片，不属于文本
  kept=()
  for part in "${pieces[@]}"; do
    [ -z "$part" ] || kept[${#kept[@]}]="$part"
  done
  IFS=''
  _PIPELINE_STRIPPED=''
  [ "${#kept[@]}" -eq 0 ] || _PIPELINE_STRIPPED="${kept[*]}"
}

pipeline_decode_json_ascii_escapes() { # $1=json-input.sh 解码后的命令 → _PIPELINE_DECODED（\\u00XX 还原成 ASCII 字符）
  local text="${1:-}" IFS part hex ch last first=1 held=0
  local -a pieces kept
  _PIPELINE_DECODED="$text"
  case "$text" in *'\\u00'*) ;; *) return 0 ;; esac
  IFS='\'
  read -r -d '' -a pieces <<< "$text" || true
  last=$((${#pieces[@]} - 1))
  [ "$last" -ge 0 ] || return 0
  pieces[$last]="${pieces[$last]%$'\n'}"
  kept=()
  # 按反斜杠切开后，除第一片外每片前面都有一个反斜杠。`\\u00XX` 是紧挨着的两个反斜杠夹一个空片：遇到空片先把它前面的反斜杠
  # 扣住（held），看下一片是不是 u00XX——是就两个反斜杠一起换成字符，不是就把扣住的补回去。\u0000–\u0003、\u007f 与 ≥ \u0080 保持原样。
  for part in "${pieces[@]}"; do
    if [ "$first" = 1 ]; then
      first=0
      [ -z "$part" ] || kept[${#kept[@]}]="$part"
      continue
    fi
    if [ "$held" = 1 ]; then
      held=0
      case "$part" in
        u00[0-7][0-9a-fA-F]*)
          hex="${part:3:2}"
          case "$hex" in
            00|01|02|03|7f|7F) ;; # 同 pipeline_restore_shell_escapes：这几个码点不还原
            *)
              printf -v ch "\\x$hex"
              kept[${#kept[@]}]="$ch${part:5}"
              continue
              ;;
          esac
          ;;
      esac
      kept[${#kept[@]}]='\'
    fi
    if [ -z "$part" ]; then held=1; continue; fi
    kept[${#kept[@]}]="\\$part"
  done
  [ "$held" = 0 ] || kept[${#kept[@]}]='\'
  IFS=''
  _PIPELINE_DECODED=''
  [ "${#kept[@]}" -eq 0 ] || _PIPELINE_DECODED="${kept[*]}"
}

pipeline_restore_shell_escapes() { # $1=命令文本 → _PIPELINE_RESTORED（\xHH、\NNN、\uHHHH、\UHHHHHHHH 还原成 ASCII 字符，前面垫一个 MARK）
  local text="${1:-}" IFS part last first=1 kind max class digits count c value hex ch
  local -a pieces kept
  _PIPELINE_RESTORED="$text"
  case "$text" in *'\'*) ;; *) return 0 ;; esac
  IFS='\'
  read -r -d '' -a pieces <<< "$text" || true
  last=$((${#pieces[@]} - 1))
  [ "$last" -ge 0 ] || return 0
  pieces[$last]="${pieces[$last]%$'\n'}"
  kept=()
  # 按反斜杠切开后，除第一片外每片前面都有一个反斜杠；片首是 x / u / U / 八进制数字时，取前导数字串当码点。
  # 码点在 0x04–0x7e 内才还原（见下面的说明；≥ 0x80 不是 ASCII），其余原样留给后面的去反斜杠。
  for part in "${pieces[@]}"; do
    if [ "$first" = 1 ]; then
      first=0
      [ -z "$part" ] || kept[${#kept[@]}]="$part"
      continue
    fi
    kind="${part:0:1}"
    case "$kind" in
      x) max=2 class=hex digits="${part:1}" ;;
      u) max=4 class=hex digits="${part:1}" ;;
      U) max=8 class=hex digits="${part:1}" ;;
      [0-7]) max=3 class=oct digits="$part" ;;
      *) kept[${#kept[@]}]="\\$part"; continue ;;
    esac
    count=0
    while [ "$count" -lt "$max" ]; do
      c="${digits:$count:1}"
      case "$class$c" in hex[0-9a-fA-F]|oct[0-7]) count=$((count + 1)) ;; *) break ;; esac
    done
    if [ "$count" -eq 0 ]; then kept[${#kept[@]}]="\\$part"; continue; fi
    if [ "$class" = hex ]; then value=$((16#${digits:0:$count})); else value=$((8#${digits:0:$count})); fi
    # \0、bash 3.2 内部的 \1 / \177，以及两个标记字符 MARK(\2) QMARK(\3) 不还原：它们进字符串后会让模式匹配出错或冒充标记，
    # 也不是任何关键词的组成字符。
    if [ "$value" -ge 4 ] && [ "$value" -le 126 ]; then
      printf -v hex '%02x' "$value"
      printf -v ch "\\x$hex"
      kept[${#kept[@]}]="$PIPELINE_MARK$ch${digits:$count}"
    else
      kept[${#kept[@]}]="\\$part"
    fi
  done
  IFS=''
  _PIPELINE_RESTORED=''
  [ "${#kept[@]}" -eq 0 ] || _PIPELINE_RESTORED="${kept[*]}"
}

# 去掉引号并给带空白的引号串里的词垫 QMARK。$1 是已经把反斜杠换成 MARK 的文本（引号还在）。
# 成功 → _PIPELINE_QMARKED = 去引号并垫好 QMARK 的文本；返回 1 = 引号区间没法可靠判断，调用方改成「--delegated 开关一律不认」。
# 引号区间按 shell 的规则划：区间外遇到哪种引号就开启那种区间，区间里只有同种引号能关闭它，另一种引号是字面字符。
# 为了拿到每个引号字符是哪一种：只有一种引号时不用查；两种混用时再按双引号切一次，用累计偏移把两次切分对齐。
pipeline_quote_mark_whitespace() {
  local text="${1:-}" IFS part last k n i kind allkind state=0 start close ws mixed=0 dpos dj cpos
  local -a pieces dparts kinds flags kept
  IFS="\"'"
  read -r -d '' -a pieces <<< "$text" || true
  last=$((${#pieces[@]} - 1))
  [ "$last" -ge 1 ] || return 1
  # 逐片扫描在 bash 3.2 下每片约 0.1 ms：引号字符超过 1000 个的命令不会是正常的确认调用，不核对，--delegated 开关一律不认。
  [ "$last" -le 1000 ] || return 1
  pieces[$last]="${pieces[$last]%$'\n'}"
  case "$text" in
    *'"'*)
      case "$text" in
        *"'"*) mixed=1 ;;
        *) allkind=d ;;
      esac
      ;;
    *) allkind=s ;;
  esac
  kinds=()
  if [ "$mixed" = 1 ]; then
    IFS='"'
    read -r -d '' -a dparts <<< "$text" || true
    n=$((${#dparts[@]} - 1))
    dparts[$n]="${dparts[$n]%$'\n'}"
    dpos=${#dparts[0]} dj=0 cpos=0 k=0
    while [ "$k" -lt "$last" ]; do
      cpos=$((cpos + ${#pieces[$k]}))
      if [ "$dj" -lt "$n" ] && [ "$cpos" -eq "$dpos" ]; then
        kinds[$k]=d
        dj=$((dj + 1))
        dpos=$((dpos + 1 + ${#dparts[$dj]}))
      else
        kinds[$k]=s
      fi
      cpos=$((cpos + 1))
      k=$((k + 1))
    done
  fi
  flags=()
  k=0
  while [ "$k" -le "$last" ]; do
    close=0
    if [ "$k" -lt "$last" ]; then
      case "${pieces[$k]}" in *"$PIPELINE_MARK") return 1 ;; esac # 字面引号（被转义 / 由转义编码还原出来），区间边界划不准
      if [ "$mixed" = 1 ]; then kind="${kinds[$k]}"; else kind="$allkind"; fi
      case "$state$kind" in
        0s) state=1; start=$((k + 1)) ;;
        0d) state=2; start=$((k + 1)) ;;
        1s|2d) close=1 ;;
      esac
    elif [ "$state" != 0 ]; then
      close=1 # 到文本结束还没关上的区间，也按区间算
    fi
    if [ "$close" = 1 ]; then
      state=0
      i=$start ws=0
      while [ "$i" -le "$k" ]; do
        case "${pieces[$i]}" in
          *$'\n'*) return 1 ;; # 区间跨行：命令段已经按换行拆开，区间边界划不准
          *' '*|*$'\t'*) ws=1 ;;
        esac
        i=$((i + 1))
      done
      if [ "$ws" = 1 ]; then
        i=$start
        while [ "$i" -le "$k" ]; do flags[$i]=1; i=$((i + 1)); done
      fi
    fi
    k=$((k + 1))
  done
  IFS=''
  kept=()
  k=0
  while [ "$k" -le "$last" ]; do
    part="${pieces[$k]}"
    [ "$k" -ge "$last" ] || part="${part%\$}" # 紧贴在引号前的 $ 是 $'…' / $"…" 的前缀
    if [ "${flags[$k]:-0}" = 1 ]; then
      [ "${#part}" -le 1024 ] || return 1 # 逐词垫标记用的模式替换对匹配个数是平方级，只对小片做
      part="$PIPELINE_QMARK${part// / $PIPELINE_QMARK}"
      part="${part//$'\t'/$'\t'$PIPELINE_QMARK}"
    fi
    [ -z "$part" ] || kept[${#kept[@]}]="$part"
    k=$((k + 1))
  done
  _PIPELINE_QMARKED=''
  [ "${#kept[@]}" -eq 0 ] || _PIPELINE_QMARKED="${kept[*]}"
  return 0
}

# shell 执行前会去掉的续行、反斜杠、引号与 $'…' / $"…" 的 $。去掉的反斜杠在原位留一个 MARK。
# 一个参数里的空白（带空白的引号串、被反斜杠转义的空白）会让一个参数在后面被切成几个词：延续部分的词前面垫 QMARK，
# 后面的状态机靠它分清「独立的词」和「别的参数的一部分」。
# _PIPELINE_NO_SWITCH = 1 表示引号区间没法可靠判断：--delegated 开关一律不认，带值选项的值也不再按「占一个词」处理。
pipeline_shell_unquote() { # $1=命令文本 → _PIPELINE_UNQUOTED
  local text="${1:-}" IFS part last index first
  local -a pieces kept
  _PIPELINE_UNQUOTED="$text"
  _PIPELINE_NO_SWITCH=0
  case "$text" in
    *'\'*)
      IFS='\'
      read -r -d '' -a pieces <<< "$text" || true
      last=$((${#pieces[@]} - 1))
      if [ "$last" -ge 0 ]; then
        pieces[$last]="${pieces[$last]%$'\n'}"
        kept=()
        first=1
        for part in "${pieces[@]}"; do
          if [ "$first" = 1 ]; then
            first=0
          else
            case "$part" in
              $'\n'*) part="${part#$'\n'}" ;; # 反斜杠 + 换行是续行，两个字符都不留
              ' '*|$'\t'*) part="${part:0:1}$PIPELINE_QMARK${part:1}" ;; # 反斜杠 + 空白：空白属于前一个词，后面接着的是它的延续
            esac
          fi
          [ -z "$part" ] || kept[${#kept[@]}]="$part"
        done
        IFS="$PIPELINE_MARK"
        text=''
        [ "${#kept[@]}" -eq 0 ] || text="${kept[*]}"
      fi
      ;;
  esac
  case "$text" in
    *'"'*|*"'"*)
      local quoted="$text"
      IFS="\"'"
      read -r -d '' -a pieces <<< "$text" || true
      last=$((${#pieces[@]} - 1))
      if [ "$last" -ge 0 ]; then
        pieces[$last]="${pieces[$last]%$'\n'}"
        kept=()
        index=0
        for part in "${pieces[@]}"; do
          [ "$index" -ge "$last" ] || part="${part%\$}" # 紧贴在引号前的 $ 是 $'…' / $"…" 的前缀
          index=$((index + 1))
          [ -z "$part" ] || kept[${#kept[@]}]="$part"
        done
        IFS=''
        text=''
        [ "${#kept[@]}" -eq 0 ] || text="${kept[*]}"
        if pipeline_quote_mark_whitespace "$quoted"; then text="$_PIPELINE_QMARKED"; else _PIPELINE_NO_SWITCH=1; fi
      fi
      ;;
  esac
  _PIPELINE_UNQUOTED="$text"
}

pipeline_clean_marks() { # $1=text → _PIPELINE_CLEAN（去掉所有 MARK / QMARK，线性）
  _PIPELINE_CLEAN="${1:-}"
  case "$_PIPELINE_CLEAN" in
    *"$PIPELINE_MARK"*|*"$PIPELINE_QMARK"*)
      pipeline_strip_chars "$_PIPELINE_CLEAN" "$PIPELINE_MARK$PIPELINE_QMARK"
      _PIPELINE_CLEAN="$_PIPELINE_STRIPPED"
      ;;
  esac
}

# 找词里最左的有效花括号组：{a,b}（最外层逗号分隔）或单字母序列 {x..y}；${…} 是参数展开，不算。
# 0 = 找到（前缀 _PIPELINE_BRACE_PRE、后缀 _PIPELINE_BRACE_POST、备选 _PIPELINE_BRACE_ALTS），1 = 没有，2 = 总步数超限。
pipeline_brace_find_group() { # $1=词（无空白）
  local s="${1:-}" len pos=0 depth j m c inner cur sawcomma ca cb code hex
  local -a alts
  len=${#s}
  while [ "$pos" -lt "$len" ]; do
    _PIPELINE_BRACE_STEPS=$((_PIPELINE_BRACE_STEPS + 1))
    [ "$_PIPELINE_BRACE_STEPS" -le 20000 ] || return 2
    if [ "${s:$pos:1}" = '{' ] && { [ "$pos" -eq 0 ] || [ "${s:$((pos - 1)):1}" != '$' ]; }; then
      depth=0 j=$pos
      while [ "$j" -lt "$len" ]; do
        c="${s:$j:1}"
        if [ "$c" = '{' ]; then depth=$((depth + 1))
        elif [ "$c" = '}' ]; then depth=$((depth - 1)); [ "$depth" -gt 0 ] || break
        fi
        j=$((j + 1))
      done
      _PIPELINE_BRACE_STEPS=$((_PIPELINE_BRACE_STEPS + j - pos))
      if [ "$j" -lt "$len" ]; then
        inner="${s:$((pos + 1)):$((j - pos - 1))}"
        alts=() cur='' depth=0 sawcomma=0 m=0
        while [ "$m" -lt "${#inner}" ]; do
          c="${inner:$m:1}"
          case "$c" in
            '{') depth=$((depth + 1)); cur="$cur$c" ;;
            '}') depth=$((depth - 1)); cur="$cur$c" ;;
            ',') if [ "$depth" -eq 0 ]; then alts[${#alts[@]}]="$cur"; cur=''; sawcomma=1; else cur="$cur$c"; fi ;;
            *) cur="$cur$c" ;;
          esac
          m=$((m + 1))
        done
        _PIPELINE_BRACE_STEPS=$((_PIPELINE_BRACE_STEPS + m))
        if [ "$sawcomma" = 1 ]; then
          alts[${#alts[@]}]="$cur"
        else
          case "$inner" in
            [a-zA-Z]..[a-zA-Z])
              printf -v ca '%d' "'${inner:0:1}"
              printf -v cb '%d' "'${inner:3:1}"
              code=$ca
              while :; do
                printf -v hex '%02x' "$code"
                printf -v c "\\x$hex"
                alts[${#alts[@]}]="$c"
                [ "$code" -ne "$cb" ] || break
                if [ "$ca" -le "$cb" ]; then code=$((code + 1)); else code=$((code - 1)); fi
              done
              sawcomma=1
              ;;
          esac
        fi
        if [ "$sawcomma" = 1 ]; then
          _PIPELINE_BRACE_PRE="${s:0:$pos}"
          _PIPELINE_BRACE_POST="${s:$((j + 1))}"
          _PIPELINE_BRACE_ALTS=("${alts[@]}")
          return 0
        fi
      fi
    fi
    pos=$((pos + 1))
  done
  return 1
}

# 把一个词展开成 shell 会得到的词（深度优先、从左到右，和 bash 的顺序一致）。0 = 成功，结果在 _PIPELINE_BRACE_WORDS（空串丢掉，
# 因为不带引号的空词会被 shell 丢掉）；1 = 结果多于 128 个或总步数超限。
pipeline_brace_expand_word() { # $1=词（无空白）
  local s n k rc
  local -a work
  _PIPELINE_BRACE_WORDS=()
  work=("${1:-}")
  while [ "${#work[@]}" -gt 0 ]; do
    n=$((${#work[@]} - 1))
    s="${work[$n]}"
    if [ "$n" -eq 0 ]; then work=(); else work=("${work[@]:0:$n}"); fi
    pipeline_brace_find_group "$s"; rc=$?
    case "$rc" in
      0)
        k=${#_PIPELINE_BRACE_ALTS[@]}
        while [ "$k" -gt 0 ]; do
          k=$((k - 1))
          work[${#work[@]}]="$_PIPELINE_BRACE_PRE${_PIPELINE_BRACE_ALTS[$k]}$_PIPELINE_BRACE_POST"
        done
        ;;
      1) [ -z "$s" ] || _PIPELINE_BRACE_WORDS[${#_PIPELINE_BRACE_WORDS[@]}]="$s" ;;
      *) return 1 ;;
    esac
    [ "$((${#work[@]} + ${#_PIPELINE_BRACE_WORDS[@]}))" -le 128 ] || return 1
  done
  return 0
}

# 对命令文本里含花括号展开语法的词（有 { 且有 , 或 ..）做有界展开，展开出的词前垫 MARK 后用空格接回原处。
# 展开只作用于一个词：词在空白和 & | ; ( ) < > ` 处结束（`echo hi;{tenon,review}` 里的词是 {tenon,review}，不是 hi;{tenon,review}），
# 所以先按这些元字符切段、再按空白切词；段之间一律接回 `;`——后面按命令段切分时这些元字符本来就不分彼此。
# _PIPELINE_BRACED = 展开后的文本；_PIPELINE_BRACE_OVERFLOW = 1 表示有词没展开（超预算，或展开后还留着没认出的花括号组）；
# _PIPELINE_BRACE_HIT = 1 表示其中某个没展开的词的字母能依次拼出 acknowledge。
pipeline_expand_braces() { # $1=命令文本
  local text="${1:-}" IFS line seg tok word budget=200
  local -a lines segs toks out_lines out_segs out_toks
  _PIPELINE_BRACED="$text"
  _PIPELINE_BRACE_OVERFLOW=0
  _PIPELINE_BRACE_HIT=0
  _PIPELINE_BRACE_STEPS=0
  case "$text" in *'{'*) ;; *) return 0 ;; esac
  IFS=$'\n'
  read -r -d '' -a lines <<< "$text" || true
  [ "${#lines[@]}" -gt 0 ] || return 0
  out_lines=()
  for line in "${lines[@]}"; do
    case "$line" in
      *'{'*) ;;
      *) out_lines[${#out_lines[@]}]="$line"; continue ;;
    esac
    IFS='&|;()<>`'
    read -r -a segs <<< "$line" || true
    out_segs=()
    for seg in ${segs[@]+"${segs[@]}"}; do
      case "$seg" in
        *'{'*) ;;
        *) [ -z "$seg" ] || out_segs[${#out_segs[@]}]="$seg"; continue ;;
      esac
      IFS=$' \t'
      read -r -a toks <<< "$seg" || true
      out_toks=()
      for tok in ${toks[@]+"${toks[@]}"}; do
        case "$tok" in
          *'{'*)
            case "$tok" in
              *,*|*..*)
                if [ "$budget" -gt 0 ] && [ "${#tok}" -le 256 ]; then
                  budget=$((budget - 1))
                  if pipeline_brace_expand_word "$tok"; then
                    if [ "${#_PIPELINE_BRACE_WORDS[@]}" -gt 0 ]; then
                      for word in "${_PIPELINE_BRACE_WORDS[@]}"; do
                        out_toks[${#out_toks[@]}]="$PIPELINE_MARK$word"
                        # 展开后还留着没认出的花括号组（带步长的 {x..y..N} 等）：当成没展开处理，字母能依次拼出 acknowledge 就失败关闭。
                        case "$word" in
                          *'{'*..*) ! pipeline_text_may_spell_acknowledge "$word" || { _PIPELINE_BRACE_OVERFLOW=1; _PIPELINE_BRACE_HIT=1; } ;;
                        esac
                      done
                    fi
                    continue
                  fi
                fi
                _PIPELINE_BRACE_OVERFLOW=1
                # 内联 k / w / g 的快速排除，绝大多数没展开的词不用付一次函数调用（填充几万个花括号词时这是热点）。
                case "$tok" in
                  *k*) case "$tok" in *w*) case "$tok" in *g*) ! pipeline_text_may_spell_acknowledge "$tok" || _PIPELINE_BRACE_HIT=1 ;; esac ;; esac ;; esac
                ;;
            esac
            ;;
        esac
        out_toks[${#out_toks[@]}]="$tok"
      done
      if [ "${#out_toks[@]}" -gt 0 ]; then
        IFS=' '
        out_segs[${#out_segs[@]}]="${out_toks[*]}"
      fi
      IFS='&|;()<>`'
    done
    [ "${#out_segs[@]}" -gt 0 ] || continue
    IFS=';'
    out_lines[${#out_lines[@]}]="${out_segs[*]}"
    IFS=$'\n'
  done
  IFS=$'\n'
  _PIPELINE_BRACED=''
  [ "${#out_lines[@]}" -eq 0 ] || _PIPELINE_BRACED="${out_lines[*]}"
}

pipeline_word_is_tenon_cli() { # $1=command word → 0 = tenon 入口（命令名，或 CLI 源码 / 产物入口文件，或 npx 一类的包名）
  case "${1##*/}" in tenon|tenon.mjs) return 0 ;; esac
  case "${1:-}" in src/main.ts|*/src/main.ts) return 0 ;; esac # tsx / ts-node / vite-node / node --import tsx 直接跑 packages/cli/src/main.ts
  case "${1:-}" in tenon@*|@tenon/cli|@tenon/cli@*) return 0 ;; esac # npx / bunx / pnpm dlx 的包名写法（可带版本）
  return 1
}

pipeline_word_wraps_command() { # $1=command word → 真正的命令在它后面（名单外的启动器覆盖不到，见文件头）
  case "${1##*/}" in
    env|sudo|doas|nohup|time|exec|command|builtin|nice|ionice|stdbuf|timeout|setsid|xargs|find|parallel|watch|\
    arch|caffeinate|flock|unbuffer|script|su|runuser|sg|ssh|xcrun|strace|chronic|taskset|chrt|\
    bash|sh|zsh|dash|ksh|eval|node|nodejs|bun|deno|npx|bunx|pnpm|yarn|npm|tsx|ts-node|vite-node|\
    if|then|elif|else|do|while|until|'!') return 0 ;;
  esac
  return 1
}

# 整条命令是 `<shell> [-lc|-c] "整串"` 且整串里没有同种引号时，取出整串（Codex 把每条命令包成 /bin/zsh -lc "…"）。
# 整串里还有同种引号（转义引号，或两个引号串）就不取：那不是单独一个引号串，取出来会把后面的参数并进命令。
pipeline_peel_shell_wrapper() { # $1=命令 → _PIPELINE_PEELED（取不出就原样）
  local command="${1:-}" shell flag prefix inner trims=0
  _PIPELINE_PEELED="$command"
  while [ "$trims" -lt 8 ]; do # 末尾的换行 / 空白（最多去 8 个，避免大命令上平方级的逐个复制）
    case "$command" in
      *[[:space:]]) command="${command%[[:space:]]}"; trims=$((trims + 1)) ;;
      *) break ;;
    esac
  done
  for shell in /bin/zsh /bin/bash /bin/sh zsh bash sh; do
    for flag in -lc -c; do
      prefix="$shell $flag "
      case "$command" in
        "$prefix"*)
          inner="${command#"$prefix"}"
          case "$inner" in
            '"'?*'"') inner="${inner#\"}"; inner="${inner%\"}"; case "$inner" in *'"'*) return 0 ;; esac ;;
            "'"?*"'") inner="${inner#\'}"; inner="${inner%\'}"; case "$inner" in *"'"*) return 0 ;; esac ;;
            *) return 0 ;;
          esac
          _PIPELINE_PEELED="$inner"
          return 0
          ;;
      esac
    done
  done
  return 0
}

pipeline_command_runs_manual_acknowledge() { # $1=decoded command → 0 = 某段执行不带 --delegated 的 tenon review acknowledge
  local command="${1:-}" IFS segment word raw first arm acked delegated ack_q skip_value options_ended uncertain
  local -a segments
  # 缺了预筛的那个 helper 就核实不了：失败关闭。
  type pipeline_text_may_spell_acknowledge > /dev/null 2>&1 || return 0
  pipeline_peel_shell_wrapper "$command"
  pipeline_peel_shell_wrapper "$_PIPELINE_PEELED" # sh -c "bash -c '…'" 这种两层
  command="$_PIPELINE_PEELED"
  pipeline_decode_json_ascii_escapes "$command"
  pipeline_restore_shell_escapes "$_PIPELINE_DECODED"
  pipeline_shell_unquote "$_PIPELINE_RESTORED"
  command="$_PIPELINE_UNQUOTED"
  # 必须在还原之后：词中拆开、转义编码、花括号拼出的写法原文里没有这个词。没有标记的文本不用清理；有花括号时只有字母能依次拼出
  # acknowledge 才值得展开（展开出的词来自原文里的字符，这是必要条件）。
  pipeline_clean_marks "$command"
  case "$_PIPELINE_CLEAN" in
    *acknowledge*) ;;
    *'{'*) pipeline_text_may_spell_acknowledge "$_PIPELINE_CLEAN" || return 1 ;;
    *) return 1 ;;
  esac
  pipeline_expand_braces "$command"
  command="$_PIPELINE_BRACED"
  pipeline_clean_marks "$command"
  if [ "$_PIPELINE_BRACE_OVERFLOW" = 1 ]; then # 有词没展开：词链核实不了，只要出现 acknowledge 或某个词能拼出它就拦
    [ "$_PIPELINE_BRACE_HIT" = 0 ] || return 0
    case "$_PIPELINE_CLEAN" in *acknowledge*) return 0 ;; esac
  fi
  case "$_PIPELINE_CLEAN" in *acknowledge*) ;; *) return 1 ;; esac
  # 命令段一次切开（线性）：用 ${command//分隔符/换行} 逐个替换，几万个分隔符的命令要跑几分钟，hook 超时就等于放行。
  IFS=$'&|;(){}<>`\n'
  read -r -d '' -a segments <<< "$command" || true
  IFS=$' \t\n'
  for segment in "${segments[@]}"; do
    [ -n "$segment" ] || continue
    first=1 arm=0 acked=0 delegated=0 ack_q=0 skip_value=0 options_ended=0 uncertain=0
    set -f
    for word in $segment; do
      # 带标记的词：raw 是原词（判断 --delegated 开关用），word 是清掉标记的词（其它判断用）。超过 256 字符的词不会是任何关键词，不清。
      raw="$word"
      case "$word" in
        *"$PIPELINE_MARK"*|*"$PIPELINE_QMARK"*)
          if [ "${#word}" -le 256 ]; then word="${word//$PIPELINE_MARK/}"; word="${word//$PIPELINE_QMARK/}"; fi
          ;;
      esac
      [ -n "$word" ] || continue # 只剩标记的词（续行前的空格 + 反斜杠留下的）不算词，不能打断 tenon → review → 确认子命令的链
      case "$word" in '#'*) break ;; esac # 词首的 # 起是注释，后面的字（含 --delegated）不算参数
      if [ "$first" = 1 ]; then
        case "$word" in *=*) continue ;; esac
        first=0
        # tenon 入口：从下一个词起按 review → 确认子命令往下认；包装器：在整段里找 tenon 入口；其它命令：这段不是它。
        if pipeline_word_is_tenon_cli "$word"; then
          arm=1
        elif ! pipeline_word_wraps_command "$word"; then
          break
        fi
        continue
      fi
      case "$arm" in
        2)
          if [ "$skip_value" = 1 ]; then # 上一个词是 --as / --event / --reason：这个词是它的值，不是 sub，也不是开关
            skip_value=0
            case "$raw" in
              *"$PIPELINE_QMARK"*) ;; # 值是带空白的参数：占几个词看不出来，按普通词往下走（会退成「出现 acknowledge 词就算确认」）
              *) continue ;;
            esac
          fi
          if [ "$options_ended" = 0 ]; then
            case "$word" in
              --) options_ended=1; continue ;; # `--` 之后的 --delegated 是位置参数，不是开关
              -*)
                case "$word" in --as|--event|--reason) skip_value=1 ;; esac
                [ "$raw" != --delegated ] || [ "$_PIPELINE_NO_SWITCH" = 1 ] || delegated=1
                continue
                ;;
            esac
          fi
          if [ "$acked" = 0 ]; then
            if [ "$word" = acknowledge ]; then
              acked=1
              case "$raw" in *"$PIPELINE_QMARK"*) ack_q=1 ;; esac
            else
              case "$raw" in *"$PIPELINE_QMARK"*) uncertain=1 ;; esac # 别的参数的延续部分，不能当「第一个位置参数」
              if [ "$uncertain" = 0 ]; then # 第一个位置参数不是 acknowledge（request / revoke / 别的）：这条 review 不是手动确认
                arm=0
                pipeline_word_is_tenon_cli "$word" && arm=1
              fi
            fi
          fi
          ;;
        1)
          case "$word" in
            -*) ;;
            review) arm=2 acked=0 delegated=0 ack_q=0 skip_value=0 options_ended=0 uncertain="$_PIPELINE_NO_SWITCH" ;;
            *) arm=0; pipeline_word_is_tenon_cli "$word" && arm=1 ;;
          esac
          ;;
        *) pipeline_word_is_tenon_cli "$word" && arm=1 ;;
      esac
    done
    set +f
    if [ "$arm" = 2 ] && [ "$acked" = 1 ]; then
      [ "$delegated" = 1 ] && [ "$ack_q" = 0 ] || return 0
    fi
  done
  return 1
}
