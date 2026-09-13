#!/usr/bin/env bash
# adapters/lib/atomic-write.sh — 所有适配器共用的「原子落盘 + 诚实安装结果」库。
#
# ── 为什么存在（两个已实证的静默失效面）─────────────────────────────────────
# ① 裸截断写。`sed ... > "$dst"` 是 O_TRUNC：目标先被清零，再逐块写入。写到一半被打断
#    （Ctrl-C、磁盘满、sed 失败、宿主重启）就留下半个 JSON。宿主解析失败后普遍 fail-open
#    ——registry.yaml 里 `veto_failclosed: true` 这个核心承诺随之静默失效，既无 receipt
#    也无任何可观测信号。修法是同一文件系统内 mktemp 暂存 → 校验 → mv：rename(2) 在同一
#    文件系统内原子，读者只会看到「完整的旧文件」或「完整的新文件」，不存在中间态。
#    临时文件必须与目标同目录（不是 $TMPDIR）——跨文件系统的 mv 退化成 copy+unlink，
#    原子性当场消失。
# ② 未生效却宣称成功。目标配置已存在时，installer 只旁挂一份 `<dst>.pipeline-adapter`
#    供人工合并，却仍然 exit 0 并打印「完成」。叠加宿主 fail-open，一次完全没生效的安装
#    对用户没有任何信号。本库把「未生效」记成账（adapter_mark_not_applied），由
#    adapter_finish 统一以非零码收尾并列出需人工合并的路径。
#
# ── 用法（各 installer）─────────────────────────────────────────────────────
#   set -euo pipefail
#   . "$ADAPTER_DIR/../lib/atomic-write.sh"
#   adapter_lib_init cursor
#   atomic_write "$dst" <<'EOF'            # 内容走 stdin（heredoc / < file）
#   atomic_render_template "$src" "$dst" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
#   atomic_stage "$dst"; awk ... > "$ATOMIC_TMP"; atomic_commit "$dst"   # 需要自己生成内容时
#   adapter_mark_not_applied "$dst.pipeline-adapter" "hooks.json 已被占用，未接管"
#   adapter_finish                          # 有未生效项 → exit 3；否则 exit 0
#
# 调用约定：本库的函数**不要放在管道右侧**。bash 的管道末段跑在子 shell 里，暂存文件登记和
# 「未生效」记账会随子 shell 一起消失（trap 清不到、退出码不体现）。要拼内容就用 heredoc、
# 输入重定向，或 atomic_stage/atomic_commit。
#
# 单一实现，11 个适配器共用：加平台仍是填表，不需要复制第 12 份落盘逻辑。

# 已被本库暂存、尚未 mv 的临时文件（trap 清理用）
_ATOMIC_TMP_FILES=()
# 「写了旁挂建议文件但没真正生效」的记账
ADAPTER_NOT_APPLIED_PATHS=()
ADAPTER_NOT_APPLIED_COUNT=0
ADAPTER_LIB_PLATFORM="adapter"
# 未生效的退出码：与「用法错误」(2) 区分，便于调用方分流
ADAPTER_EXIT_NOT_APPLIED=3

_AW_R='\033[31m'; _AW_Z='\033[0m'

_atomic_err() { printf "${_AW_R}[%s]${_AW_Z} %b\n" "$ADAPTER_LIB_PLATFORM" "$1" >&2; }

# 清理所有仍在暂存态的临时文件（正常退出 / 中断 / 被 set -e 中止都会走到）
_atomic_cleanup() {
  local f
  for f in ${_ATOMIC_TMP_FILES[@]+"${_ATOMIC_TMP_FILES[@]}"}; do
    [ -n "$f" ] && rm -f "$f" 2>/dev/null || true
  done
  _ATOMIC_TMP_FILES=()
}

_atomic_forget() { # <tmp> 从待清理列表移除（已成功 mv 走）
  local keep=() f
  for f in ${_ATOMIC_TMP_FILES[@]+"${_ATOMIC_TMP_FILES[@]}"}; do
    [ "$f" = "$1" ] || keep+=("$f")
  done
  _ATOMIC_TMP_FILES=(${keep[@]+"${keep[@]}"})
}

adapter_lib_init() { # <platform-id>
  ADAPTER_LIB_PLATFORM="${1:-adapter}"
  ADAPTER_NOT_APPLIED_PATHS=()
  ADAPTER_NOT_APPLIED_COUNT=0
  _ATOMIC_TMP_FILES=()
  trap '_atomic_cleanup' EXIT
  trap '_atomic_cleanup; trap - INT; kill -INT $$' INT
  trap '_atomic_cleanup; exit 143' TERM
  trap '_atomic_cleanup; exit 129' HUP
}

# JSON 结构校验：宿主真正会解析它，半个文件必须在 mv 之前被拦下。
# node/python3 在则用真解析器；都没有时退回 awk 的括号/字符串配平扫描——
# 后者足以抓住本库要防的失效模式（截断 = 括号不配平 / 字符串未闭合）。
_atomic_json_balanced() { # <file>
  awk '
    BEGIN { depth = 0; instr = 0; esc = 0; seen = 0; bad = 0 }
    bad { next }
    {
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (instr) {
          if (esc) { esc = 0 }
          else if (c == "\\") { esc = 1 }
          else if (c == "\"") { instr = 0 }
          continue
        }
        if (c == "\"") { instr = 1; seen = 1; continue }
        if (c == "{" || c == "[") { depth++; seen = 1; continue }
        if (c == "}" || c == "]") {
          depth--; seen = 1
          if (depth < 0) { bad = 1; next }
        }
      }
      # JSON 字符串不能跨行；跨行即非法（典型的截断特征）
      if (instr) { bad = 1 }
    }
    END { if (bad || instr || depth != 0 || !seen) exit 1 }
  ' "$1"
}

atomic_json_valid() { # <file> → 0 合法
  local f="$1"
  [ -s "$f" ] || return 1
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" >/dev/null 2>&1
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" >/dev/null 2>&1
    return $?
  fi
  _atomic_json_balanced "$f"
}

_atomic_stat_mode() { # <file> → 八进制权限（BSD/GNU stat 两种形态）
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || printf '644'
}

# ── 暂存 → 提交 两段式 ──────────────────────────────────────────────────────
# ATOMIC_TMP 指向与目标同目录（= 同文件系统）的暂存文件。跨文件系统的 mv 会退化成
# copy+unlink，原子性当场消失，所以暂存文件绝不能放 $TMPDIR。
ATOMIC_TMP=""

atomic_stage() { # <dst>
  local dir
  dir="$(dirname "$1")"
  mkdir -p "$dir" || { _atomic_err "无法创建目录: $dir"; return 1; }
  ATOMIC_TMP="$(mktemp "$dir/.tenon-adapter.XXXXXX")" || { _atomic_err "无法在 $dir 创建临时文件"; return 1; }
  _ATOMIC_TMP_FILES+=("$ATOMIC_TMP")
  return 0
}

atomic_abort() { # 放弃本次暂存（目标保持原样）
  [ -n "$ATOMIC_TMP" ] || return 0
  rm -f "$ATOMIC_TMP"
  _atomic_forget "$ATOMIC_TMP"
  ATOMIC_TMP=""
  return 0
}

# 提交：校验 → 定权限 → mv（rename(2) 原子）。任何一步失败都保持目标完全原样。
atomic_commit() { # <dst> [--json] [--mode <octal>]
  local dst="" want_json=0 mode="" tmp="$ATOMIC_TMP"
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) want_json=1; shift ;;
      --mode) mode="${2:?--mode 需要八进制权限}"; shift 2 ;;
      *) if [ -z "$dst" ]; then dst="$1"; shift; else _atomic_err "atomic_commit 多余参数: $1"; return 2; fi ;;
    esac
  done
  [ -n "$dst" ] || { _atomic_err "atomic_commit 缺目标路径"; return 2; }
  [ -n "$tmp" ] || { _atomic_err "atomic_commit 无暂存文件（缺 atomic_stage）: $dst"; return 2; }

  if [ "$want_json" = 1 ] && ! atomic_json_valid "$tmp"; then
    _atomic_err "生成内容不是合法 JSON，拒绝落盘（目标保持原样，宿主不会读到半个配置）: $dst"
    atomic_abort; return 1
  fi
  # mktemp 建的文件是 0600；配置文件用 0600 会在多用户/CI 场景下失效，故显式定权限：
  # 显式 --mode 优先，其次沿用目标既有权限（重装不改用户已调过的位），最后默认 0644。
  if [ -z "$mode" ]; then
    if [ -f "$dst" ]; then mode="$(_atomic_stat_mode "$dst")"; else mode="0644"; fi
  fi
  chmod "$mode" "$tmp" 2>/dev/null || true
  if ! mv -f "$tmp" "$dst"; then
    _atomic_err "原子替换失败，目标保持原样: $dst"
    atomic_abort; return 1
  fi
  _atomic_forget "$tmp"
  ATOMIC_TMP=""
  return 0
}

# 内容从 stdin 读（heredoc / < file）。不要放在管道右侧，见文件头「调用约定」。
atomic_write() { # <dst> [--json] [--mode <octal>]
  local dst="$1"
  atomic_stage "$dst" || return 1
  if ! cat > "$ATOMIC_TMP"; then
    _atomic_err "写入暂存文件失败，目标保持原样: $dst"
    atomic_abort; return 1
  fi
  atomic_commit "$@"
}

# 模板投影（占位符 → 绝对路径）：11 个适配器里最常见的落盘形态，收在一处而不是各写一遍 sed。
atomic_render_template() { # <src> <dst> <placeholder> <value> [--json] [--mode <octal>]
  local src="$1" dst="$2" ph="$3" val="$4"
  shift 4
  [ -f "$src" ] || { _atomic_err "模板不存在: $src"; return 1; }
  atomic_stage "$dst" || return 1
  if ! sed "s#${ph}#${val}#g" "$src" > "$ATOMIC_TMP"; then
    _atomic_err "模板渲染失败，目标保持原样: $dst"
    atomic_abort; return 1
  fi
  atomic_commit "$dst" "$@"
}

# 记账：只写了旁挂建议文件 = 投影**没有生效**。安装结束时必须非零退出。
adapter_mark_not_applied() { # <sidecar-path> <原因>
  ADAPTER_NOT_APPLIED_COUNT=$((ADAPTER_NOT_APPLIED_COUNT + 1))
  ADAPTER_NOT_APPLIED_PATHS+=("$1")
  _atomic_err "未生效：${2}——需人工合并 ${1}"
}

# 统一收尾：有未生效项就非零退出并列出全部待合并路径，绝不打印「完成」。
adapter_finish() { # [成功时打印的一行说明]
  if [ "$ADAPTER_NOT_APPLIED_COUNT" -gt 0 ]; then
    _atomic_err "安装未生效：${ADAPTER_NOT_APPLIED_COUNT} 项配置没有接管，宿主此刻不会执行 pipeline 的 inject/veto/track。"
    local p
    for p in ${ADAPTER_NOT_APPLIED_PATHS[@]+"${ADAPTER_NOT_APPLIED_PATHS[@]}"}; do
      _atomic_err "  需人工合并 ${p}"
    done
    exit "$ADAPTER_EXIT_NOT_APPLIED"
  fi
  [ $# -eq 0 ] || printf '%b\n' "$1"
  exit 0
}
