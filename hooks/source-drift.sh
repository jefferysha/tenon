#!/usr/bin/env bash
# source-drift.sh — SessionStart 助手：在 Tenon 源码仓库里比较「已装」与「仓库工作区」，
# 不一致时给出同步命令。
#
# 被 session-start.sh source，只定义函数，不产生副作用、不 exit。纯 bash + git：不 spawn 任何解释器
# （tools/test-hooks.sh §3 红线）；任何失败一律返回空（fail-open，绝不阻断会话）。
#
# 比较口径与 packages/cli/src/runtime/dev-source-identity.ts 逐字一致（source-drift-hook.test.ts 交叉验证）：
#   worktree_digest：路径集合 = git ls-files -z --cached --others --exclude-standard -- <PATHSPECS> 去重、
#     只留普通文件、按字节序排序；每行 "<blob> <path>\n"，blob = 工作区原始字节的 git blob id
#     （git hash-object --no-filters：.gitattributes 的 skills/** eol=lf 会让带过滤器的哈希与原始字节不一致）；
#     整体再取 git blob id（git hash-object --stdin）。
#   skills_index_digest：skills/skills.lock.json 原始字节的 git blob id，缺文件为 absent。
#   commit 只在提示里展示，不是判据：提交文档类改动不应触发提示。
# 标记文件：<config 根>/install-channel（tenon setup --from-source 写入；正式安装 / --to-stable 删除）。

# 必须与 packages/cli/src/runtime/release-store-codecs.ts 的 PAYLOAD_ENTRIES 相同（逐行，顺序一致）。
PIPELINE_SOURCE_DRIFT_PATHSPECS=(
  .agents/plugins/marketplace.json
  .claude-plugin/marketplace.json
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  adapters
  hooks
  packages/cli/dist/tenon.mjs
  packages/dashboard-app/dist
  packages/server/dist/dashboard.mjs
  runtime/tenon-bootstrap.mjs
  skills
  templates
  tools/verify-skills.sh
)

_pipeline_source_first_name() { # $1=JSON 文件 → 第一个 "name" 的值
  grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -n 1 \
    | sed -e 's/^"name"[[:space:]]*:[[:space:]]*"//' -e 's/"$//'
}

# 四项判据（TypeScript 端是严格 JSON 判定，这里是 grep 近似；两者在 source-drift-hook.test.ts 里对拍）。
pipeline_source_is_tenon_repo() { # $1=仓库根
  local root="$1"
  [ -f "$root/package.json" ] && [ -f "$root/.claude-plugin/marketplace.json" ] || return 1
  [ -f "$root/skills/sources.yaml" ] && [ -f "$root/runtime/tenon-bootstrap.mjs" ] || return 1
  [ "$(_pipeline_source_first_name "$root/package.json")" = "tenon" ] || return 1
  [ "$(_pipeline_source_first_name "$root/.claude-plugin/marketplace.json")" = "tenon" ] || return 1
  grep -Eq '"source"[[:space:]]*:[[:space:]]*"\./"' "$root/.claude-plugin/marketplace.json" 2>/dev/null || return 1
  return 0
}

pipeline_source_worktree_digest() { # $1=仓库根 → stdout 摘要；失败返回非 0
  local root="$1" path ids id sorted manifest="" index=0
  local -a listed=() files=() id_list=()
  while IFS= read -r path; do
    [ -n "$path" ] && [ -f "$root/$path" ] && listed+=("$path")
  done < <(git -C "$root" ls-files -z --cached --others --exclude-standard -- "${PIPELINE_SOURCE_DRIFT_PATHSPECS[@]}" 2>/dev/null | tr '\0' '\n')
  [ "${#listed[@]}" -gt 0 ] || return 1
  sorted="$(printf '%s\n' "${listed[@]}" | LC_ALL=C sort -u)"
  while IFS= read -r path; do files+=("$path"); done <<< "$sorted"
  ids="$(printf '%s\n' "${files[@]}" | git -C "$root" hash-object --no-filters --stdin-paths 2>/dev/null)" || return 1
  while IFS= read -r id; do id_list+=("$id"); done <<< "$ids"
  [ "${#id_list[@]}" -eq "${#files[@]}" ] || return 1
  while [ "$index" -lt "${#files[@]}" ]; do
    manifest+="${id_list[$index]} ${files[$index]}"$'\n'
    index=$((index + 1))
  done
  printf '%s' "$manifest" | git -C "$root" hash-object --stdin 2>/dev/null
}

pipeline_source_skills_digest() { # $1=仓库根 → stdout 摘要或 absent
  local file="$1/skills/skills.lock.json"
  if [ -f "$file" ]; then
    git -C "$1" hash-object --no-filters -- "$file" 2>/dev/null || return 1
  else
    printf 'absent'
  fi
}

# 与 hooks/auto-update.sh 同一套 config 根解析。
_pipeline_source_config_base() {
  if [ -n "${TENON_RUNTIME_CONFIG_ROOT:-}" ]; then
    printf '%s' "$TENON_RUNTIME_CONFIG_ROOT"
  elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
    printf '%s' "${HOME:-}/Library/Application Support/tenon/config"
  else
    printf '%s' "${XDG_CONFIG_HOME:-${HOME:-}/.config}/tenon"
  fi
}

# 读 install-channel；只有 channel=dev 的标记才算开发安装。结果放在 PSD_* 变量里。
_pipeline_source_read_marker() { # $1=config 根
  local file="$1/install-channel" key value channel=""
  PSD_HOST=""; PSD_RELEASE=""; PSD_REPO=""; PSD_WORKTREE=""; PSD_SKILLS=""
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      channel) channel="$value" ;;
      host) PSD_HOST="$value" ;;
      release_id) PSD_RELEASE="$value" ;;
      repo) PSD_REPO="$value" ;;
      worktree_digest) PSD_WORKTREE="$value" ;;
      skills_index_digest) PSD_SKILLS="$value" ;;
    esac
  done < "$file"
  [ "$channel" = "dev" ]
}

# stdout：提示文本（空 = 没有提示）。恒 return 0。
pipeline_source_drift_message() { # $1=cwd $2=当前 active release id（可空）
  local cwd="$1" active="${2:-}" top qtop base live_worktree live_skills reasons="" cmd
  command -v git >/dev/null 2>&1 || return 0
  top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || return 0
  [ -n "$top" ] || return 0
  # 仓库路径会原样进入会话上下文与要复制执行的命令：含任何控制字符（换行、制表符、ESC 等）就整条提示不输出（fail-open）。
  case "$top" in *[[:cntrl:]]*) return 0 ;; esac
  pipeline_source_is_tenon_repo "$top" || return 0
  # 提示正文与命令里展示的路径都用 shell 引号形式（printf %q，bash 内建）：含空格等的路径可直接复制执行。
  qtop="$(printf '%q' "$top")"
  base="$(_pipeline_source_config_base)"
  # 标记里的 release_id 与当前 active 对不上（回滚、重装之后）= 标记陈旧，等同没有标记。
  if _pipeline_source_read_marker "$base" && { [ -z "$active" ] || [ "$active" = "$PSD_RELEASE" ]; }; then
    # 标记的值会进会话上下文：宿主只认两个合法值，标记里的仓库路径只用来比较、不回显，免得成为注入入口。
    case "$PSD_HOST" in claude|codex) ;; *) PSD_HOST=claude ;; esac
    cmd="tenon setup --${PSD_HOST} --from-source ${qtop}"
    if [ "$PSD_REPO" != "$top" ]; then
      printf '[tenon] 已装的开发安装绑定的是另一个仓库，当前仓库 %s 的技能、hooks 与 CLI 不是它的源码。同步：%s' \
        "$qtop" "$cmd"
      return 0
    fi
    live_worktree="$(pipeline_source_worktree_digest "$top")" || return 0
    live_skills="$(pipeline_source_skills_digest "$top")" || return 0
    [ "$live_worktree" = "$PSD_WORKTREE" ] || reasons="安装内容已变"
    [ "$live_skills" = "$PSD_SKILLS" ] || reasons="${reasons:+${reasons}、}技能索引已变"
    [ -n "$reasons" ] || return 0
    printf '[tenon] 源码仓库与已装的开发安装不一致（%s）：本会话加载的技能、hooks 与 CLI 不是当前工作区的源码。同步：%s' \
      "$reasons" "$cmd"
    return 0
  fi
  printf '[tenon] 当前目录是 Tenon 源码仓库（%s），但已装的是正式版：技能、hooks 与 CLI 不是仓库源码。同步为源码开发安装：tenon setup --claude --from-source %s（用 Codex 时把 --claude 换成 --codex）。' \
    "$qtop" "$qtop"
  return 0
}
