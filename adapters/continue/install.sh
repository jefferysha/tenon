#!/usr/bin/env bash
# adapters/continue/install.sh — 安装 Continue CLI（`cn`）pipeline 适配器（lite，档 A 全保真）。
#
# 目标面是 **Continue CLI**（`cn`），非 Continue.dev IDE 插件（VSCode/JetBrains 的 config.yaml
# rules 静态层——spike 实证该面无任何 hook/lifecycle 事件，仅静态 system-prompt 拼接）。Continue
# CLI 有独立的、与 Claude Code 逐字同构的 hooks 系统（README「研究结论」详述），是本 adapter
# 的实际承载面。
#
# 投影产物：
#   .continue/settings.json   三能力 hook（inject/veto/track，__ADAPTER_DIR__ 定死绝对路径，
#                              wrapper 从仓库跑，自定位 lite baseline hooks/*.sh）
# Continue CLI hook 协议与 CC 逐字同构——三 wrapper 薄包 baseline，无 trust 机制、落盘即生效。
# 额外：Continue CLI 同时兼容读取 ~/.claude/settings.json / .claude/settings.json（跨工具共用），
#   但本 adapter 仍写独立的 .continue/settings.json，保持"各平台各自 configDir"的填表惯例。
#
# 选项：--target <dir>（默认 $PWD）/ --continue-home <dir>（默认 $TARGET/.continue）
#       / --no-hooks（跳过 hook 安装，降级）/ --yes / -h
#
# 落盘一律走 adapters/lib/atomic-write.sh（原子替换 + JSON 校验 + 未生效非零退出）。
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

. "$ADAPTER_DIR/../lib/atomic-write.sh"
adapter_lib_init continue

G='\033[32m'; Y='\033[33m'; R='\033[31m'; B='\033[1m'; Z='\033[0m'
info() { printf "${G}[continue]${Z} %b\n" "$1"; }
warn() { printf "${Y}[continue]${Z} %b\n" "$1"; }
err()  { printf "${R}[continue]${Z} %b\n" "$1" >&2; }
note() { printf "%b\n" "$1"; }

TARGET="$PWD"
CONTINUE_HOME_DIR=""
WITH_HOOKS=1
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)        TARGET="${2:?--target 需要目录}"; shift 2 ;;
    --continue-home) CONTINUE_HOME_DIR="${2:?--continue-home 需要目录}"; shift 2 ;;
    --no-hooks)       WITH_HOOKS=0; shift ;;
    --yes|-y)         ASSUME_YES=1; shift ;;
    -h|--help)
      # --help 打印文件头注释块，止于第一行非注释。不写死行号：行号会随头部注释增删而失配，
      # 把 `set -euo pipefail` 这类代码行当帮助文本打出来。
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) err "未知参数: $1（见 --help）"; exit 2 ;;
  esac
done
[ -n "$CONTINUE_HOME_DIR" ] || CONTINUE_HOME_DIR="${CONTINUE_GLOBAL_DIR:-$TARGET/.continue}"

# ── .continue/settings.json#hooks 投递（占位替换为绝对适配器路径；已存在则不覆盖，写 .pipeline-adapter 供合并）──
install_hooks_settings() {
  mkdir -p "$CONTINUE_HOME_DIR" || { err "无法创建 .continue: $CONTINUE_HOME_DIR"; exit 1; }
  local sj="$CONTINUE_HOME_DIR/settings.json"
  if [ -f "$sj" ]; then
    warn "$sj 已存在——不自动覆盖你既有 settings。替换版写到 $sj.pipeline-adapter 供合并。"
    atomic_render_template "$ADAPTER_DIR/settings.json" "$sj.pipeline-adapter" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
    adapter_mark_not_applied "$sj.pipeline-adapter" \
      "$sj 已被你既有 settings 占用，Continue CLI 现在读的仍是旧配置——inject/veto/track 三能力均未接管"
    return 0
  fi
  atomic_render_template "$ADAPTER_DIR/settings.json" "$sj" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
  info "settings.json#hooks → ${sj}（inject/veto/track wrapper 绝对路径已绑定）"
}

note "${B}Continue CLI（cn）pipeline 适配器安装${Z}  target=${TARGET}  continue-home=${CONTINUE_HOME_DIR}"
if [ "$WITH_HOOKS" = 1 ]; then
  # 「档 A 全保真完成」只在 hooks 真接管时才打印；旁挂建议文件走 adapter_finish 的非零退出。
  install_hooks_settings
  adapter_finish "${G}[continue]${Z} 档 A 全保真完成：三能力全 native（.continue/settings.json#hooks，与 CC 逐字同构，无 trust，落盘即生效）。"
else
  warn "--no-hooks：跳过 hook 安装（无自动强制；review 仍须走 tenon review request/acknowledge）。"
fi
adapter_finish
