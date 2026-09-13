#!/usr/bin/env bash
# adapters/copilot/install.sh — 安装 GitHub Copilot pipeline 适配器（lite，档 B）。
#
# 投影产物：
#   .github/copilot/hooks.json      veto(preToolUse) + track(postToolUse)   ┐ dual hookContainer：
#   .github/hooks/tenon.json      同源第二份（漏一份 copilot 引擎不生效）  ┘ 两份都写
#   .github/copilot-instructions.md inject 降级静态层（copilot session-start 平台私有不可控，contract §1）
#
# 三能力：veto/track native、inject **降级**（不伪装会话级 inject）。__ADAPTER_DIR__ 定死为
# 仓库内适配器绝对路径，wrapper 从仓库跑，自定位 lite baseline hooks/gate.sh · skill-tracker.sh。
#
# 选项：--target <dir>（默认 $PWD）/ --no-hooks（只装静态层，降级）/ --yes / -h
#
# 落盘一律走 adapters/lib/atomic-write.sh（原子替换 + JSON 校验 + 未生效非零退出）。
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

. "$ADAPTER_DIR/../lib/atomic-write.sh"
adapter_lib_init copilot

G='\033[32m'; Y='\033[33m'; R='\033[31m'; B='\033[1m'; Z='\033[0m'
info() { printf "${G}[copilot]${Z} %b\n" "$1"; }
warn() { printf "${Y}[copilot]${Z} %b\n" "$1"; }
err()  { printf "${R}[copilot]${Z} %b\n" "$1" >&2; }
note() { printf "%b\n" "$1"; }

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

# ── inject 降级静态层 .github/copilot-instructions.md（copilot 平台文档级上下文文件）──
install_instructions() {
  local dir="$TARGET/.github"
  mkdir -p "$dir"
  local f="$dir/copilot-instructions.md"
  local START="<!-- PIPELINE:COPILOT:START -->" END="<!-- PIPELINE:COPILOT:END -->"
  local block; block="$(cat <<'EOF'
## Pipeline Workflow（Copilot inject 降级静态层）

> Copilot session-start 为平台私有、不可控——本文件是 pipeline 上下文的降级静态层（契约 §1）。
> 动态 breadcrumb 由 userPromptSubmitted 补偿（若平台支持）；enforcement 由 hooks preToolUse 硬拦。

7-phase 流水线：open → explore → spec → build ⇄ verify → ship → archive。
状态操作一律走 `pipeline` CLI（status / get / set / transition / check），勿手改 `.pipeline.yaml`。

离开 review phase（explore / spec / verify）须对确切 event 取得人类显式确认：

    tenon review request <change> --event <event>
    # 人类确认后：
    tenon review acknowledge <change>

不得删除 `.pipeline-pending-review` 绕过 review-gate（会产生 solo 推进）。
EOF
)"
  if [ -f "$f" ] && grep -qF "$START" "$f" 2>/dev/null; then
    # 哨兵块按行号切片替换（不用 awk -v 传多行 block：macOS 自带 BSD awk 对含内嵌换行的
    # -v 值报 "newline in string" 并 exit 2，GNU awk 不报——跨平台正确性优先，勿改回去）。
    local start_line end_line
    start_line="$(grep -nF "$START" "$f" | head -1 | cut -d: -f1)"
    end_line="$(grep -nF "$END" "$f" | head -1 | cut -d: -f1 || true)"
    if [ -z "$end_line" ] || [ "$end_line" -lt "$start_line" ]; then
      err "$f 的 Tenon 哨兵块不成对，拒绝改写用户内容。"
      exit 1
    fi
    atomic_stage "$f"
    {
      # 块外的用户内容原样保留；只写暂存文件，$f 直到 atomic_commit 都不动。
      if [ "$start_line" -gt 1 ]; then head -n "$((start_line - 1))" "$f"; fi
      printf '%s\n' "$START"
      printf '%s\n' "$block"
      printf '%s\n' "$END"
      tail -n "+$((end_line + 1))" "$f"
    } > "$ATOMIC_TMP"
    atomic_commit "$f"
  else
    # 追加也先在暂存文件里拼完整份再原子替换：裸 `>>` 被打断会在用户文件尾留半个哨兵块，
    # 下次安装认不出来，就会再追加一份。
    atomic_stage "$f"
    {
      if [ -f "$f" ]; then cat "$f"; fi
      printf '\n%s\n' "$START"; printf '%s\n' "$block"; printf '%s\n' "$END"
    } > "$ATOMIC_TMP"
    atomic_commit "$f"
  fi
  info "copilot-instructions.md 静态层 → ${f}（inject 降级，哨兵块幂等）"
}

# ── dual hookContainer：同源写 .github/copilot/hooks.json + .github/hooks/tenon.json ──
install_hooks_dual() {
  local d1="$TARGET/.github/copilot" d2="$TARGET/.github/hooks"
  mkdir -p "$d1" "$d2"
  local dst written=0 total=0
  for dst in "$d1/hooks.json" "$d2/tenon.json"; do
    total=$((total + 1))
    if [ -f "$dst" ] && ! grep -q "pipeline 适配器 hook 注册" "$dst" 2>/dev/null; then
      warn "$dst 已存在（疑似你既有 hook）——不覆盖，替换版写到 $dst.pipeline-adapter 供合并。"
      atomic_render_template "$ADAPTER_DIR/hooks.json" "$dst.pipeline-adapter" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
      adapter_mark_not_applied "$dst.pipeline-adapter" \
        "$dst 已被你的既有 hook 占用，这一份 hookContainer 没有接管"
    else
      atomic_render_template "$ADAPTER_DIR/hooks.json" "$dst" __ADAPTER_DIR__ "$ADAPTER_DIR" --json
      info "hooks → ${dst}（veto/track 绝对路径已绑定）"
      written=$((written + 1))
    fi
  done
  # 如实报实际写入份数。旧版不论实际结果都宣称两份写好了，即使其中一份只落了旁挂建议
  # 文件——叠加宿主 fail-open，用户会以为门装好了，实际全程放行。
  if [ "$written" -eq "$total" ]; then
    info "dual hookContainer：${written}/${total} 份已写入（两份齐全，copilot 引擎才读得到 hook）。"
  else
    warn "dual hookContainer：实际只写入 ${written}/${total} 份——copilot 引擎读不到完整 hook 注册，veto/track 不生效。"
  fi
}

note "${B}GitHub Copilot pipeline 适配器安装${Z}  target=${TARGET}"
install_instructions
if [ "$WITH_HOOKS" = 1 ]; then
  # 「档 B 完成」只在两份 hookContainer 都真接管时才打印；否则 adapter_finish 非零退出。
  install_hooks_dual
  adapter_finish "${G}[copilot]${Z} 档 B 完成：veto/track native（dual hookContainer）+ inject 降级静态层。"
else
  warn "--no-hooks：跳过 hooks（无自动强制；review 仍须走 tenon review request/acknowledge）。"
fi
adapter_finish
