#!/usr/bin/env bash
# adapters/aider/hooks/veto.sh — aider veto 降级实现：commit-gate 静态约定（档 B，非硬拦）。
#
# aider 无 pre-tool hook 原语——无法在每次文件写入前拦截（spike 实证：aider 仅有 lint-cmd/test-cmd
# 编辑后检查、无 before-write 拦截点）。本脚本装作 `.git/hooks/pre-commit`：aider 默认每次编辑后
# auto-commit，故 commit 是最接近"工作单元边界"的真实钩子点——检查项目根新鲜 .pipeline-pending-*
# marker，命中则阻止本次 commit（非零 exit + stderr 指引）。
#
# 诚实标注为**降级**而非 native（不伪装硬拦，contract §1 红线）：
#   ① 只在 COMMIT 粒度拦截——工作区文件写入动作本身已经发生，只是暂不能提交，
#      不同于 baseline gate.sh 在工具调用前就拦截（写入尚未发生）；
#   ② 依赖 aider auto-commit 默认行为，用户传 --no-auto-commits 可关闭（此时本 gate 不会被触发）。
#
# 双模式（真部署 + conformance 可测同款调用协议）：
#   真 git hook 场景：argv 空、stdin 可能是终端（交互 git commit）——不阻塞读取，退回 git 定位 cwd；
#   conformance 场景：喂 {"cwd":...} stdin JSON（与其余适配器 drive_veto_at 同款）。
# 复用 lite baseline hooks/gate.sh 的 marker 扫描决策（透传其退出码）。
# fail-safe：找不到 gate.sh → 放行（不因 wrapper 缺失把 commit 卡死；不伪装硬门）。
set -uo pipefail

if [ -n "${2:-}" ]; then
  INPUT="$2"
elif [ -t 0 ]; then
  INPUT='{}'   # stdin 是终端（人工 git commit）——绝不 cat 阻塞交互式提交
else
  INPUT="$(cat 2>/dev/null || printf '{}')"
fi
[ -z "$INPUT" ] && INPUT='{}'

json_get() {
  local key="$1" rest
  case "$INPUT" in *"\"$key\""*) ;; *) return 1 ;; esac
  rest="${INPUT#*\"$key\"}"
  while true; do
    case "$rest" in
      [$' \t\r\n']*) rest="${rest#?}" ;;
      ':'*) rest="${rest#:}"; break ;;
      *) return 1 ;;
    esac
  done
  while true; do
    case "$rest" in
      [$' \t\r\n']*) rest="${rest#?}" ;;
      *) break ;;
    esac
  done
  case "$rest" in
    '"'*) rest="${rest#\"}"; printf '%s' "${rest%%\"*}"; return 0 ;;
    *) return 1 ;;
  esac
}

CWD="$(json_get cwd || true)"
[ -z "$CWD" ] && CWD="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$_ROOT" ] || [ ! -d "$_ROOT/hooks" ]; then
  _ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../../.." 2>/dev/null && pwd || printf '%s' "$HOME/.claude")"
fi
export CLAUDE_PLUGIN_ROOT="$_ROOT"

CC_GATE="${TENON_CC_GATE:-$_ROOT/hooks/gate.sh}"
[ -f "$CC_GATE" ] || exit 0

reason="$(printf '{"cwd":"%s","tool_name":"git-commit"}' "$CWD" | bash "$CC_GATE" 2>&1 1>/dev/null)"; rc=$?
if [ "$rc" -ne 0 ]; then
  printf '【pipeline commit-gate（降级 veto，commit 粒度）】检测到待处理交互标记，本次 commit 已被阻止：%s\n' "$reason" >&2
  printf '等用户确认：用户在 Dashboard（tenon dashboard --open）确认，或由用户本人在自己的终端运行 tenon review acknowledge <change>；agent 不得代为执行，也不要删除 marker。确认后重新 commit。\n' >&2
  exit 1
fi
exit 0
