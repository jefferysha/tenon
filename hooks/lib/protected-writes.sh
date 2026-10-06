#!/usr/bin/env bash
# protected-writes.sh — source-only. The "does this tool call write something Tenon owns" recognition of hooks/gate.sh:
# test records, the local seal and its key, the task test plan and its ledger, the frozen review list, the shared baselines and
# known-failures.yaml, plus the two decisions only the user may take (`tenon test trust`, `TENON_TEST_TRUST=`).
#
# gate.sh sources this file only when the raw tool input contains a word the recognition could care about (see the
# pre-filter in gate.sh), so a call that mentions none of them never pays for it.  The rules and the 13 shell write shapes are
# described at the top of gate.sh; tools/test-hooks.sh has one refusal and one neighbouring allowance per shape.
#
# Expects from gate.sh: INPUT, json_get, pipeline_json_get_* (json-input.sh) and pipeline_unwrap_shell_wrapper.
# Pure bash 3.2, linear in the command length; no interpreter, no JSON tool, no grep, no eval.

pipeline_mentions_protected() { # $1=text → 0 when it names something the record rules protect
  case "${1:-}" in
    *test-plan*|*.tenon*|*known-failures*|*review-waivers*|*baselines*|*test-seal*|*env.key*) return 0 ;;
  esac
  return 1
}
pipeline_test_record_path() { # $1=target path, $2=cwd → 0 when it is a Tenon-owned test record
  local path="${1:-}" rest sub double='//' single='/'
  [ -n "$path" ] || return 1
  case "$path" in /*) ;; *) path="${2:-.}/$path" ;; esac
  # bash 3.2 keeps a backslash-escaped `/` literally in a replacement, so both sides are variables.
  while :; do case "$path" in *//*) path="${path//$double/$single}" ;; *) break ;; esac; done
  # `.` / `..` 段落不猜它最终指向哪里：路径里提到受保护的名字就按记录路径拒绝。
  case "$path" in
    */../*|*/./*|*/..|*/.)
      case "$path" in
        *test-plan.yaml*|*.pipeline-test-plan.json*|*.pipeline-review-waivers.json*|*known-failures.yaml*|*test-seal.json*|*env.key*|*/.tenon/tests|*/.tenon/tests/*) return 0 ;;
      esac
      ;;
  esac
  case "$path" in
    */openspec/changes/*/test-plan.yaml|*/openspec/changes/*/.pipeline-test-plan.json|*/openspec/changes/*/.pipeline-review-waivers.json) return 0 ;;
    */.tenon/tests|*/.tenon/tests/baselines|*/.tenon/tests/baselines/*|*/.tenon/tests/known-failures.yaml) return 0 ;;
  esac
  case "$path" in */.tenon/users/*) ;; *) return 1 ;; esac
  rest="${path#*/.tenon/users/}"
  sub="${rest#*/}"
  case "$sub" in tests|tests/*|baselines|baselines/*|local/test-seal.json*|local/env.key*) return 0 ;; esac
  # `.` / `..` 段落出现在用户目录之下时不猜它最终指向哪里，一律按记录路径拒绝。
  case "/$rest" in */../*|*/./*|*/..|*/.) return 0 ;; esac
  return 1
}
# 写入目标：受保护路径，或展开不了的变量（命令里已经名了受保护路径，变量多半就指向它）。
pipeline_target_protected() { # $1=target token, $2=cwd
  case "${1:-}" in *'$'*) return 0 ;; esac
  pipeline_test_record_path "${1:-}" "${2:-.}"
}
pipeline_patch_text() { # apply_patch 的补丁正文：宿主把它放在 command / cmd / input / patch 或 argv 里
  local key value
  for key in command cmd input patch; do
    value="$(pipeline_json_get_string "$INPUT" "$key" || true)"
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  done
  for key in command cmd argv; do
    value="$(pipeline_json_get_string_array "$INPUT" "$key" || true)"
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  done
  return 1
}
pipeline_patch_targets() { # $1=patch text → 每个补丁头的目标路径一行（只认行首的补丁头）
  local line IFS=$'\n'
  local -a lines
  read -r -d '' -a lines <<< "${1:-}" || true
  for line in "${lines[@]}"; do
    line="${line%$'\r'}"
    case "$line" in
      '*** Add File: '*|'*** Update File: '*|'*** Delete File: '*|'*** Move to: '*) printf '%s\n' "${line#*: }" ;;
    esac
  done
}


# ── shell 写入识别（尽力而为，线性）──
# 命令里的变量赋值（形态 7）：一行一条 NAME=值，按出现顺序累积；展开一次（值在赋值时已展开）。
# 红线自证要求 gate.sh 里不出现某个脚本语言解释器名的字面量（test-hooks.sh section 3），所以拆开写。
PIPELINE_PY='pyth''on'
PIPELINE_JQ='j''q'
PIPELINE_SHELL_VARS=''
PIPELINE_SHELL_CWD='.'
PIPELINE_REFUSE_KIND=record # 拒绝原因：record = 写受保护路径，trust = 替用户做信任决定
PIPELINE_DANGLING=0         # 上一段以裸 `>` 结尾（目标在下一段的命令替换里）
PIPELINE_CMD_MENTIONS=0     # 整条命令名了受保护路径（展开不了的变量目标据此按写入拒）
PIPELINE_CMD_TEXT=''        # 整条命令的文本（去掉最外层 shell 包装）：被引号切开的内联代码要看它后面还有什么
PIPELINE_EXPANDED=''
PIPELINE_SEG_REST=''

pipeline_var_set() { # $1=name $2=value
  local line out='' nl=$'\n'
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in "$1="*) ;; *) out="$out$line$nl" ;; esac
  done <<< "$PIPELINE_SHELL_VARS"
  PIPELINE_SHELL_VARS="$out$1=$2"
}
# 展开已知变量：${NAME} 直接替换；$NAME 只在下一个字符不是标识符字符时替换。结果放 PIPELINE_EXPANDED。
pipeline_expand_vars() { # $1=text
  local text="${1:-}" line name value out rest before next count=0 dollar='$' brace_open='{' brace_close='}' pat
  PIPELINE_EXPANDED="$text"
  [ -n "$PIPELINE_SHELL_VARS" ] || return 0
  case "$text" in *"$dollar"*) ;; *) return 0 ;; esac
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line%%=*}"
    value="${line#*=}"
    pat="$dollar$brace_open$name$brace_close"
    text="${text//"$pat"/$value}"
    pat="$dollar$name"
    out=''
    rest="$text"
    while :; do
      case "$rest" in *"$pat"*) ;; *) break ;; esac
      before="${rest%%"$pat"*}"
      rest="${rest#*"$pat"}"
      next="${rest:0:1}"
      case "$next" in
        [A-Za-z0-9_]) out="$out$before$pat" ;;
        *) out="$out$before$value" ;;
      esac
      count=$((count + 1))
      [ "$count" -lt 64 ] || break
    done
    text="$out$rest"
  done <<< "$PIPELINE_SHELL_VARS"
  PIPELINE_EXPANDED="$text"
}
# 段首的 NAME=值 赋值（可带 export / declare / readonly / local 前缀）记入变量表；剩下的命令放 PIPELINE_SEG_REST。
pipeline_absorb_assignments() { # $1=raw segment
  local rest="${1:-}" name value consumed=0
  while :; do
    rest="${rest#"${rest%%[![:space:]]*}"}"
    case "$rest" in
      export\ *|declare\ *|readonly\ *|local\ *|typeset\ *) rest="${rest#* }"; continue ;;
    esac
    case "$rest" in
      [A-Za-z_]*=*) ;;
      *) break ;;
    esac
    name="${rest%%=*}"
    case "$name" in *[!A-Za-z0-9_]*) break ;; esac
    rest="${rest#*=}"
    case "$rest" in
      '"'*) rest="${rest#\"}"; value="${rest%%\"*}"; rest="${rest#"$value"}"; rest="${rest#\"}" ;;
      "'"*) rest="${rest#\'}"; value="${rest%%\'*}"; rest="${rest#"$value"}"; rest="${rest#\'}" ;;
      *) value="${rest%%[[:space:]]*}"; rest="${rest#"$value"}" ;;
    esac
    pipeline_expand_vars "$value"
    pipeline_var_set "$name" "$PIPELINE_EXPANDED"
    consumed=1
  done
  if [ "$consumed" = 1 ]; then PIPELINE_SEG_REST="$rest"; else PIPELINE_SEG_REST="${1:-}"; fi
}

# 信任决定只能由用户给（R6）：`tenon test trust`（含 node …/tenon.mjs test trust）与前缀赋值 TENON_TEST_TRUST=。
# 只在命令位置匹配——`grep "tenon test trust" docs/`、`git commit -m "…TENON_TEST_TRUST…"` 不是信任决定。
pipeline_segment_takes_trust() { # $1=raw segment
  case "${1:-}" in *trust*|*TRUST*) ;; *) return 1 ;; esac
  local segment="${1:-}" token ch head='' seen_head=0 exporting=0 step=0 trust_seen=0 IFS=$' \t'
  local -a toks
  for ch in '"' "'" '(' ')' '{' '}' '`'; do segment="${segment//$ch/ }"; done
  read -r -a toks <<< "$segment" || true
  [ "${#toks[@]}" -gt 0 ] || return 1
  for token in "${toks[@]}"; do
    if [ "$seen_head" = 0 ]; then
      case "$token" in
        TENON_TEST_TRUST=*) return 0 ;;
        export|declare|typeset|readonly|setenv) exporting=1; continue ;;
        [A-Za-z_]*=*|sudo|command|env|exec|nohup|time|nice|builtin|then|do|else|'!'|-*|npx|pnpm|yarn|bunx|dlx) continue ;;
      esac
      if [ "$exporting" = 1 ]; then
        case "$token" in TENON_TEST_TRUST*) return 0 ;; esac
        continue
      fi
      seen_head=1
      head="${token##*/}"
      case "$head" in
        tenon|tenon.mjs) step=1 ;;
        node|nodejs|bash|sh|zsh|dash) step=0 ;;
        *) return 1 ;;
      esac
      continue
    fi
    case "$token" in -*) continue ;; esac
    case "$step" in
      0) case "${token##*/}" in tenon|tenon.mjs) step=1 ;; *) return 1 ;; esac ;;
      1) [ "$token" = test ] && step=2 || return 1 ;;
      2) [ "$token" = trust ] && { trust_seen=1; break; } || return 1 ;;
    esac
  done
  # `tenon test trust --status` 只是看一眼是否已信任，不是信任决定。
  [ "$trust_seen" = 1 ] && case " ${toks[*]} " in *' --status '*) return 1 ;; *) return 0 ;; esac
  return 1
}

# 补丁文件是否在头部行点名受保护路径（形态 6；大文件不扫）。
pipeline_patch_file_names_protected() { # $1=file
  local file="${1:-}"
  case "$file" in /*) ;; *) file="$PIPELINE_SHELL_CWD/$file" ;; esac
  [ -f "$file" ] && [ -r "$file" ] || return 1
  [ "$(wc -c < "$file" 2>/dev/null | tr -d ' ')" -le 2097152 ] 2>/dev/null || return 1
  grep -E -q '^(\+\+\+|---|diff --git|rename (to|from)|copy (to|from)) .*(test-plan|\.tenon|known-failures|review-waivers|test-seal|env\.key)' "$file" 2>/dev/null
}
# 脚本文件是否点名受保护路径且不是干净的 git 跟踪文件（形态 8）。被 git 跟踪且没改动的脚本是项目维护的代码
# （本仓自己的 tools/test-hooks.sh 就点名这些路径）；新写的、改过的、仓库外的脚本按「刚被 agent 写出来」处理。
pipeline_script_names_protected() { # $1=script path
  local file="${1:-}" dir="$PIPELINE_SHELL_CWD"
  case "$file" in /*) ;; *) file="$dir/$file" ;; esac
  [ -f "$file" ] && [ -r "$file" ] || return 1
  [ "$(wc -c < "$file" 2>/dev/null | tr -d ' ')" -le 2097152 ] 2>/dev/null || return 1
  grep -q -e test-plan -e '\.tenon' -e known-failures -e review-waivers -e test-seal -e 'env\.key' "$file" 2>/dev/null || return 1
  if ( cd "$dir" 2>/dev/null && git ls-files --error-unmatch -- "$file" >/dev/null 2>&1 && git diff --quiet HEAD -- "$file" >/dev/null 2>&1 ); then
    return 1
  fi
  return 0
}

# 下面这些形态函数读调用者（pipeline_segment_writes_record）的局部变量 head / args / tokens / relevant，命中返回 0。
pipeline_args_any_protected() { # args 里任一非 flag 记号是受保护路径（或展开不了的变量）
  local i=0 n="${#args[@]}" token
  while [ "$i" -lt "$n" ]; do
    token="${args[$i]}"; i=$((i + 1))
    case "$token" in -*) continue ;; esac
    pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0
  done
  return 1
}
pipeline_shape_script() { # 形态 8：解释器 / ./x 运行的脚本文件自己点名受保护路径（段里不必点名）
  local i=0 n="${#args[@]}" token
  case "$head" in
    bash|sh|zsh|dash|ksh|source|.|"$PIPELINE_PY"|"$PIPELINE_PY"[0-9]*|node|nodejs|ruby|perl|php|lua|deno|bun|Rscript)
      while [ "$i" -lt "$n" ]; do
        token="${args[$i]}"; i=$((i + 1))
        case "$token" in
          -m|-c|-e|-E|-p|-r|--eval) return 1 ;;
          -o|-O|--rcfile|--init-file) i=$((i + 1)); continue ;;
          -*) continue ;;
        esac
        pipeline_script_names_protected "$token" && return 0
        return 1
      done
      ;;
  esac
  case "$head_token" in
    ./*|../*|/*) pipeline_script_names_protected "$head_token" && return 0 ;;
  esac
  return 1
}
pipeline_shape_bulk() { # 形态 9：xargs / parallel 的路径来自 stdin；find 的动作来自参数
  local i=0 n="${#args[@]}" token inner=''
  case "$head" in
    xargs|gxargs|parallel)
      while [ "$i" -lt "$n" ]; do
        token="${args[$i]}"; i=$((i + 1))
        case "$token" in
          -n|-P|-L|-l|-s|-d|-E|-a|-J|--max-args|--max-procs|--max-lines|--delimiter|--arg-file) i=$((i + 1)); continue ;;
          -*) continue ;;
        esac
        inner="${token##*/}"
        break
      done
      case "$inner" in
        # 只读：这些命令没有写文件的参数形态（JSON 过滤器没有写文件的功能；od / strings / nl / tac 只读 stdin 或文件）。
        # 红线自证要求本文件里不出现这个 JSON 过滤器名的字面量（test-hooks.sh section 3），所以用 PIPELINE_JQ 拆开写。
        ''|cat|grep|egrep|fgrep|rg|wc|head|tail|ls|diff|stat|file|sha256sum|shasum|md5sum|md5|realpath|echo|printf|basename|dirname|"$PIPELINE_JQ"|tac|nl|od|strings|sha1sum|sha512sum|cksum|readlink)
          # 只读命令也可能带着 `{}` 目标的重定向（`parallel 'echo x > {}'`）：段尾悬着一个没有目标的 `>` 就按写入拒。
          [ "${tokens[$((${#tokens[@]} - 1))]}" = '>' ] && return 0
          return 1
          ;;
      esac
      return 0
      ;;
    find|gfind)
      case " ${tokens[*]} " in
        *' -exec '*|*' -execdir '*|*' -ok '*|*' -okdir '*|*' -delete '*|*' -fprint '*|*' -fprint0 '*|*' -fprintf '*|*' -fls '*) ;;
        *) return 1 ;;
      esac
      # 起点：明确点名受保护路径就拒；没有起点或起点是 . / .. / ~ 这类宽范围且命令名了受保护路径，也拒。
      local broad=1
      while [ "$i" -lt "$n" ]; do
        token="${args[$i]}"; i=$((i + 1))
        case "$token" in -*|'!'|'(') break ;; esac
        pipeline_test_record_path "$token" "$PIPELINE_SHELL_CWD" && return 0
        case "$token" in .|./|..|../|/|'~'|'$'*) ;; *) broad=0 ;; esac
      done
      [ "$broad" = 1 ] && [ "$relevant" = 1 ] && return 0
      ;;
  esac
  return 1
}
pipeline_inline_tail_clean() { # $raw（被引号切开的内联代码所在的段）之后的命令文本与已赋值的变量里，没有受保护字样、变量引用或命令替换，
  # 且整段内联代码里没有写文件 / 起进程的 API 字样 → 0（读记录再交给解释器处理的管道）
  local tail code dollar='$' tick='`'
  pipeline_mentions_protected "$PIPELINE_SHELL_VARS" && return 1
  case "$PIPELINE_CMD_TEXT" in *"$raw"*) tail="${PIPELINE_CMD_TEXT#*"$raw"}" ;; *) return 1 ;; esac
  pipeline_mentions_protected "$tail" && return 1
  case "$tail" in *"$dollar"*|*"$tick"*) return 1 ;; esac
  # 代码的写法没法逐门语言去分析：出现任何能写文件、改文件、起进程的字样（含拼出路径再写的做法）都当拿不准，照旧拒。
  code="$raw$tail"
  case "$code" in
    *write*|*append*|*open*|*unlink*|*rename*|*remove*|*rmdir*|*rmSync*|*'rm('*|*mkdir*|*copy*|*cpSync*|*'cp('*|*link*|*truncate*|*chmod*|*chown*|*utimes*|*put_contents*) return 1 ;;
    *system*|*exec*|*spawn*|*popen*|*subprocess*|*child_process*|*shutil*|*eval*|*'os.'*|*'Deno.'*|*'Bun.'*|*'tee '*) return 1 ;;
  esac
  return 0
}
pipeline_shape_inline() { # 形态 1 / 2：解释器内联代码，命令段名了受保护路径（内联代码里的 `;` 会把代码切到后面的段里，所以引号没闭合时看整条命令）
  local i=0 n="${#args[@]}" token quotes dq='"' sq="'" qset
  qset="$dq$sq"
  if [ "$relevant" != 1 ]; then
    [ "$PIPELINE_CMD_MENTIONS" = 1 ] || return 1
    quotes="${raw//[!$qset]/}"
    [ $(( ${#quotes} % 2 )) = 1 ] || return 1
    # 读记录再交给解释器处理（`cat 记录 | 解释器 -c '…;…'`）：受保护路径只出现在这一段之前，被切开的内联代码之后没有再提到它们，
    # 也没有变量或命令替换可以指向它们——这段代码没有写它们的可能，放行；其余（含任何拿不准的）照旧按写入拒。
    pipeline_inline_tail_clean && return 1
  fi
  case "$head" in
    "$PIPELINE_PY"|"$PIPELINE_PY"[0-9]*|node|nodejs|ruby|perl|php|lua|deno|bun|Rscript|osascript) ;;
    *) return 1 ;;
  esac
  while [ "$i" -lt "$n" ]; do
    token="${args[$i]}"; i=$((i + 1))
    case "$token" in
      -c|-e|-E|-p|-r|--eval|--eval=*|-[a-zA-Z][a-zA-Z]*[ce]) return 0 ;;
    esac
  done
  return 1
}
pipeline_shape_transfer() { # 形态 3 / 4：curl wget 的输出目标，tar unzip 的解包目标
  local i=0 n="${#args[@]}" token prev='' extract=0
  case "$head" in
    curl|wget)
      while [ "$i" -lt "$n" ]; do
        token="${args[$i]}"; i=$((i + 1))
        case "$prev" in
          -o|--output|--output-document|-P|--directory-prefix|--output-dir) pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0 ;;
          -O|-[a-zA-Z][a-zA-Z]*O) [ "$head" = wget ] && { pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0; } ;;
          -[a-zA-Z][a-zA-Z]*o) [ "$head" = curl ] && { pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0; } ;;
        esac
        case "$token" in
          --output=*|--output-document=*|--directory-prefix=*|--output-dir=*) pipeline_target_protected "${token#*=}" "$PIPELINE_SHELL_CWD" && return 0 ;;
          -o?*) [ "$head" = curl ] && { pipeline_target_protected "${token#-o}" "$PIPELINE_SHELL_CWD" && return 0; } ;;
          -O?*) [ "$head" = wget ] && { pipeline_target_protected "${token#-O}" "$PIPELINE_SHELL_CWD" && return 0; } ;;
          -O|--remote-name|--remote-name-all) [ "$head" = curl ] && { pipeline_test_record_path "x" "$PIPELINE_SHELL_CWD" && return 0; } ;;
          -[a-zA-Z][a-zA-Z]*O) [ "$head" = curl ] && { pipeline_test_record_path "x" "$PIPELINE_SHELL_CWD" && return 0; } ;;
        esac
        prev="$token"
      done
      ;;
    tar|bsdtar|gtar)
      # 第一个参数不带 `-` 是旧式写法（`tar xf a.tar`），其余只认带 `-` 的选项簇。
      case "${args[0]:-}" in -*) ;; *x*) extract=1 ;; esac
      while [ "$i" -lt "$n" ]; do
        token="${args[$i]}"; i=$((i + 1))
        case "$token" in
          --extract|--get) extract=1 ;;
          --*) ;;
          -*x*) extract=1 ;;
        esac
      done
      [ "$extract" = 1 ] || return 1
      pipeline_test_record_path "x" "$PIPELINE_SHELL_CWD" && return 0
      i=0
      while [ "$i" -lt "$n" ]; do
        token="${args[$i]}"; i=$((i + 1))
        case "$prev" in -C|--directory) pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0 ;; esac
        case "$token" in
          --directory=*) pipeline_target_protected "${token#*=}" "$PIPELINE_SHELL_CWD" && return 0 ;;
          -C?*) pipeline_target_protected "${token#-C}" "$PIPELINE_SHELL_CWD" && return 0 ;;
          -*) ;;
          *) pipeline_test_record_path "$token" "$PIPELINE_SHELL_CWD" && return 0 ;;
        esac
        prev="$token"
      done
      ;;
    unzip|7z|7za|7zr|cpio)
      pipeline_test_record_path "x" "$PIPELINE_SHELL_CWD" && return 0
      pipeline_args_any_protected && return 0
      ;;
  esac
  return 1
}
pipeline_shape_vcs() { # 形态 5 / 6：git 用别处的内容覆盖受保护路径 / 应用补丁；patch
  local i=0 n="${#args[@]}" token prev='' sub=''
  case "$head" in
    git)
      while [ "$i" -lt "$n" ]; do
        token="${args[$i]}"; i=$((i + 1))
        case "$token" in -C|-c|--git-dir|--work-tree|--namespace) i=$((i + 1)); continue ;; -*) continue ;; esac
        sub="$token"
        break
      done
      case "$sub" in
        checkout|restore|reset|rm|clean|checkout-index|read-tree|update-index)
          [ "$relevant" = 1 ] || return 1
          while [ "$i" -lt "$n" ]; do
            token="${args[$i]}"; i=$((i + 1))
            pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0
          done
          ;;
        apply|am)
          while [ "$i" -lt "$n" ]; do
            token="${args[$i]}"; i=$((i + 1))
            case "$token" in -*|'<') continue ;; esac
            pipeline_patch_file_names_protected "$token" && return 0
          done
          ;;
      esac
      ;;
    patch)
      while [ "$i" -lt "$n" ]; do
        token="${args[$i]}"; i=$((i + 1))
        case "$prev" in
          '<'|-i|--input) pipeline_patch_file_names_protected "$token" && return 0 ;;
          *) case "$token" in -*|'<') ;; *) pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0 ;; esac ;;
        esac
        prev="$token"
      done
      ;;
  esac
  return 1
}
pipeline_shape_classic() { # 形态 10-13：重定向、tee / cp / mv / ln / dd / sed -i 等
  local token prev='' last='' inplace=0
  for token in "${tokens[@]}"; do
    # 输出重定向：操作符后面的记号是被写的路径。
    if [ "$prev" = '>' ]; then
      pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0
    fi
    case "$token" in
      -i|-i?*|--in-place|--in-place=*) inplace=1 ;;
      -[!-]*i*) case "$head" in sed|perl|ruby) inplace=1 ;; esac ;;
      inplace) case "$head" in awk|gawk) inplace=1 ;; esac ;;
    esac
    case "$head" in
      tee|mv|rm|unlink|truncate|touch|shred|rmdir|chmod|chown)
        case "$token" in -*) ;; *) pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0 ;; esac
        ;;
      cp|install|ln|rsync)
        case "$prev" in -t) pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0 ;; esac
        case "$token" in --target-directory=*) pipeline_target_protected "${token#*=}" "$PIPELINE_SHELL_CWD" && return 0 ;; esac
        ;;
      dd)
        case "$token" in of=*) pipeline_target_protected "${token#of=}" "$PIPELINE_SHELL_CWD" && return 0 ;; esac
        ;;
      sed)
        # sed 的 w 命令 / s 的 w 标志写文件：`sed -n 'w path'`、`s/a/b/w path`。
        case "$prev" in w|W|*/w|*/gw|*/pw|*/Iw) pipeline_target_protected "$token" "$PIPELINE_SHELL_CWD" && return 0 ;; esac
        ;;
    esac
    last="$token"
    prev="$token"
  done
  case "$head" in
    # 复制类命令的目的地是最后一个参数（源文件在受保护路径里只是读）。
    cp|install|ln|rsync) pipeline_target_protected "$last" "$PIPELINE_SHELL_CWD" && return 0 ;;
    # 就地编辑：任何一个受保护路径参数都是被改写的对象。
    sed|perl|ruby|awk|gawk)
      if [ "$inplace" = 1 ]; then
        for token in "${tokens[@]}"; do
          case "$token" in -*) continue ;; esac
          pipeline_test_record_path "$token" "$PIPELINE_SHELL_CWD" && return 0
        done
      fi
      ;;
  esac
  return 1
}

# 一个命令段（已按 && || ; | & 与命令替换切开）是否写受保护路径。PIPELINE_SHELL_CWD 跟踪 `cd`。
pipeline_segment_writes_record() { # $1=segment → 0 = writes a protected path / takes the trust decision
  local segment="${1:-}" raw="${1:-}" token ch head='' head_token='' has_head=0 relevant=0 index=0 head_index=0 i n
  local dangling="$PIPELINE_DANGLING"
  local IFS=$' \t'
  local -a tokens args
  PIPELINE_DANGLING=0
  PIPELINE_REFUSE_KIND=record
  if pipeline_segment_takes_trust "$raw"; then PIPELINE_REFUSE_KIND=trust; return 0; fi
  pipeline_absorb_assignments "$segment"
  pipeline_expand_vars "$PIPELINE_SEG_REST"
  segment="$PIPELINE_EXPANDED"
  for ch in '"' "'" '(' ')' '{' '}' '`'; do segment="${segment//$ch/ }"; done
  segment="${segment//\\/}" # 反斜杠直接去掉（`test\-plan.yaml` 还原成 `test-plan.yaml`）；bash 3.2 下变量形式的 `\` 模式不生效
  # `>` `<` 两侧补空格：`x>path` `2>path` `&>path` `>>path` 都变成「操作符 + 路径」两个记号（`>>` 是两个连续的 `>`，
  # `2>&1` 的 `&1` 不是受保护路径）。
  segment="${segment//>/ > }"
  segment="${segment//</ < }"
  read -r -a tokens <<< "$segment" || true
  n="${#tokens[@]}"
  [ "$n" -gt 0 ] || return 1
  for token in "${tokens[@]}"; do
    if [ "$has_head" = 0 ]; then
      case "$token" in
        [A-Za-z_]*=*|sudo|command|env|exec|nohup|time|nice|builtin|then|do|else|'!'|-*|npx|pnpm|yarn|bunx|dlx) ;;
        *) head_token="$token"; head="${token##*/}"; has_head=1; head_index="$index" ;;
      esac
    fi
    index=$((index + 1))
  done
  args=()
  i=$((head_index + 1))
  while [ "$i" -lt "$n" ]; do args[${#args[@]}]="${tokens[$i]}"; i=$((i + 1)); done
  # 上一段以裸 `>` 结尾：目标在这一段（`> $(pwd)/x`、`>(tee f)` 被命令替换切开后的后半）。
  if [ "$dangling" = 1 ]; then
    for token in "${tokens[@]}"; do
      pipeline_test_record_path "$token" "$PIPELINE_SHELL_CWD" && return 0
    done
  fi
  # `cd <dir>`：相对路径之后按新目录解析（子 shell 作用域不细究，宁多拒）。
  if [ "$head" = cd ]; then
    for token in "${tokens[@]}"; do
      case "$token" in cd|-P|-L|--) continue ;; esac
      case "$token" in
        /*) PIPELINE_SHELL_CWD="$token" ;;
        '~'*|'$'*) ;;
        *) PIPELINE_SHELL_CWD="$PIPELINE_SHELL_CWD/$token" ;;
      esac
      break
    done
    return 1
  fi
  [ "${tokens[$((n - 1))]}" = '>' ] && PIPELINE_DANGLING=1
  # 命令段里没有任何相关字样，且当前目录也不在受保护区域：需要「命名了受保护路径」的规则整段跳过。
  case "$segment" in *test-plan*|*.tenon*|*known-failures*|*review-waivers*|*baselines*|*tests*|*test-seal*|*env.key*) relevant=1 ;; esac
  case "$PIPELINE_SHELL_CWD" in */.tenon|*/.tenon/*|*/openspec/changes/*) relevant=1 ;; esac
  # 展开不了的变量出现在名了受保护路径的命令里：它多半就指向受保护路径（形态 7）。
  case "$segment" in *'$'*) [ "$PIPELINE_CMD_MENTIONS" = 1 ] && relevant=1 ;; esac

  # 段里不必点名路径就要查的：脚本文件点名了路径（8）、xargs / find 的动作（9）。
  pipeline_shape_script && return 0
  pipeline_shape_bulk && return 0
  pipeline_shape_vcs && return 0
  pipeline_shape_inline && return 0
  [ "$relevant" = 1 ] || return 1
  pipeline_shape_transfer && return 0
  pipeline_shape_classic && return 0
  return 1
}

# heredoc 的正文是不是交给解释器当脚本执行：行里（heredoc 前后）有 shell / 脚本语言的命令名。
# 返回 0 = shell（正文按命令逐行扫），1 = 不是，2 = 脚本语言（正文名了受保护路径就拒）。
pipeline_heredoc_feeds_interpreter() { # $1=line
  local line="${1:-}" token IFS=$' \t' found=1 ch
  local -a toks
  for ch in '"' "'" '(' ')' '{' '}' '`' '|' ';' '&' '<' '>'; do line="${line//$ch/ }"; done
  read -r -a toks <<< "$line" || true
  for token in "${toks[@]}"; do
    case "${token##*/}" in
      bash|sh|zsh|dash|ksh) found=0 ;;
      "$PIPELINE_PY"|"$PIPELINE_PY"[0-9]*|node|nodejs|ruby|perl|php|lua|deno|bun|Rscript) [ "$found" = 0 ] || found=2 ;;
    esac
  done
  return "$found"
}
# $1=命令全文 $2=cwd $3=1 时跳过 heredoc 正文。0 = 找到写受保护路径的命令；1 = 没有；2 = heredoc 没有结束行。
pipeline_scan_shell_commands() {
  local line body segment tag='' dash=0 rest nl=$'\n' feed=1 patch_feed=0 subst_open='$(' assign_subst='=$(' assign_tick='=`' assign_mark='=$__subst__' angle_out='>(' angle_in='<(' pwd_sub='$(pwd)' pwd_var='$PWD' pwd_brace='${PWD}'
  local IFS=$'\n'
  local -a lines segments
  PIPELINE_SHELL_CWD="${2:-.}"
  PIPELINE_SHELL_VARS=''
  PIPELINE_DANGLING=0
  read -r -d '' -a lines <<< "${1:-}" || true
  [ "${#lines[@]}" -gt 0 ] || return 1
  for line in "${lines[@]}"; do
    line="${line%$'\r'}"
    if [ -n "$tag" ]; then
      body="$line"
      if [ "$dash" = 1 ]; then while [ "${body#$'\t'}" != "$body" ]; do body="${body#$'\t'}"; done; fi
      if [ "$body" = "$tag" ]; then tag=''; feed=1; patch_feed=0; continue; fi
      # 补丁正文里的头部行点名受保护路径（形态 6，heredoc 喂给 git apply / patch）。
      if [ "$patch_feed" = 1 ]; then
        case "$line" in
          '+++ '*|'--- '*|'diff --git '*|'rename to '*|'copy to '*) pipeline_mentions_protected "$line" && return 0 ;;
        esac
      fi
      # heredoc 喂给解释器：正文就是要执行的脚本，不再当文档跳过。
      case "$feed" in
        0) body="$line" ;;
        2) pipeline_mentions_protected "$line" && return 0; continue ;;
        *) continue ;;
      esac
    else
      body="$line"
    fi
    body="${body//"$pwd_sub"/$PIPELINE_SHELL_CWD}"
    body="${body//"$pwd_var"/$PIPELINE_SHELL_CWD}"
    body="${body//"$pwd_brace"/$PIPELINE_SHELL_CWD}"
    # 赋值号后面的命令替换：值无从知道，记成展开不了的变量（之后写到它就按受保护路径拒）。
    body="${body//"$assign_subst"/$assign_mark$nl}"
    body="${body//"$assign_tick"/$assign_mark$nl}"
    body="${body//"$subst_open"/$nl}"
    body="${body//"$angle_out"/$nl}"
    body="${body//"$angle_in"/$nl}"
    body="${body//\`/$nl}"
    body="${body//&&/$nl}"
    body="${body//||/$nl}"
    body="${body//>|/>}"
    body="${body//|/$nl}"
    body="${body//;/$nl}"
    body="${body//&/$nl}"
    segments=()
    read -r -d '' -a segments <<< "$body" || true
    if [ "${#segments[@]}" -gt 0 ]; then
      for segment in "${segments[@]}"; do
        pipeline_segment_writes_record "$segment" && return 0
      done
    fi
    if [ -z "$tag" ] && [ "${3:-1}" = 1 ]; then
      case "$line" in
        *'<<<'*) ;;
        *'<<'*)
          rest="${line#*<<}"
          dash=0
          case "$rest" in -*) dash=1; rest="${rest#-}" ;; esac
          rest="${rest#"${rest%%[![:space:]]*}"}"
          case "$rest" in
            "'"*) rest="${rest#\'}"; tag="${rest%%\'*}" ;;
            '"'*) rest="${rest#\"}"; tag="${rest%%\"*}" ;;
            '\'*) rest="${rest#\\}"; tag="${rest%%[[:space:];|&<>)]*}" ;;
            *) tag="${rest%%[[:space:];|&<>)]*}" ;;
          esac
          pipeline_heredoc_feeds_interpreter "$line"
          feed=$?
          patch_feed=0
          case "$line" in *'git apply'*|*'git am'*|*'patch '*|*'| patch'*) patch_feed=1 ;; esac
          ;;
      esac
    fi
  done
  [ -z "$tag" ] || return 2
  return 1
}
pipeline_shell_writes_record() { # $1=decoded command, $2=cwd → 0 when it writes a protected path or takes the trust decision
  local command="${1:-}" skip_bodies rc
  pipeline_mentions_protected "$command" || case "$command" in *trust*|*TRUST*|*bash*|*sh\ *|*zsh*|*"$PIPELINE_PY"*|*node*|*ruby*|*perl*|*php*|*deno*|*bun*|*source*|*apply*|*patch*|./*|*\ ./*|*\;./*) ;; *) return 1 ;; esac
  command="$(pipeline_unwrap_shell_wrapper "$command")"
  PIPELINE_CMD_TEXT="$command"
  PIPELINE_CMD_MENTIONS=0
  pipeline_mentions_protected "$command" && PIPELINE_CMD_MENTIONS=1
  for skip_bodies in 1 0; do
    pipeline_scan_shell_commands "$command" "${2:-.}" "$skip_bodies"
    rc=$?
    case "$rc" in 0) return 0 ;; 1) return 1 ;; esac # 2 = 有 heredoc 没结束：改成不跳正文再扫一遍
  done
  return 1
}
pipeline_refuse_test_record_write() {
  if [ "${PIPELINE_REFUSE_KIND:-record}" = trust ]; then
    printf '测试命令的信任只能由你本人在自己的终端里给出（tenon test trust）；CI 由运行器设置 TENON_TEST_TRUST=1，agent 不能替你确认\n' >&2
  else
    printf '测试记录与基线只能由 tenon test run / tenon test baseline 写入；测试计划、已知失败清单与豁免只能经 tenon test plan|register|waive|known 与 tenon review 写入\n' >&2
  fi
  exit 2
}
