#!/usr/bin/env bash
# adapters/cline/install.sh — 安装 Cline pipeline 适配器（lite，档 A 全保真）。
#
# Cline hooks 要求钩子是**物理文件**、精确命名（PreToolUse/PostToolUse/TaskStart/TaskResume，
# 无扩展名），放在 .clinerules/hooks/<Name>（spike 实证 cline/cline 仓库 .clinerules/hooks/README.md）
# ——不像 hooks.json/settings.json 那样可以在配置里指向任意绝对路径的命令。本 install.sh 因此在
# 目标项目里生成**薄 shim 文件**（每个 shim 只 `exec` 本仓库 adapters/cline/hooks/<Name> 的绝对路径），
# 而非直接拷贝逻辑本体——逻辑仍留在本仓库、可被 conformance 直接驱动，shim 只做路径转发。
#
# 投影产物：
#   .clinerules/hooks/PreToolUse    veto（真硬拦，{"cancel":true} 阻止工具执行）
#   .clinerules/hooks/PostToolUse   track（真 append history）
#   .clinerules/hooks/TaskStart     inject（新任务开始注入上下文）
#   .clinerules/hooks/TaskResume    inject（恢复任务注入上下文，委托 TaskStart 同一份逻辑）
#
# **重要**：Cline 要求在 VSCode 设置里手动勾选一次「Enable Hooks」，钩子才会生效（一次性人工步骤，
# 同 Codex 的 trust 步骤，不降主档——见 contract.md 档 A 判据是"能力保真"而非"零人工步骤"）。
#
# 选项：--target <dir>（默认 $PWD）/ --global（改装 ~/Documents/Cline/Hooks/，而非项目级）
#       / --no-hooks（跳过 hook 安装，降级）/ --yes / -h
#
# 落盘一律走 adapters/lib/atomic-write.sh：半个 PreToolUse shim 会让 Cline 拿不到 cancel:true，
# 硬拦静默失效；旁挂 .pipeline-adapter 则记为「未生效」并以非零码收尾。
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SIGNATURE="# pipeline-adapter:cline"

. "$ADAPTER_DIR/../lib/atomic-write.sh"
adapter_lib_init cline

G='\033[32m'; Y='\033[33m'; R='\033[31m'; B='\033[1m'; Z='\033[0m'
info() { printf "${G}[cline]${Z} %b\n" "$1"; }
warn() { printf "${Y}[cline]${Z} %b\n" "$1"; }
err()  { printf "${R}[cline]${Z} %b\n" "$1" >&2; }
note() { printf "%b\n" "$1"; }

TARGET="$PWD"
GLOBAL=0
WITH_HOOKS=1
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)   TARGET="${2:?--target 需要目录}"; shift 2 ;;
    --global)   GLOBAL=1; shift ;;
    --no-hooks) WITH_HOOKS=0; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    -h|--help)
      # --help 打印文件头注释块，止于第一行非注释。不写死行号：行号会随头部注释增删而失配，
      # 把 `set -euo pipefail` 这类代码行当帮助文本打出来。
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) err "未知参数: $1（见 --help）"; exit 2 ;;
  esac
done

if [ "$GLOBAL" = 1 ]; then
  HOOKS_DIR="$HOME/Documents/Cline/Hooks"
else
  HOOKS_DIR="$TARGET/.clinerules/hooks"
fi

# ── 生成薄 shim：exec 本仓库 adapters/cline/hooks/<name> 的绝对路径（保留 stdin/argv 透传）──
install_hook_shim() { # <name>
  # 注意：不能写成 `local name="$1" src="...$name..."`——bash 对同一条 local 语句里的多个
  # 赋值会先展开全部 RHS 再赋值，此时后面的 $name 仍读外层作用域（set -u 下报 unbound）。
  # 故拆成三条独立 local 语句，确保 name 先落地再被 src/dst 引用。
  local name="$1"
  local src="$ADAPTER_DIR/hooks/$name"
  local dst="$HOOKS_DIR/$name"
  mkdir -p "$HOOKS_DIR"
  if [ -f "$dst" ] && ! grep -qF "$SIGNATURE" "$dst" 2>/dev/null; then
    warn "$dst 已存在（非本适配器管理，疑似你既有 hook）——不覆盖，写建议文件 ${dst}.pipeline-adapter 供手动合并。"
    atomic_stage "$dst.pipeline-adapter"
    { printf '#!/usr/bin/env bash\n%s\n' "$SIGNATURE"; printf 'exec bash "%s" "$@"\n' "$src"; } > "$ATOMIC_TMP"
    atomic_commit "$dst.pipeline-adapter" --mode 0755
    adapter_mark_not_applied "$dst.pipeline-adapter" \
      "$dst 已被你既有的 ${name} hook 占用，Cline 现在跑的仍是旧 hook——${name} 未接管"
    return 0
  fi
  atomic_stage "$dst"
  { printf '#!/usr/bin/env bash\n%s\n' "$SIGNATURE"; printf 'exec bash "%s" "$@"\n' "$src"; } > "$ATOMIC_TMP"
  atomic_commit "$dst" --mode 0755
  info "hook shim → ${dst}（转发到 ${src}）"
}

note "${B}Cline pipeline 适配器安装${Z}  target=${TARGET}  hooks-dir=${HOOKS_DIR}"
if [ "$WITH_HOOKS" = 1 ]; then
  install_hook_shim PreToolUse
  install_hook_shim PostToolUse
  install_hook_shim TaskStart
  install_hook_shim TaskResume
  note ""
  note "${B}════════ 档 A 全保真：还差一步（一次性手动启用）════════${Z}"
  note "Cline 要求手动启用 Hooks 功能，未启用前钩子文件不会被执行："
  note "  VSCode → Cline 侧栏 → 设置（齿轮图标）→ Feature Settings → 勾选 ${B}\"Enable Hooks\"${Z}"
  note "${B}════════════════════════════════════════════════════${Z}"
  # 「完成」只在四个 shim 都真接管时才打印；任何一项退化成旁挂建议文件都由 adapter_finish 非零退出。
  [ "$ADAPTER_NOT_APPLIED_COUNT" -eq 0 ] \
    && info "档 A 完成：inject（TaskStart/TaskResume）/ veto（PreToolUse cancel:true）/ track（PostToolUse）全 native。" || true
else
  warn "--no-hooks：跳过 hook 安装（无自动强制/注入/留痕；review 仍须走 tenon review request/acknowledge）。"
fi
adapter_finish
