#!/usr/bin/env bash
# test-bundle.sh — esbuild 单文件分发冒烟（BACKLOG #8）。
# 断言：
#   1. CLI/dashboard server/SPA 三组发布产物存在（npm run build 产出）
#   2. CLI 单文件自足：不 import 'commander'/@tenon（全部内联），只留 node: 内建
#   3. CLI 能从打包根发现 dashboard 并通过 dry-run 验证，不依赖 npm/npx/node_modules
#   4. 端到端上手路径：临时目录 init → .pipeline.yaml 落盘 → get phase = open
#      → 登记随 init 生成的 OpenSpec proposal/design/tasks 的真实 skill 证据
#      → transition open-complete → get phase = explore → history JSONL 有 init+transition
#   5. 冻结 N-1 reader 保持旧写入协议；fixture 固定的真实上一正式版本（CLI 字节按 digest 钉死）双向验证：
#      N-1 创建/写入的 Change 由当前 CLI 读取并继续 mutation；当前 CLI 写入的 Change 由 N-1 CLI 读取并继续
#      mutation；skills/skills.lock.json 当前 writer → N-1 verifier、N-1 writer → 当前 verifier 都必须通过
#      （fixture status=none 时只报告 [HONEST SKIP]）。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/packages/cli/dist/tenon.mjs"
DASHBOARD_SERVER="$ROOT/packages/server/dist/dashboard.mjs"
DASHBOARD_INDEX="$ROOT/packages/dashboard-app/dist/index.html"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL - %s（%s）\n' "$1" "${2:-}"; }

# 1. 产物存在 + shebang
if [ -f "$BUNDLE" ]; then ok "bundle: tenon.mjs 存在"; else bad "bundle: tenon.mjs 存在" "先 npm run build"; fi
if [ -f "$BUNDLE" ] && head -1 "$BUNDLE" | grep -q '^#!/usr/bin/env node'; then
  ok "bundle: 首行 shebang"
else bad "bundle: 首行 shebang" "$(head -1 "$BUNDLE" 2>/dev/null || echo 缺文件)"; fi
[ -f "$DASHBOARD_SERVER" ] && ok "bundle: dashboard.mjs 存在" \
  || bad "bundle: dashboard.mjs 存在" "先 npm run build"
[ -f "$DASHBOARD_INDEX" ] && ok "bundle: dashboard SPA index.html 存在" \
  || bad "bundle: dashboard SPA index.html 存在" "先 npm run build"
for asset in \
  templates/documents/registry.v1.yaml \
  templates/documents/locales/zh-CN.yaml \
  templates/documents/locales/en.yaml \
  templates/documents/schemas/registry.v1.schema.json; do
  [ -f "$ROOT/$asset" ] && ok "bundle: $asset 存在" \
    || bad "bundle: $asset 存在" "治理文档 Registry 必须随完整插件发布"
done
plugin_runtime_spec="$ROOT/openspec/changes/fix-tenon-entry-skill-contract/specs/plugin-runtime/spec.md"
if [ ! -f "$plugin_runtime_spec" ]; then
  plugin_runtime_spec="$ROOT/openspec/specs/plugin-runtime/spec.md"
fi
review_budget_spec="$ROOT/openspec/changes/versioned-release-install-lifecycle-20260808/specs/review-attempt-budget/spec.md"
if [ ! -f "$review_budget_spec" ]; then
  review_budget_spec="$ROOT/openspec/specs/review-attempt-budget/spec.md"
fi
grep -q 'Build pre-Verify readiness 门' "$ROOT/docs/CONTRACT.md" \
  && grep -q 'Critical/High/Medium 全部清零' "$ROOT/docs/CONTRACT.md" \
  && grep -q '同一候选的一轮复核 SHALL 只有一个 attempt' "$review_budget_spec" \
  && grep -q 'Review 预算耗尽 SHALL 停止自动循环' "$review_budget_spec" \
  && ok "bundle: Build 实现反馈与有限聚合 Review 边界闭环" \
  || bad "bundle: Build 实现反馈与有限聚合 Review 边界闭环" "治理契约或 Review budget delta 未闭环"
grep -q 'repo-zero-output' "$plugin_runtime_spec" \
  && grep -q 'canonical `verification_report`.*唯一例外' "$plugin_runtime_spec" \
  && ok "bundle: Build/Verify 冻结交接强制零写入、外置产物与逐轨指纹" \
  || bad "bundle: Build/Verify 冻结交接强制零写入、外置产物与逐轨指纹" "冻结验证约束缺失"
# 内建 agent 在 templates/agents/ 下（插件根 agents/ 会被宿主自动加载，任务级 agent 不能进那里）。
builtin_agents="$ROOT/templates/agents"
missing_agents=""
for agent in architecture backend-quality builder code-size e2e frontend-quality researcher security spec-consistency; do
  [ -f "$builtin_agents/$agent.md" ] || missing_agents="$missing_agents $agent"
done
[ -z "$missing_agents" ] && [ ! -d "$ROOT/agents" ] \
  && grep -q '只读' "$builtin_agents/backend-quality.md" \
  && grep -q 'tenon-result' "$builtin_agents/frontend-quality.md" \
  && grep -q '只能写仓库外临时目录' "$builtin_agents/e2e.md" \
  && ok "bundle: 内建 agent 在 templates/agents/ 且插件根无 agents/" \
  || bad "bundle: 内建 agent 在 templates/agents/ 且插件根无 agents/" "缺$missing_agents 或插件根仍有 agents/"

# 2. 自足性：不残留对 npm 包的运行时 import（node: 内建豁免）
if [ -f "$BUNDLE" ]; then
  leftover="$(grep -Eo 'from *"(commander|@tenon/[a-z]+)"' "$BUNDLE" | head -3 || true)"
  if [ -z "$leftover" ]; then ok "bundle: commander/@tenon 已内联"; else bad "bundle: commander/@tenon 已内联" "$leftover"; fi
fi

# 3. `tenon dashboard` 必须从同一个发布包找到 server + SPA，不能再回退到 npx 或源码 build。
if [ -f "$BUNDLE" ] && [ -f "$DASHBOARD_SERVER" ] && [ -f "$DASHBOARD_INDEX" ]; then
  dashboard_out="$(node "$BUNDLE" dashboard --dry-run 2>&1)"
  if [ "$?" -eq 0 ] && printf '%s' "$dashboard_out" | grep -q '插件内置 SPA + server bundle'; then
    ok "bundle: tenon dashboard --dry-run 使用随包完整 runtime"
  else
    bad "bundle: tenon dashboard --dry-run 使用随包完整 runtime" "$dashboard_out"
  fi
fi

# 3b. The shipped bundle must exercise the real Commander/buildProgram scorecard path, not only
# the source command unit seam.
if [ -f "$BUNDLE" ]; then
  interaction_fixture_dir="$ROOT/tools/fixtures/interaction-events/v1"
  interaction_scorecard_out="$(node "$BUNDLE" interaction scorecard "$interaction_fixture_dir" --json 2>&1)"
  if [ "$?" -eq 0 ] && printf '%s' "$interaction_scorecard_out" \
    | grep -q 'tenon-interaction-scorecard/v1' \
    && ! printf '%s' "$interaction_scorecard_out" | grep -q "$interaction_fixture_dir"; then
    ok "bundle: interaction scorecard 真实 CLI 路径"
  else
    bad "bundle: interaction scorecard 真实 CLI 路径" "$interaction_scorecard_out"
  fi
fi

# 4. 端到端上手路径（真跑 bundle）
if [ -f "$BUNDLE" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  # 声明身份对每一次 bundle 调用都必需（写操作要求身份）；CI runner 没有 git 身份，逐条注入会漏。
  export TENON_USER=smoke@tenon.test
  export TENON_USER_NAME=smoke
  # 每一次 bundle 调用（当前与 N-1）都落在临时 runtime home，绝不读写本机真实 Tenon state。
  export TENON_RUNTIME_HOME="$TMP/.tenon-runtime-home"
  ( cd "$TMP" && TENON_RUNTIME_HOME="$TMP/.tenon-runtime-home" node "$BUNDLE" init t8-smoke --track backend --preset full ) 2>/dev/null
  [ -f "$TMP/openspec/changes/t8-smoke/.pipeline.yaml" ] \
    && ok "bundle: init 落盘 .pipeline.yaml" || bad "bundle: init 落盘 .pipeline.yaml" "文件缺失"
  grep -q '"locale":"zh-CN"' "$TMP/openspec/changes/t8-smoke/.pipeline-document-locale.json" \
    && ! grep -q '^pipeline_document_locale:' "$TMP/openspec/changes/t8-smoke/.pipeline.yaml" \
    && ok "bundle: 新 Change 以回滚兼容 sidecar 固定中文文档语言" \
    || bad "bundle: 新 Change 以回滚兼容 sidecar 固定中文文档语言" "sidecar 缺失或 locale 泄漏到 canonical projection"
  grep -q '^# 提案$' "$TMP/openspec/changes/t8-smoke/proposal.md" \
    && ok "bundle: 默认 proposal 使用中文模板" \
    || bad "bundle: 默认 proposal 使用中文模板" "$(head -1 "$TMP/openspec/changes/t8-smoke/proposal.md" 2>/dev/null)"
  phase="$(cd "$TMP" && node "$BUNDLE" get t8-smoke phase 2>/dev/null)"
  [ "$phase" = "open" ] && ok "bundle: get phase = open" || bad "bundle: get phase = open" "得到 '$phase'"
  ( cd "$TMP" && node "$BUNDLE" set t8-smoke pre_verify_review_result pass ) >/dev/null 2>&1
  pre_verify="$(cd "$TMP" && node "$BUNDLE" get t8-smoke pre_verify_review_result 2>/dev/null)"
  [ "$pre_verify" = "pass" ] \
    && ok "bundle: companion-backed pre-Verify pass 可读" \
    || bad "bundle: companion-backed pre-Verify pass 可读" "得到 '$pre_verify'"
  ( cd "$TMP" && node "$BUNDLE" set t8-smoke scope current-after-pass ) >/dev/null 2>&1
  scope="$(cd "$TMP" && node "$BUNDLE" get t8-smoke scope 2>/dev/null)"
  [ "$scope" = "current-after-pass" ] \
    && ok "bundle: pre-Verify pass 后下一次 mutation 可提交" \
    || bad "bundle: pre-Verify pass 后下一次 mutation 可提交" "得到 '$scope'"

  # Evidence is intentionally attached only after an explicit target selection.  This is the same
  # `pipeline` entry-skill sequence used by normal conversations, and prevents an mtime-selected
  # old Change from satisfying this new bundle smoke Change.
  ( cd "$TMP" && node "$BUNDLE" session activate t8-smoke ) >/dev/null 2>&1
  [ "$?" -eq 0 ] \
    && ok "bundle: session activate 绑定 t8-smoke" \
    || bad "bundle: session activate 绑定 t8-smoke" "activate 失败"

  tasks_path="$TMP/openspec/changes/t8-smoke/tasks.md"
  node -e '
    const fs = require("node:fs")
    const path = process.argv[1]
    const raw = fs.readFileSync(path, "utf8")
    const completed = raw.replace("- [ ] ", "- [x] ")
    if (completed === raw) process.exit(2)
    fs.writeFileSync(path, completed, "utf8")
  ' "$tasks_path"
  [ "$?" -eq 0 ] \
    && ok "bundle: open 阶段 Todo 已完成" \
    || bad "bundle: open 阶段 Todo 已完成" "未找到可勾选的 open 任务"

  # 每次进入步骤都要重新加载唯一的 tenon skill；通过同一个真实 PostToolUse
  # skill tracker 记录它，保持 open-complete 的 workflow-skill enforcement fail-closed。
  printf '{"cwd":"%s","tool_name":"Skill","skill":"tenon","session_id":"bundle-smoke-session","tool_use_id":"bundle-smoke-tenon"}' "$TMP" \
    | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ROOT/hooks/skill-tracker.sh" >/dev/null 2>&1
  [ "$?" -eq 0 ] \
    && ok "bundle: hook 记录 tenon 调用证据" \
    || bad "bundle: hook 记录 tenon 调用证据" "skill-tracker 失败"

  # default workflow 的 OpenSpec 文档契约要求 open 阶段先登记 proposal/design/tasks。它们是 init
  # 创建的最小骨架；这里通过真实 CLI 绑定产物 hash 和 openspec-propose skill 证据，证明入库 bundle
  # 同时包含新文档链路，而不是把冒烟测试回退成历史上的无证据直转。先调用同包的 PostToolUse
  # skill tracker 生成真实的 `Skill: openspec-propose` 审计行；document record 会验证这条证据。
  printf '{"cwd":"%s","tool_name":"Skill","skill":"openspec-propose","session_id":"bundle-smoke-session","tool_use_id":"bundle-smoke-openspec-propose"}' "$TMP" \
    | CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ROOT/hooks/skill-tracker.sh" >/dev/null 2>&1
  [ "$?" -eq 0 ] \
    && ok "bundle: hook 记录 openspec-propose 调用证据" \
    || bad "bundle: hook 记录 openspec-propose 调用证据" "skill-tracker 失败"
  for row in \
    'proposal proposal.md' \
    'openspec-design design.md' \
    'tasks tasks.md'; do
    kind="${row%% *}"
    file="${row#* }"
    ( cd "$TMP" && node "$BUNDLE" document record t8-smoke "$kind" "openspec/changes/t8-smoke/$file" --producer openspec-propose ) 2>/dev/null
    [ "$?" -eq 0 ] \
      && ok "bundle: 登记 $kind 文档证据" \
      || bad "bundle: 登记 $kind 文档证据" "document record 失败"
  done
  ( cd "$TMP" && node "$BUNDLE" transition t8-smoke open-complete ) 2>"$TMP/transition.err"
  phase="$(cd "$TMP" && node "$BUNDLE" get t8-smoke phase 2>/dev/null)"
  [ "$phase" = "explore" ] && ok "bundle: transition 后 phase = explore" || bad "bundle: transition 后 phase = explore" "得到 '$phase'; $(cat "$TMP/transition.err" 2>/dev/null)"
  hist="$TMP/openspec/changes/t8-smoke/.pipeline-history.jsonl"
  if [ -f "$hist" ] && grep -q '"kind":"init"' "$hist" && grep -q '"kind":"transition"' "$hist"; then
    ok "bundle: history JSONL 记 init+transition"
  else bad "bundle: history JSONL 记 init+transition" "$(cat "$hist" 2>/dev/null | head -2 || echo 缺文件)"; fi

  # 5. N-1 兼容。冻结 reader 是可离线、可重复的硬门；真实 previous runtime 是可用时的第二证据，
  # 不把某台开发机的 managed cache 变成 CI 前置条件。
  current_json="$TMP/openspec/changes/t8-smoke/.pipeline-run/current.json"
  n_minus_phase="$(node "$ROOT/tools/fixtures/n-minus-one-canonical-reader.mjs" "$current_json" 2>&1)"
  [ "$?" -eq 0 ] && [ "$n_minus_phase" = "explore" ] \
    && ok "bundle: 冻结 N-1 严格读取器可读当前 canonical Change" \
    || bad "bundle: 冻结 N-1 严格读取器可读当前 canonical Change" "$n_minus_phase"

  n_minus_meta="$ROOT/tools/fixtures/n-minus-one-release.json"
  n_minus_status="$(node -p "require('$n_minus_meta').status" 2>/dev/null || true)"
  explicit_n_minus_cli="${TENON_N_MINUS_ONE_CLI:-}"
  explicit_n_minus_payload="${TENON_N_MINUS_ONE_PAYLOAD:-}"
  N_MINUS_PAYLOAD=""
  if [ "$n_minus_status" = none ]; then
    # 只有 fixture 声明的一次性跳过（prepare 退出 78）不计通过也不计失败；显式 N-1 入口与之矛盾。
    if [ -n "$explicit_n_minus_cli" ] || [ -n "$explicit_n_minus_payload" ]; then
      bad "bundle: N-1 fixture 与显式入口一致" "fixture status=none 却设置了 TENON_N_MINUS_ONE_CLI/PAYLOAD"
    else
      n_minus_skip="$(bash "$ROOT/tools/prepare-n-minus-one-release.sh" "$TMP/n-minus-one-release" 2>&1)"
      n_minus_skip_code="$?"
      if [ "$n_minus_skip_code" -eq 78 ]; then
        printf '[HONEST SKIP] bundle: 真实 N-1 兼容：%s\n' "$(node -p "require('$n_minus_meta').reason")"
      else
        bad "bundle: N-1 一次性跳过有效" "exit=$n_minus_skip_code $n_minus_skip"
      fi
    fi
  else
    if [ -n "$explicit_n_minus_cli" ] && [ -n "$explicit_n_minus_payload" ]; then
      bad "bundle: N-1 显式入口唯一" "TENON_N_MINUS_ONE_CLI 与 TENON_N_MINUS_ONE_PAYLOAD 不得同时设置"
    elif [ -n "$explicit_n_minus_payload" ]; then
      n_minus_cli_entry="$(node -e '
        const value = require(process.argv[1])
        const entry = value.cliEntry
        if (
          typeof entry !== "string" ||
          entry === "" ||
          entry.startsWith("/") ||
          entry.split("/").includes("..")
        ) process.exit(2)
        process.stdout.write(entry)
      ' "$n_minus_meta" 2>/dev/null || true)"
      if [ -z "$n_minus_cli_entry" ]; then
        bad "bundle: N-1 fixture CLI 入口合法" "$n_minus_meta"
      else
        explicit_n_minus_cli="$explicit_n_minus_payload/$n_minus_cli_entry"
        N_MINUS_PAYLOAD="$explicit_n_minus_payload"
      fi
    elif [ -n "$explicit_n_minus_cli" ]; then
      # 只给了 CLI：它必须位于完整 payload 的 cliEntry 处，skill lock 门要用同一 payload 里的 verifier 根。
      N_MINUS_PAYLOAD="${explicit_n_minus_cli%/"$(node -p "require('$n_minus_meta').cliEntry")"}"
    fi
    n_minus_tag="$(node -p "require('$n_minus_meta').tag" 2>/dev/null || true)"
    if [ -z "$explicit_n_minus_cli" ]; then
      prepared_n_minus="$TMP/n-minus-one-release"
      if bash "$ROOT/tools/prepare-n-minus-one-release.sh" "$prepared_n_minus" >/dev/null; then
        n_minus_cli_entry="$(node -p "require('$n_minus_meta').cliEntry")"
        explicit_n_minus_cli="$prepared_n_minus/payload/$n_minus_cli_entry"
        N_MINUS_PAYLOAD="$prepared_n_minus/payload"
      else
        bad "bundle: 固定公开 N-1 payload 可准备" "${n_minus_tag:-N-1} tag/commit/完整 payload 缺失"
      fi
    fi
    N_MINUS_CLI="$explicit_n_minus_cli"
    expected_n_minus_digest="$(node -p "require('$n_minus_meta').cliSha256")"
    actual_n_minus_digest="$(node -e '
      const { createHash } = require("node:crypto")
      const { readFileSync } = require("node:fs")
      try { process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex")) }
      catch { process.exit(2) }
    ' "$N_MINUS_CLI" 2>/dev/null || true)"
    [ "$actual_n_minus_digest" = "$expected_n_minus_digest" ] \
      && ok "bundle: 固定公开 N-1 CLI digest 精确" \
      || bad "bundle: 固定公开 N-1 CLI digest 精确" \
        "expected=$expected_n_minus_digest actual=${actual_n_minus_digest:-missing}"
    if [ -n "$explicit_n_minus_cli" ] && [ ! -f "$explicit_n_minus_cli" ]; then
      bad "bundle: 显式 N-1 bundle 存在" "$explicit_n_minus_cli"
    elif [ -n "$N_MINUS_CLI" ] && [ -f "$N_MINUS_CLI" ]; then
      n_minus_release="${TENON_N_MINUS_ONE_RELEASE:-$n_minus_tag}"
      n_minus_change="n1-created"
      # 0.x 的 init 没有 --user；身份走上面导出的 TENON_USER。同一身份让当前 runtime 能接续写，
      # 否则 owner guard 会先拒（那是所有权语义，不是跨版本兼容）。
      n_minus_init="$(cd "$TMP" && node "$N_MINUS_CLI" init "$n_minus_change" --track backend --preset full 2>&1)"
      n_minus_init_code="$?"
      n_minus_real="$(cd "$TMP" && node "$N_MINUS_CLI" status "$n_minus_change" --json 2>&1)"
      n_minus_status_code="$?"
      [ "$n_minus_init_code" -eq 0 ] && [ "$n_minus_status_code" -eq 0 ] \
        && printf '%s' "$n_minus_real" | grep -q '"phase":"open"' \
        && ok "bundle: 真实上一发行版 CLI（${n_minus_release}）创建并读取 legacy Change" \
        || bad "bundle: 真实上一发行版 CLI（${n_minus_release}）创建并读取 legacy Change" \
          "init=$n_minus_init_code $n_minus_init status=$n_minus_real"
      n_minus_write="$(cd "$TMP" && node "$N_MINUS_CLI" set "$n_minus_change" scope n1-compatible 2>&1)"
      n_minus_write_code="$?"
      n_minus_scope="$(cd "$TMP" && node "$BUNDLE" get "$n_minus_change" scope 2>/dev/null)"
      [ "$n_minus_write_code" -eq 0 ] && [ "$n_minus_scope" = "n1-compatible" ] \
        && ok "bundle: 当前 runtime 可读真实 N-1 mutation" \
        || bad "bundle: 当前 runtime 可读真实 N-1 mutation" \
          "exit=$n_minus_write_code scope=$n_minus_scope $n_minus_write"
      ( cd "$TMP" && node "$BUNDLE" set "$n_minus_change" related_files current-after-n1 ) >/dev/null 2>&1
      after_n_minus_current="$(cd "$TMP" && node "$BUNDLE" get "$n_minus_change" related_files 2>/dev/null)"
      [ "$after_n_minus_current" = "current-after-n1" ] \
        && ok "bundle: 当前 runtime 可接续 N-1 V1/V2 snapshot 后 mutation" \
        || bad "bundle: 当前 runtime 可接续 N-1 stale anchor 后 mutation" \
          "得到 '$after_n_minus_current'"

      # 5b. 反方向：冻结的 N-1 CLI 读当前 runtime 创建并推进（open → explore）的 Change，
      # 并在其上继续写；当前 runtime 再读回。回滚到 N-1 的机器会遇到的正是这份 state。
      n_minus_reads_current="$(cd "$TMP" && TENON_RUNTIME_HOME="$TMP/.tenon-runtime-home" \
        node "$N_MINUS_CLI" get t8-smoke phase 2>&1)"
      n_minus_reads_current_code="$?"
      n_minus_status_current="$(cd "$TMP" && TENON_RUNTIME_HOME="$TMP/.tenon-runtime-home" \
        node "$N_MINUS_CLI" status t8-smoke --json 2>&1)"
      n_minus_status_current_code="$?"
      [ "$n_minus_reads_current_code" -eq 0 ] && [ "$n_minus_reads_current" = "explore" ] \
        && [ "$n_minus_status_current_code" -eq 0 ] \
        && printf '%s' "$n_minus_status_current" | grep -q '"phase":"explore"' \
        && ok "bundle: N-1 CLI（${n_minus_release}）读取当前 runtime 写入的 Change" \
        || bad "bundle: N-1 CLI（${n_minus_release}）读取当前 runtime 写入的 Change" \
          "get=$n_minus_reads_current_code '$n_minus_reads_current' status=$n_minus_status_current_code $n_minus_status_current"
      n_minus_over_current="$(cd "$TMP" && TENON_RUNTIME_HOME="$TMP/.tenon-runtime-home" \
        node "$N_MINUS_CLI" set t8-smoke scope n1-after-current 2>&1)"
      n_minus_over_current_code="$?"
      current_after_n_minus="$(cd "$TMP" && node "$BUNDLE" get t8-smoke scope 2>/dev/null)"
      [ "$n_minus_over_current_code" -eq 0 ] && [ "$current_after_n_minus" = "n1-after-current" ] \
        && ok "bundle: N-1 CLI 可在当前 runtime 写入的 Change 上继续 mutation" \
        || bad "bundle: N-1 CLI 可在当前 runtime 写入的 Change 上继续 mutation" \
          "exit=$n_minus_over_current_code scope='$current_after_n_minus' $n_minus_over_current"

      # 5c. skills/skills.lock.json 是跨年龄线格式：升级时当前 fetcher 写、候选根里的 verifier 读，
      # 回滚时反过来。两个方向都用真实 CLI（internal-skill-upstream fetch → internal-skill-provenance
      # verify），上游仓库是本地 git fixture，经隔离 HOME 下的 insteadOf 改写 github.com，不联网。
      if [ -z "$N_MINUS_PAYLOAD" ] || [ ! -f "$N_MINUS_PAYLOAD/templates/skill-sources.yaml" ]; then
        bad "bundle: N-1 payload 可做 skill lock 验证根" "${N_MINUS_PAYLOAD:-未知}"
      else
        lock_hub="$TMP/n1-lock-hub"
        lock_repo="$lock_hub/n1-fixture/skills.git"
        mkdir -p "$lock_repo/skills/n1-probe" "$TMP/n1-lock-home"
        printf -- '---\nname: n1-probe\ndescription: N-1 skill lock fixture\n---\n# n1-probe\n' \
          > "$lock_repo/skills/n1-probe/SKILL.md"
        printf 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n' \
          > "$lock_repo/LICENSE"
        lock_git() {
          HOME="$TMP/n1-lock-home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$TMP/n1-lock-home/.gitconfig" \
            git -C "$lock_repo" -c user.email=n1@tenon.test -c user.name=n1 -c commit.gpgsign=false "$@"
        }
        lock_git init -q -b main && lock_git add -A && lock_git commit -q -m fixture \
          && lock_git config uploadpack.allowFilter true \
          && lock_git config uploadpack.allowAnySHA1InWant true
        lock_fixture_code="$?"
        lock_sources='version: 1
skills:
  n1-probe: { repo: n1-fixture/skills, path: skills/n1-probe, ref: default-branch, license_expected: MIT }'
        # 验证根只需要 verifier 读的两棵树：registry 所在的 templates 与 skills（仅受 git 跟踪的子项）。
        n1_lock_root="$TMP/n1-lock-root-n-minus"
        current_lock_root="$TMP/n1-lock-root-current"
        mkdir -p "$n1_lock_root" "$current_lock_root/skills"
        cp -R "$N_MINUS_PAYLOAD/templates" "$N_MINUS_PAYLOAD/skills" "$n1_lock_root/"
        cp -R "$ROOT/templates" "$current_lock_root/"
        while IFS= read -r tracked; do
          [ -n "$tracked" ] && cp -R "$ROOT/$tracked" "$current_lock_root/skills/"
        done < <(git -C "$ROOT" ls-tree --name-only HEAD skills/)
        for lock_root in "$n1_lock_root" "$current_lock_root"; do
          rm -rf "$lock_root/skills/skills.lock.json"
          printf '%s\n' "$lock_sources" > "$lock_root/skills/sources.yaml"
        done
        lock_cli() {
          HOME="$TMP/n1-lock-home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$TMP/n1-lock-home/.gitconfig" \
            GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 \
            GIT_CONFIG_KEY_0="url.file://$lock_hub/.insteadOf" GIT_CONFIG_VALUE_0=https://github.com/ \
            TENON_RUNTIME_HOME="$TMP/.tenon-runtime-home" node "$@" 2>&1
        }
        for direction in current-to-n-minus n-minus-to-current; do
          if [ "$direction" = current-to-n-minus ]; then
            writer="$BUNDLE"; reader="$N_MINUS_CLI"; lock_root="$n1_lock_root"
            label="bundle: 当前 writer 的 skills.lock.json 被 N-1 verifier（${n_minus_release}）接受"
          else
            writer="$N_MINUS_CLI"; reader="$BUNDLE"; lock_root="$current_lock_root"
            label="bundle: N-1 writer（${n_minus_release}）的 skills.lock.json 被当前 verifier 接受"
          fi
          lock_write="$(lock_cli "$writer" internal-skill-upstream fetch --root "$lock_root")"
          lock_write_code="$?"
          lock_read="$(lock_cli "$reader" internal-skill-provenance verify --root "$lock_root")"
          lock_read_code="$?"
          [ "$lock_fixture_code" -eq 0 ] && [ "$lock_write_code" -eq 0 ] && [ "$lock_read_code" -eq 0 ] \
            && grep -q '"id": "n1-probe"' "$lock_root/skills/skills.lock.json" 2>/dev/null \
            && [ -f "$lock_root/skills/n1-probe/SKILL.md" ] \
            && ok "$label" \
            || bad "$label" "fixture=$lock_fixture_code fetch=$lock_write_code $lock_write verify=$lock_read_code $lock_read"
        done
      fi
    else
      bad "bundle: 固定公开 N-1 CLI 存在" "$N_MINUS_CLI"
    fi
  fi
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
