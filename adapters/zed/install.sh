#!/usr/bin/env bash
# adapters/zed/install.sh — 安装 Zed pipeline 适配器（lite，档 C 静态降级）。
#
# 研究结论（2026-07-07 spike，见 README「为什么是档 C」）：Zed 官方文档（zed.dev/docs/ai/rules）
# 确认 .rules / AGENTS.md 只是静态项目指令文件；Zed 自身的 issue #57890 / discussion #57943
# （"AI Agent extensibility — Custom Commands, Lifecycle Hooks, and Skills"）显式证实
# session_start/pre_tool_use/post_tool_use 生命周期钩子**仅是社区提案、尚未实现**——Zed Agent
# Panel 当前无任何用户可配置的 enforcement hook。三能力**全静态降级**，如实档 C（同 devin）。
#
# 投影产物：
#   生效的项目指令文件  inject 降级静态层。Zed 只读工作区根目录下按 ZED_ORDER 第一个存在的文件
#                       （zed.dev/docs/ai/instructions），都不存在时为 AGENTS.md；哨兵块幂等合并，不覆盖用户内容。
#
# 选项：--target <dir>（默认 $PWD）/ --yes / -h
#
# 落盘一律走 adapters/lib/atomic-write.sh：指令文件里既有用户自己的内容，半个文件会直接吃掉它们。
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

. "$ADAPTER_DIR/../lib/atomic-write.sh"
adapter_lib_init zed

G='\033[32m'; Y='\033[33m'; R='\033[31m'; B='\033[1m'; Z='\033[0m'
info() { printf "${G}[zed]${Z} %b\n" "$1"; }
warn() { printf "${Y}[zed]${Z} %b\n" "$1"; }
err()  { printf "${R}[zed]${Z} %b\n" "$1" >&2; }
note() { printf "%b\n" "$1"; }

TARGET="$PWD"; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)  TARGET="${2:?--target 需要目录}"; shift 2 ;;
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

# Zed 读取顺序（第一个存在的生效，其余忽略）；与 kernel ZED_PROJECT_ORDER 一致，tools/test-adapters.sh 对账。
ZED_ORDER=(.rules .cursorrules .windsurfrules .clinerules .github/copilot-instructions.md AGENT.md AGENTS.md CLAUDE.md GEMINI.md)
START="<!-- PIPELINE:ZED:START -->"
END="<!-- PIPELINE:ZED:END -->"

# 输出 "<start> <end>" 行号；无块输出空；标记不成对、重复或逆序返回 1。
zed_block_range() { # <file>
  local n_start n_end s e
  n_start="$(grep -cxF "$START" "$1" || true)"
  n_end="$(grep -cxF "$END" "$1" || true)"
  if [ "$n_start" = 0 ] && [ "$n_end" = 0 ]; then return 0; fi
  if [ "$n_start" != 1 ] || [ "$n_end" != 1 ]; then return 1; fi
  s="$(grep -nxF "$START" "$1" | cut -d: -f1)"
  e="$(grep -nxF "$END" "$1" | cut -d: -f1)"
  [ "$e" -gt "$s" ] || return 1
  printf '%s %s\n' "$s" "$e"
}

# 输出去掉 ZED 块（连同块前一个空行）后的内容。
zed_without_block() { # <file> <start> <end>
  local f="$1" e="$3" before=$(( $2 - 1 ))
  if [ "$before" -ge 1 ] && [ -z "$(sed -n "${before}p" "$f")" ]; then before=$(( before - 1 )); fi
  if [ "$before" -ge 1 ]; then head -n "$before" "$f"; fi
  tail -n "+$(( e + 1 ))" "$f"
}

install_rules() {
  local block; block="$(cat <<'EOF'
## Pipeline Workflow（Zed 静态降级层，档 C）

> Zed Agent Panel 无自定义 enforcement hook（zed-industries/zed#57890 提案尚未实现）——
> 本节是 pipeline 三能力的全静态降级层（契约 §1）。inject=本文件；veto=静态 advisory；
> track=无自动留痕（如实标注）。

7-phase 流水线：open → explore → spec → build ⇄ verify → ship → archive。
状态操作一律走 `pipeline` CLI（status / get / set / transition / check），勿手改 .pipeline.yaml。

离开 review phase（explore / spec / verify）须对确切 event 取得人类显式确认。Zed 无 hook 硬拦时仍须：

    tenon review request <change> --event <event>
    # 人类确认后：
    tenon review acknowledge <change>

不得删除 `.pipeline-pending-review` 绕过 review-gate（会产生 solo 推进）。命令前缀 /pipeline-（如 /tenon-explore）。
EOF
)"
  local rel f range effective="AGENTS.md"
  # 先整体校验：任一候选文件的哨兵块不成对就拒绝，一个字节都不动。
  for rel in "${ZED_ORDER[@]}"; do
    f="$TARGET/$rel"
    [ -f "$f" ] || continue
    if ! zed_block_range "$f" >/dev/null; then
      err "$f 的 Tenon 哨兵块不成对，拒绝改写用户内容。"
      exit 1
    fi
  done
  # 只含 ZED 块的文件是 Tenon 自己建的（旧版安装器的 .rules）：删掉，否则它会遮住用户的 AGENTS.md / CLAUDE.md。
  for rel in "${ZED_ORDER[@]}"; do
    f="$TARGET/$rel"
    [ -f "$f" ] || continue
    range="$(zed_block_range "$f")"
    [ -n "$range" ] || continue
    # shellcheck disable=SC2086
    if [ -z "$(zed_without_block "$f" $range | tr -d '[:space:]')" ]; then
      rm -f "$f"
      info "删除只含 Tenon 块的 ${f}"
    fi
  done
  for rel in "${ZED_ORDER[@]}"; do
    if [ -f "$TARGET/$rel" ]; then effective="$rel"; break; fi
  done
  # Zed 不读其它候选文件，其中残留的 ZED 块移走，保证全部候选文件合计恰一份。
  for rel in "${ZED_ORDER[@]}"; do
    [ "$rel" != "$effective" ] || continue
    f="$TARGET/$rel"
    [ -f "$f" ] || continue
    range="$(zed_block_range "$f")"
    [ -n "$range" ] || continue
    atomic_stage "$f"
    # shellcheck disable=SC2086
    zed_without_block "$f" $range > "$ATOMIC_TMP"
    atomic_commit "$f"
  done

  f="$TARGET/$effective"
  range=""
  if [ -f "$f" ]; then range="$(zed_block_range "$f")"; fi
  # 哨兵块替换用 head/tail 按行号切片（不用 awk -v 传多行字符串——BSD awk（macOS 自带
  # 20200816 版）对含内嵌换行的 -v 变量报 "newline in string" 并 exit 2，GNU awk 不报；
  # 为跨平台正确性改用行号切片，勿改回 awk -v 多行传参）。
  atomic_stage "$f"
  if [ -n "$range" ]; then
    local start_line end_line
    start_line="${range% *}"; end_line="${range#* }"
    {
      # 块外的用户内容原样保留；`> $ATOMIC_TMP` 只写暂存文件，$f 直到 atomic_commit 都不动。
      if [ "$start_line" -gt 1 ]; then head -n "$((start_line - 1))" "$f"; fi
      printf '%s\n%s\n%s\n' "$START" "$block" "$END"
      tail -n "+$((end_line + 1))" "$f"
    } > "$ATOMIC_TMP"
  elif [ -s "$f" ]; then
    # 追加同样先在暂存文件里拼完整份（旧内容 + 新块），再原子替换：
    # 裸 `>>` 被打断会在用户文件尾部留半个哨兵块，下次安装就再也认不出来了。
    { cat "$f"; printf '\n%s\n%s\n%s\n' "$START" "$block" "$END"; } > "$ATOMIC_TMP"
  else
    printf '%s\n%s\n%s\n' "$START" "$block" "$END" > "$ATOMIC_TMP"
  fi
  atomic_commit "$f"
  info "Zed 生效指令文件 ${effective} → ${f}（inject 降级，哨兵块幂等，不覆盖既有内容）"
}

note "${B}Zed pipeline 适配器安装${Z}  target=${TARGET}"
install_rules
adapter_finish "${G}[zed]${Z} 档 C（静态降级）完成：三能力全静态，${B}未装 hook${Z}（Zed 无 enforcement hook 原语，不伪装强制）。"
