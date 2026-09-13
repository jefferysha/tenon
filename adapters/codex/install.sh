#!/usr/bin/env bash
# adapters/codex/install.sh — 安装 Codex pipeline 适配器（lite 版，分档 A/B/C）。
#
# 三档（互斥，由 flag 选）：
#   默认（无 flag）= 档 A 全保真·manual-trust：
#       写 hooks.json（inject/route/veto/track wrapper 绝对路径）到 CODEX_HOME，落静态上下文层，
#       结尾打印一次性 trust 指引（codex TUI 里 /hooks 按 t）。
#   --managed  = 档 B 全保真·managed/MDM：写 /etc/codex/{requirements.toml,managed_hooks}。需 root。
#       绝不静默 sudo——非 root 就打印需手动 sudo 的命令、不自动执行。
#   --static   = 档 C 静态降级：只落静态上下文层（AGENTS.md 哨兵块），不装 hooks（无自动强制，
#       靠 AGENTS.md 自律 + 人类下一条明确确认）。
#
# 选项：--target <dir>（默认 $PWD）/ --codex-home <dir>（默认 ${CODEX_HOME:-$HOME/.codex}）/ --yes / -h
# 安全：默认绝不碰 /etc 或 root 路径；--managed 检测非 root 即停、只打印命令。
#
# 落盘一律走 adapters/lib/atomic-write.sh：AGENTS.md 里有用户自己的内容，hooks.json 是 hook
# 注册的唯一载体——半个文件要么吃掉用户内容，要么让 Codex 读不到 hook 而静默放行。
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLATFORM_ID=codex

. "$ADAPTER_DIR/../lib/atomic-write.sh"
adapter_lib_init codex

G='\033[32m'; Y='\033[33m'; R='\033[31m'; B='\033[1m'; Z='\033[0m'
info() { printf "${G}[codex]${Z} %b\n" "$1"; }
warn() { printf "${Y}[codex]${Z} %b\n" "$1"; }
err()  { printf "${R}[codex]${Z} %b\n" "$1" >&2; }
note() { printf "%b\n" "$1"; }

MODE="full"        # full(A) | managed(B) | static(C)
TARGET="$PWD"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --managed) MODE="managed"; shift ;;
    --static)  MODE="static";  shift ;;
    --target)  TARGET="${2:?--target 需要目录参数}"; shift 2 ;;
    --codex-home) CODEX_HOME_DIR="${2:?--codex-home 需要目录参数}"; shift 2 ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    -h|--help)
      # --help 打印文件头注释块，止于第一行非注释。不写死行号：行号会随头部注释增删而失配，
      # 把 `set -euo pipefail` 这类代码行当帮助文本打出来。
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) err "未知参数: $1（见 --help）"; exit 2 ;;
  esac
done

confirm() { # prompt → 0 同意
  [ "$ASSUME_YES" = 1 ] && return 0
  printf "%b%s%b [y/N] " "$B" "$1" "$Z"
  local ans; read -r ans </dev/tty 2>/dev/null || ans=""
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ── 静态上下文层（三档共用）：消费身份生成的 AGENTS.md managed block ──
install_static() {
  local dest="$1"
  mkdir -p "$dest" || { err "无法创建目标目录: $dest"; exit 1; }
  local START="<!-- PIPELINE:CODEX:START -->" END="<!-- PIPELINE:CODEX:END -->"
  local template="$ADAPTER_DIR/../../templates/generated/codex-agents-block.md"
  [ -f "$template" ] || { err "缺少生成的 Codex managed block: $template"; exit 1; }
  local f="$dest/AGENTS.md"
  if [ -f "$f" ]; then
    local start_count end_count
    start_count="$(grep -cFx "$START" "$f" 2>/dev/null || true)"
    end_count="$(grep -cFx "$END" "$f" 2>/dev/null || true)"
    case "$start_count:$end_count" in
      0:0|1:1) ;;
      *)
        err "AGENTS.md 的 Tenon 哨兵块必须成对且唯一，拒绝改写用户内容: $f"
        exit 1
        ;;
    esac
    if [ "$start_count" = 1 ]; then
      # awk 只用退出码表达判定（无输出）。直接放进 if 条件里判，别经命令替换取 $?——
      # set -e 下命令替换子 shell 会在 awk 非零时提前退出，$? 根本传不出来。
      if ! awk -v s="$START" -v e="$END" '
        $0==s { if (seen_end || seen_start) exit 2; seen_start=1; next }
        $0==e { if (!seen_start || seen_end) exit 2; seen_end=1; next }
        END { if (!seen_start || !seen_end) exit 2 }
      ' "$f" 2>/dev/null; then
        err "AGENTS.md 的 Tenon 哨兵块顺序非法，拒绝改写用户内容: $f"
        exit 1
      fi
    fi
  fi
  if [ -f "$f" ] && [ "$start_count" = 1 ]; then
    # 哨兵块精确替换（块内重刷、块外用户内容原样保留）
    # macOS/BSD awk 不接受带换行的 -v 值。把新块放进受控临时文件，再由 awk 逐行读取，
    # 才能既保留块外内容又保证第二次安装真幂等。
    local block_tmp
    block_tmp="$(mktemp)"
    cp "$template" "$block_tmp"
    atomic_stage "$f"
    if awk -v s="$START" -v e="$END" -v b="$block_tmp" '
      $0==s {
        while ((getline line < b) > 0) print line
        close(b)
        skip=1
        next
      }
      $0==e {skip=0; next}
      !skip {print}
    ' "$f" > "$ATOMIC_TMP"; then
      atomic_commit "$f"
    else
      atomic_abort
      rm -f "$block_tmp"
      err "无法刷新 AGENTS.md 的 Pipeline 静态块: $f"
      exit 1
    fi
    rm -f "$block_tmp"
  else
    # 追加也先在暂存文件里拼完整份再原子替换：裸 `>>` 被打断会在用户 AGENTS.md 尾部留半个
    # 哨兵块，下次安装认不出来就会再追加一份（也就不再幂等）。
    atomic_stage "$f"
    { if [ -f "$f" ]; then cat "$f"; fi; printf '\n'; cat "$template"; } > "$ATOMIC_TMP"
    atomic_commit "$f"
  fi
  info "AGENTS.md 静态层 → ${f}（哨兵块幂等）"
}

# ── 项目技能部署（native/static 互斥）─────────────────────────────────────
# 这是非原生 adapter 的兼容投影：`tenon setup --codex` 走 Codex marketplace 原生插件，
# 不会调用本脚本。仅当用户明确需要把 pipeline 投递到某个项目时，才软链**本插件完整自带**的
# skills 到目标 `.agents/skills/`。不读取 Claude/Codex 的第三方 cache，也不安装任何外部 skill。
# 已有用户目录或非同源链接一律报错而不覆盖。

install_project_skills() {
  local dest="$1"
  local source_root skills_dest source name target linked installed=0
  local -a sources
  source_root="$(cd -P "$ADAPTER_DIR/../../skills" 2>/dev/null && pwd -P)" || { err "找不到插件 skills 目录"; exit 1; }
  [ -d "$source_root" ] || { err "找不到插件 skills 目录: $source_root"; exit 1; }
  skills_dest="$dest/.agents/skills"
  mkdir -p "$skills_dest" || { err "无法创建项目技能目录: $skills_dest"; exit 1; }

  sources=()
  for source in "$source_root"/*; do
    [ -d "$source" ] || continue
    [ -f "$source/SKILL.md" ] || { err "插件 skill 缺 SKILL.md: $source"; exit 1; }
    sources+=("$source")
  done

  # 先完整检查冲突，避免半途失败留下半套投递结果。
  for source in "${sources[@]}"; do
    name="${source##*/}"
    target="$skills_dest/$name"
    if [ -L "$target" ]; then
      linked="$(cd -P "$target" 2>/dev/null && pwd)" || { err "项目 skill 是悬空链接，拒绝覆盖: $target"; exit 1; }
      [ "$linked" = "$source" ] || { err "项目 skill 已指向其他来源，拒绝覆盖: $target"; exit 1; }
    elif [ -e "$target" ]; then
      err "项目 skill 已存在，拒绝覆盖: $target"
      exit 1
    fi
  done

  for source in "${sources[@]}"; do
    name="${source##*/}"
    target="$skills_dest/$name"
    if [ -L "$target" ]; then
      continue
    fi
    ln -s "$source" "$target" || { err "无法投递项目 skill: $target"; exit 1; }
    installed=$((installed + 1))
  done
  info "项目 pipeline/OpenSpec skills → ${skills_dest}（新增 ${installed} 个，已存在同源链接保持不变）"
}

# Native Codex discovery must be selected by the host/stable launcher.  Never enumerate cache
# directories here: an old cache is rollback material, not evidence that its Skills are active.
selected_native_plugin_root() {
  local candidate physical manifest
  for candidate in "${TENON_CODEX_PLUGIN_ROOT:-}" "${TENON_HOST_PLUGIN_ROOT:-}"; do
    [ -n "$candidate" ] || continue
    physical="$(cd -P "$candidate" 2>/dev/null && pwd -P)" || continue
    manifest="$physical/.codex-plugin/plugin.json"
    [ -f "$manifest" ] || continue
    [ -d "$physical/skills" ] || continue
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"tenon"' "$manifest" 2>/dev/null || continue
    printf '%s' "$physical"
    return 0
  done
  return 1
}

# Remove only links this exact adapter can prove it owns: each link must still resolve to the
# corresponding canonical source directory beside this installer.  Real directories, files,
# dangling links and foreign links are preserved and reported as a shadow conflict.
converge_project_skills_to_native() { # $1=project $2=selected native root
  local dest="$1" native_root="$2"
  local source_root skills_dest source name target linked removed=0 conflicts=0
  local -a owned_targets
  source_root="$(cd -P "$ADAPTER_DIR/../../skills" 2>/dev/null && pwd -P)" \
    || { err "找不到插件 skills 目录"; return 1; }
  skills_dest="$dest/.agents/skills"
  [ -d "$skills_dest" ] || {
    info "Selected Skill Root → ${native_root}/skills（项目无旧 Skill 投影）"
    return 0
  }

  owned_targets=()
  for source in "$source_root"/*; do
    [ -d "$source" ] || continue
    [ -f "$source/SKILL.md" ] || { err "插件 skill 缺 SKILL.md: $source"; return 1; }
    name="${source##*/}"
    target="$skills_dest/$name"
    if [ -L "$target" ]; then
      linked="$(cd -P "$target" 2>/dev/null && pwd -P)" || {
        err "shadow-conflict: 保留悬空项目 Skill 链接: $target"
        conflicts=$((conflicts + 1))
        continue
      }
      if [ "$linked" = "$source" ]; then
        owned_targets+=("$target")
      else
        err "shadow-conflict: 保留非 tenon 所有的项目 Skill 链接: $target → $linked"
        conflicts=$((conflicts + 1))
      fi
    elif [ -e "$target" ]; then
      err "shadow-conflict: 保留用户所有的项目 Skill 路径: $target"
      conflicts=$((conflicts + 1))
    fi
  done

  [ "$conflicts" -eq 0 ] || {
    err "检测到 ${conflicts} 个同名 Skill 冲突；未删除任何项目 Skill。"
    return 1
  }
  for target in "${owned_targets[@]}"; do
    rm "$target" || { err "无法移除 adapter-owned Skill 链接: $target"; return 1; }
    removed=$((removed + 1))
  done
  info "Selected Skill Root → ${native_root}/skills（已安全收敛 ${removed} 个旧项目链接）"
}

install_or_converge_project_skills() {
  local dest="$1" native_root
  native_root="$(selected_native_plugin_root || true)"
  if [ -n "$native_root" ]; then
    converge_project_skills_to_native "$dest" "$native_root"
  else
    install_project_skills "$dest"
  fi
}

# ── hooks.json 投递（档 A）：占位替换为绝对适配器路径 ──
install_hooks_codex_home() {
  mkdir -p "$CODEX_HOME_DIR" || { err "无法创建 CODEX_HOME: $CODEX_HOME_DIR"; exit 1; }
  local hj="$CODEX_HOME_DIR/hooks.json"
  if [ -f "$hj" ]; then
    warn "CODEX_HOME 已存在 hooks.json: $hj —— 不自动覆盖你既有 hook。"
    warn "已替换占位的版本写到 $hj.pipeline-adapter（供你手动合并事件 group）。"
    atomic_render_template "$ADAPTER_DIR/hooks.json" "$hj.pipeline-adapter" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
    adapter_mark_not_applied "$hj.pipeline-adapter" \
      "$hj 已被你既有 hook 占用，Codex 现在读的仍是旧 hooks.json——inject/route/veto/track 均未接管"
    return 0
  fi
  atomic_render_template "$ADAPTER_DIR/hooks.json" "$hj" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
  info "hooks.json → ${hj}（inject/route/veto/track wrapper 绝对路径已绑定）"
}

print_trust_instructions() {
  note ""
  note "${B}════════ 档 A 全保真：还差一步（一次性 trust）════════${Z}"
  note "Codex 普通用户态对自定义 hook 要求一次性人工 trust。未 trust 前 inject/route/veto/track 不生效。"
  note "  1. 启动 Codex TUI：${B}codex${Z}   2. 输入 ${B}/hooks${Z}   3. 对 pipeline hooks.json 按 ${B}t${Z}"
  note "改动 wrapper/hooks.json 后需重新 trust。之后 \`codex exec\` 复用 trust，三能力自动跑。"
  note "${B}══════════════════════════════════════════════════${Z}"
}

install_managed() {
  local req="/etc/codex/requirements.toml" mdir="/etc/codex/managed_hooks"
  note ""
  warn "档 B（managed/MDM 全保真）需写系统级 root 路径 ${req} 与 ${mdir}（唯一 trust-free 的 headless 路径）。"
  # 暂存文件是给用户 sudo 前先 `cat` 审阅的那一份，同样走原子渲染：审阅到半个 JSON
  # 然后 sudo cp 上去，等于把 fail-open 直接铺到系统级 managed_dir。
  local staged_hooks; staged_hooks="$(mktemp "${TMPDIR:-/tmp}/codex-managed-hooks.XXXXXX.json")"
  atomic_render_template "$ADAPTER_DIR/hooks.json" "$staged_hooks" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
  local staged_req; staged_req="$(mktemp "${TMPDIR:-/tmp}/codex-requirements.XXXXXX.toml")"
  atomic_stage "$staged_req"
  printf '# pipeline-workflow codex adapter — managed hooks（档 B）\n[hooks]\nmanaged_dir = "%s"\n' "$mdir" > "$ATOMIC_TMP"
  atomic_commit "$staged_req"
  if [ "$(id -u)" -ne 0 ]; then
    err "当前非 root。${B}绝不静默 sudo${Z}——请手动执行（先审阅暂存文件）："
    note "  cat $staged_req ; cat $staged_hooks"
    note "  sudo mkdir -p $mdir && sudo cp $staged_hooks $mdir/hooks.json"
    note "  sudo cp $staged_req $req   # 若已存在改为手动合并 [hooks] 段"
    install_static "$TARGET"; install_or_converge_project_skills "$TARGET" || exit 1
    return 0
  fi
  confirm "确认以 root 写入 ${req} 与 ${mdir}？" || { warn "已取消，未改动系统。"; return 0; }
  mkdir -p "$mdir"
  atomic_write "$mdir/hooks.json" --json < "$staged_hooks"
  if [ -f "$req" ]; then
    warn "$req 已存在——请手动合并 [hooks] 段。"
    adapter_mark_not_applied "$staged_req" \
      "$req 已存在，managed_dir 指向未写入——Codex 不会加载 ${mdir} 下的 managed hooks"
  else
    atomic_write "$req" < "$staged_req"
    info "requirements.toml → $req"
  fi
  info "managed hooks → $mdir/hooks.json（always-on、免 trust）"
  install_static "$TARGET"; install_or_converge_project_skills "$TARGET" || exit 1
}

# ════════════════ 主流程 ════════════════
note "${B}Codex pipeline 适配器安装${Z}  mode=${MODE}  target=${TARGET}"
case "$MODE" in
  static)
    install_static "$TARGET"; install_or_converge_project_skills "$TARGET" || exit 1
    info "档 C（静态降级）完成：AGENTS.md 已落地；无 native selected root 时才投递项目 skills，${B}未装 hooks${Z}（无自动强制；review 仍必须等用户下一条明确确认，不能删 marker 绕过）。"
    ;;
  full)
    install_static "$TARGET"; install_or_converge_project_skills "$TARGET" || exit 1
    install_hooks_codex_home
    # trust 指引只在 hooks.json 真接管时才有意义——旁挂建议文件时由 adapter_finish 非零退出。
    [ "$ADAPTER_NOT_APPLIED_COUNT" -eq 0 ] && print_trust_instructions || true
    ;;
  managed)
    install_managed
    ;;
esac
adapter_finish
