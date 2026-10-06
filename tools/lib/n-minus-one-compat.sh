# shellcheck shell=bash
# N-1 数据兼容门（由 tools/test-bundle.sh 的 N-1 一节 source，复用它的 ok / bad 与已导出的身份、运行时 home）。
#
# 合同：当前版本在正常使用中「隐式写下」的数据（状态、记录链、台账、计划、discover 写的目录、history 与边车）
# 必须能被上一个正式版本（fixture 固定的 N-1）读取，不被它判为损坏、被改动或非法；反方向，N-1 写下的数据当前版本也要读得了。
# 期望值取决于 fixture 固定的那个 N-1 认得什么。现在的 N-1 是 v0.3.0：它认得 agent 运行台账旁注（host / host_source / rerun_reason）、
# 记录链的 `chain-base` 标记与 `TENON_RECORD_RETENTION`、测试记录的本机封存，所以这些不再是「N-1 不懂、当前版本独有」的豁免项，
# 而是双向都要读得了：旁注与链基点在下面两个方向都测。v0.3.0 不认得的只有 0.3.1 起记录绑的「可移植指纹」：
# 它在没有宿主本地文件的工作区里与完整指纹逐位相同；工作区里有未跟踪的 `.claude/settings.local.json` 时两者不同，
# v0.3.0 把当前版本写下的记录判为「已过期」（要重跑），绝不能判为损坏；反过来 v0.3.0 写下的记录（完整指纹）当前版本照样读作新鲜。
# 目录 `profile: coarse`、`integrity: block|notice`、评审者 `host:`、自定义 agent 的 `attach_on` 也是 v0.3.0 起就有的用户选用能力，
# 这里没有交叉测；换到下一个 N-1 时重新核对这一段与下面每一条期望。
#
# 判据只看退出码和 N-1 读取器的「损坏」措辞，不比对整句输出：
#   测试记录被改动 / 找不到链首记录      v2 记录链被判断链
#   台账第 N 行 / 形状非法               agent 运行台账被判损坏
#   无法解析 / 未知字段                  冻结的 agent 文件被判不可读
#   未注册的 track                       任务的 track 不在 N-1 的注册表里
#   step 投影不可用                      status --json 因上述任一原因丢了 step 投影
N1_CORRUPT_RE='测试记录被改动|找不到链首记录|台账第|形状非法|runs-corrupt|无法解析|未知字段|未注册的 track|step 投影不可用|记录文件无法读取'

n1_git() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -c user.name=n1 -c user.email=n1@tenon.test -c commit.gpgsign=false "$@"
}

# n1_clean <output> : 输出里没有任何「损坏」措辞
n1_clean() { ! printf '%s' "$1" | grep -Eq "$N1_CORRUPT_RE"; }

# n1_expect <label> <expected-exit> <actual-exit> <output> : 退出码符合预期且输出干净
n1_expect() {
  if [ "$3" -eq "$2" ] && n1_clean "$4"; then
    ok "$1"
  else
    bad "$1" "exit=$3 期望 $2: $(printf '%s' "$4" | head -c 700)"
  fi
}

# n1_clean_only <label> <actual-exit> <output> : 只要求输出干净（命令本身因任务还没做完退出非零是正常的）
n1_clean_only() {
  if n1_clean "$3"; then ok "$1"; else bad "$1" "exit=$2: $(printf '%s' "$3" | head -c 700)"; fi
}

n1_workflow() {
  cat <<'YAML'
name: compat
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      executors:
        - agent: builder
    guards: []
    test_policy:
      plan: required
      kinds: [typecheck]
      run: [typecheck]
      scope: full
      files: any
    transitions:
      - event: build-done
        to: done
  - id: done
    label: 完结
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
YAML
}

# n1_agent_run <cli> <project> <change> [record-args...] : 用 <cli> 在 <project> 里跑一次 builder 执行者
# （prompt → 写报告 → record），打印 record 的输出。record 的参数由调用方给：两个版本都认 `--host claude`（声明宿主），
# 旁注 `.pipeline-agent-run-meta.jsonl` 里会有 host / host_source（v0.3 起；v0.2.1 没有这个选项，也读不到旁注）。
n1_agent_run() {
  local cli="$1" proj="$2" change="$3" prompt run report
  shift 3
  prompt="$(cd "$proj" && node "$cli" agent prompt "$change" builder --json 2>&1)" || { printf 'prompt: %s' "$prompt"; return 1; }
  run="$(printf '%s' "$prompt" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).run_id)')"
  report="$(printf '%s' "$prompt" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).report_path)')"
  mkdir -p "$proj/$(dirname "$report")"
  printf '# r\n\n```tenon-result\n{"result":"done","findings":[]}\n```\n' > "$proj/$report"
  ( cd "$proj" && node "$cli" agent record "$change" "$run" "$@" 2>&1 )
}

# n1_json_field <json> <js-expression-on-v> : 取 JSON 里的一个值
n1_json_field() {
  printf '%s' "$1" | node -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(String(eval(process.argv[1])))' "$2" 2>/dev/null
}

# n1_discover_project <dir> : 一个有测试脚本和测试文件的 Node 项目，供 discover --write 用
n1_discover_project() {
  mkdir -p "$1/test"
  printf '{ "name": "n1-discover", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }\n' > "$1/package.json"
  printf "import { test } from 'node:test'\ntest('ok', () => {})\n" > "$1/test/ok.test.js"
  ( cd "$1" && n1_git init -q -b main && n1_git add -A && n1_git commit -q -m fixture ) >/dev/null 2>&1
}

# n1_compat_default_task <current-cli> <n-1-cli> <project> <change> <n-1-label>
# test-bundle 里用真实 hook 推进到 explore 的 default 任务：它冻结了 default 工作流引用的全部官方 agent，
# N-1 读它的 agent / step 投影不能因为冻结副本的内容失败。
n1_compat_default_task() {
  local old="$2" proj="$3" change="$4" label="$5" out code
  out="$(cd "$proj" && node "$old" agent next "$change" 2>&1)"; code="$?"
  n1_expect "$label 读取当前版本冻结的官方 agent（agent next）" 0 "$code" "$out"
  out="$(cd "$proj" && node "$old" status "$change" --json 2>&1)"; code="$?"
  n1_expect "$label 读取当前版本任务的 step 投影（status --json）" 0 "$code" "$out"
  out="$(cd "$proj" && node "$old" check "$change" 2>&1)"; code="$?"
  n1_clean_only "$label check 不报任何损坏的冻结 agent / 台账 / 记录链" "$code" "$out"
  out="$(cd "$proj" && node "$old" test status "$change" 2>&1)"; code="$?"
  n1_clean_only "$label test status 不报记录链损坏" "$code" "$out"
}

# n1_compat_gate <current-cli> <n-1-cli> <workdir> <n-1-label>
n1_compat_gate() {
  local cur="$1" old="$2" work="$3" label="$4"
  local proj="$work/n1-compat-project" out code runs failed files status

  # 当前版本写进记录的可移植指纹按 git 的权限位模型（目录 755、文件 644 / 755、符号链接 755），常见的 umask 022 下的树它与
  # N-1 自己算的完整指纹逐位相同，所以 N-1 读当前版本的记录是新鲜的；这一节的断言以此为前提，不依赖运行者的 umask。
  umask 022

  mkdir -p "$proj/src" "$proj/.pipeline/workflows" "$proj/test-results"
  printf '{ "name": "n1-compat", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }\n' > "$proj/package.json"
  printf 'export const add = (a, b) => a + b\n' > "$proj/src/add.js"
  printf 'test-results\n.tenon/users/*/local\n' > "$proj/.gitignore"
  n1_workflow > "$proj/.pipeline/workflows/compat.yaml"
  ( cd "$proj" && n1_git init -q -b main && n1_git add -A && n1_git commit -q -m fixture ) >/dev/null 2>&1

  # 目录由 CLI 写：smoke 只看退出码；stale 的报告被回填成旧时间，当前版本会在记录里写 report-untrusted。
  out="$(cd "$proj" && node "$cur" test catalog add smoke --kind typecheck --runner custom --command true --report-format exit-code 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：当前版本写入测试目录" "exit=$code $out"; return; }
  out="$(cd "$proj" && node "$cur" test catalog add stale --kind unit --runner custom --report-format junit --report-path test-results/stale.xml \
    --command "printf '<testsuites><testsuite name=\"s\" tests=\"1\" failures=\"0\"><testcase classname=\"a\" name=\"b\" file=\"a.test.js\"/></testsuite></testsuites>' > test-results/stale.xml && touch -t 200001010000 test-results/stale.xml" 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：当前版本写入回填报告套件" "exit=$code $out"; return; }

  # ── 当前版本写、N-1 读 ──────────────────────────────────────────────────────
  # 1) 记录链：超过 20 次运行（0.2.x 的默认保留上限）也不清理，链仍是 N-1 认得的形状。
  out="$(cd "$proj" && node "$cur" init compat-w --track backend --workflow compat --preset full 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：当前版本创建 compat-w" "exit=$code $out"; return; }
  ( cd "$proj" && node "$cur" test plan compat-w --seed && node "$cur" test register compat-w --suite smoke ) >/dev/null 2>&1
  runs=0; failed=0
  while [ "$runs" -lt 22 ]; do
    ( cd "$proj" && TENON_TEST_TRUST=1 node "$cur" test run compat-w --suite smoke ) >/dev/null 2>&1 || failed=$((failed + 1))
    runs=$((runs + 1))
  done
  [ "$failed" -eq 0 ] && ok "N-1 兼容：当前版本连续运行 22 次套件" || bad "N-1 兼容：当前版本连续运行 22 次套件" "$failed 次失败"
  files="$(find "$proj/.tenon/users" -path '*/tests/compat-w/*.json' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$files" -eq 22 ] && [ -z "$(find "$proj/.tenon/users" -path '*/tests/compat-w/chain-base' 2>/dev/null)" ] \
    && ok "N-1 兼容：默认不清理记录，22 次运行留下 22 份记录且没有 chain-base 标记" \
    || bad "N-1 兼容：默认不清理记录" "记录 $files 份（期望 22），或存在 chain-base 标记"
  out="$(cd "$proj" && node "$old" test status compat-w 2>&1)"; code="$?"
  n1_expect "$label 读取 22 份记录的链（test status）" 0 "$code" "$out"

  # 2) agent 运行台账：当前版本登记时记下宿主（--host claude 声明，写进旁注）。N-1 认得旁注，读出来的宿主必须是 claude。
  out="$(n1_agent_run "$cur" "$proj" compat-w --host claude)"
  printf '%s' "$out" | grep -q 'host=claude' \
    && ok "N-1 兼容：当前版本登记 agent 运行并记下宿主" || bad "N-1 兼容：当前版本登记 agent 运行并记下宿主" "$out"
  grep -q '"host":"claude"' "$proj/openspec/changes/compat-w/.pipeline-agent-run-meta.jsonl" 2>/dev/null \
    && ok "N-1 兼容：当前版本把宿主写进 agent 运行旁注" || bad "N-1 兼容：当前版本把宿主写进 agent 运行旁注" "旁注里没有 host=claude"
  out="$(cd "$proj" && node "$old" agent next compat-w 2>&1)"; code="$?"
  n1_expect "$label 读取带宿主的 agent 运行台账（agent next）" 0 "$code" "$out"
  out="$(cd "$proj" && node "$old" agent next compat-w --json 2>&1)"; code="$?"
  [ "$code" -eq 0 ] && [ "$(n1_json_field "$out" 'v.agents[0].host')" = claude ] \
    && ok "$label 从旁注读出当前版本登记的宿主（agent next --json）" \
    || bad "$label 从旁注读出当前版本登记的宿主（agent next --json）" "exit=$code $(printf '%s' "$out" | head -c 500)"
  out="$(cd "$proj" && node "$old" status compat-w --json 2>&1)"; code="$?"
  n1_expect "$label 读取 status --json（step 投影可用）" 0 "$code" "$out"
  out="$(cd "$proj" && node "$old" check compat-w 2>&1)"; code="$?"
  n1_clean_only "$label check 不报任何损坏" "$code" "$out"
  out="$(cd "$proj" && node "$old" test plan compat-w 2>&1)"; code="$?"
  n1_expect "$label 读取当前版本登记的测试计划" 0 "$code" "$out"
  printf '%s' "$out" | grep -q 'smoke' \
    && ok "$label 的计划里有当前版本登记的套件" || bad "$label 的计划里有当前版本登记的套件" "$out"
  out="$(cd "$proj" && node "$old" test catalog validate 2>&1)"; code="$?"
  n1_expect "$label 校验当前版本写下的测试目录" 0 "$code" "$out"

  # 3) 报告被回填成旧时间 → 记录里的 report-untrusted：单独一个任务，只有这一次运行。
  out="$(cd "$proj" && node "$cur" init compat-u --track backend --workflow compat --preset full 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：当前版本创建 compat-u" "exit=$code $out"; return; }
  ( cd "$proj" && node "$cur" test plan compat-u --seed && node "$cur" test register compat-u --suite stale ) >/dev/null 2>&1
  ( cd "$proj" && TENON_TEST_TRUST=1 node "$cur" test run compat-u --suite stale ) >/dev/null 2>&1
  files="$(find "$proj/.tenon/users" -path '*/tests/compat-u/*.json' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$files" -eq 1 ] && ok "N-1 兼容：当前版本在回填报告的套件上写下记录" || bad "N-1 兼容：当前版本在回填报告的套件上写下记录" "记录 $files 份"
  grep -rq 'report-untrusted' "$proj"/.tenon/users/*/tests/compat-u/ \
    && ok "当前版本把回填的报告判为 report-untrusted 并记进记录" || bad "当前版本把回填的报告判为 report-untrusted 并记进记录" "记录里没有这个原因"
  out="$(cd "$proj" && node "$old" test status compat-u 2>&1)"; code="$?"
  n1_clean_only "$label 读取带 report-untrusted 原因的记录" "$code" "$out"

  # 4) discover --write 写的目录
  local disc="$work/n1-discover-current"
  n1_discover_project "$disc"
  out="$(cd "$disc" && node "$cur" test discover --write 2>&1)"; code="$?"
  [ "$code" -eq 0 ] && [ -f "$disc/.tenon/tests/catalog.yaml" ] \
    && ok "N-1 兼容：当前版本 discover --write 写出目录" || bad "N-1 兼容：当前版本 discover --write 写出目录" "exit=$code $out"
  out="$(cd "$disc" && node "$old" test catalog validate 2>&1)"; code="$?"
  n1_expect "$label 校验当前版本 discover --write 写的目录" 0 "$code" "$out"
  out="$(cd "$disc" && node "$old" test catalog show 2>&1)"; code="$?"
  n1_expect "$label 读出当前版本 discover --write 写的套件" 0 "$code" "$out"

  # 5) N-1 接着在当前版本写下的链上继续运行（回滚后继续工作）。
  ( cd "$proj" && TENON_TEST_TRUST=1 node "$old" test run compat-w --suite smoke ) >/dev/null 2>&1
  code="$?"
  [ "$code" -eq 0 ] && ok "$label 可在当前版本写下的记录链上继续运行" || bad "$label 可在当前版本写下的记录链上继续运行" "exit=$code"
  out="$(cd "$proj" && node "$old" test status compat-w 2>&1)"; code="$?"
  n1_expect "$label 续写之后读取整条链（23 份）" 0 "$code" "$out"

  # ── N-1 写、当前版本读 ──────────────────────────────────────────────────────
  out="$(cd "$proj" && node "$old" init compat-o --track backend --workflow compat --preset full 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：$label 创建 compat-o" "exit=$code $out"; return; }
  ( cd "$proj" && node "$old" test plan compat-o --seed && node "$old" test register compat-o --suite smoke ) >/dev/null 2>&1
  runs=0; failed=0
  while [ "$runs" -lt 3 ]; do
    ( cd "$proj" && TENON_TEST_TRUST=1 node "$old" test run compat-o --suite smoke ) >/dev/null 2>&1 || failed=$((failed + 1))
    runs=$((runs + 1))
  done
  [ "$failed" -eq 0 ] && ok "N-1 兼容：$label 连续运行 3 次套件" || bad "N-1 兼容：$label 连续运行 3 次套件" "$failed 次失败"
  out="$(n1_agent_run "$old" "$proj" compat-o --host claude)"
  printf '%s' "$out" | grep -q 'result=done' && printf '%s' "$out" | grep -q 'host=claude' \
    && ok "N-1 兼容：$label 登记 agent 运行并记下宿主" || bad "N-1 兼容：$label 登记 agent 运行并记下宿主" "$out"
  # 链完好、读作通过：v0.3.0 自己封存它写的记录（本机封存文件），所以当前版本读它们不是「来源不明」（record-unsealed）；
  # 它之前的 v0.2.1 当 N-1 时，写的记录没有封存，当前版本才把它们当作来源不明、要求重跑。无论如何都不能判成断链 / 被改动。
  out="$(cd "$proj" && node "$cur" test status compat-o --json 2>&1)"
  status="$(n1_json_field "$out" 'v.policy.chain')"
  [ "$status" = intact ] && [ "$(n1_json_field "$out" 'v.pass')" = true ] \
    && ok "当前版本读取 $label 写下的记录链：链完好、读作通过" \
    || bad "当前版本读取 $label 写下的记录链" "chain=$status $(printf '%s' "$out" | head -c 500)"
  out="$(cd "$proj" && node "$cur" agent next compat-o 2>&1)"; code="$?"
  n1_expect "当前版本读取 $label 写下的 agent 运行台账" 0 "$code" "$out"
  out="$(cd "$proj" && node "$cur" agent next compat-o --json 2>&1)"; code="$?"
  [ "$code" -eq 0 ] && [ "$(n1_json_field "$out" 'v.agents[0].host')" = claude ] \
    && ok "当前版本从旁注读出 $label 登记的宿主（agent next --json）" \
    || bad "当前版本从旁注读出 $label 登记的宿主（agent next --json）" "exit=$code $(printf '%s' "$out" | head -c 500)"
  out="$(cd "$proj" && node "$cur" status compat-o --json 2>&1)"; code="$?"
  n1_expect "当前版本读取 $label 创建的任务（status --json）" 0 "$code" "$out"
  out="$(cd "$proj" && node "$cur" test plan compat-o 2>&1)"; code="$?"
  n1_expect "当前版本读取 $label 登记的测试计划" 0 "$code" "$out"
  disc="$work/n1-discover-n1"
  n1_discover_project "$disc"
  ( cd "$disc" && node "$old" test discover --write ) >/dev/null 2>&1
  out="$(cd "$disc" && node "$cur" test catalog validate 2>&1)"; code="$?"
  n1_expect "当前版本校验 $label discover --write 写的目录" 0 "$code" "$out"

  # ── 记录清理（用户主动设 TENON_RECORD_RETENTION，只留最新 N 份并写 chain-base 标记）────────────────────
  # v0.3.0 认得这个环境变量和 chain-base 标记，所以两个方向都要读得了；默认（上面 22 次运行）不清理、不写标记。
  # 放在宿主本地文件之前：之后 N-1 算的完整指纹变了，它读到的记录会是「已过期」而不是新鲜。
  out="$(cd "$proj" && node "$cur" init compat-rc --track backend --workflow compat --preset full 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：当前版本创建 compat-rc" "exit=$code $out"; return; }
  ( cd "$proj" && node "$cur" test plan compat-rc --seed && node "$cur" test register compat-rc --suite smoke ) >/dev/null 2>&1
  runs=0
  while [ "$runs" -lt 5 ]; do
    ( cd "$proj" && TENON_RECORD_RETENTION=3 TENON_TEST_TRUST=1 node "$cur" test run compat-rc --suite smoke ) >/dev/null 2>&1
    runs=$((runs + 1))
  done
  files="$(find "$proj/.tenon/users" -path '*/tests/compat-rc/*.json' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$files" -eq 3 ] && [ -n "$(find "$proj/.tenon/users" -path '*/tests/compat-rc/chain-base' 2>/dev/null)" ] \
    && ok "N-1 兼容：当前版本在 TENON_RECORD_RETENTION=3 下 5 次运行只留 3 份记录并写下 chain-base 标记" \
    || bad "N-1 兼容：当前版本按 TENON_RECORD_RETENTION 清理记录" "记录 $files 份（期望 3），或缺 chain-base 标记"
  out="$(cd "$proj" && node "$old" test status compat-rc 2>&1)"; code="$?"
  n1_expect "$label 读取被清理过的记录链（chain-base 标记）" 0 "$code" "$out"
  ( cd "$proj" && TENON_TEST_TRUST=1 node "$old" test run compat-rc --suite smoke ) >/dev/null 2>&1
  code="$?"
  [ "$code" -eq 0 ] && ok "$label 可在当前版本清理过的记录链上继续运行" || bad "$label 可在当前版本清理过的记录链上继续运行" "exit=$code"
  out="$(cd "$proj" && node "$cur" test status compat-rc --json 2>&1)"
  [ "$(n1_json_field "$out" 'v.policy.chain')" = intact ] \
    && ok "当前版本读取 $label 在清理过的链上续写之后的整条链：链完好" \
    || bad "当前版本读取 $label 在清理过的链上续写之后的整条链" "$(printf '%s' "$out" | head -c 500)"
  out="$(cd "$proj" && node "$old" init compat-ro --track backend --workflow compat --preset full 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：$label 创建 compat-ro" "exit=$code $out"; return; }
  ( cd "$proj" && node "$old" test plan compat-ro --seed && node "$old" test register compat-ro --suite smoke ) >/dev/null 2>&1
  runs=0
  while [ "$runs" -lt 5 ]; do
    ( cd "$proj" && TENON_RECORD_RETENTION=3 TENON_TEST_TRUST=1 node "$old" test run compat-ro --suite smoke ) >/dev/null 2>&1
    runs=$((runs + 1))
  done
  files="$(find "$proj/.tenon/users" -path '*/tests/compat-ro/*.json' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$files" -eq 3 ] && [ -n "$(find "$proj/.tenon/users" -path '*/tests/compat-ro/chain-base' 2>/dev/null)" ] \
    && ok "N-1 兼容：$label 在 TENON_RECORD_RETENTION=3 下 5 次运行只留 3 份记录并写下 chain-base 标记" \
    || bad "N-1 兼容：$label 按 TENON_RECORD_RETENTION 清理记录" "记录 $files 份（期望 3），或缺 chain-base 标记"
  out="$(cd "$proj" && node "$cur" test status compat-ro --json 2>&1)"
  [ "$(n1_json_field "$out" 'v.policy.chain')" = intact ] && [ "$(n1_json_field "$out" 'v.pass')" = true ] \
    && ok "当前版本读取 $label 清理过的记录链：链完好、读作通过" \
    || bad "当前版本读取 $label 清理过的记录链" "$(printf '%s' "$out" | head -c 500)"
  ( cd "$proj" && TENON_TEST_TRUST=1 node "$cur" test run compat-ro --suite smoke ) >/dev/null 2>&1
  code="$?"
  [ "$code" -eq 0 ] && ok "当前版本可在 $label 清理过的记录链上继续运行" || bad "当前版本可在 $label 清理过的记录链上继续运行" "exit=$code"
  out="$(cd "$proj" && node "$old" test status compat-ro 2>&1)"; code="$?"
  n1_expect "$label 读取当前版本在它清理过的链上续写之后的整条链" 0 "$code" "$out"

  # ── 宿主本地文件（放在最后：它让此前所有记录绑定的候选变了）─────────────────────────
  # 工作区里有未被 git 跟踪的 .claude/settings.local.json（Claude Code 自己写的权限允许列表）：当前版本写下的记录绑「不含宿主本地文件」的
  # 可移植指纹，干净克隆才复现得出来。N-1 自己算的指纹含这个文件，所以它把这条记录判成「已过期：代码已变化」（退出码 2，要重跑），
  # 绝不能判成损坏；当前版本自己读它是新鲜的，Claude Code 之后改写这个文件也不让它过期。
  # 反方向：N-1 在同样的工作区里写下的记录绑完整指纹（含这个文件），当前版本照样读作新鲜、链完好——v0.3.0 的记录不因升级而过期。
  mkdir -p "$proj/.claude"
  printf '{ "permissions": { "allow": ["Bash(ls)"] } }\n' > "$proj/.claude/settings.local.json"
  out="$(cd "$proj" && node "$cur" init compat-h --track backend --workflow compat --preset full 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：当前版本创建 compat-h" "exit=$code $out"; return; }
  ( cd "$proj" && node "$cur" test plan compat-h --seed && node "$cur" test register compat-h --suite smoke ) >/dev/null 2>&1
  ( cd "$proj" && TENON_TEST_TRUST=1 node "$cur" test run compat-h --suite smoke ) >/dev/null 2>&1
  out="$(cd "$proj" && node "$cur" test status compat-h 2>&1)"; code="$?"
  n1_expect "当前版本在有宿主本地文件的工作区里写下的记录对自己是新鲜的" 0 "$code" "$out"
  out="$(cd "$proj" && node "$old" test status compat-h 2>&1)"; code="$?"
  if [ "$code" -eq 2 ] && printf '%s' "$out" | grep -q '已过期' && n1_clean "$out"; then
    ok "$label 把有宿主本地文件的工作区里写下的记录判为已过期（退出码 2，要重跑），不报损坏"
  else
    bad "$label 把有宿主本地文件的工作区里写下的记录判为已过期，不报损坏" "exit=$code（期望 2 且有「已过期」）: $(printf '%s' "$out" | head -c 700)"
  fi
  printf '{ "permissions": { "allow": ["Bash(ls)", "Bash(npm test)"] } }\n' > "$proj/.claude/settings.local.json"
  out="$(cd "$proj" && node "$cur" test status compat-h 2>&1)"; code="$?"
  n1_expect "改写 .claude/settings.local.json 之后当前版本的记录仍然新鲜" 0 "$code" "$out"

  # N-1 在这个有宿主本地文件的工作区里写记录：它绑完整指纹，自己读是新鲜的，当前版本也读作新鲜、链完好。
  out="$(cd "$proj" && node "$old" init compat-d --track backend --workflow compat --preset full 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：$label 创建 compat-d" "exit=$code $out"; return; }
  ( cd "$proj" && node "$old" test plan compat-d --seed && node "$old" test register compat-d --suite smoke ) >/dev/null 2>&1
  ( cd "$proj" && TENON_TEST_TRUST=1 node "$old" test run compat-d --suite smoke ) >/dev/null 2>&1
  out="$(cd "$proj" && node "$old" test status compat-d 2>&1)"; code="$?"
  n1_expect "$label 在有宿主本地文件的工作区里写下的记录对它自己是新鲜的" 0 "$code" "$out"
  out="$(cd "$proj" && node "$cur" test status compat-d --json 2>&1)"
  [ "$(n1_json_field "$out" 'v.policy.chain')" = intact ] && [ "$(n1_json_field "$out" 'v.pass')" = true ] \
    && ok "当前版本把 $label 在有宿主本地文件的工作区里写下的记录读作新鲜（完整指纹照样认），链完好" \
    || bad "当前版本读取 $label 在有宿主本地文件的工作区里写下的记录" "$(printf '%s' "$out" | head -c 700)"

  # ── 符号链接与 umask 之外的权限位（放在最后：它让此前所有记录绑定的候选变了）──────────────────────
  # 完整指纹记录原始权限位（符号链接在 macOS 是 0755、在 Linux 恒为 0777，目录与文件跟着 umask），评审结论与构建基线绑的是它：
  # 当前版本算出的完整指纹必须逐位等于 N-1 在同一棵树上、同一台机器上自己算的值。可移植指纹（测试记录绑的）按 git 的权限位
  # 模型记录，在这样的树上与完整指纹不同，N-1 读它判为已过期（要重跑）——可以，只是不能判成损坏。
  ln -s src/add.js "$proj/link.js"
  chmod 664 "$proj/src/add.js"
  chmod 775 "$proj/src"
  out="$(cd "$proj" && node "$cur" init compat-m --track backend --workflow compat --preset full 2>&1)"; code="$?"
  [ "$code" -eq 0 ] || { bad "N-1 兼容：当前版本创建 compat-m" "exit=$code $out"; return; }
  local cur_candidate old_candidate
  cur_candidate="$(cd "$proj" && node "$cur" agent next compat-m --json 2>&1 | grep -Eo 'workspace:sha256:[0-9a-f]{64}' | head -1)"
  old_candidate="$(cd "$proj" && node "$old" agent next compat-m --json 2>&1 | grep -Eo 'workspace:sha256:[0-9a-f]{64}' | head -1)"
  if [ -n "$cur_candidate" ] && [ "$cur_candidate" = "$old_candidate" ]; then
    ok "有符号链接和 664 / 775 权限位的树：当前版本的完整指纹与 $label 自己算的逐位相同"
  else
    bad "有符号链接和 664 / 775 权限位的树：当前版本的完整指纹与 $label 自己算的逐位相同" "当前=$cur_candidate $label=$old_candidate"
  fi
  ( cd "$proj" && node "$cur" test plan compat-m --seed && node "$cur" test register compat-m --suite smoke ) >/dev/null 2>&1
  ( cd "$proj" && TENON_TEST_TRUST=1 node "$cur" test run compat-m --suite smoke ) >/dev/null 2>&1
  out="$(cd "$proj" && node "$cur" test status compat-m 2>&1)"; code="$?"
  n1_expect "当前版本在这棵树上写下的记录对自己是新鲜的" 0 "$code" "$out"
  out="$(cd "$proj" && node "$old" test status compat-m 2>&1)"; code="$?"
  n1_clean_only "$label 读取这棵树上写下的记录：不报损坏（至多判为已过期）" "$code" "$out"
}
