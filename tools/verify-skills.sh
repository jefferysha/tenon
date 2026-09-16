#!/usr/bin/env bash
# verify-skills.sh — 插件资产零悬空引用校验（CONTRACT §5.7，安装/CI 期硬失败）。
#
# 校验面：
#   1. Codex/Claude manifests、两套 marketplace、hooks/hooks.json、CLI/dashboard 发布产物与 canonical helpers 存在；
#   2. hook command 必须调用用户级稳定 tenon-hook ABI，不能直连可变 marketplace checkout；
#   3. skills/ 下每个 skill 目录都含 SKILL.md；
#   5. templates/skill-sources.yaml 的每一项必须是 bundled，并有同名（或 content_skill 指向）的
#      SKILL.md；这防止默认 workflow 悄悄重新引入外部安装依赖。
# 任何缺失 → exit 1，逐条列出「缺什么 / 在哪引用的 / 怎么修」。
#
# 用法：verify-skills.sh [--quiet] [--root <plugin根>] [--node <冻结绝对路径>]
#   --quiet  成功时零输出（SessionStart hook 用）；失败输出照常（stderr）
#   --root   指定插件根（默认：本脚本所在 tools/ 的上级）；测试用它指向 sandbox
#   --node   指定已冻结的绝对 Node 可执行文件；canonical verifier 不通过 PATH 解析 Node
#
# Bash 负责资产检查与输出；canonical Skill provenance 校验委托随包 Node CLI，保持与
# install/doctor/bundle/release 共用同一 verifier（因此本脚本不再声称 zero-interpreter）。
set -uo pipefail

QUIET=0
ROOT=""
NODE_BIN="${TENON_NODE_PATH:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=1 ;;
    --root)
      shift
      [ $# -gt 0 ] || { echo "verify-skills: --root 需要参数" >&2; exit 2; }
      ROOT="$1"
      ;;
    --node)
      shift
      [ $# -gt 0 ] || { echo "verify-skills: --node 需要参数" >&2; exit 2; }
      NODE_BIN="$1"
      ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "verify-skills: 未知参数 ${1}（支持 --quiet / --root <dir> / --node <绝对路径>）" >&2; exit 2 ;;
  esac
  shift
done

# Direct/contributor invocations historically omitted --node. Keep that entrypoint compatible by
# resolving one absolute PATH candidate only when the caller supplied neither an explicit argument
# nor TENON_NODE_PATH; production callers still pass their frozen physical executable explicitly.
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
[ -z "$ROOT" ] && ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$ROOT" ] || { echo "verify-skills: 插件根不存在: $ROOT" >&2; exit 2; }

# ── 失败收集（bash 3.2 兼容：普通数组 + 下标循环，避免 set -u 下空数组展开）──
FAIL_WHAT=()
FAIL_WHERE=()
FAIL_FIX=()
add_fail() { # what where fix
  FAIL_WHAT[${#FAIL_WHAT[@]}]="$1"
  FAIL_WHERE[${#FAIL_WHERE[@]}]="$2"
  FAIL_FIX[${#FAIL_FIX[@]}]="$3"
}

N_PATH=0
N_SKILL=0
N_EXT=0

PLUGIN_JSON="$ROOT/.claude-plugin/plugin.json"
CLAUDE_MARKETPLACE_JSON="$ROOT/.claude-plugin/marketplace.json"
CODEX_PLUGIN_JSON="$ROOT/.codex-plugin/plugin.json"
CODEX_MARKETPLACE_JSON="$ROOT/.agents/plugins/marketplace.json"
HOOKS_JSON="$ROOT/hooks/hooks.json"
CANONICAL_STATE_HELPER="$ROOT/hooks/canonical-state.sh"
JSON_INPUT_HELPER="$ROOT/hooks/json-input.sh"
PROMPT_INTENT_HELPER="$ROOT/hooks/prompt-intent.sh"
AUTO_UPDATE_HELPER="$ROOT/hooks/auto-update.sh"
RUNTIME_BOOTSTRAP="$ROOT/runtime/tenon-bootstrap.mjs"
CLI_BUNDLE="$ROOT/packages/cli/dist/tenon.mjs"
DASHBOARD_SERVER_BUNDLE="$ROOT/packages/server/dist/dashboard.mjs"
DASHBOARD_WEB_INDEX="$ROOT/packages/dashboard-app/dist/index.html"
SIMPLE_WORKFLOW_TEMPLATE="$ROOT/templates/workflows/simple.yaml"
DOCUMENT_TEMPLATE_REGISTRY="$ROOT/templates/documents/registry.v1.yaml"
DOCUMENT_TEMPLATE_ZH="$ROOT/templates/documents/locales/zh-CN.yaml"
DOCUMENT_TEMPLATE_EN="$ROOT/templates/documents/locales/en.yaml"
DOCUMENT_TEMPLATE_SCHEMA="$ROOT/templates/documents/schemas/registry.v1.schema.json"

# ── 1. 清单文件本体 ──
if [ ! -f "$PLUGIN_JSON" ]; then
  add_fail "缺失插件清单 .claude-plugin/plugin.json" "CC 插件规范（插件必需）" "在 $ROOT/.claude-plugin/ 下创建 plugin.json（至少含 name/description/version）"
else
  grep -q '"name"[[:space:]]*:' "$PLUGIN_JSON" \
    || add_fail "plugin.json 缺少 name 字段" ".claude-plugin/plugin.json" "补充 \"name\": \"<插件名>\""
  grep -q '"skills"[[:space:]]*:[[:space:]]*"\./skills/"' "$PLUGIN_JSON" \
    || add_fail "Claude plugin.json 未声明 canonical skills 根" ".claude-plugin/plugin.json" "把 skills 设为 ./skills/，与 Codex 共用同一份 Skill"
  # Claude Code 自动加载标准 hooks/hooks.json；清单再引用同一文件会被判为重复，整个插件加载失败。
  ! grep -q '"hooks"[[:space:]]*:' "$PLUGIN_JSON" \
    || add_fail "Claude plugin.json 声明了 hooks（标准 hooks/hooks.json 已自动加载，重复引用导致插件加载失败）" ".claude-plugin/plugin.json" "删除 hooks 字段；只有 Codex 清单需要 hooks"
fi
[ -f "$CLAUDE_MARKETPLACE_JSON" ] \
  || add_fail "缺失 Claude marketplace .claude-plugin/marketplace.json" "Claude marketplace 规范（远程安装必需）" "创建 marketplace.json 并登记 tenon"
if [ -f "$CLAUDE_MARKETPLACE_JSON" ]; then
  grep -q '"name"[[:space:]]*:[[:space:]]*"tenon"' "$CLAUDE_MARKETPLACE_JSON" \
    || add_fail "Claude marketplace 未登记 tenon" ".claude-plugin/marketplace.json" "补充 tenon 插件条目"
  grep -q '"source"[[:space:]]*:[[:space:]]*"\./"' "$CLAUDE_MARKETPLACE_JSON" \
    || add_fail "Claude marketplace 未指向插件仓根" ".claude-plugin/marketplace.json" "把 source 设为 ./"
fi
[ -f "$CODEX_PLUGIN_JSON" ] \
  || add_fail "缺失 Codex 插件清单 .codex-plugin/plugin.json" "Codex 插件规范（原生插件必需）" "在 $ROOT/.codex-plugin/ 下创建 plugin.json，并声明 skills/hooks"
if [ -f "$CODEX_PLUGIN_JSON" ]; then
  grep -q '"name"[[:space:]]*:[[:space:]]*"tenon"' "$CODEX_PLUGIN_JSON" \
    || add_fail "Codex plugin.json 缺 tenon name" ".codex-plugin/plugin.json" "补充 name: tenon"
  grep -q '"skills"[[:space:]]*:[[:space:]]*"\./skills/"' "$CODEX_PLUGIN_JSON" \
    || add_fail "Codex plugin.json 未声明打包 skills" ".codex-plugin/plugin.json" "补充 skills: ./skills/"
  grep -q '"hooks"[[:space:]]*:[[:space:]]*"\./hooks/hooks.json"' "$CODEX_PLUGIN_JSON" \
    || add_fail "Codex plugin.json 未声明共享 hooks" ".codex-plugin/plugin.json" "补充 hooks: ./hooks/hooks.json"
fi
[ -f "$CODEX_MARKETPLACE_JSON" ] \
  || add_fail "缺失 Codex marketplace .agents/plugins/marketplace.json" "Codex marketplace 规范（远程安装必需）" "创建 marketplace.json 并登记 tenon"
if [ -f "$CODEX_MARKETPLACE_JSON" ]; then
  grep -q '"name"[[:space:]]*:[[:space:]]*"tenon"' "$CODEX_MARKETPLACE_JSON" \
    || add_fail "Codex marketplace 未登记 tenon" ".agents/plugins/marketplace.json" "补充 tenon 插件条目"
  grep -q '"path"[[:space:]]*:[[:space:]]*"\./"' "$CODEX_MARKETPLACE_JSON" \
    || add_fail "Codex marketplace 未指向插件仓根" ".agents/plugins/marketplace.json" "把 source.path 设为 ./"
fi
[ -f "$HOOKS_JSON" ] \
  || add_fail "缺失 hooks 清单 hooks/hooks.json" "CC 插件规范（本插件挂 hook 必需）" "在 $ROOT/hooks/ 下创建 hooks.json"
[ -f "$CANONICAL_STATE_HELPER" ] && [ -r "$CANONICAL_STATE_HELPER" ] \
  || add_fail "缺失或不可读 hooks/canonical-state.sh" \
              "G1 hooks canonical state 共享读取依赖" \
              "把 hooks/canonical-state.sh 纳入插件资产并保证可读；禁止靠各 hook 的 legacy YAML fallback 运行"
[ -f "$JSON_INPUT_HELPER" ] && [ -r "$JSON_INPUT_HELPER" ] \
  || add_fail "缺失或不可读 hooks/json-input.sh" \
              "实时 hooks 的共享 JSON 字符串解析依赖" \
              "把 hooks/json-input.sh 纳入插件资产并保证可读；禁止让任一 hook 回退到各自的截断式解析"
[ -f "$PROMPT_INTENT_HELPER" ] && [ -r "$PROMPT_INTENT_HELPER" ] \
  || add_fail "缺失或不可读 hooks/prompt-intent.sh" \
              "UserPromptSubmit 跨会话恢复意图判定依赖" \
              "把 hooks/prompt-intent.sh 纳入插件资产并保证可读；router/breadcrumb 缺它时必须 fail-closed，避免旧 change 泄漏"
[ -f "$AUTO_UPDATE_HELPER" ] && [ -x "$AUTO_UPDATE_HELPER" ] \
  || add_fail "缺失或不可执行 hooks/auto-update.sh" "原生宿主 opt-in 自动升级" "把 hooks/auto-update.sh 纳入插件资产并 chmod +x"
[ -f "$RUNTIME_BOOTSTRAP" ] && [ -r "$RUNTIME_BOOTSTRAP" ] \
  || add_fail "缺失 runtime/tenon-bootstrap.mjs" "稳定 launcher / host hook ABI" "把 runtime/tenon-bootstrap.mjs 纳入发布包"
[ -f "$CLI_BUNDLE" ] && [ -x "$CLI_BUNDLE" ] \
  || add_fail "缺失或不可执行 packages/cli/dist/tenon.mjs" "完整插件 CLI runtime" "运行 npm run build，并提交 packages/cli/dist/tenon.mjs"
[ -f "$DASHBOARD_SERVER_BUNDLE" ] && [ -r "$DASHBOARD_SERVER_BUNDLE" ] \
  || add_fail "缺失 dashboard server bundle: packages/server/dist/dashboard.mjs" "完整插件 dashboard runtime" "运行 npm run build，并提交 packages/server/dist/dashboard.mjs"
[ -f "$DASHBOARD_WEB_INDEX" ] && [ -r "$DASHBOARD_WEB_INDEX" ] \
  || add_fail "缺失 dashboard SPA: packages/dashboard-app/dist/index.html" "完整插件 dashboard runtime" "运行 npm run build，并提交 packages/dashboard-app/dist/"
[ -f "$SIMPLE_WORKFLOW_TEMPLATE" ] && [ -r "$SIMPLE_WORKFLOW_TEMPLATE" ] \
  || add_fail "缺失内建轻量 workflow 模板: templates/workflows/simple.yaml" \
              "simple Track 的发行资产" \
              "把 templates/workflows/simple.yaml 纳入发布包，并与 kernel 内建定义保持一致"
for document_asset in \
  "$DOCUMENT_TEMPLATE_REGISTRY" \
  "$DOCUMENT_TEMPLATE_ZH" \
  "$DOCUMENT_TEMPLATE_EN" \
  "$DOCUMENT_TEMPLATE_SCHEMA"; do
  [ -f "$document_asset" ] && [ -r "$document_asset" ] \
    || add_fail "缺失治理文档模板资产: ${document_asset#"$ROOT"/}" \
                "中文默认文档 Registry 的发行资产" \
                "把 templates/documents/ 完整纳入发布包，并运行 npm run check:document-templates"
done

# index.html 是 server 同源托管的入口；仅目录存在不足以保证哈希资源也随 release 进入仓库。
if [ -f "$DASHBOARD_WEB_INDEX" ]; then
  while IFS= read -r asset; do
    [ -n "$asset" ] || continue
    case "$asset" in
      assets/*)
        [ -f "$ROOT/packages/dashboard-app/dist/$asset" ] \
          || add_fail "dashboard SPA 缺少 index.html 引用的资源: $asset" \
                      "packages/dashboard-app/dist/index.html" \
                      "重新运行 npm run build，并把 packages/dashboard-app/dist/ 整目录纳入发布"
        ;;
    esac
  done < <(grep -oE 'assets/[A-Za-z0-9._-]+' "$DASHBOARD_WEB_INDEX" 2>/dev/null | sort -u)
fi

# ── 2. 稳定 host hook ABI + payload shell 语法 ──
# Native host cache 是更新时可变的候选输入。host manifest 只准调用 setup 写入的
# ~/.local/bin/tenon-hook；它再进入已验证的 managed release，不能直接跑 PLUGIN_ROOT。
if [ -f "$HOOKS_JSON" ]; then
  grep -Fq 'tenon-hook' "$HOOKS_JSON" \
    || add_fail "hooks 未调用稳定 tenon-hook launcher" "hooks/hooks.json" "所有 host hook command 使用 bash \"\${HOME}/.local/bin/tenon-hook\" <hook-id>"
  if grep -Fq '${PLUGIN_ROOT' "$HOOKS_JSON" || grep -Fq '${CLAUDE_PLUGIN_ROOT' "$HOOKS_JSON"; then
    add_fail "hooks 直接引用可变 plugin root" "hooks/hooks.json" "host manifest 不得直连 PLUGIN_ROOT；改为稳定 tenon-hook ABI"
  fi
  for rel in \
    hooks/session-start.sh \
    hooks/confirm-clear-prompt.sh \
    hooks/breadcrumb.sh \
    hooks/router.sh \
    hooks/gate.sh \
    hooks/confirm-clear.sh \
    hooks/decision-recorder.sh \
    hooks/skill-tracker.sh \
    hooks/skill-start.sh \
    hooks/interactive-skill-gate.sh \
    hooks/terminal-activity.sh \
    hooks/test-nudge.sh \
    hooks/interaction-authority.sh \
    hooks/tenon-user.sh; do
    N_PATH=$((N_PATH + 1))
    p="$ROOT/$rel"
    [ -f "$p" ] && [ -x "$p" ] \
      || add_fail "缺失或不可执行 hook 脚本: $rel" "hooks/hooks.json" "把 $rel 纳入发布包并 chmod +x"
  done
  while IFS= read -r shell_file; do
    [ -n "$shell_file" ] || continue
    N_PATH=$((N_PATH + 1))
    if ! bash -n "$shell_file" 2>/dev/null; then
      add_fail "shell 语法无效: ${shell_file#"$ROOT"/}" "打包 hook / adapter" "修复语法后重新运行 bash -n ${shell_file#"$ROOT"/}"
    fi
  done < <(find "$ROOT/hooks" "$ROOT/adapters" -type f -name '*.sh' -print 2>/dev/null | sort)
fi

check_refs() { # file
  local f="$1" rel p disp
  [ -f "$f" ] || return 0
  disp="${f#"$ROOT"/}"
  # 兼容历史的直写 ${CLAUDE_PLUGIN_ROOT}/<path> 引用；共享 hooks 已在上方按跨宿主模板逐项校验。
  for rel in $(grep -o 'CLAUDE_PLUGIN_ROOT}/[^"[:space:]\\]*' "$f" 2>/dev/null | sed 's|^CLAUDE_PLUGIN_ROOT}/||' | sort -u); do
    N_PATH=$((N_PATH + 1))
    p="$ROOT/$rel"
    if [ ! -e "$p" ]; then
      add_fail "缺失路径: $rel" "$disp" "创建 ${rel}，或修正 $disp 中的该引用"
      continue
    fi
    case "$rel" in
      *.sh)
        [ -x "$p" ] || add_fail "脚本不可执行: $rel" "$disp" "chmod +x $p"
        ;;
    esac
  done
}
check_refs "$PLUGIN_JSON"
check_refs "$HOOKS_JSON"

# ── 3. skills/ 下每个 skill 目录含 SKILL.md ──
if [ -d "$ROOT/skills" ]; then
  for d in "$ROOT"/skills/*/; do
    [ -d "$d" ] || continue
    N_SKILL=$((N_SKILL + 1))
    [ -f "${d}SKILL.md" ] \
      || add_fail "skill 目录缺少 SKILL.md: ${d#"$ROOT"/}" "skills/ 目录约定（每个 skill 目录必须含 SKILL.md）" "在 ${d#"$ROOT"/} 下创建 SKILL.md，或删除该空目录"
  done
fi

# 插件发行内容只维护 ROOT/skills 这一棵 Skill 内容树。Host adapter 可以在工作区的
# .agents/ 创建安装投影，Loop 也会在 .pipeline/ 保存不可变快照；两者都是被忽略的运行态，
# 不能被误判为插件源码。Git 仓只检查 tracked 与未忽略候选；无 Git 的发行包显式排除运行态目录。
list_release_skill_files() {
  local git_root
  git_root="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$git_root" = "$ROOT" ]; then
    git -C "$ROOT" ls-files --cached --others --exclude-standard -- '*SKILL.md' \
      | sed "s|^|$ROOT/|"
    return
  fi
  find "$ROOT" \
    \( -path "$ROOT/.git" -o -path "$ROOT/node_modules" -o -path "$ROOT/.agents" -o -path "$ROOT/.pipeline" \) -prune -o \
    -type f -name 'SKILL.md' -print 2>/dev/null
}

while IFS= read -r duplicate_skill; do
  [ -n "$duplicate_skill" ] || continue
  case "$duplicate_skill" in
    # Only ROOT/skills is a distributable Skill tree. Claude/Codex host
    # integration and runtime projections are intentionally outside the
    # release inventory, even when they are present as untracked files in a
    # source checkout.
    "$ROOT/skills/"*|"$ROOT/.claude/"*|"$ROOT/.agents/"*|"$ROOT/.pipeline/"*) continue ;;
  esac
  add_fail \
    "发现重复 Skill 内容树: ${duplicate_skill#"$ROOT"/}" \
    "单一 canonical Skill 根约束" \
    "删除复制内容并让 host manifest/adapter 指向 $ROOT/skills；安装投影不得回写进插件包"
done < <(
  list_release_skill_files | sort
)

# ── 5. canonical provenance verifier（生产 CLI 唯一解析/哈希实现）──
# 这里不再 grep/解析 YAML，也不计算 Skill hash。所有 canonical registry、source_ref、完整物理集合、
# tree digest、coordinate 与 legacy-lock 语义由随包的 bundled CLI strict verifier 统一裁决。
REGISTRY="$ROOT/templates/skill-sources.yaml"
N_REG=0
if [ -d "$ROOT/skills" ]; then
  N_REG="$(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | wc -l | tr -d ' ')"
fi
PROVENANCE_CLI="$ROOT/packages/cli/dist/tenon.mjs"
if [ ! -f "$PROVENANCE_CLI" ]; then
  add_fail "缺失 bundled provenance verifier CLI" \
    "packages/cli/dist/tenon.mjs" \
    "运行 npm run bundle 后再执行 verify-skills.sh"
else
  if [ -z "$NODE_BIN" ] || [ "${NODE_BIN#/}" = "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    add_fail "缺少已冻结的绝对 Node 可执行文件，拒绝通过 PATH 运行 provenance verifier" \
      "verify-skills.sh --node <绝对路径>" \
      "由 production caller 传入冻结 nodePath，或设置 TENON_NODE_PATH 后重试"
  else
    provenance_output="$("$NODE_BIN" "$PROVENANCE_CLI" internal-skill-provenance verify --root "$ROOT" --quiet 2>&1)"
    provenance_code=$?
    if [ "$provenance_code" -ne 0 ]; then
      add_fail "canonical Skill provenance verifier 失败: ${provenance_output}" \
        "templates/skill-sources.yaml + skills/" \
        "按上方 category 修复后运行 npm run sync:skill-provenance，再重跑 verify-skills.sh"
    fi
  fi
fi

# ── 6. OpenSpec Ship/Archive 收据语义 ──
# 主 spec 是应用结果；ledger 的 applied-spec kind 必须绑定 Change 自己的审计 receipt。若这里
# 漂移回 openspec/specs/**，Archive 就失去 changed/no-op 与 digest 证据。
TENON_SHIP_SKILL="$ROOT/skills/tenon-ship/SKILL.md"
if [ -f "$TENON_SHIP_SKILL" ]; then
  grep -Fq 'APPLIED_RECEIPT="openspec/changes/$TENON_CHANGE_NAME/applied-spec.md"' "$TENON_SHIP_SKILL" \
    || add_fail "tenon-ship 未登记 Change applied-spec receipt" \
                "skills/tenon-ship/SKILL.md" \
                "把 applied-spec document record 固定到 openspec/changes/<change>/applied-spec.md"
  if grep -Fq 'applied="openspec/specs/' "$TENON_SHIP_SKILL"; then
    add_fail "tenon-ship 把主 spec 冒充 applied-spec receipt" \
             "skills/tenon-ship/SKILL.md" \
             "主 spec 只作为应用结果；ledger 登记 Change applied-spec.md 收据"
  fi
  if grep -Fq 'node tools/reconcile-spec-application.mjs' "$TENON_SHIP_SKILL"; then
    add_fail "tenon-ship 引用了 managed release 未分发的一次性仓库迁移工具" \
             "skills/tenon-ship/SKILL.md" \
             "打包 Skill 只消费 spec-migration-applied typed evidence；仓库维护工具不得成为用户运行时依赖"
  fi
  grep -Fq '`spec-migration-applied` typed guard' "$TENON_SHIP_SKILL" \
    || add_fail "tenon-ship 未声明主规格迁移 typed evidence 门" \
                "skills/tenon-ship/SKILL.md" \
                "存在 migration receipt 时必须由 spec-migration-applied guard 复核 result 与 after digest"
fi

# ── 汇总 ──
NFAIL=${#FAIL_WHAT[@]}
if [ "$NFAIL" -gt 0 ]; then
  {
    printf '[verify-skills] FAIL — 发现 %d 处悬空引用/缺失（root: %s）：\n' "$NFAIL" "$ROOT"
    i=0
    while [ "$i" -lt "$NFAIL" ]; do
      printf '  %d) 缺什么: %s\n' "$((i + 1))" "${FAIL_WHAT[$i]}"
      printf '     在哪引用: %s\n' "${FAIL_WHERE[$i]}"
      printf '     怎么修: %s\n' "${FAIL_FIX[$i]}"
      i=$((i + 1))
    done
    printf '修复后复跑: bash %s\n' "$0"
  } >&2
  exit 1
fi

[ "$QUIET" = 1 ] || printf '[verify-skills] OK — 路径引用 %d 项 / skill 目录 %d 个 / 外部依赖引用 %d 项 / registry 可安装 token %d 项 全部通过（root: %s）\n' "$N_PATH" "$N_SKILL" "$N_EXT" "$N_REG" "$ROOT"
exit 0
