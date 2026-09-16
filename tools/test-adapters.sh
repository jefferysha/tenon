#!/usr/bin/env bash
# test-adapters.sh — 适配器 conformance 测试（BACKLOG #39；仿 tools/test-hooks.sh 风格）。
#
# 把 adapters/contract.md 从「约定」变成「机器约束」：对每个适配器跑同一组输入场景，
# 断言各适配器产出与 Claude Code baseline（hooks/gate.sh · session-start.sh · skill-tracker.sh）
# 等价的 inject/veto/track 决策——或以 registry.yaml 声明的降级档位如实降级（不得伪装硬门/原生）。
#
# 这解决老仓「contract 是约定不是测试」的病灶：改坏任一适配器契约（veto 该拦却放行、
# inject 该注却空、track 该留痕却不写、或声明 native 却降级）必被抓红。§9 反例哨兵自证判别力。
#
# 真实性（GOAL C9/C10：无伪测试·真实且全量）：
#   - veto  真跑适配器 wrapper → 真读项目根 .pipeline-pending-* marker → 真断 exit/permission；
#   - inject 真跑 → 真 cat baseline 宪法/上下文 → 真断 additionalContext 命中；
#   - track  真跑 → 真 append 到 .pipeline-history.jsonl（真实文件系统副作用），断记录逐字对齐。
#   无 mock：断言的是真实副作用与真实决策，不是桩返回值。
#
# 覆盖矩阵（同一输入喂所有适配器 → 断言等价或如实降级）：
#   ① registry.yaml + lint（填表完整性：加平台是填表非重写，D7/D14 策略面）
#   ② 零悬空：每平台 configure 脚本存在；codex/cursor hooks.json wrapper 路径可解析
#   ③ veto：新鲜 marker 拦 / 无 marker 放行 / 陈旧放行 / 子目录上溯拦（× codex × cursor）
#   ④ inject：codex native 包 baseline 上下文；cursor degraded 落 .cursor/rules 且不伪装 native
#   ⑤ track：codex/cursor 真 append history 记录，与 baseline 逐字对齐
#   ⑥ 分档降级如实声明：tier A/B/C 与实际行为一致（native 必等价、degraded 必如实降级）
#   ⑦ 反例哨兵：人为改坏的适配器（veto 放行 / track 不写 / inject 伪装）必被判别为红
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Hooks resolve the declared identity (hooks/tenon-user.sh); fixtures select Changes for this user.
export TENON_USER=hooks@tenon.test
HOOK_USER_SLUG=hooks-at-tenon.test
set_active() { # $1=project root $2=change name
  mkdir -p "$1/.tenon/users/$HOOK_USER_SLUG/local"
  printf '%s\n' "$2" > "$1/.tenon/users/$HOOK_USER_SLUG/local/active-change"
}
clear_active() { rm -f "$1/.tenon/users/$HOOK_USER_SLUG/local/active-change"; }
active_authority_path() { printf '%s/.tenon/users/%s/local/authority' "$1" "$HOOK_USER_SLUG"; }

ADAPTERS="$ROOT/adapters"
REG="$ADAPTERS/registry.yaml"
CONTRACT="$ADAPTERS/contract.md"
LINT="$ADAPTERS/lint-adapter.sh"
# Claude Code baseline 三能力（适配器要在其它工具上等价实现或降级）
GATE="$ROOT/hooks/gate.sh"           # veto  (PreToolUse)
SS="$ROOT/hooks/session-start.sh"    # inject (SessionStart)
TRACKER="$ROOT/hooks/skill-tracker.sh"  # track (PostToolUse Skill)

# 行为 conformance 覆盖的适配器（claude-code = baseline 自身，不自测）
ADAPTER_IDS="codex cursor"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-adapters.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n       %s\n' "$1" "${2:-}"; }
assert_eq()       { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望「$2」实得「$3」"; fi; }
assert_ne()       { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1" "期望不等，两者皆「$2」"; fi; }
assert_contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "输出未含「$3」；实际：${2:0:200}" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) bad "$1" "输出不应含「$3」；实际：${2:0:200}" ;; *) ok "$1" ;; esac; }
assert_file()     { if [ -f "$2" ]; then ok "$1"; else bad "$1" "文件不存在：$2"; fi; }
assert_absent()   { if [ ! -e "$2" ]; then ok "$1"; else bad "$1" "文件本不应存在：$2"; fi; }
assert_exec()     { if [ -x "$2" ]; then ok "$1"; else bad "$1" "非可执行：$2"; fi; }

# ── registry 扁平字段读取（平台块内 4 空格缩进的 key: value；剥一层引号）──
# 平台块以 `  - id: <id>` 起，至下一 `  - id:` 或文件尾止。加平台=填表：conformance 从此表派生。
reg_field() { # <id> <key>
  [ -f "$REG" ] || return 1
  awk -v id="$1" -v key="$2" '
    $0 ~ "^  - id: " id "[[:space:]]*$" { inb=1; next }
    /^  - id: / { inb=0 }
    inb && $0 ~ ("^    " key ":") {
      line=$0; sub(/^    [A-Za-z_]+:[ ]*/,"",line);
      gsub(/^"/,"",line); gsub(/"$/,"",line);
      gsub(/^'\''/,"",line); gsub(/'\''$/,"",line);
      print line; exit
    }
  ' "$REG"
}

# ════════════════════════════════════════════════════════════════════════════
# 前置：baseline 三能力必须在（适配器包装的就是它们）
# ════════════════════════════════════════════════════════════════════════════
for f in "$GATE" "$SS" "$TRACKER"; do
  assert_file "baseline 能力存在：${f#"$ROOT"/}" "$f"
done

# ════════════════════════════════════════════════════════════════════════════
# ① 契约 + registry + lint（填表完整性）
# ════════════════════════════════════════════════════════════════════════════
assert_file "adapters/contract.md 存在" "$CONTRACT"
assert_file "adapters/registry.yaml 存在" "$REG"
# 契约必须把三能力 + A/B/C 分档 + conformance 写清
if [ -f "$CONTRACT" ]; then
  for kw in inject veto track "档 A" "档 B" "档 C" conformance "tenon review acknowledge"; do
    assert_contains "contract.md 覆盖 [${kw}]" "$(cat "$CONTRACT")" "$kw"
  done
  assert_not_contains "contract.md 不再把删 marker 当作解封" "$(cat "$CONTRACT")" "Unlock sentinel"
fi
# lint-adapter.sh：五处齐全机器校验（加平台是填表，缺字段抓红）
if [ -x "$LINT" ]; then
  if bash "$LINT" --all >/dev/null 2>&1; then ok "lint-adapter.sh --all 全绿（registry 填表完整）"
  else bad "lint-adapter.sh --all 全绿（registry 填表完整）" "lint 报错，见 bash $LINT --all"; fi
else
  bad "lint-adapter.sh 可执行" "缺失或不可执行：$LINT"
fi

# ════════════════════════════════════════════════════════════════════════════
# ② 零悬空：configure 脚本存在 + hooks.json wrapper 路径可解析
# ════════════════════════════════════════════════════════════════════════════
for id in $ADAPTER_IDS; do
  conf="$(reg_field "$id" configure)"
  if [ -n "$conf" ]; then assert_file "$id configure 脚本存在（零悬空）：$conf" "$ROOT/$conf"
  else bad "$id configure 字段非空" "registry 未登记 $id.configure"; fi
  # hooks.json 内 __ADAPTER_DIR__/hooks/*.sh 全部落地且可执行
  hj="$ADAPTERS/$id/hooks.json"
  if [ -f "$hj" ]; then
    for rel in $(grep -oE '__ADAPTER_DIR__/[^"]*\.sh' "$hj" 2>/dev/null | sed 's#__ADAPTER_DIR__/##' | sort -u); do
      assert_exec "$id hooks.json 引用可执行（零悬空）：$rel" "$ADAPTERS/$id/$rel"
    done
  else
    bad "$id hooks.json 存在" "缺失：$hj"
  fi
done

# ════════════════════════════════════════════════════════════════════════════
# ③ veto conformance（同输入喂每个适配器，断言与 baseline 决策等价）
# ════════════════════════════════════════════════════════════════════════════
# baseline veto 决策：gate.sh 直跑，exit 2 = DENY / exit 0 = ALLOW
# Review v2 fixture helpers are defined just below the wrapper helpers; functions are resolved at
# call time, so baseline_veto can normalize legacy test setup into the shipped protocol first.
baseline_veto() { normalize_review_marker_for_json "$1"; printf '%s' "$1" | bash "$GATE" >/dev/null 2>&1; [ "$?" = 2 ] && printf DENY || printf ALLOW; }

# 归一任意适配器 veto 输出为 DENY/ALLOW（按 registry 声明的 veto_format 解读）
norm_veto() { # <format> <rc> <stdout>
  case "$1" in
    exit2-stderr)     [ "$2" = 2 ] && printf DENY || printf ALLOW ;;
    permission-json)  case "$3" in *'"permission":"deny"'*|*'"permission": "deny"'*) printf DENY ;; *) printf ALLOW ;; esac ;;
    # git-hook-exit-nonzero（#41 aider）：commit-gate 只要求非零退出即挡（不像 CC 硬性 exit=2）；
    # veto.sh 内部实际用 exit 1——真实 git 世界任何非零都会中止 commit，语义上不必强求 2。
    git-hook-exit-nonzero) [ "$2" != 0 ] && printf DENY || printf ALLOW ;;
    # cancel-json（#41 cline）：输出恒为合法 JSON，无 exit-code 语义；cancel:true 才是真拦截。
    cancel-json)      case "$3" in *'"cancel":true'*) printf DENY ;; *) printf ALLOW ;; esac ;;
    # reject-and-continue（#41 amp）：Amp 插件 tool.call 返回值格式；此归一函数留作 bash 侧
    # 一致性入口，amp 实际走 Node __test 分发（见 §⑨.amp），归一逻辑与此处相同（字符串匹配）。
    reject-and-continue) case "$3" in *'"action":"reject-and-continue"'*) printf DENY ;; *) printf ALLOW ;; esac ;;
    *) printf UNKNOWN ;;
  esac
}
# 跑一个 veto wrapper（显式 wrapper 路径 + format，便于反例哨兵复用同一判别路径）
drive_veto_at() { # <wrapper> <format> <json> -> echo DENY/ALLOW
  local w="$1" fmt="$2" json="$3" out rc
  [ -f "$w" ] || { printf MISSING; return; }
  normalize_review_marker_for_json "$json"
  out="$(printf '%s' "$json" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$w" veto-event 2>/dev/null)"; rc=$?
  norm_veto "$fmt" "$rc" "$out"
}
drive_veto() { drive_veto_at "$ADAPTERS/$1/hooks/veto.sh" "$(reg_field "$1" veto_format)" "$2"; }

# scenario 构造器：最小 Git 项目根。所有 review fixture 都有一个显式 active Change；普通
# 空 marker 是已退休的 entry-time 协议，不能再作为 native veto 的测试输入。
mk_proj() {
  local d="$TMP/$1"
  mkdir -p "$d/.git" "$d/openspec/changes/demo-change"
  printf 'phase: explore\ntrack: backend\nworkflow: default\narchived: false\n' > "$d/openspec/changes/demo-change/.pipeline.yaml"
  set_active "$d" demo-change
  printf '%s' "$d"
}

write_v2_review_marker() { # <project root> [change=demo-change] [phase=explore]
  local root="$1" name="${2:-demo-change}" phase="${3:-explore}" dir="$1/openspec/changes/${2:-demo-change}"
  mkdir -p "$dir"
  if [ ! -f "$dir/.pipeline.yaml" ]; then
    printf 'phase: %s\ntrack: backend\nworkflow: default\narchived: false\n' "$phase" > "$dir/.pipeline.yaml"
  fi
  set_active "$root" "$name"
  printf 'pipeline-review-v2\nphase=%s\nchange=%s\nrequested_at=2026-07-24T00:00:00Z\n待人工复核\n' "$phase" "$name" \
    > "$root/.pipeline-pending-review"
}

# Existing adapter fixtures intentionally use `touch` for marker setup.  Upgrade only fresh,
# empty legacy review markers immediately before a veto assertion; stale legacy markers remain
# harmless/allowed and therefore keep their TTL scenario meaning.  The JSON parser is the same
# pure-Bash implementation used by hooks, so escaped paths cannot point this test at another root.
# shellcheck source=../hooks/json-input.sh
. "$ROOT/hooks/json-input.sh"
normalize_review_marker_for_json() { # <hook JSON>
  local json="$1" cwd marker first now mt age
  cwd="$(pipeline_json_get_string "$json" cwd || true)"
  [ -n "$cwd" ] || return 0
  marker="$cwd/.pipeline-pending-review"
  [ -f "$marker" ] || return 0
  IFS= read -r first < "$marker" 2>/dev/null || true
  [ "$first" = pipeline-review-v2 ] && return 0
  mt="$(stat -c %Y "$marker" 2>/dev/null)"
  case "$mt" in ''|*[!0-9]*) mt="$(stat -f %m "$marker" 2>/dev/null)" ;; esac
  case "$mt" in ''|*[!0-9]*) return 0 ;; esac
  now="$(date +%s)"; age=$((now - mt))
  [ "$age" -le 1800 ] || return 0
  [ -d "$cwd/openspec/changes/demo-change" ] || return 0
  write_v2_review_marker "$cwd" demo-change explore
}
touch_age() { # <file> <秒龄>（BSD/GNU 双兼容）
  local ts; ts="$(date -v-"$2"S +%Y%m%d%H%M.%S 2>/dev/null || date -d "@$(( $(date +%s) - $2 ))" +%Y%m%d%H%M.%S 2>/dev/null)"
  touch -t "$ts" "$1"
}

run_veto_scenario() { # <名> <json> <expected DENY/ALLOW>
  local name="$1" json="$2" expect="$3" b; b="$(baseline_veto "$json")"
  assert_eq "veto/$name: baseline gate.sh 决策 = $expect" "$expect" "$b"
  local id d
  for id in $ADAPTER_IDS; do
    d="$(drive_veto "$id" "$json")"
    assert_eq "veto/$name: $id 与 baseline 等价 (${expect})" "$expect" "$d"
  done
}

# 场景 V1：新鲜 review marker → DENY
p="$(mk_proj veto-deny)"; touch "$p/.pipeline-pending-review"
run_veto_scenario "V1-fresh-review" "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}" DENY
# 场景 V2：无 marker → ALLOW
p="$(mk_proj veto-none)"
run_veto_scenario "V2-no-marker" "{\"cwd\":\"$p\",\"tool_name\":\"Bash\"}" ALLOW
# 场景 V3：陈旧 marker → ALLOW
p="$(mk_proj veto-stale)"; touch "$p/.pipeline-pending-review"; touch_age "$p/.pipeline-pending-review" 4000
run_veto_scenario "V3-stale" "{\"cwd\":\"$p\",\"tool_name\":\"Edit\"}" ALLOW
# 场景 V4：marker 在项目根、cwd 是子目录 → 上溯拦 DENY
p="$(mk_proj veto-nested)"; mkdir -p "$p/sub/deep"; touch "$p/.pipeline-pending-interaction"
run_veto_scenario "V4-nested-cwd" "{\"cwd\":\"$p/sub/deep\",\"tool_name\":\"Write\"}" DENY

# ════════════════════════════════════════════════════════════════════════════
# ④ inject conformance（native 包 baseline 上下文；degraded 如实降级 + 不伪装）
# ════════════════════════════════════════════════════════════════════════════
mk_change_proj() { # <名> -> echo 项目路径（含显式选择的 change）
  local d="$TMP/$1"; mkdir -p "$d/openspec/changes/demo-change"
  printf 'phase: explore\ntrack: backend\narchived: false\n' > "$d/openspec/changes/demo-change/.pipeline.yaml"
  # Runtime evidence never chooses a most-recent Change.  Model-side `tenon session activate`
  # creates this pointer in production; fixtures model that explicit binding before they exercise
  # native adapter tracking.
  set_active "$d" demo-change
  printf '%s' "$d"
}

# codex：inject_status=native，wrapper 把 baseline session-start.sh 上下文包成 additionalContext
cx_inj="$ADAPTERS/codex/hooks/inject.sh"
assert_eq "inject/codex: registry 声明 native" native "$(reg_field codex inject_status)"
if [ -f "$cx_inj" ]; then
  p="$(mk_change_proj codex-inject)"
  out="$(printf '{"cwd":"%s"}' "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$cx_inj" SessionStart 2>/dev/null)"
  assert_contains "inject/codex: 产出 hookSpecificOutput（codex JSON 格式）" "$out" "hookSpecificOutput"
  assert_contains "inject/codex: 含 additionalContext 字段" "$out" "additionalContext"
  assert_contains "inject/codex: additionalContext 真包 baseline 宪法（tenon）" "$out" "tenon"
else
  bad "inject/codex: wrapper 存在" "缺失：$cx_inj"
fi

# codex 路由：真跑 UserPromptSubmit wrapper。已激活任务必须从 breadcrumb 注入；没有
# 当前任务时，正常开发对话必须直接触发 default pipeline dispatch，不能先问是否走 workflow。
cx_prompt="$ADAPTERS/codex/hooks/prompt.sh"
if [ -f "$cx_prompt" ]; then
  p="$(mk_change_proj codex-prompt-active)"
  set_active "$p" demo-change
  printf '实现登录页，并完成浏览器验收。\n' > "$p/openspec/changes/demo-change/REAL_AGENT_TASK.md"
  out="$(printf '{\"prompt\":\"继续实现登录页面的 React 组件\",\"cwd\":\"%s\"}' "$p" | TENON_ROUTER_CACHE="$TMP/codex-prompt-active.cache" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$cx_prompt" UserPromptSubmit 2>/dev/null)"
  assert_contains "route/codex: 产出 UserPromptSubmit hookSpecificOutput" "$out" "\"hookEventName\":\"UserPromptSubmit\""
  assert_contains "route/codex: 真注入已激活 Change" "$out" "change: demo-change"
  assert_contains "route/codex: 真注入已保存任务提示词" "$out" "实现登录页，并完成浏览器验收。"
  assert_contains "route/codex: 同轮保留真实 workflow-state" "$out" "workflow-state"

  # 回归跨会话劫持：repo 级 `active-change` 仅是明确恢复候选。一个新的工具项目
  # 调研目标必须从 open 派发独立 change，不能继承 demo-change 的 phase / 任务文本。
  out="$(printf '{\"prompt\":\"我现在想要调研一个新的工具项目\",\"cwd\":\"%s\"}' "$p" | TENON_ROUTER_CACHE="$TMP/codex-prompt-new-topic.cache" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$cx_prompt" UserPromptSubmit 2>/dev/null)"
  assert_contains "route/codex: 新主题显式派发 new intent" "$out" "intent: new"
  assert_contains "route/codex: 新主题从 open 开始" "$out" "phase: open"
  assert_not_contains "route/codex: 新主题不绑定旧 change" "$out" "change: demo-change"
  assert_not_contains "route/codex: 新主题不泄漏旧任务文本" "$out" "实现登录页，并完成浏览器验收。"

  # Codex 会为别的插件注入 CLAUDE_PLUGIN_ROOT。适配器必须确认其中实际有
  # pipeline 的 baseline 脚本，不能只因存在 hooks/ 目录就误取外来插件根。
  foreign_root="$TMP/codex-foreign-plugin"; mkdir -p "$foreign_root/hooks"
  out="$(printf '{\"prompt\":\"继续实现登录页面的 React 组件\",\"cwd\":\"%s\"}' "$p" | TENON_ROUTER_CACHE="$TMP/codex-prompt-foreign.cache" CLAUDE_PLUGIN_ROOT="$foreign_root" bash "$cx_prompt" UserPromptSubmit 2>/dev/null)"
  assert_contains "route/codex: 外来 CLAUDE_PLUGIN_ROOT 不劫持 adapter 根" "$out" "workflow-state"

  p="$TMP/codex-prompt-unrouted"; mkdir -p "$p/openspec/changes"
  mkdir -p "$p/.pipeline/workflows"
  printf 'name: landing\nsteps:\n  - id: open\n    title: Start\n    transitions: []\n' > "$p/.pipeline/workflows/landing.yaml"
  out="$(printf '{\"prompt\":\"请实现一个响应式 React 页面\",\"cwd\":\"%s\"}' "$p" | TENON_ROUTER_CACHE="$TMP/codex-prompt-unrouted.cache" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$cx_prompt" UserPromptSubmit 2>/dev/null)"
  assert_contains "route/codex: 无当前任务时要求入口 tenon skill" "$out" "skill: tenon"
  assert_contains "route/codex: 无当前任务时派发 default workflow" "$out" "workflow: default"
  assert_contains "route/codex: 无当前任务时输出结构化 tenon dispatch" "$out" "tenon-dispatch"
  assert_not_contains "route/codex: 正常对话不再先问是否走 workflow" "$out" "要走哪个工作流"
  assert_not_contains "route/codex: 正常对话不列自定义 workflow 供选择" "$out" "landing"

  # Codex 正常对话没有 AskUserQuestion 工具。明确确认必须在 UserPromptSubmit 阶段调用
  # `tenon review acknowledge`；hook 本身不得删除 v2 marker 伪造批准。
  p="$(mk_proj codex-prompt-confirm)"
  write_v2_review_marker "$p"
  printf '{"prompt":"为什么需要确认？","cwd":"%s"}' "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$cx_prompt" UserPromptSubmit >/dev/null 2>&1
  [ -f "$p/.pipeline-pending-review" ] && ok "route/codex: 普通询问不误清 review marker" || bad "route/codex: 普通询问不误清 review marker" "marker 被错误清除"
  fake_bin="$TMP/codex-prompt-fake-bin"; fake_log="$TMP/codex-prompt-fake.log"; mkdir -p "$fake_bin"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$TENON_HOOK_LOG"\n' > "$fake_bin/tenon"
  chmod +x "$fake_bin/tenon"
  printf '{"prompt":"确认继续，全部执行","cwd":"%s"}' "$p" | PATH="$fake_bin:$PATH" TENON_HOOK_LOG="$fake_log" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$cx_prompt" UserPromptSubmit >/dev/null 2>&1
  [ -f "$p/.pipeline-pending-review" ] && ok "route/codex: 明确确认不直接删除 review marker" || bad "route/codex: 明确确认不直接删除 review marker" "marker 被错误删除"
  grep -Fq 'review acknowledge demo-change' "$fake_log" 2>/dev/null \
    && ok "route/codex: 明确确认调用 canonical acknowledge" \
    || bad "route/codex: 明确确认调用 canonical acknowledge" "未记录 acknowledge 调用"
else
  bad "route/codex: UserPromptSubmit wrapper 存在" "缺失：$cx_prompt"
fi

# Codex 的项目级 skill 发现依赖 .agents/skills；仅注册 hook/写 AGENTS 无法让宿主实际调用
# Tenon。静态安装也必须完整投递入口和七个 phase skill，并且重跑幂等。
cx_inst="$ADAPTERS/codex/install.sh"
if [ -f "$cx_inst" ]; then
  cx_target="$TMP/codex-static-skills"
  if bash "$cx_inst" --static --target "$cx_target" --codex-home "$TMP/codex-static-home" --yes >/dev/null 2>&1; then
    assert_contains "codex static install: managed block 调用唯一 Tenon 入口" \
      "$(cat "$cx_target/AGENTS.md" 2>/dev/null)" 'tenon:tenon'
    assert_not_contains "codex static install: managed block 不保留旧入口命令" \
      "$(cat "$cx_target/AGENTS.md" 2>/dev/null)" 'tenon:pipeline'
    assert_contains "codex static install: managed block 使用唯一 Tenon CLI" \
      "$(cat "$cx_target/AGENTS.md" 2>/dev/null)" 'tenon status'
    for skill in tenon tenon-open tenon-explore tenon-spec tenon-build tenon-verify tenon-ship tenon-archive simple-task brainstorming writing-plans verification-before-completion openspec-propose openspec-apply-change; do
      assert_file "codex static install: 投递 $skill skill" "$cx_target/.agents/skills/$skill/SKILL.md"
    done
    [ -L "$cx_target/.agents/skills/tenon" ] \
      && ok "codex static install: tenon skill 使用同源软链" \
      || bad "codex static install: tenon skill 使用同源软链" "未创建软链"
    for skill in brainstorming writing-plans verification-before-completion; do
      [ -L "$cx_target/.agents/skills/$skill" ] \
        && ok "codex static install: $skill 使用插件内置同源软链" \
        || bad "codex static install: $skill 使用插件内置同源软链" "未创建软链"
    done
    if bash "$cx_inst" --static --target "$cx_target" --codex-home "$TMP/codex-static-home" --yes >/dev/null 2>&1; then
      ok "codex static install: 同源技能重跑幂等"
    else
      bad "codex static install: 同源技能重跑幂等" "第二次安装失败"
    fi
  else
    bad "codex static install: 完成 AGENTS 与项目 skills 投递" "安装命令失败"
  fi

  # malformed marker topology must fail closed before awk can consume user-owned content.
  cx_bad_marker="$TMP/codex-bad-marker"
  mkdir -p "$cx_bad_marker"
  printf '%s\n%s\n' '<!-- PIPELINE:CODEX:START -->' 'user content after unmatched marker' > "$cx_bad_marker/AGENTS.md"
  cx_bad_before="$(cat "$cx_bad_marker/AGENTS.md")"
  if bash "$cx_inst" --static --target "$cx_bad_marker" --codex-home "$TMP/codex-bad-marker-home" --yes >/dev/null 2>&1; then
    bad "codex static install: 缺失 END marker 时失败关闭" "安装器错误接受了不完整哨兵块"
  else
    [ "$(cat "$cx_bad_marker/AGENTS.md")" = "$cx_bad_before" ] \
      && ok "codex static install: 缺失 END marker 时保留全部用户内容" \
      || bad "codex static install: 缺失 END marker 时保留全部用户内容" "用户内容被改写"
  fi

  cx_reversed_marker="$TMP/codex-reversed-marker"
  mkdir -p "$cx_reversed_marker"
  printf '%s\n%s\n%s\n' '<!-- PIPELINE:CODEX:END -->' 'user content between reversed markers' '<!-- PIPELINE:CODEX:START -->' > "$cx_reversed_marker/AGENTS.md"
  cx_reversed_before="$(cat "$cx_reversed_marker/AGENTS.md")"
  if bash "$cx_inst" --static --target "$cx_reversed_marker" --codex-home "$TMP/codex-reversed-marker-home" --yes >/dev/null 2>&1; then
    bad "codex static install: 反序 marker 时失败关闭" "安装器错误接受了反序哨兵块"
  else
    [ "$(cat "$cx_reversed_marker/AGENTS.md")" = "$cx_reversed_before" ] \
      && ok "codex static install: 反序 marker 时保留全部用户内容" \
      || bad "codex static install: 反序 marker 时保留全部用户内容" "用户内容被改写"
  fi

  # 原生插件和 static project projection 必须互斥。selected root 由宿主/稳定 launcher
  # 显式传入；adapter 不扫描历史 cache 猜版本。
  cx_native_target="$TMP/codex-native-skills"
  if TENON_CODEX_PLUGIN_ROOT="$ROOT" bash "$cx_inst" --static --target "$cx_native_target" \
    --codex-home "$TMP/codex-native-home" --yes >/dev/null 2>&1; then
    [ ! -e "$cx_native_target/.agents/skills/tenon" ] \
      && ok "codex native install: selected plugin root 存在时不创建项目 Skill 重复投影" \
      || bad "codex native install: selected plugin root 存在时不创建项目 Skill 重复投影" "发现重复 pipeline Skill"
  else
    bad "codex native install: selected root 检测成功" "安装命令失败"
  fi

  cx_migrate_target="$TMP/codex-native-migrate"
  bash "$cx_inst" --static --target "$cx_migrate_target" --codex-home "$TMP/codex-migrate-home" --yes >/dev/null 2>&1
  [ -L "$cx_migrate_target/.agents/skills/tenon" ] \
    && ok "codex native migrate: 夹具先有 adapter-owned legacy link" \
    || bad "codex native migrate: 夹具先有 adapter-owned legacy link" "旧链接未建立"
  if TENON_CODEX_PLUGIN_ROOT="$ROOT" bash "$cx_inst" --static --target "$cx_migrate_target" \
    --codex-home "$TMP/codex-migrate-home" --yes >/dev/null 2>&1; then
    [ ! -e "$cx_migrate_target/.agents/skills/tenon" ] \
      && ok "codex native migrate: 只清理同源 adapter-owned legacy link" \
      || bad "codex native migrate: 只清理同源 adapter-owned legacy link" "旧链接仍可发现"
  else
    bad "codex native migrate: ownership-safe 收敛成功" "迁移命令失败"
  fi

  cx_foreign_target="$TMP/codex-native-foreign"
  mkdir -p "$cx_foreign_target/.agents/skills/tenon"
  printf '%s\n' '# user-owned tenon skill' > "$cx_foreign_target/.agents/skills/tenon/SKILL.md"
  if TENON_CODEX_PLUGIN_ROOT="$ROOT" bash "$cx_inst" --static --target "$cx_foreign_target" \
    --codex-home "$TMP/codex-foreign-home" --yes >/dev/null 2>&1; then
    bad "codex native migrate: 用户目录产生 shadow-conflict 并拒绝" "命令意外成功"
  else
    ok "codex native migrate: 用户目录产生 shadow-conflict 并拒绝"
  fi
  assert_file "codex native migrate: shadow-conflict 保留用户 SKILL.md" \
    "$cx_foreign_target/.agents/skills/tenon/SKILL.md"
else
  bad "codex static install.sh 存在" "缺失：$cx_inst"
fi

# cursor：inject_status=degraded → 落 .cursor/rules 静态层；且不得暴露伪 SessionStart inject
assert_eq "inject/cursor: registry 声明 degraded" degraded "$(reg_field cursor inject_status)"
assert_eq "inject/cursor: registry 声明 fallback=static-rules" static-rules "$(reg_field cursor inject_fallback)"
assert_absent "inject/cursor: 无 hooks/inject.sh（不伪装会话级 inject，如实降级）" "$ADAPTERS/cursor/hooks/inject.sh"
cur_inst="$ADAPTERS/cursor/install.sh"
if [ -f "$cur_inst" ]; then
  cp="$TMP/cursor-install"; mkdir -p "$cp"
  bash "$cur_inst" --target "$cp" --no-hooks --yes >/dev/null 2>&1 || true
  assert_file "inject/cursor: install 落地 .cursor/rules/tenon.mdc（降级静态层真产出）" "$cp/.cursor/rules/tenon.mdc"
  cur_front="$(awk 'NR==1 && $0=="---" { inb=1; next } inb && $0=="---" { exit } inb { print }' "$cp/.cursor/rules/tenon.mdc" 2>/dev/null)"
  assert_contains "inject/cursor: tenon.mdc frontmatter 含 alwaysApply: true（Cursor 每次会话都带上）" "$cur_front" "alwaysApply: true"
  assert_absent "inject/cursor: 不写 Cursor 忽略的 .cursor/rules/pipeline.md" "$cp/.cursor/rules/pipeline.md"
  # 旧版安装器生成的 pipeline.md（逐字节夹具，sha256 与 install.sh 的 LEGACY_RULES_SHA256 对账）
  cur_legacy="$TMP/cursor-legacy"; mkdir -p "$cur_legacy/.cursor/rules"
  cat > "$cur_legacy/.cursor/rules/pipeline.md" <<'LEGACY'
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
LEGACY
  bash "$cur_inst" --target "$cur_legacy" --no-hooks --yes >/dev/null 2>&1 || true
  assert_absent "inject/cursor: 旧版生成且未改动的 pipeline.md 被删除" "$cur_legacy/.cursor/rules/pipeline.md"
  cur_edited="$TMP/cursor-legacy-edited"; mkdir -p "$cur_edited/.cursor/rules"
  printf '# 我的规则\n' > "$cur_edited/.cursor/rules/pipeline.md"
  cur_out="$(bash "$cur_inst" --target "$cur_edited" --no-hooks --yes 2>&1)"; cur_rc=$?
  assert_eq "inject/cursor: 用户改过的 pipeline.md 不算失败（exit 0）" 0 "$cur_rc"
  assert_file "inject/cursor: 用户改过的 pipeline.md 保留" "$cur_edited/.cursor/rules/pipeline.md"
  assert_contains "inject/cursor: 保留旧文件时打印警告" "$cur_out" "保留不删"
else
  bad "inject/cursor: install.sh 存在" "缺失：$cur_inst"
fi

# ════════════════════════════════════════════════════════════════════════════
# ⑤ track conformance（真 append history，与 baseline 逐字对齐）
# ════════════════════════════════════════════════════════════════════════════
TRACK_JSON_TMPL='{"cwd":"%s","tool_name":"Skill","skill":"tenon-explore"}'
HIST="openspec/changes/demo-change/.pipeline-history.jsonl"

# baseline：skill-tracker.sh 直跑 → history 记 raw="Skill: tenon-explore"
p="$(mk_change_proj track-baseline)"
printf "$TRACK_JSON_TMPL" "$p" | bash "$TRACKER" >/dev/null 2>&1 || true
if [ -f "$p/$HIST" ]; then
  assert_contains "track/baseline: history 记 Skill: tenon-explore" "$(cat "$p/$HIST")" '"raw":"Skill: tenon-explore"'
else
  bad "track/baseline: history 文件生成" "缺 $p/$HIST"
fi

drive_track() { # <id> -> 在独立项目跑该适配器 track，echo 最后一行 history
  # 注意（#41 铺量时抓出的潜伏 bug）：不能写成 `local id="$1" w="...$id..."`——bash 对同一条
  # local 语句里的多个赋值会先展开全部 RHS 再赋值，此时 w 里的 $id 仍读外层作用域的同名变量
  # （历史上恰好都在 `for id in ...` 循环里调用、外层 id 巧合等于传入的 "$1" 才没露馅；
  # #41 新增的 continue/track 用例在循环外直接传字面量调用，当即抓出）。拆成两条独立 local 语句。
  local id="$1"
  local w="$ADAPTERS/$id/hooks/track.sh"
  [ -f "$w" ] || { printf MISSING; return; }
  local p; p="$(mk_change_proj "track-$id")"
  printf "$TRACK_JSON_TMPL" "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$w" postToolUse >/dev/null 2>&1 || true
  [ -f "$p/$HIST" ] && tail -1 "$p/$HIST" || printf NO_HISTORY
}
for id in $ADAPTER_IDS; do
  line="$(drive_track "$id")"
  assert_contains "track/$id: 真 append history（与 baseline 记录等价）" "$line" '"raw":"Skill: tenon-explore"'
done

# ════════════════════════════════════════════════════════════════════════════
# ⑥ 分档降级如实（tier A/B/C 与实际行为一致）
# ════════════════════════════════════════════════════════════════════════════
# codex = 档 A 全保真：三能力全 native
assert_eq "tier/codex: registry tier=A" A "$(reg_field codex tier)"
assert_eq "tier/codex: veto native"  native "$(reg_field codex veto_status)"
assert_eq "tier/codex: inject native" native "$(reg_field codex inject_status)"
assert_eq "tier/codex: track native"  native "$(reg_field codex track_status)"
# cursor = 档 B 部分降级：veto/track native、inject degraded
assert_eq "tier/cursor: registry tier=B" B "$(reg_field cursor tier)"
assert_eq "tier/cursor: veto native"  native "$(reg_field cursor veto_status)"
assert_eq "tier/cursor: track native" native "$(reg_field cursor track_status)"
assert_eq "tier/cursor: inject degraded" degraded "$(reg_field cursor inject_status)"
# cursor veto 必 failClosed（默认 fail-open 与硬拦冲突）——hooks.json 声明 + registry 登记
assert_eq "tier/cursor: registry veto_failclosed=true" true "$(reg_field cursor veto_failclosed)"
if [ -f "$ADAPTERS/cursor/hooks.json" ]; then
  assert_contains "tier/cursor: hooks.json 含 failClosed:true" "$(cat "$ADAPTERS/cursor/hooks.json")" "failClosed"
fi

# ════════════════════════════════════════════════════════════════════════════
# ⑦ 反例哨兵：人为改坏契约必被判别为红（证明 conformance 有判别力，非空跑）
# ════════════════════════════════════════════════════════════════════════════
# 反例 A：veto 该拦却放行 → 判别器须报 与 baseline 不等价（= 会被 §③ 抓红）
mkdir -p "$TMP/broken-veto/hooks"
cat > "$TMP/broken-veto/hooks/veto.sh" <<'BROKEN'
#!/usr/bin/env bash
printf '{"permission":"allow"}\n'
BROKEN
chmod +x "$TMP/broken-veto/hooks/veto.sh"
p="$(mk_proj sentinel-veto)"; touch "$p/.pipeline-pending-review"
b="$(baseline_veto "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}")"
d="$(drive_veto_at "$TMP/broken-veto/hooks/veto.sh" permission-json "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}")"
assert_eq "哨兵: baseline 对新鲜 marker = DENY" DENY "$b"
assert_ne "哨兵: 改坏的 veto（放行）被判别为 ≠ baseline → 会抓红" "$b" "$d"

# 反例 B：track 该留痕却不写 → 判别器须发现 history 未增（= 会被 §⑤ 抓红）
mkdir -p "$TMP/broken-track/hooks"
cat > "$TMP/broken-track/hooks/track.sh" <<'BROKEN'
#!/usr/bin/env bash
exit 0
BROKEN
chmod +x "$TMP/broken-track/hooks/track.sh"
p="$(mk_change_proj sentinel-track)"
printf "$TRACK_JSON_TMPL" "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$TMP/broken-track/hooks/track.sh" postToolUse >/dev/null 2>&1 || true
if [ -f "$p/$HIST" ]; then bad "哨兵: 改坏的 track（不写）被抓红" "history 竟被写了：$(cat "$p/$HIST")"
else ok "哨兵: 改坏的 track（不写 history）被判别为红（history 未生成）"; fi

# 反例 C：inject 声明 native 却空产出 → 判别器须发现 additionalContext 缺失
mkdir -p "$TMP/broken-inject/hooks"
cat > "$TMP/broken-inject/hooks/inject.sh" <<'BROKEN'
#!/usr/bin/env bash
exit 0
BROKEN
chmod +x "$TMP/broken-inject/hooks/inject.sh"
p="$(mk_change_proj sentinel-inject)"
out="$(printf '{"cwd":"%s"}' "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$TMP/broken-inject/hooks/inject.sh" SessionStart 2>/dev/null)"
case "$out" in *additionalContext*) bad "哨兵: 改坏的 inject（空产出）被抓红" "竟产出了 context" ;; *) ok "哨兵: 声明 native 却空产出的 inject 被判别为红（无 additionalContext）" ;; esac

# ════════════════════════════════════════════════════════════════════════════
# ⑧ 新平台铺量 conformance（BACKLOG #40：#39 planned → active，填表式扩展 D7/D14）
#    gemini(A 全 native) · copilot(B veto/track native·inject 降级) ·
#    pi(B inject/track native·veto 降级) · devin(C workflow-only 三能力全静态降级)
#    同一组输入场景喂新平台 → 归一 canonical 决策 → native 断言等价 baseline / degraded 断言落声明 fallback。
#    诚实：真做不到 native 的能力如实标降级档（不伪装硬门/原生，contract §1 红线）。
# ════════════════════════════════════════════════════════════════════════════
NEW_IDS="gemini copilot pi devin"

# ⑧.0 lint 全绿（4 新平台进 platforms: 后各自填表完整——加平台是填表非重写，缺字段被抓红）
for id in $NEW_IDS; do
  if [ -x "$LINT" ]; then
    if bash "$LINT" "$id" >/dev/null 2>&1; then ok "lint/$id: 填表完整（registry 字段齐全）"
    else bad "lint/$id: 填表完整（registry 字段齐全）" "见 bash $LINT $id"; fi
  else
    bad "lint/$id: lint-adapter.sh 可执行" "缺失或不可执行：$LINT"
  fi
done

# ⑧.1 零悬空：每新平台 configure 脚本存在；hook 模板引用的 wrapper 落地可执行（devin 无 hook 如实无目录）
for id in $NEW_IDS; do
  conf="$(reg_field "$id" configure)"
  if [ -n "$conf" ]; then assert_file "$id: configure 脚本存在（零悬空）：$conf" "$ROOT/$conf"
  else bad "$id: configure 字段非空" "registry 未登记 $id.configure"; fi
  # hook 模板：codex/cursor/copilot = hooks.json；gemini/pi = settings.json#hooks；devin 无 hook 模板
  htmpl=""
  for cand in "$ADAPTERS/$id/hooks.json" "$ADAPTERS/$id/settings.json"; do
    [ -f "$cand" ] && { htmpl="$cand"; break; }
  done
  if [ "$(reg_field "$id" hasHooks)" = "true" ]; then
    if [ -n "$htmpl" ]; then
      for rel in $(grep -oE '__ADAPTER_DIR__/[^"]*\.sh' "$htmpl" 2>/dev/null | sed 's#__ADAPTER_DIR__/##' | sort -u); do
        assert_exec "$id hook 模板引用可执行（零悬空）：$rel" "$ADAPTERS/$id/$rel"
      done
    else
      bad "$id hasHooks=true → hook 模板存在（hooks.json/settings.json）" "缺：$ADAPTERS/$id/"
    fi
  else
    assert_absent "$id hasHooks=false → 无 hooks/ 目录（workflow-only，不伪装 hook 强制）" "$ADAPTERS/$id/hooks"
  fi
done

# ⑧.2 veto conformance — 新平台 native veto（gemini/copilot）与 baseline 逐场景等价（同 §③ 输入）
run_veto_new() { # <名> <json> <expect> <ids...>
  local name="$1" json="$2" expect="$3"; shift 3
  local id d
  for id in "$@"; do
    d="$(drive_veto_at "$ADAPTERS/$id/hooks/veto.sh" "$(reg_field "$id" veto_format)" "$json")"
    assert_eq "veto/$name: $id native 与 baseline 等价 (${expect})" "$expect" "$d"
  done
}
NV="gemini copilot"
p="$(mk_proj nv-deny)"; touch "$p/.pipeline-pending-review"
run_veto_new "V1-fresh-review" "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}" DENY $NV
p="$(mk_proj nv-none)"
run_veto_new "V2-no-marker"    "{\"cwd\":\"$p\",\"tool_name\":\"Bash\"}"  ALLOW $NV
p="$(mk_proj nv-stale)"; touch "$p/.pipeline-pending-review"; touch_age "$p/.pipeline-pending-review" 4000
run_veto_new "V3-stale"        "{\"cwd\":\"$p\",\"tool_name\":\"Edit\"}"  ALLOW $NV
p="$(mk_proj nv-nested)"; mkdir -p "$p/sub/deep"; touch "$p/.pipeline-pending-interaction"
run_veto_new "V4-nested-cwd"   "{\"cwd\":\"$p/sub/deep\",\"tool_name\":\"Write\"}" DENY $NV

# ⑧.3 inject conformance — native（gemini/pi 包 baseline 上下文）/ degraded（copilot/devin 落 fallback 不伪装）
for id in gemini pi; do
  assert_eq "inject/$id: registry 声明 native" native "$(reg_field "$id" inject_status)"
  w="$ADAPTERS/$id/hooks/inject.sh"
  if [ -f "$w" ]; then
    p="$(mk_change_proj "$id-inject")"
    out="$(printf '{"cwd":"%s"}' "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$w" SessionStart 2>/dev/null)"
    assert_contains "inject/$id: 产出 hookSpecificOutput（CC 同构 JSON）" "$out" "hookSpecificOutput"
    assert_contains "inject/$id: 含 additionalContext 字段" "$out" "additionalContext"
    assert_contains "inject/$id: additionalContext 真包 baseline 宪法（tenon）" "$out" "tenon"
  else
    bad "inject/$id: wrapper 存在" "缺失：$w"
  fi
done
# copilot inject degraded：无 hooks/inject.sh（不伪装会话级 inject），install 落 .github/copilot-instructions.md 静态层
assert_eq "inject/copilot: registry 声明 degraded" degraded "$(reg_field copilot inject_status)"
assert_ne "inject/copilot: inject_fallback 非空（声明降级须给落点）" "" "$(reg_field copilot inject_fallback)"
assert_absent "inject/copilot: 无 hooks/inject.sh（如实降级，不伪装会话级 inject）" "$ADAPTERS/copilot/hooks/inject.sh"
if [ -f "$ADAPTERS/copilot/install.sh" ]; then
  cp="$TMP/copilot-install"; mkdir -p "$cp"
  bash "$ADAPTERS/copilot/install.sh" --target "$cp" --no-hooks --yes >/dev/null 2>&1 || true
  assert_file "inject/copilot: install 落静态层 .github/copilot-instructions.md（降级真产出）" "$cp/.github/copilot-instructions.md"
else
  bad "inject/copilot: install.sh 存在" "缺失：$ADAPTERS/copilot/install.sh"
fi
# devin inject degraded（tier C 静态）：无 hook，install 落 .devin/workflows 静态层
assert_eq "inject/devin: registry 声明 degraded（tier C 静态）" degraded "$(reg_field devin inject_status)"
assert_ne "inject/devin: inject_fallback 非空" "" "$(reg_field devin inject_fallback)"
if [ -f "$ADAPTERS/devin/install.sh" ]; then
  cp="$TMP/devin-install"; mkdir -p "$cp"
  bash "$ADAPTERS/devin/install.sh" --target "$cp" --yes >/dev/null 2>&1 || true
  assert_file "inject/devin: install 落静态 workflow 层 .devin/workflows/pipeline.md（降级真产出）" "$cp/.devin/workflows/pipeline.md"
else
  bad "inject/devin: install.sh 存在" "缺失：$ADAPTERS/devin/install.sh"
fi

# ⑧.4 track conformance — native（gemini/copilot/pi 真 append history）/ degraded（devin 无自动留痕不伪装）
for id in gemini copilot pi; do
  line="$(drive_track "$id")"
  assert_contains "track/$id: 真 append history（与 baseline 记录等价）" "$line" '"raw":"Skill: tenon-explore"'
done
assert_eq "track/devin: registry 声明 degraded（tier C 无 hook 自动留痕）" degraded "$(reg_field devin track_status)"
assert_ne "track/devin: track_fallback 非空" "" "$(reg_field devin track_fallback)"
assert_absent "track/devin: 无 hooks/track.sh（不伪装自动留痕）" "$ADAPTERS/devin/hooks/track.sh"

# ⑧.5 分档降级如实（tier 与三能力 status 与实际行为一致——诚实标降级档）
# gemini = 档 A 全保真：三能力全 native
assert_eq "tier/gemini: registry tier=A" A "$(reg_field gemini tier)"
assert_eq "tier/gemini: inject native" native "$(reg_field gemini inject_status)"
assert_eq "tier/gemini: veto native"  native "$(reg_field gemini veto_status)"
assert_eq "tier/gemini: track native" native "$(reg_field gemini track_status)"
# copilot = 档 B：veto/track native、inject degraded
assert_eq "tier/copilot: registry tier=B" B "$(reg_field copilot tier)"
assert_eq "tier/copilot: veto native"  native "$(reg_field copilot veto_status)"
assert_eq "tier/copilot: track native" native "$(reg_field copilot track_status)"
assert_eq "tier/copilot: inject degraded" degraded "$(reg_field copilot inject_status)"
# pi = 档 B：inject/track native、veto degraded（enforcement 走 .pi/extensions 运行时 advisory + CLI receipt，无原生 pre-tool 硬拦）
assert_eq "tier/pi: registry tier=B" B "$(reg_field pi tier)"
assert_eq "tier/pi: inject native" native "$(reg_field pi inject_status)"
assert_eq "tier/pi: track native"  native "$(reg_field pi track_status)"
assert_eq "tier/pi: veto degraded"  degraded "$(reg_field pi veto_status)"
assert_ne "tier/pi: veto_fallback 非空（声明降级须给落点）" "" "$(reg_field pi veto_fallback)"
assert_absent "tier/pi: 无 hooks/veto.sh（veto 降级，不伪装原生硬拦）" "$ADAPTERS/pi/hooks/veto.sh"
# devin = 档 C 静态降级：hasHooks=false、三能力全 degraded
assert_eq "tier/devin: registry tier=C" C "$(reg_field devin tier)"
assert_eq "tier/devin: hasHooks=false" false "$(reg_field devin hasHooks)"
assert_eq "tier/devin: inject degraded" degraded "$(reg_field devin inject_status)"
assert_eq "tier/devin: veto degraded"  degraded "$(reg_field devin veto_status)"
assert_eq "tier/devin: track degraded" degraded "$(reg_field devin track_status)"

# ⑧.6 变异测试（反例哨兵）：改坏新平台的能力必被判别为红（证明新平台也进真判别路径，非空跑）
# 变异 D：改坏 gemini(A) 的 veto（放行）→ 判别器须报 ≠ baseline（= 会被 ⑧.2 抓红）
mkdir -p "$TMP/broken-gemini/hooks"
cat > "$TMP/broken-gemini/hooks/veto.sh" <<'BROKEN'
#!/usr/bin/env bash
exit 0
BROKEN
chmod +x "$TMP/broken-gemini/hooks/veto.sh"
p="$(mk_proj mut-gemini)"; touch "$p/.pipeline-pending-review"
b="$(baseline_veto "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}")"
d="$(drive_veto_at "$TMP/broken-gemini/hooks/veto.sh" exit2-stderr "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}")"
assert_eq "变异/gemini: baseline 对新鲜 marker = DENY" DENY "$b"
assert_ne "变异/gemini: 改坏的 veto（放行）被判别为 ≠ baseline → 抓红" "$b" "$d"
# 变异 E：改坏 copilot(B) 的 track（不写）→ 判别器须发现 history 未增（= 会被 ⑧.4 抓红）
mkdir -p "$TMP/broken-copilot/hooks"
cat > "$TMP/broken-copilot/hooks/track.sh" <<'BROKEN'
#!/usr/bin/env bash
exit 0
BROKEN
chmod +x "$TMP/broken-copilot/hooks/track.sh"
p="$(mk_change_proj mut-copilot)"
printf "$TRACK_JSON_TMPL" "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$TMP/broken-copilot/hooks/track.sh" postToolUse >/dev/null 2>&1 || true
if [ -f "$p/$HIST" ]; then bad "变异/copilot: 改坏的 track（不写）被抓红" "history 竟被写了：$(cat "$p/$HIST")"
else ok "变异/copilot: 改坏的 track（不写 history）被判别为红（history 未生成）"; fi

# ════════════════════════════════════════════════════════════════════════════
# ⑨ 长尾铺量 #41 conformance（zed/aider/continue/cline/amp）
#    zed(C 全静态) · aider(B veto 降级 commit-gate·inject/track native) ·
#    continue(A，CLI `cn` 与 CC 逐字同构) · cline(A，schema 不同构但三能力真 native) ·
#    amp(A，插件而非 exit-code 子进程，但三能力保真度不打折)。
#    同一组输入场景喂新平台 → 归一 canonical 决策 → native 断言等价 baseline / degraded 断言落
#    声明 fallback。continue/aider 复用既有 drive_veto_at/run_veto_new/drive_track 基础设施
#    （norm_veto 已扩两个新 format 分支）；cline/amp 因 I/O 形状不同构（stdin-only 嵌套 JSON /
#    Node 插件）新写专用 driver，但断言的仍是真实副作用与真实决策，非桩返回值。
# ════════════════════════════════════════════════════════════════════════════
LONGTAIL_IDS="zed aider continue cline amp"

# ⑨.0 lint 全绿（5 新平台进 platforms: 后各自填表完整）
for id in $LONGTAIL_IDS; do
  if [ -x "$LINT" ]; then
    if bash "$LINT" "$id" >/dev/null 2>&1; then ok "lint/$id: 填表完整（registry 字段齐全）"
    else bad "lint/$id: 填表完整（registry 字段齐全）" "见 bash $LINT $id"; fi
  else
    bad "lint/$id: lint-adapter.sh 可执行" "缺失或不可执行：$LINT"
  fi
done

# ⑨.1 零悬空：configure 脚本存在；各平台按自身容器形状核实 hook 产物可执行（无伪装）
for id in $LONGTAIL_IDS; do
  conf="$(reg_field "$id" configure)"
  if [ -n "$conf" ]; then assert_file "$id: configure 脚本存在（零悬空）：$conf" "$ROOT/$conf"
  else bad "$id: configure 字段非空" "registry 未登记 $id.configure"; fi
done
assert_exec  "continue hooks/inject.sh 可执行" "$ADAPTERS/continue/hooks/inject.sh"
assert_exec  "continue hooks/veto.sh 可执行"   "$ADAPTERS/continue/hooks/veto.sh"
assert_exec  "continue hooks/track.sh 可执行"  "$ADAPTERS/continue/hooks/track.sh"
assert_file  "continue settings.json 模板存在" "$ADAPTERS/continue/settings.json"
assert_exec  "aider hooks/inject.sh 可执行"     "$ADAPTERS/aider/hooks/inject.sh"
assert_exec  "aider hooks/veto.sh 可执行"       "$ADAPTERS/aider/hooks/veto.sh"
assert_exec  "aider hooks/track.sh 可执行"      "$ADAPTERS/aider/hooks/track.sh"
assert_exec  "cline hooks/PreToolUse 可执行"    "$ADAPTERS/cline/hooks/PreToolUse"
assert_exec  "cline hooks/PostToolUse 可执行"   "$ADAPTERS/cline/hooks/PostToolUse"
assert_exec  "cline hooks/TaskStart 可执行"     "$ADAPTERS/cline/hooks/TaskStart"
assert_exec  "cline hooks/TaskResume 可执行"    "$ADAPTERS/cline/hooks/TaskResume"
assert_file  "amp plugins/pipeline.js 存在"     "$ADAPTERS/amp/plugins/pipeline.js"
if command -v node >/dev/null 2>&1; then
  if node --check "$ADAPTERS/amp/plugins/pipeline.js" >/dev/null 2>&1; then ok "amp plugins/pipeline.js 语法有效（node --check）"
  else bad "amp plugins/pipeline.js 语法有效（node --check）" "node --check 报错"; fi
fi
assert_absent "zed 无 hooks/（hasHooks=false，不伪装强制）" "$ADAPTERS/zed/hooks"

# ════════════════════════════════════════════════════════════════════════════
# ⑨.2 continue（档 A，与 CC 逐字同构）——直接复用既有 run_veto_new/drive_track/inject 断言模式
# ════════════════════════════════════════════════════════════════════════════
assert_eq "tier/continue: registry tier=A" A "$(reg_field continue tier)"
p="$(mk_proj s9-continue-deny)"; touch "$p/.pipeline-pending-review"
run_veto_new "continue-V1-fresh-review" "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}" DENY continue
p="$(mk_proj s9-continue-none)"
run_veto_new "continue-V2-no-marker" "{\"cwd\":\"$p\",\"tool_name\":\"Bash\"}" ALLOW continue
p="$(mk_proj s9-continue-stale)"; touch "$p/.pipeline-pending-review"; touch_age "$p/.pipeline-pending-review" 4000
run_veto_new "continue-V3-stale" "{\"cwd\":\"$p\",\"tool_name\":\"Edit\"}" ALLOW continue
p="$(mk_proj s9-continue-nested)"; mkdir -p "$p/sub/deep"; touch "$p/.pipeline-pending-interaction"
run_veto_new "continue-V4-nested-cwd" "{\"cwd\":\"$p/sub/deep\",\"tool_name\":\"Write\"}" DENY continue

p="$(mk_change_proj s9-continue-inject)"
out="$(printf '{"cwd":"%s"}' "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/continue/hooks/inject.sh" SessionStart 2>/dev/null)"
assert_contains "inject/continue: 产出 hookSpecificOutput" "$out" "hookSpecificOutput"
assert_contains "inject/continue: additionalContext 真包 baseline 宪法" "$out" "tenon"

line="$(drive_track continue)"
assert_contains "track/continue: 真 append history（与 baseline 记录等价）" "$line" '"raw":"Skill: tenon-explore"'

# ════════════════════════════════════════════════════════════════════════════
# ⑨.3 aider（档 B：veto 降级 commit-gate·inject/track native）
# ════════════════════════════════════════════════════════════════════════════
assert_eq "tier/aider: registry tier=B" B "$(reg_field aider tier)"
assert_eq "tier/aider: veto degraded"   degraded "$(reg_field aider veto_status)"
assert_eq "tier/aider: veto_fallback=commit-gate" commit-gate "$(reg_field aider veto_fallback)"
assert_eq "tier/aider: inject native"   native "$(reg_field aider inject_status)"
assert_eq "tier/aider: track native"    native "$(reg_field aider track_status)"

# veto：aider/hooks/veto.sh 支持与其余适配器同款 stdin JSON 调用协议（norm_veto 新增
# git-hook-exit-nonzero 分支），故可直接复用 run_veto_new 四场景。
p="$(mk_proj s9-aider-deny)"; touch "$p/.pipeline-pending-review"
run_veto_new "aider-V1-fresh-review" "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}" DENY aider
p="$(mk_proj s9-aider-none)"
run_veto_new "aider-V2-no-marker" "{\"cwd\":\"$p\",\"tool_name\":\"Bash\"}" ALLOW aider
p="$(mk_proj s9-aider-stale)"; touch "$p/.pipeline-pending-review"; touch_age "$p/.pipeline-pending-review" 4000
run_veto_new "aider-V3-stale" "{\"cwd\":\"$p\",\"tool_name\":\"Edit\"}" ALLOW aider

# inject：aider read: 文件是纯文本（非 JSON 包装，contract §3 不串格式）——断言纯文本含 baseline 宪法。
p="$(mk_change_proj s9-aider-inject)"
out="$(printf '{"cwd":"%s"}' "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/aider/hooks/inject.sh" SessionStart 2>/dev/null)"
assert_contains "inject/aider: 纯文本含 baseline 宪法（无 JSON 包装，不串格式）" "$out" "tenon"
case "$out" in *hookSpecificOutput*) bad "inject/aider: 未误用 JSON 包装" "纯文本输出里不该出现 hookSpecificOutput" ;; *) ok "inject/aider: 未误用 JSON 包装（纯文本，如实对应 read: 文件形态）" ;; esac

# track：aider 把 commit 当工作单元，skill 字段固定 "aider-edit"（诚实再解释，非伪造）。
p="$(mk_change_proj s9-aider-track)"
printf '{"cwd":"%s"}' "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/aider/hooks/track.sh" post-commit >/dev/null 2>&1 || true
if [ -f "$p/$HIST" ]; then
  assert_contains "track/aider: 真 append history（commit 工作单元，skill=aider-edit）" "$(cat "$p/$HIST")" '"raw":"Skill: aider-edit"'
else
  bad "track/aider: history 文件生成" "缺 $p/$HIST"
fi

# 端到端安装集成：真 git 仓库里跑 install.sh，断言 .aider.conf.yml / 上下文文件 / 真 git hook 落地
# 且 hook 真能挡/真能记（比单跑 wrapper 更进一步：验证 install.sh 接线本身无悬空）。
AIDER_IT="$TMP/aider-it"; mkdir -p "$AIDER_IT"
( cd "$AIDER_IT" && git init -q && git config user.email t@t.com && git config user.name t ) 2>/dev/null
mkdir -p "$AIDER_IT/openspec/changes/demo-change"
printf 'phase: explore\ntrack: backend\narchived: false\n' > "$AIDER_IT/openspec/changes/demo-change/.pipeline.yaml"
set_active "$AIDER_IT" demo-change
CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/aider/install.sh" --target "$AIDER_IT" --yes >/dev/null 2>&1
assert_file "aider install: .aider.conf.yml 落地" "$AIDER_IT/.aider.conf.yml"
assert_file "aider install: 上下文文件落地且含宪法" "$AIDER_IT/.aider-pipeline-context.md"
assert_contains "aider install: 上下文文件真含 baseline 宪法" "$(cat "$AIDER_IT/.aider-pipeline-context.md" 2>/dev/null)" "tenon"
assert_exec "aider install: .git/hooks/pre-commit 真落地可执行"  "$AIDER_IT/.git/hooks/pre-commit"
assert_exec "aider install: .git/hooks/post-commit 真落地可执行" "$AIDER_IT/.git/hooks/post-commit"
( cd "$AIDER_IT" && echo hi > f1.txt && git add f1.txt && git commit -q -m t1 </dev/null ) 2>/dev/null
if [ -f "$AIDER_IT/$HIST" ]; then ok "aider install 端到端：真 commit 后 history 真增（非单测 wrapper，是真装完的 git hook）"
else bad "aider install 端到端：真 commit 后 history 真增" "缺 $AIDER_IT/$HIST"; fi
write_v2_review_marker "$AIDER_IT" demo-change explore
( cd "$AIDER_IT" && echo hi2 > f2.txt && git add f2.txt )
if ( cd "$AIDER_IT" && git commit -q -m t2 </dev/null ) 2>/dev/null; then
  bad "aider install 端到端：真装的 pre-commit 挡住新鲜 marker" "commit 竟然成功了"
else
  ok "aider install 端到端：真装的 pre-commit 真挡住新鲜 marker（commit 失败，非伪造硬拦）"
fi

# ════════════════════════════════════════════════════════════════════════════
# ⑨.4 cline（档 A：schema 与 CC 不同构——stdin-only 嵌套 JSON + 恒 JSON 输出，三能力仍 native）
# ════════════════════════════════════════════════════════════════════════════
assert_eq "tier/cline: registry tier=A" A "$(reg_field cline tier)"
assert_eq "tier/cline: inject native" native "$(reg_field cline inject_status)"
assert_eq "tier/cline: veto native"   native "$(reg_field cline veto_status)"
assert_eq "tier/cline: track native"  native "$(reg_field cline track_status)"

drive_veto_cline() { # <cwd> <toolName> -> DENY/ALLOW（cline 专用：嵌套 JSON + 恒 JSON 输出）
  local cwd="$1" tool="$2" json out
  json="$(printf '{"hookName":"PreToolUse","workspaceRoots":["%s"],"preToolUse":{"toolName":"%s","parameters":{}}}' "$cwd" "$tool")"
  out="$(printf '%s' "$json" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/cline/hooks/PreToolUse" 2>/dev/null)"
  norm_veto cancel-json 0 "$out"
}
run_cline_veto_scenario() { # <名> <cwd> <toolName> <expect>
  local name="$1" cwd="$2" tool="$3" expect="$4" b d
  b="$(baseline_veto "{\"cwd\":\"$cwd\",\"tool_name\":\"$tool\"}")"
  assert_eq "veto/cline-$name: baseline gate.sh 决策 = $expect" "$expect" "$b"
  d="$(drive_veto_cline "$cwd" "$tool")"
  assert_eq "veto/cline-$name: cline 与 baseline 等价 ($expect)" "$expect" "$d"
}
p="$(mk_proj s9-cline-deny)"; touch "$p/.pipeline-pending-review"
run_cline_veto_scenario "V1-fresh-review" "$p" write_to_file DENY
p="$(mk_proj s9-cline-none)"
run_cline_veto_scenario "V2-no-marker" "$p" execute_command ALLOW
p="$(mk_proj s9-cline-stale)"; touch "$p/.pipeline-pending-review"; touch_age "$p/.pipeline-pending-review" 4000
run_cline_veto_scenario "V3-stale" "$p" read_file ALLOW
p="$(mk_proj s9-cline-nested)"; mkdir -p "$p/sub/deep"; touch "$p/.pipeline-pending-interaction"
run_cline_veto_scenario "V4-nested-cwd" "$p/sub/deep" write_to_file DENY

p="$(mk_change_proj s9-cline-inject)"
json="$(printf '{"hookName":"TaskStart","workspaceRoots":["%s"],"taskStart":{"taskMetadata":{"taskId":"t1","ulid":"u1","initialTask":"x"}}}' "$p")"
out="$(printf '%s' "$json" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/cline/hooks/TaskStart" 2>/dev/null)"
assert_contains "inject/cline(TaskStart): 产出 contextModification 字段" "$out" "contextModification"
assert_contains "inject/cline(TaskStart): 真含 baseline 宪法" "$out" "tenon"
json2="$(printf '{"hookName":"TaskResume","workspaceRoots":["%s"],"taskResume":{"taskMetadata":{"taskId":"t1","ulid":"u1"},"previousState":{}}}' "$p")"
out2="$(printf '%s' "$json2" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/cline/hooks/TaskResume" 2>/dev/null)"
assert_contains "inject/cline(TaskResume): 委托 TaskStart 同款注入" "$out2" "contextModification"

p="$(mk_change_proj s9-cline-track)"
json3="$(printf '{"hookName":"PostToolUse","workspaceRoots":["%s"],"postToolUse":{"toolName":"tenon-explore","parameters":{},"result":"ok","success":true,"executionTimeMs":1}}' "$p")"
printf '%s' "$json3" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/cline/hooks/PostToolUse" >/dev/null 2>&1 || true
if [ -f "$p/$HIST" ]; then
  assert_contains "track/cline: 真 append history（真实工具名强制映射，与 baseline 等价记录）" "$(cat "$p/$HIST")" '"raw":"Skill: tenon-explore"'
else
  bad "track/cline: history 文件生成" "缺 $p/$HIST"
fi
CLINE_IT="$TMP/cline-it"; mkdir -p "$CLINE_IT"
bash "$ADAPTERS/cline/install.sh" --target "$CLINE_IT" --yes >/dev/null 2>&1
assert_contains "cline install: shim 转发到本仓库绝对路径（非拷贝，逻辑单一来源）" \
  "$(cat "$CLINE_IT/.clinerules/hooks/PreToolUse" 2>/dev/null)" "$ADAPTERS/cline/hooks/PreToolUse"

# ════════════════════════════════════════════════════════════════════════════
# ⑨.5 amp（档 A：进程内插件而非 exit-code 子进程，三能力保真度不打折——见 README §4/§5）
# ════════════════════════════════════════════════════════════════════════════
assert_eq "tier/amp: registry tier=A" A "$(reg_field amp tier)"
assert_eq "tier/amp: inject native" native "$(reg_field amp inject_status)"
assert_eq "tier/amp: veto native"   native "$(reg_field amp veto_status)"
assert_eq "tier/amp: track native"  native "$(reg_field amp track_status)"

AMP_PLUGIN="$ADAPTERS/amp/plugins/pipeline.js"
HAVE_NODE=0; command -v node >/dev/null 2>&1 && HAVE_NODE=1
if [ "$HAVE_NODE" = 1 ]; then
  drive_veto_amp() { # <cwd> <toolName> -> DENY/ALLOW
    local out
    out="$(CLAUDE_PLUGIN_ROOT="$ROOT" node "$AMP_PLUGIN" __test decideToolCall "$1" "$2" 2>/dev/null)"
    norm_veto reject-and-continue 0 "$out"
  }
  run_amp_veto_scenario() { # <名> <cwd> <toolName> <expect>
    local name="$1" cwd="$2" tool="$3" expect="$4" b d
    b="$(baseline_veto "{\"cwd\":\"$cwd\",\"tool_name\":\"$tool\"}")"
    assert_eq "veto/amp-$name: baseline gate.sh 决策 = $expect" "$expect" "$b"
    d="$(drive_veto_amp "$cwd" "$tool")"
    assert_eq "veto/amp-$name: amp 与 baseline 等价 ($expect)" "$expect" "$d"
  }
  p="$(mk_proj s9-amp-deny)"; touch "$p/.pipeline-pending-review"
  run_amp_veto_scenario "V1-fresh-review" "$p" Write DENY
  p="$(mk_proj s9-amp-none)"
  run_amp_veto_scenario "V2-no-marker" "$p" Bash ALLOW
  p="$(mk_proj s9-amp-stale)"; touch "$p/.pipeline-pending-review"; touch_age "$p/.pipeline-pending-review" 4000
  run_amp_veto_scenario "V3-stale" "$p" Edit ALLOW
  p="$(mk_proj s9-amp-nested)"; mkdir -p "$p/sub/deep"; touch "$p/.pipeline-pending-interaction"
  run_amp_veto_scenario "V4-nested-cwd" "$p/sub/deep" Write DENY

  p="$(mk_change_proj s9-amp-inject)"
  out="$(CLAUDE_PLUGIN_ROOT="$ROOT" node "$AMP_PLUGIN" __test buildInjectContext "$p" 2>/dev/null)"
  assert_contains "inject/amp: buildInjectContext 真含 baseline 宪法" "$out" "tenon"

  p="$(mk_change_proj s9-amp-track)"
  CLAUDE_PLUGIN_ROOT="$ROOT" node "$AMP_PLUGIN" __test recordToolResult "$p" tenon-explore >/dev/null 2>&1 || true
  if [ -f "$p/$HIST" ]; then
    assert_contains "track/amp: 真 append history（真实工具名强制映射，与 baseline 等价记录）" "$(cat "$p/$HIST")" '"raw":"Skill: tenon-explore"'
  else
    bad "track/amp: history 文件生成" "缺 $p/$HIST"
  fi

  # 插件注册层（amp.on 挂接）也真跑一次，不只测纯函数：mock PluginAPI 验证 once-per-thread inject 门控真生效。
  MOCK_HARNESS="$TMP/amp-mock-harness.mjs"
  cat > "$MOCK_HARNESS" <<'MOCKEOF'
const { default: plugin } = await import(process.argv[2]);
const handlers = {};
plugin({ on(e, h) { handlers[e] = h; } });
const cwd = process.argv[3];
const r1 = await handlers["agent.start"]({ thread: { id: "tA" }, cwd }, {});
const r2 = await handlers["agent.start"]({ thread: { id: "tA" }, cwd }, {});
console.log(JSON.stringify({ firstTurnMsgCount: r1.messages.length, secondTurnMsgCount: r2.messages.length }));
MOCKEOF
  p="$(mk_change_proj s9-amp-plugin-wiring)"
  out="$(CLAUDE_PLUGIN_ROOT="$ROOT" node "$MOCK_HARNESS" "$AMP_PLUGIN" "$p" 2>/dev/null)"
  assert_contains "amp 插件注册层：首回合真注入（messages 非空）" "$out" '"firstTurnMsgCount":1'
  assert_contains "amp 插件注册层：同线程次回合不重复注入（模拟 CC 每会话一次）" "$out" '"secondTurnMsgCount":0'
else
  printf 'SKIP - amp 全部运行时 conformance（无 node，跳过；lint/文件存在性断言仍生效，环境限制如实标注）\n'
fi

AMP_IT="$TMP/amp-it"; mkdir -p "$AMP_IT"
bash "$ADAPTERS/amp/install.sh" --target "$AMP_IT" --yes >/dev/null 2>&1
assert_file "amp install: .amp/plugins/pipeline.js 落地" "$AMP_IT/.amp/plugins/pipeline.js"
assert_contains "amp install: TENON_ROOT 占位符已替换为绝对路径" \
  "$(cat "$AMP_IT/.amp/plugins/pipeline.js" 2>/dev/null)" "$ROOT"
case "$(cat "$AMP_IT/.amp/plugins/pipeline.js" 2>/dev/null)" in
  *__TENON_ROOT__*) bad "amp install: 占位符不残留" "__TENON_ROOT__ 字面量仍在文件里，替换失败" ;;
  *) ok "amp install: 占位符不残留（sed 替换真生效）" ;;
esac

# ════════════════════════════════════════════════════════════════════════════
# ⑨.6 zed（档 C：全静态降级，同 devin 形）
# ════════════════════════════════════════════════════════════════════════════
assert_eq "tier/zed: registry tier=C" C "$(reg_field zed tier)"
assert_eq "tier/zed: hasHooks=false" false "$(reg_field zed hasHooks)"
assert_eq "tier/zed: inject degraded" degraded "$(reg_field zed inject_status)"
assert_eq "tier/zed: veto degraded"   degraded "$(reg_field zed veto_status)"
assert_eq "tier/zed: track degraded"  degraded "$(reg_field zed track_status)"
# Zed 只读工作区根目录下第一个存在的指令文件（zed.dev/docs/ai/instructions）；块必须落在该文件里。
# 顺序的单一来源是 kernel ZED_PROJECT_ORDER（Dashboard 用它显示生效文件），脚本里的副本必须逐项相等。
zed_script_order="$(sed -n 's/^ZED_ORDER=(\(.*\))$/\1/p' "$ADAPTERS/zed/install.sh")"
if command -v node >/dev/null 2>&1; then
  zed_kernel_order="$(node --input-type=module -e "const m = await import('$ROOT/packages/kernel/dist/index.js'); console.log(m.ZED_PROJECT_ORDER.join(' '))" 2>&1)"
  assert_eq "zed install: 脚本读取顺序与 kernel ZED_PROJECT_ORDER 一致" "$zed_kernel_order" "$zed_script_order"
else
  printf 'SKIP - zed 读取顺序与 kernel 对账（无 node）\n'
fi
zed_blocks_in() { # <dir> <rel> → 该文件 ZED START 标记数
  if [ -f "$1/$2" ]; then grep -cxF '<!-- PIPELINE:ZED:START -->' "$1/$2" || true; else printf '0'; fi
}
zed_block_total() { # <dir> → 全部候选文件合计
  local n=0 rel
  for rel in $zed_script_order; do n=$((n + $(zed_blocks_in "$1" "$rel"))); done
  printf '%s' "$n"
}

ZED_IT="$TMP/zed-it"; mkdir -p "$ZED_IT"
bash "$ADAPTERS/zed/install.sh" --target "$ZED_IT" --yes >/dev/null 2>&1
assert_absent "zed install: 干净项目不创建 .rules（它会遮住 AGENTS.md / CLAUDE.md）" "$ZED_IT/.rules"
assert_eq "zed install: 干净项目 ZED 块写入 AGENTS.md" "1" "$(zed_blocks_in "$ZED_IT" AGENTS.md)"
assert_contains "zed install: AGENTS.md 真含 pipeline 静态引导内容" "$(cat "$ZED_IT/AGENTS.md" 2>/dev/null)" "Pipeline Workflow"
# 幂等：重装一次不应产生第二份哨兵块
bash "$ADAPTERS/zed/install.sh" --target "$ZED_IT" --yes >/dev/null 2>&1
assert_eq "zed install: 重装幂等（全部候选文件合计恰一份 ZED 块）" "1" "$(zed_block_total "$ZED_IT")"

ZED_USER="$TMP/zed-user-rules"; mkdir -p "$ZED_USER"
printf '# 我的 Zed 规则\n' > "$ZED_USER/.rules"; printf '# 项目\n' > "$ZED_USER/AGENTS.md"
bash "$ADAPTERS/zed/install.sh" --target "$ZED_USER" --yes >/dev/null 2>&1
assert_eq "zed install: 用户已有 .rules → 块写入 .rules" "1" "$(zed_blocks_in "$ZED_USER" .rules)"
assert_eq "zed install: 用户已有 .rules → AGENTS.md 不写块" "0" "$(zed_blocks_in "$ZED_USER" AGENTS.md)"
assert_contains "zed install: .rules 保留用户内容" "$(cat "$ZED_USER/.rules")" "我的 Zed 规则"

ZED_OLD="$TMP/zed-old-rules"; mkdir -p "$ZED_OLD"
printf '\n<!-- PIPELINE:ZED:START -->\n## Pipeline Workflow（旧版）\n<!-- PIPELINE:ZED:END -->\n' > "$ZED_OLD/.rules"
printf '# 项目\n' > "$ZED_OLD/AGENTS.md"
bash "$ADAPTERS/zed/install.sh" --target "$ZED_OLD" --yes >/dev/null 2>&1
assert_absent "zed install: 旧版安装器建的只含 Tenon 块的 .rules 被删除" "$ZED_OLD/.rules"
assert_eq "zed install: 块移到 AGENTS.md" "1" "$(zed_blocks_in "$ZED_OLD" AGENTS.md)"
assert_contains "zed install: AGENTS.md 保留用户内容" "$(cat "$ZED_OLD/AGENTS.md")" "# 项目"
bash "$ADAPTERS/zed/install.sh" --target "$ZED_OLD" --yes >/dev/null 2>&1
assert_eq "zed install: 迁移后重装仍恰一份 ZED 块" "1" "$(zed_block_total "$ZED_OLD")"

# ════════════════════════════════════════════════════════════════════════════
# ⑨.7 变异测试（反例哨兵）：新架构形态（JSON-only 输出 / Node 插件）也要能被抓红，非空跑
# ════════════════════════════════════════════════════════════════════════════
# 变异 F：改坏 cline(A) 的 PreToolUse（恒放行）→ 判别器须报 ≠ baseline（会被 ⑨.4 抓红）
mkdir -p "$TMP/broken-cline"
cat > "$TMP/broken-cline/PreToolUse" <<'BROKEN'
#!/usr/bin/env bash
cat >/dev/null 2>&1
printf '{"cancel":false}\n'
BROKEN
chmod +x "$TMP/broken-cline/PreToolUse"
p="$(mk_proj mut-cline)"; touch "$p/.pipeline-pending-review"
b="$(baseline_veto "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}")"
json="$(printf '{"hookName":"PreToolUse","workspaceRoots":["%s"],"preToolUse":{"toolName":"Write","parameters":{}}}' "$p")"
broken_out="$(printf '%s' "$json" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$TMP/broken-cline/PreToolUse" 2>/dev/null)"
d="$(norm_veto cancel-json 0 "$broken_out")"
assert_eq "变异/cline: baseline 对新鲜 marker = DENY" DENY "$b"
assert_ne "变异/cline: 改坏的 PreToolUse（恒 cancel:false）被判别为 ≠ baseline → 抓红" "$b" "$d"

# 变异 G：改坏 amp(A) 的插件（tool.call 恒 allow）→ 判别器须报 ≠ baseline（会被 ⑨.5 抓红）
if [ "$HAVE_NODE" = 1 ]; then
  mkdir -p "$TMP/broken-amp"
  cat > "$TMP/broken-amp/pipeline.js" <<'BROKEN'
export function decideToolCall() { return { action: "allow" }; }
export function buildInjectContext() { return null; }
export function recordToolResult() {}
async function main() {
  const [, , mode, fnName, ...rest] = process.argv;
  if (mode !== "__test") return;
  const fns = { decideToolCall, buildInjectContext, recordToolResult };
  const fn = fns[fnName];
  const result = await fn(...rest);
  process.stdout.write(`${JSON.stringify(result === undefined ? null : result)}\n`);
}
if (process.argv[2] === "__test") { main(); }
BROKEN
  p="$(mk_proj mut-amp)"; touch "$p/.pipeline-pending-review"
  b="$(baseline_veto "{\"cwd\":\"$p\",\"tool_name\":\"Write\"}")"
  broken_out2="$(node "$TMP/broken-amp/pipeline.js" __test decideToolCall "$p" Write 2>/dev/null)"
  d2="$(norm_veto reject-and-continue 0 "$broken_out2")"
  assert_eq "变异/amp: baseline 对新鲜 marker = DENY" DENY "$b"
  assert_ne "变异/amp: 改坏的插件（tool.call 恒 allow）被判别为 ≠ baseline → 抓红" "$b" "$d2"
else
  printf 'SKIP - 变异/amp: 无 node，跳过（不计入 pass，也不误判——环境限制如实标注）\n'
fi

# 变异 H：改坏 aider(B) 的 track（post-commit 不写）→ 判别器须发现 history 未增
mkdir -p "$TMP/broken-aider"
cat > "$TMP/broken-aider/track.sh" <<'BROKEN'
#!/usr/bin/env bash
cat >/dev/null 2>&1
exit 0
BROKEN
chmod +x "$TMP/broken-aider/track.sh"
p="$(mk_change_proj mut-aider-track)"
printf '{"cwd":"%s"}' "$p" | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$TMP/broken-aider/track.sh" post-commit >/dev/null 2>&1 || true
if [ -f "$p/$HIST" ]; then bad "变异/aider: 改坏的 track（不写）被抓红" "history 竟被写了：$(cat "$p/$HIST")"
else ok "变异/aider: 改坏的 track（不写 history）被判别为红（history 未生成）"; fi

# ════════════════════════════════════════════════════════════════════════════
# ⑩ 原子落盘 + 诚实退出码（W2）
# ════════════════════════════════════════════════════════════════════════════
# 两个曾经静默的失效面，在这里变成机器约束：
#   ① 裸截断写：`sed ... > "$dst"` 写到一半被打断 → 宿主读到半个 JSON → 普遍 fail-open。
#      registry 承诺的 veto_failclosed 就这样无声消失，既无 receipt 也无报错。
#   ② 未生效却宣称成功：目标配置已存在时只旁挂 .pipeline-adapter，却仍 exit 0 打印「完成」。
#      叠加 ①，一次完全没生效的安装对用户零信号。
ATOMIC_LIB="$ADAPTERS/lib/atomic-write.sh"
assert_file "atomic: 共用原子落盘库存在（11 个适配器单一实现，加平台仍是填表）" "$ATOMIC_LIB"

ALL_INSTALLERS="aider amp cline codex continue copilot cursor devin gemini pi zed"
for id in $ALL_INSTALLERS; do
  inst="$ADAPTERS/$id/install.sh"
  if [ ! -f "$inst" ]; then bad "atomic/$id: install.sh 存在" "缺失：$inst"; continue; fi
  src="$(cat "$inst")"
  assert_contains "atomic/$id: 复用共用原子落盘库（不是第 12 份复制粘贴）" "$src" "lib/atomic-write.sh"
  assert_contains "atomic/$id: 命令失败即中止（set -e）" "$src" "set -euo pipefail"
  # 反漂移：模板渲染不得再直接重定向到目标（那正是 O_TRUNC 裸截断写）
  if printf '%s\n' "$src" | grep -qE '^[^#]*sed .*__(ADAPTER_DIR|TENON_ROOT)__.*> *"'; then
    bad "atomic/$id: 无裸截断写（sed 直接重定向到目标）" "仍存在 sed ... > \"目标\" 的截断写"
  else
    ok "atomic/$id: 无裸截断写（sed 直接重定向到目标）"
  fi
done

# ⑩.1 中断不留半个文件：暂存写到一半被 SIGTERM 打断，目标必须保持完整原样、暂存文件被清掉。
AT_DIR="$TMP/atomic-interrupt"
mkdir -p "$AT_DIR"
AT_ORIG='{"existing":"user hook config"}'
printf '%s\n' "$AT_ORIG" > "$AT_DIR/hooks.json"
cat > "$TMP/atomic-interrupt.sh" <<INTERRUPT_EOF
set -euo pipefail
. "$ATOMIC_LIB"
adapter_lib_init interrupt-probe
atomic_stage "$AT_DIR/hooks.json"
printf '{"hooks":{"preToolUse":[{"command":"bash /x/gate' > "\$ATOMIC_TMP"
kill -TERM \$\$
INTERRUPT_EOF
bash "$TMP/atomic-interrupt.sh" >/dev/null 2>&1 || true
assert_eq "atomic 中断：目标文件保持完整原样（不是半个 JSON）" "$AT_ORIG" "$(cat "$AT_DIR/hooks.json" 2>/dev/null)"
assert_eq "atomic 中断：暂存文件被 trap 清掉，不留残骸" "" \
  "$(find "$AT_DIR" -name '.tenon-adapter.*' 2>/dev/null | head -1)"

# ⑩.2 真 installer 路径：源模板本身是半个 JSON 时，既有目标必须零改动且非零退出
#     （fail-closed：宁可不装，也不能把半个 hook 注册铺到宿主上）。
BT="$TMP/broken-template"
mkdir -p "$BT/adapters/lib" "$BT/adapters/cursor" "$BT/target/.cursor"
cp "$ATOMIC_LIB" "$BT/adapters/lib/atomic-write.sh"
cp -R "$ADAPTERS/cursor/." "$BT/adapters/cursor/"
printf '%s' '{"hooks":{"preToolUse":[{"command":"bash /x/gate' > "$BT/adapters/cursor/hooks.json"
BT_ORIG='{"pipeline 适配器 hook 注册":"v1"}'
printf '%s\n' "$BT_ORIG" > "$BT/target/.cursor/hooks.json"
bt_out="$(bash "$BT/adapters/cursor/install.sh" --target "$BT/target" --yes 2>&1)" && bt_rc=0 || bt_rc=$?
assert_ne "atomic 半个模板：installer 非零退出（不宣称成功）" 0 "$bt_rc"
assert_eq "atomic 半个模板：既有 hooks.json 零改动（未被截断覆盖）" "$BT_ORIG" \
  "$(cat "$BT/target/.cursor/hooks.json" 2>/dev/null)"
assert_contains "atomic 半个模板：明说拒绝落盘的原因" "$bt_out" "不是合法 JSON"
assert_eq "atomic 半个模板：不留暂存文件残骸" "" \
  "$(find "$BT/target/.cursor" -name '.tenon-adapter.*' 2>/dev/null | head -1)"

# ⑩.3 已存在配置 → 只能旁挂 .pipeline-adapter = **未生效**：必须非零退出 + 明确说明
INST_OUT=""
INST_RC=0
run_installer() { INST_OUT="$("$@" 2>&1)" && INST_RC=0 || INST_RC=$?; }
assert_not_applied() { # <平台> <目标既有配置> <既有内容> <旁挂路径>
  local id="$1" existing="$2" original="$3" sidecar="$4"
  assert_ne "not-applied/$id: 未生效时非零退出（不再 exit 0 宣称完成）" 0 "$INST_RC"
  assert_contains "not-applied/$id: 输出明说「未生效」" "$INST_OUT" "未生效"
  assert_contains "not-applied/$id: 输出给出需人工合并的确切路径" "$INST_OUT" "需人工合并 $sidecar"
  assert_file "not-applied/$id: 旁挂建议文件真落地" "$sidecar"
  assert_eq "not-applied/$id: 用户既有配置零改动" "$original" "$(cat "$existing" 2>/dev/null)"
}

NA_MINE='{"mine":true}'

d="$TMP/na-cursor"; mkdir -p "$d/.cursor"; printf '%s\n' "$NA_MINE" > "$d/.cursor/hooks.json"
run_installer bash "$ADAPTERS/cursor/install.sh" --target "$d" --yes
assert_not_applied cursor "$d/.cursor/hooks.json" "$NA_MINE" "$d/.cursor/hooks.json.pipeline-adapter"

d="$TMP/na-gemini"; mkdir -p "$d/.gemini"; printf '%s\n' "$NA_MINE" > "$d/.gemini/settings.json"
run_installer bash "$ADAPTERS/gemini/install.sh" --target "$d" --gemini-home "$d/.gemini" --yes
assert_not_applied gemini "$d/.gemini/settings.json" "$NA_MINE" "$d/.gemini/settings.json.pipeline-adapter"
assert_not_contains "not-applied/gemini: 未生效时不打印「档 A 全保真完成」" "$INST_OUT" "档 A 全保真完成"

d="$TMP/na-continue"; mkdir -p "$d/.continue"; printf '%s\n' "$NA_MINE" > "$d/.continue/settings.json"
run_installer bash "$ADAPTERS/continue/install.sh" --target "$d" --continue-home "$d/.continue" --yes
assert_not_applied continue "$d/.continue/settings.json" "$NA_MINE" "$d/.continue/settings.json.pipeline-adapter"
assert_not_contains "not-applied/continue: 未生效时不打印「档 A 全保真完成」" "$INST_OUT" "档 A 全保真完成"

d="$TMP/na-pi"; mkdir -p "$d/.pi"; printf '%s\n' "$NA_MINE" > "$d/.pi/settings.json"
run_installer bash "$ADAPTERS/pi/install.sh" --target "$d" --pi-home "$d/.pi" --yes
assert_not_applied pi "$d/.pi/settings.json" "$NA_MINE" "$d/.pi/settings.json.pipeline-adapter"

d="$TMP/na-codex"; mkdir -p "$d/target" "$d/home"; printf '%s\n' "$NA_MINE" > "$d/home/hooks.json"
run_installer bash "$ADAPTERS/codex/install.sh" --target "$d/target" --codex-home "$d/home" --yes
assert_not_applied codex "$d/home/hooks.json" "$NA_MINE" "$d/home/hooks.json.pipeline-adapter"
assert_not_contains "not-applied/codex: 未生效时不打印一次性 trust 指引（还没东西可 trust）" "$INST_OUT" "还差一步（一次性 trust）"

d="$TMP/na-amp"; mkdir -p "$d/.amp/plugins"; printf '%s\n' 'export default function(){}' > "$d/.amp/plugins/pipeline.js"
run_installer bash "$ADAPTERS/amp/install.sh" --target "$d" --yes
assert_not_applied amp "$d/.amp/plugins/pipeline.js" 'export default function(){}' "$d/.amp/plugins/pipeline.js.pipeline-adapter"
assert_not_contains "not-applied/amp: 未生效时不打印「档 A 完成」" "$INST_OUT" "档 A 完成"

d="$TMP/na-cline"; mkdir -p "$d/.clinerules/hooks"; printf '%s\n' '#!/bin/sh' > "$d/.clinerules/hooks/PreToolUse"
run_installer bash "$ADAPTERS/cline/install.sh" --target "$d" --yes
assert_not_applied cline "$d/.clinerules/hooks/PreToolUse" '#!/bin/sh' "$d/.clinerules/hooks/PreToolUse.pipeline-adapter"
assert_not_contains "not-applied/cline: 未生效时不打印「档 A 完成」" "$INST_OUT" "档 A 完成"

d="$TMP/na-aider"; mkdir -p "$d"; printf '%s\n' 'model: gpt-4o' > "$d/.aider.conf.yml"
run_installer env CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ADAPTERS/aider/install.sh" --target "$d" --no-git-hooks --yes
assert_not_applied aider "$d/.aider.conf.yml" 'model: gpt-4o' "$d/.aider.conf.yml.pipeline-adapter"
assert_not_contains "not-applied/aider: 未生效时不打印「档 B 完成」" "$INST_OUT" "档 B 完成"

# ⑩.4 copilot dual hookContainer：只写成一份时必须如实报份数（旧版无条件说「两份都已写」）
assert_not_contains "copilot: install.sh 不再无条件宣称「两份都已写」" \
  "$(cat "$ADAPTERS/copilot/install.sh")" "两份都已写"
d="$TMP/na-copilot"; mkdir -p "$d/.github/copilot"; printf '%s\n' "$NA_MINE" > "$d/.github/copilot/hooks.json"
run_installer bash "$ADAPTERS/copilot/install.sh" --target "$d" --yes
assert_not_applied copilot "$d/.github/copilot/hooks.json" "$NA_MINE" "$d/.github/copilot/hooks.json.pipeline-adapter"
assert_contains "not-applied/copilot: 如实报实际写入份数（1/2，不是「两份都已写」）" "$INST_OUT" "1/2"
assert_not_contains "not-applied/copilot: 未生效时不打印「档 B 完成」" "$INST_OUT" "档 B 完成"
assert_file "not-applied/copilot: 另一份 hookContainer 仍真写入" "$d/.github/hooks/tenon.json"

# ⑩.5 干净目标：三档正常路径仍必须 exit 0 并如实打印完成（诚实是双向的，不许一律报错）
d="$TMP/clean-cursor"; run_installer bash "$ADAPTERS/cursor/install.sh" --target "$d" --yes
assert_eq "clean/cursor: 全部接管时 exit 0" 0 "$INST_RC"
d="$TMP/clean-gemini"; run_installer bash "$ADAPTERS/gemini/install.sh" --target "$d" --gemini-home "$d/.gemini" --yes
assert_eq "clean/gemini: 全部接管时 exit 0" 0 "$INST_RC"
assert_contains "clean/gemini: 真接管时才打印「档 A 全保真完成」" "$INST_OUT" "档 A 全保真完成"
d="$TMP/clean-continue"; run_installer bash "$ADAPTERS/continue/install.sh" --target "$d" --continue-home "$d/.continue" --yes
assert_eq "clean/continue: 全部接管时 exit 0" 0 "$INST_RC"
d="$TMP/clean-pi"; run_installer bash "$ADAPTERS/pi/install.sh" --target "$d" --pi-home "$d/.pi" --yes
assert_eq "clean/pi: 全部接管时 exit 0" 0 "$INST_RC"
d="$TMP/clean-copilot"; run_installer bash "$ADAPTERS/copilot/install.sh" --target "$d" --yes
assert_eq "clean/copilot: 全部接管时 exit 0" 0 "$INST_RC"
assert_contains "clean/copilot: 两份 hookContainer 齐全时如实报 2/2" "$INST_OUT" "2/2"
d="$TMP/clean-zed"; run_installer bash "$ADAPTERS/zed/install.sh" --target "$d" --yes
assert_eq "clean/zed: 档 C 静态层落地后 exit 0" 0 "$INST_RC"
d="$TMP/clean-devin"; run_installer bash "$ADAPTERS/devin/install.sh" --target "$d" --yes
assert_eq "clean/devin: 档 C 静态层落地后 exit 0" 0 "$INST_RC"

# ════════════════════════════════════════════════════════════════════════════
# ⑪ 顶层派发器 adapters/install.sh：交给 installer 的参数列表必须逐字正确
# ════════════════════════════════════════════════════════════════════════════
# 病灶：空数组在 `set -u` 下的经典陷阱。`"${extra[@]:-}"` 当 extra 为空时展开出的不是
# 零个参数，而是**一个空字符串参数**——被派发的 installer 立刻 `未知参数:` 并 exit 2。
# 后果：不带 --yes 的 `adapters/install.sh --<platform>` 全平台端到端坏掉（顶层派发器，
# 所有平台都走它），而单跑 adapters/<id>/install.sh 却全绿，单测层看不见。
# 这里用「录参 stub installer」把派发出去的 argv 逐字钉死：不带 --yes 必须只有两个参数。
DP="$TMP/dispatch"
mkdir -p "$DP/adapters" "$DP/stub"
cp "$ADAPTERS/install.sh" "$DP/adapters/install.sh"   # 真派发器逐字副本（registry 换成 stub）
cat > "$DP/adapters/registry.yaml" <<'DP_REG_EOF'
platforms:
  - id: stub
    cliFlag: stub
    tier: A
    configure: stub/record.sh
  - id: stub2
    cliFlag: stub2
    tier: A
    configure: stub/record2.sh
DP_REG_EOF
# stub installer：逐字录下收到的 argv，并与真 installer 同样严格（空/未知参数即 exit 2）
cat > "$DP/stub/record.sh" <<'DP_STUB_EOF'
#!/usr/bin/env bash
set -u
: > "$RECORD_OUT"
printf 'argc=%s\n' "$#" >> "$RECORD_OUT"
for a in "$@"; do printf '[%s]\n' "$a" >> "$RECORD_OUT"; done
while [ $# -gt 0 ]; do
  case "$1" in
    --target) shift; shift ;;
    --yes|-y) shift ;;
    *) printf '未知参数: %s\n' "$1" >&2; exit 2 ;;
  esac
done
exit 0
DP_STUB_EOF
sed 's/RECORD_OUT/RECORD_OUT2/g' "$DP/stub/record.sh" > "$DP/stub/record2.sh"

DP_TARGET="$DP/dispatch target"   # 带空格：顺带钉死引号未被拆词
mkdir -p "$DP_TARGET"
dispatch() { # <RECORD_OUT> <install.sh 参数...>
  local out="$1"; shift
  rm -f "$out" "$out.2"
  DP_OUT="$(RECORD_OUT="$out" RECORD_OUT2="$out.2" bash "$DP/adapters/install.sh" "$@" 2>&1)" \
    && DP_RC=0 || DP_RC=$?
}

# ⑪.1 不带 --yes（默认交互式）：installer 必须只收到 --target <dir>，不得多出空参数
dispatch "$DP/args" --stub --target "$DP_TARGET"
assert_eq "dispatch/无 --yes: 派发器 exit 0（空数组没被展开成空参数）" 0 "$DP_RC"
assert_not_contains "dispatch/无 --yes: installer 未因空参数报「未知参数」" "$DP_OUT" "未知参数"
assert_eq "dispatch/无 --yes: installer 收到的参数逐字正确（argc=2，无空参数）" \
  "argc=2
[--target]
[$DP_TARGET]" "$(cat "$DP/args" 2>/dev/null)"

# ⑪.2 带 --yes：行为不变，--yes 原样透传（且仍无多余空参数）
dispatch "$DP/args-yes" --stub --target "$DP_TARGET" --yes
assert_eq "dispatch/带 --yes: 派发器 exit 0" 0 "$DP_RC"
assert_eq "dispatch/带 --yes: --yes 原样透传（argc=3）" \
  "argc=3
[--target]
[$DP_TARGET]
[--yes]" "$(cat "$DP/args-yes" 2>/dev/null)"

# ⑪.3 多平台一次派发：每个 installer 各自收到完整且正确的参数列表
dispatch "$DP/args-multi" --stub --stub2 --target "$DP_TARGET"
assert_eq "dispatch/多平台: 全部成功 exit 0" 0 "$DP_RC"
assert_eq "dispatch/多平台: 平台 1 参数逐字正确" \
  "argc=2
[--target]
[$DP_TARGET]" "$(cat "$DP/args-multi" 2>/dev/null)"
assert_eq "dispatch/多平台: 平台 2 参数逐字正确" \
  "argc=2
[--target]
[$DP_TARGET]" "$(cat "$DP/args-multi.2" 2>/dev/null)"

# ⑪.4 反漂移（源码级）：代码行不得再用 `[@]:-}` 这类会凭空造出空参数的展开（注释里可解释）
if printf '%s\n' "$(sed 's/#.*//' "$ADAPTERS/install.sh")" | grep -q '\[@\]:-}'; then
  bad "dispatch: install.sh 代码行不再用 \${arr[@]:-}（空数组会展开成空参数）" \
    "仍存在 [@]:-} 展开；空数组应写 \${arr[@]+\"\${arr[@]}\"}"
else
  ok "dispatch: install.sh 代码行不再用 \${arr[@]:-}（空数组会展开成空参数）"
fi

# ⑪.5 同类陷阱面：未选平台时必须是友好 exit 2，而不是 set -u 的 unbound variable
dispatch "$DP/args-none" --target "$DP_TARGET"
assert_eq "dispatch/未选平台: exit 2" 2 "$DP_RC"
assert_contains "dispatch/未选平台: 给出可操作提示" "$DP_OUT" "未选平台"
assert_not_contains "dispatch/未选平台: 不炸 unbound variable（空数组展开安全）" "$DP_OUT" "unbound variable"

# ⑪.6 真派发器对真 installer 的端到端：不带 --yes 也必须真装上（不是只测 stub）
DP_REAL="$TMP/dispatch-real"
mkdir -p "$DP_REAL"
DP_REAL_OUT="$(bash "$ADAPTERS/install.sh" --cursor --target "$DP_REAL" 2>&1)" && DP_REAL_RC=0 || DP_REAL_RC=$?
assert_eq "dispatch/端到端 cursor 无 --yes: exit 0" 0 "$DP_REAL_RC"
assert_not_contains "dispatch/端到端 cursor 无 --yes: 无「未知参数」" "$DP_REAL_OUT" "未知参数"
assert_file "dispatch/端到端 cursor 无 --yes: hooks.json 真落地" "$DP_REAL/.cursor/hooks.json"

# ════════════════════════════════════════════════════════════════════════════
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
