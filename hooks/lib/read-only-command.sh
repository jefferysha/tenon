# shellcheck shell=bash
# 只读放行（CONTEXT.md「只读放行」）：待处理标记存在时，哪些 shell 命令仍然放行。
# 接口：pipeline_command_is_read_only <已解码的命令> → 0 只读 / 1 不是。
# 失败关闭：超长、引号没闭合、出现重定向 / 命令替换 / 参数展开 / 子 shell / 后台执行 / ANSI-C 引号 / 换行、
# 任何一段不在名单里，都判非只读（宁可误拦，绝不误放）。
# bash 3.2；线性扫描，长度上限让 hook 在宿主超时前给出结论（超时会被宿主当成非阻断错误，即放行）。
#
# 判定分两层：
#   · 整条命令：按引号外的 `|` `||` `&&` `;` 切段（单引号内全字面；双引号内遇到 `$(`、`${`、反引号即判非只读）；
#   · 每一段：是 `cd`，或在下面的严格名单内，并且不带会写文件 / 执行程序的参数。
# 名单内命令的收紧形态（git ... --output、rg --pre、sed -n 非行号打印、file -C 等）按「去掉引号与反斜杠后的文本」匹配，
# 否则 `rg --p're'`、`find . -"delete"` 这类引号拼接能绕过字面匹配。
# 引号外与双引号内的任何展开都判非只读：`$名字` / 特殊参数（`$IFS` 会在运行时展开成空白并拆词，`find .$IFS-delete`
# 里的 -delete 就成了独立参数）、`${…}`（可以写进任意默认值）、`$(…)`、`$[…]`；花括号展开（`{-i,f}` 能拼出选项）、
# 圆括号（`ls () ( … )` 能重定义命令）同样在扫描时被拦下。行尾锚点 `"a$"`、单引号里的 `'$p'` 不是展开，照常放行。

PIPELINE_READ_ONLY_MAX_CHARS=2048
PIPELINE_RO_SED_PRINT='^([0-9]+|\$)(,([0-9]+|\$))?p$'
PIPELINE_RO_FILE_COMPILE='(^|[[:space:]])-[A-Za-z]*C'

# 丢弃输出的重定向不写任何文件：作为独立记号（前后是空格）时先去掉。
pipeline_ro_strip_discards() { # $1=command → _PIPELINE_RO_TEXT
  local text=" $1 " before=''
  while [ "$text" != "$before" ]; do
    before="$text"
    text="${text// 2>\/dev\/null / }"
    text="${text// 1>\/dev\/null / }"
    text="${text// >\/dev\/null / }"
    text="${text// &>\/dev\/null / }"
    text="${text// 2>&1 / }"
  done
  _PIPELINE_RO_TEXT="$text"
}

# 去掉引号与反斜杠：让 `--p're'`、`-"delete"` 之类的拼接露出原貌，供收紧形态的匹配用。
pipeline_ro_flatten() { # $1=text → _PIPELINE_RO_FLAT
  local text="${1:-}" sq="'" dq='"' bs='\'
  text="${text//"$sq"/}"
  text="${text//"$dq"/}"
  text="${text//"$bs"/}"
  _PIPELINE_RO_FLAT="$text"
}

# sed -n 只认行号区间打印；脚本后的参数不许是选项（GNU sed 会把 -i 之类重排进来），引号 / 反斜杠包着的也不行。
pipeline_ro_sed_ok() { # $1=segment → 0 = 只读
  local script word i=3
  local -a words
  read -r -a words <<< "$1"
  [ "${#words[@]}" -ge 3 ] || return 1
  script="${words[2]}"
  script="${script#\'}"; script="${script%\'}"
  script="${script#\"}"; script="${script%\"}"
  [[ "$script" =~ $PIPELINE_RO_SED_PRINT ]] || return 1
  while [ "$i" -lt "${#words[@]}" ]; do
    word="${words[$i]}"
    while :; do
      case "$word" in
        \'*|\"*|\\*) word="${word:1}" ;;
        *) break ;;
      esac
    done
    case "$word" in -*) return 1 ;; esac
    i=$((i + 1))
  done
  return 0
}

pipeline_ro_segment_ok() { # $1=去掉首尾空白的段 → 0 = 只读
  local s="$1" flat tab=$'\t'
  # shell 把制表符和空格一样当参数分隔：先统一成空格，下面按「空格 + 选项」匹配的收紧形态（find 的 -delete / -exec …）
  # 才不会被 `find .<TAB>-delete` 绕过。
  s="${s//"$tab"/ }"
  pipeline_ro_flatten "$s"
  flat="$_PIPELINE_RO_FLAT"
  case "$s" in
    # 不带参数的 head / tail / wc / cat 只读标准输入，是管道末端的常见写法（`ls | head`）。
    cd|cd\ *|pwd|pwd\ *|ls|ls\ *|grep\ *|head|head\ *|tail|tail\ *|wc|wc\ *|cat|cat\ *|stat\ *|realpath\ *|command\ -v\ *)
      return 0 ;;
    test\ *|'['\ *)
      # test / [ 的 -v 等操作数会对数组下标做算术求值，下标里的 $(…) 即便写在单引号里也会被执行：这两个词里不许有。
      case "$s" in *'$('*|*'`'*|*'$['*) return 1 ;; esac
      return 0 ;;
    rg\ *)
      # --pre 执行任意程序；--hostname-bin 同样执行程序。
      case "$flat" in *--pre*|*--host*) return 1 ;; esac
      return 0 ;;
    file\ *)
      # -C / --compile 会写出编译后的 magic 文件；短选项可以合并（-bC），长选项可以缩写（--comp）。
      case "$flat" in *--co*) return 1 ;; esac
      [[ "$flat" =~ $PIPELINE_RO_FILE_COMPILE ]] && return 1
      return 0 ;;
    sed\ -n\ *|sed\ --quiet\ *|sed\ --silent\ *)
      pipeline_ro_sed_ok "$s"
      return ;;
    find\ *)
      case "$flat" in
        *" -delete"*|*" -exec"*|*" -execdir"*|*" -ok"*|*" -okdir"*|*" -fprint"*|*" -fls"*) return 1 ;;
      esac
      return 0 ;;
    git\ status|git\ status\ *|git\ diff|git\ diff\ *|git\ log|git\ log\ *|git\ show|git\ show\ *)
      # --output 把结果写进文件；git 的长选项可以缩写，所以 --out 开头的一律拦。
      case "$flat" in *--out*) return 1 ;; esac
      return 0 ;;
    git\ rev-parse\ *|git\ branch\ --show-current|git\ worktree\ list|git\ worktree\ list\ *)
      return 0 ;;
    tenon\ list|tenon\ list\ *|tenon\ status\ *|tenon\ get\ *|tenon\ inbox|tenon\ inbox\ *|tenon\ document\ status\ *)
      return 0 ;;
  esac
  return 1
}

pipeline_command_is_read_only() { # $1=decoded command → 0 = 只读
  local command="${1:-}" len i=0 ch nx state=plain seg='' segments='' any=1 tab=$'\t'
  [ -n "$command" ] || return 1
  [ "${#command}" -le "$PIPELINE_READ_ONLY_MAX_CHARS" ] || return 1
  # 换行 / 回车无论在引号内外都不收：引号外的换行是第二条命令，反斜杠续行与引号内换行会把一个词拆到两行里，
  # 让逐段的收紧匹配对不上。
  case "$command" in *$'\n'*|*$'\r'*) return 1 ;; esac
  pipeline_ro_strip_discards "$command"
  command="$_PIPELINE_RO_TEXT"
  len="${#command}"
  while [ "$i" -lt "$len" ]; do
    ch="${command:i:1}"
    nx="${command:i+1:1}"
    case "$state" in
      single)
        seg="$seg$ch"
        if [ "$ch" = "'" ]; then state=plain; fi
        ;;
      double)
        case "$ch" in
          '\') seg="$seg$ch$nx"; i=$((i + 1)) ;;
          '`') return 1 ;;
          '$') case "$nx" in [A-Za-z_0-9]|'@'|'*'|'#'|'?'|'$'|'!'|'-'|'('|'{'|'[') return 1 ;; esac; seg="$seg$ch" ;;
          '"') seg="$seg$ch"; state=plain ;;
          *) seg="$seg$ch" ;;
        esac
        ;;
      *)
        case "$ch" in
          "'") seg="$seg$ch"; state=single ;;
          '"') seg="$seg$ch"; state=double ;;
          '\') seg="$seg$ch$nx"; i=$((i + 1)) ;;
          '$') case "$nx" in [A-Za-z_0-9]|'@'|'*'|'#'|'?'|'$'|'!'|'-'|'('|"'"|'{'|'[') return 1 ;; esac; seg="$seg$ch" ;;
          '`'|'>'|'<'|'('|')'|'{') return 1 ;;
          '|') segments="$segments$seg"$'\n'; seg=''; if [ "$nx" = '|' ]; then i=$((i + 1)); fi ;;
          '&') if [ "$nx" != '&' ]; then return 1; fi; segments="$segments$seg"$'\n'; seg=''; i=$((i + 1)) ;;
          ';') segments="$segments$seg"$'\n'; seg='' ;;
          *) seg="$seg$ch" ;;
        esac
        ;;
    esac
    i=$((i + 1))
  done
  [ "$state" = plain ] || return 1
  segments="$segments$seg"
  while IFS= read -r seg; do
    while :; do case "$seg" in ' '*|"$tab"*) seg="${seg:1}" ;; *) break ;; esac; done
    while :; do case "$seg" in *' '|*"$tab") seg="${seg%?}" ;; *) break ;; esac; done
    [ -n "$seg" ] || continue
    pipeline_ro_segment_ok "$seg" || return 1
    any=0
  done <<< "$segments"
  return "$any"
}
