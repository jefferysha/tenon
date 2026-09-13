#!/usr/bin/env bash
# adapters/amp/install.sh — 安装 Amp（Sourcegraph）pipeline 适配器（lite，档 A 全保真）。
#
# Amp 没有"外部命令 + stdin JSON + exit code"式 hook 协议（与 codex/gemini/continue **不同构**，
# 如实标注——见 adapters/amp/README.md）。原生扩展机制是进程内 JS/TS 插件：
# `.amp/plugins/<name>.js`（项目级）或 `~/.config/amp/plugins/<name>.js`（用户级），由 Amp 自带
# Bun 运行时加载，`export default function(amp){ amp.on(event, handler) }`。
#
# 投影产物：
#   .amp/plugins/pipeline.js   三能力插件（__TENON_ROOT__ 烘焙为本仓库绝对路径，
#                              插件内部 spawnSync bash 调 hooks/gate.sh · session-start.sh ·
#                              skill-tracker.sh，与其余适配器同一"薄包 baseline"原则，
#                              只是载体是 JS 插件而非 bash wrapper）。
#
# 选项：--target <dir>（默认 $PWD）/ --global（改装 ~/.config/amp/plugins/，而非项目级）
#       / --yes / -h
#
# 落盘一律走 adapters/lib/atomic-write.sh：半个插件文件会让 Amp 加载失败、三能力整体不生效；
# 旁挂 .pipeline-adapter 则记为「未生效」并以非零码收尾。
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TENON_ROOT="$(cd "$ADAPTER_DIR/../.." && pwd)"
SIGNATURE="pipeline-adapter:amp"

. "$ADAPTER_DIR/../lib/atomic-write.sh"
adapter_lib_init amp

G='\033[32m'; Y='\033[33m'; R='\033[31m'; B='\033[1m'; Z='\033[0m'
info() { printf "${G}[amp]${Z} %b\n" "$1"; }
warn() { printf "${Y}[amp]${Z} %b\n" "$1"; }
err()  { printf "${R}[amp]${Z} %b\n" "$1" >&2; }
note() { printf "%b\n" "$1"; }

TARGET="$PWD"
GLOBAL=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target 需要目录}"; shift 2 ;;
    --global) GLOBAL=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
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
  PLUGINS_DIR="$HOME/.config/amp/plugins"
else
  PLUGINS_DIR="$TARGET/.amp/plugins"
fi

install_plugin() {
  mkdir -p "$PLUGINS_DIR" || { err "无法创建插件目录: $PLUGINS_DIR"; exit 1; }
  local dst="$PLUGINS_DIR/pipeline.js"
  if [ -f "$dst" ] && ! grep -qF "$SIGNATURE" "$dst" 2>/dev/null; then
    warn "$dst 已存在（非本适配器管理，疑似你既有插件）——不覆盖，写建议文件 ${dst}.pipeline-adapter 供手动合并。"
    atomic_render_template "$ADAPTER_DIR/plugins/pipeline.js" "$dst.pipeline-adapter" __TENON_ROOT__ "$TENON_ROOT"
    adapter_mark_not_applied "$dst.pipeline-adapter" \
      "$dst 已被你既有的插件占用，Amp 现在加载的仍是旧插件——inject/veto/track 均未接管"
    return 0
  fi
  atomic_render_template "$ADAPTER_DIR/plugins/pipeline.js" "$dst" __TENON_ROOT__ "$TENON_ROOT"
  info "插件 → ${dst}（绝对路径已绑定 ${TENON_ROOT}）"
}

note "${B}Amp pipeline 适配器安装${Z}  target=${TARGET}  plugins-dir=${PLUGINS_DIR}"
install_plugin
note ""
note "${B}════════ 档 A 全保真：还差一步（一次性重载插件）════════${Z}"
note "Amp 启动 TUI 后运行一次命令面板的 ${B}plugins: reload${Z}（或重启 amp），插件才会被加载。"
note "已知诚实边界（README 详述）：本 adapter 基于官方文档 + 反编译已发布二进制字符串确认事件/"
note "动作名逐字存在，${B}未经真实 Amp 会话端到端实测${Z}（沙箱无有效登录态）；若 session.start/"
note "agent.start/tool.call/tool.result 的 event 字段与本插件假设不符，请据实回填 README/registry。"
note "${B}══════════════════════════════════════════════════════${Z}"
# 「完成」只在插件真接管时才打印；旁挂建议文件由 adapter_finish 非零退出并列出待合并路径。
[ "$ADAPTER_NOT_APPLIED_COUNT" -eq 0 ] \
  && info "档 A 完成：inject（agent.start 首回合注入）/ veto（tool.call reject-and-continue）/ track（tool.result）全 native。" || true
adapter_finish
