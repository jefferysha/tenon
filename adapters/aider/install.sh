#!/usr/bin/env bash
# adapters/aider/install.sh — 安装 aider pipeline 适配器（lite，档 B）。
#
# aider 无 pre-tool hook 原语（无法逐工具调用拦截）——veto 降级为 commit-gate 静态约定
# （.git/hooks/pre-commit，只在 commit 粒度拦，工作区写入已先发生，contract §1 不伪装硬拦）。
# inject/track 走 aider 自身"始终自动生效"的原语：.aider.conf.yml 的 read: 静态只读文件（会话级
# 上下文，aider 每次启动都重新读盘——非缓存，视为 native）+ git post-commit 留痕（把 commit 当工作单元）。
#
# 投影产物：
#   .aider.conf.yml            merge read: 指向生成的上下文文件（若已存在则不覆盖，写 .pipeline-adapter 供合并）
#   .aider-pipeline-context.md 生成的 inject 内容（安装时 + 每次重跑本脚本时刷新）
#   .git/hooks/pre-commit      veto 降级：commit-gate（若已存在陌生 hook 则不覆盖，写建议文件）
#   .git/hooks/post-commit     track：真 append history（同上不覆盖策略）
#
# 选项：--target <dir>（默认 $PWD）/ --no-git-hooks（跳过 git hook，只装 conf.yml+context）/ --yes / -h
#
# 落盘一律走 adapters/lib/atomic-write.sh：半个 pre-commit hook 会被 git 当成失败或直接放行，
# commit-gate 静默失效；旁挂 .pipeline-adapter 则记为「未生效」并以非零码收尾。
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

. "$ADAPTER_DIR/../lib/atomic-write.sh"
adapter_lib_init aider

G='\033[32m'; Y='\033[33m'; R='\033[31m'; B='\033[1m'; Z='\033[0m'
info() { printf "${G}[aider]${Z} %b\n" "$1"; }
warn() { printf "${Y}[aider]${Z} %b\n" "$1"; }
err()  { printf "${R}[aider]${Z} %b\n" "$1" >&2; }
note() { printf "%b\n" "$1"; }

TARGET="$PWD"
WITH_GIT_HOOKS=1
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)       TARGET="${2:?--target 需要目录}"; shift 2 ;;
    --no-git-hooks) WITH_GIT_HOOKS=0; shift ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    -h|--help)
      # --help 打印文件头注释块，止于第一行非注释。不写死行号：行号会随头部注释增删而失配，
      # 把 `set -euo pipefail` 这类代码行当帮助文本打出来。
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) err "未知参数: $1（见 --help）"; exit 2 ;;
  esac
done

CONTEXT_FILE="$TARGET/.aider-pipeline-context.md"

# ── inject：生成/刷新会话级上下文文件（aider read: 每次启动都重新读盘，天然"新鲜"）──
refresh_context() {
  mkdir -p "$TARGET"
  local out
  out="$(printf '{"cwd":"%s"}' "$TARGET" | bash "$ADAPTER_DIR/hooks/inject.sh" SessionStart 2>/dev/null || true)"
  if [ -n "$out" ]; then
    atomic_stage "$CONTEXT_FILE"
    printf '%s\n' "$out" > "$ATOMIC_TMP"
    atomic_commit "$CONTEXT_FILE"
    info "上下文 → ${CONTEXT_FILE}（aider read: 每次启动重新读盘，等价 SessionStart 新鲜度）"
  else
    atomic_stage "$CONTEXT_FILE"
    : > "$ATOMIC_TMP"
    atomic_commit "$CONTEXT_FILE"
    warn "baseline injector 无输出——写空上下文文件占位（${CONTEXT_FILE}）"
  fi
}

# ── .aider.conf.yml：不存在则新建；已存在则不覆盖，写 .pipeline-adapter 供手动合并 read: ──
install_conf() {
  local f="$TARGET/.aider.conf.yml"
  if [ -f "$f" ]; then
    warn "$f 已存在——不自动覆盖你既有配置。"
    atomic_write "$f.pipeline-adapter" <<'EOF'
# pipeline 适配器建议合并进 .aider.conf.yml 的片段（勿直接覆盖，手动合并 read: 列表）：
read:
  - .aider-pipeline-context.md
EOF
    adapter_mark_not_applied "$f.pipeline-adapter" \
      "$f 已存在且未包含 pipeline 上下文，aider 不会加载 .aider-pipeline-context.md——inject 未接管"
  else
    atomic_write "$f" <<'EOF'
# pipeline 适配器生成（长尾铺量 #41）——aider inject 降级为 read: 静态只读文件（会话级、自动加载）。
read:
  - .aider-pipeline-context.md
EOF
    info ".aider.conf.yml → ${f}（read: 指向 pipeline 上下文，aider 每次启动自动加载）"
  fi
}

# ── git hook 投递（不覆盖陌生既有 hook；已是本适配器管理则直接刷新绝对路径）──
SIGNATURE="# pipeline-adapter:aider"
install_git_hook() { # <hookName> <srcScript>
  local name="$1" src="$2" gitdir
  gitdir="$(cd "$TARGET" 2>/dev/null && git rev-parse --git-dir 2>/dev/null || true)"
  if [ -z "$gitdir" ]; then
    warn "非 git 仓库（或未找到 .git）——跳过 ${name}（veto/track 需要 git 仓库承载 commit-gate/post-commit）。"
    return 0
  fi
  case "$gitdir" in /*) ;; *) gitdir="$TARGET/$gitdir" ;; esac
  mkdir -p "$gitdir/hooks"
  local dst="$gitdir/hooks/$name"
  if [ -f "$dst" ] && ! grep -qF "$SIGNATURE" "$dst" 2>/dev/null; then
    warn "$dst 已存在（非本适配器管理，疑似你既有 hook）——不覆盖，写建议文件供手动串联。"
    atomic_stage "$dst.pipeline-adapter"
    { printf '#!/usr/bin/env bash\n%s\n' "$SIGNATURE"; printf 'bash "%s" "%s"\n' "$src" "$name"; } > "$ATOMIC_TMP"
    atomic_commit "$dst.pipeline-adapter" --mode 0755
    adapter_mark_not_applied "$dst.pipeline-adapter" \
      "$dst 已被你既有的 ${name} hook 占用，git 现在跑的仍是旧 hook——${name} 未接管（把建议文件的调用行追加进去才生效）"
    return 0
  fi
  atomic_stage "$dst"
  { printf '#!/usr/bin/env bash\n%s\n' "$SIGNATURE"; printf 'bash "%s" "%s"\n' "$src" "$name"; } > "$ATOMIC_TMP"
  atomic_commit "$dst" --mode 0755
  info "git hook → ${dst}（${name}，已绑定 adapter 绝对路径）"
}

note "${B}aider pipeline 适配器安装${Z}  target=${TARGET}"
install_conf
refresh_context
if [ "$WITH_GIT_HOOKS" = 1 ]; then
  install_git_hook pre-commit  "$ADAPTER_DIR/hooks/veto.sh"
  install_git_hook post-commit "$ADAPTER_DIR/hooks/track.sh"
  # 「完成」只在没有任何一项退化成旁挂建议文件时才打印（adapter_finish 会为未生效项非零退出）。
  [ "$ADAPTER_NOT_APPLIED_COUNT" -eq 0 ] \
    && info "档 B 完成：inject/track 走 aider 原语（read: + git commit）+ veto 降级 commit-gate。" || true
else
  warn "--no-git-hooks：跳过 pre-commit/post-commit（veto/track 均不生效；review 仍须走 tenon review request/acknowledge）。"
fi
note ""
note "提示：项目 phase/门状态变化后如需刷新会话上下文，重跑本脚本即可（幂等，覆盖 context 文件与自管 git hook）。"
adapter_finish
