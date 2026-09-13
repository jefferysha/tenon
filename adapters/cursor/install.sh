#!/usr/bin/env bash
# adapters/cursor/install.sh — 安装 Cursor pipeline 适配器（lite，spike 升正式 adapter / 转正）。
#
# 投影产物：
#   .cursor/hooks.json          veto(failClosed:true) + track（__ADAPTER_DIR__ 定死为仓库内适配器绝对路径，
#                               wrapper 从仓库跑，自定位 lite baseline hooks/gate.sh · skill-tracker.sh · session-start.sh）
#   .cursor/rules/pipeline.md   inject 降级静态层（Cursor 无 SessionStart 级 inject，contract §1）
#
# 选项：--target <dir>（默认 $PWD）/ --no-hooks（只装静态层，降级）/ --yes / -h
# 无 trust 机制——落盘即生效（部署优势 vs Codex）。
#
# 落盘一律走 adapters/lib/atomic-write.sh：hooks.json 是 fail-closed veto 的唯一载体，
# 半个 JSON 会让 Cursor fail-open、把 registry 承诺的硬门静默变成放行。
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CONFIG_DIR=".cursor"

. "$ADAPTER_DIR/../lib/atomic-write.sh"
adapter_lib_init cursor

G='\033[32m'; Y='\033[33m'; R='\033[31m'; B='\033[1m'; Z='\033[0m'
info() { printf "${G}[cursor]${Z} %b\n" "$1"; }
warn() { printf "${Y}[cursor]${Z} %b\n" "$1"; }
err()  { printf "${R}[cursor]${Z} %b\n" "$1" >&2; }

TARGET="$PWD"
WITH_HOOKS=1
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)   TARGET="${2:?--target 需要目录}"; shift 2 ;;
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

# ── inject 降级静态层 .cursor/rules/pipeline.md ──
install_rules() {
  local rdir="$TARGET/$CONFIG_DIR/rules"
  mkdir -p "$rdir"
  atomic_write "$rdir/pipeline.md" <<'EOF'
# Pipeline Workflow（Cursor 静态注入层）

> Cursor 无 SessionStart 级 inject 原语，本规则文件是 pipeline 上下文的降级静态层（契约 §1）。
> 动态 breadcrumb 由 .cursor/hooks postToolUse 的 additional_context 补偿。

7-phase 流水线：open → explore → spec → build ⇄ verify → ship → archive。
状态操作一律走 `pipeline` CLI（status / get / set / transition / check），勿手改 .pipeline.yaml。

离开 review phase（explore / spec / verify）须对确切 event 取得人类显式确认：

    tenon review request <change> --event <event>
    # 人类确认后：
    tenon review acknowledge <change>

不得删除 `.pipeline-pending-review` 绕过 review-gate（会产生 solo 推进）。命令前缀为 /pipeline-（如 /tenon-explore）。
EOF
  info "rules/pipeline.md → $rdir/pipeline.md（inject 降级静态层）"
}

# ── hooks.json（__ADAPTER_DIR__ → 仓库内适配器绝对路径；wrapper 从仓库跑，自定位 baseline hooks）──
install_hooks() {
  local cdir="$TARGET/$CONFIG_DIR"
  mkdir -p "$cdir"
  local hj="$cdir/hooks.json"
  if [ -f "$hj" ] && ! grep -q "pipeline 适配器 hook 注册" "$hj" 2>/dev/null; then
    warn "$hj 已存在（疑似你既有 hook）——不覆盖，替换版写到 $hj.pipeline-adapter 供合并。"
    atomic_render_template "$ADAPTER_DIR/hooks.json" "$hj.pipeline-adapter" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
    adapter_mark_not_applied "$hj.pipeline-adapter" \
      "$hj 已被你的既有 hook 占用，Cursor 现在读的仍是旧配置——veto(failClosed) / track 均未接管"
  else
    atomic_render_template "$ADAPTER_DIR/hooks.json" "$hj" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
    info "hooks.json → ${hj}（veto failClosed:true + track，绝对路径已绑定）"
  fi
}

note() { printf "%b\n" "$1"; }
note "${B}Cursor pipeline 适配器安装${Z}  target=${TARGET}"
mkdir -p "$TARGET/$CONFIG_DIR"
install_rules
if [ "$WITH_HOOKS" = 1 ]; then
  install_hooks
else
  warn "--no-hooks：跳过 hooks.json（无自动强制；review 仍须走 tenon review request/acknowledge）。"
fi
adapter_finish "${G}[cursor]${Z} Cursor 适配器安装完成（无 trust 机制，落盘即生效）。"
