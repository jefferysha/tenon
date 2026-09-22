#!/usr/bin/env bash
# fixture: pm-history — pm track、预置 change 携带老内核 base64 历史区
# （结构复刻老仓真实 change openspec/changes/afk-autopilot-triggers/.pipeline.yaml，
#   base64 载荷已脱敏为无害示例文本）。
#
# 验证点：
#   · 对含历史区的既有 change 做 get/set/transition/check（不 init）
#   · assignee 写成 run.sh 的 ORACLE_TENON_USER：字段写入与 document record / review 同过负责人闸，
#     无主 change 要先 `tenon owner take`。本 fixture 验的是历史尾块保真与 automation 演进，不是
#     无主任务的接手流程（那条由 kernel users/ownership 与 cli fields 单测覆盖），所以直接给它一个主。
#   · 新内核写回时历史尾块必须逐字保留 —— 基线写入 <target>/.oracle-preserve
#     （首行 change 名，其余 = 历史区块），run.sh 全程跑完后在新侧做逐字子串校验
#   · PM 内建策略在项目显式开启 automation + default_opt_in 后，于 spec-complete 自动入 AFK
#     队列是新产品能力；用精确 sidecar 声明并由 harness 验证 old=off → new=queued +
#     queued_at，绝不以宽泛 YAML 白名单掩盖它。
#
# 用法: pm-history.sh <target-dir>
# 计划行格式: <expected_new_exit>\t<cmd>\t<args...>（expected 列仅降级模式使用）
set -euo pipefail

target="${1:?usage: pm-history.sh <target-dir>}"
chdir="$target/openspec/changes/t6-pm"
mkdir -p "$chdir" "$target/docs" "$target/.pipeline"
(cd "$target" && git init -q -b main 2>/dev/null || git init -q 2>/dev/null || true)

# 自动挂队是双层显式授权：项目总开关和 default opt-in 缺一不可。旧 oracle 不消费该文件，
# 新实现必须消费它；因此 fixture 仍能精确验证“显式启用后”的产品演进，而不是依赖隐式默认。
printf '%s\n' '{"version":1,"enabled":true,"default_opt_in":true}' \
  > "$target/.pipeline/automation.json"

printf '# proposal\n\nT6 oracle fixture: pm + history region.\n' > "$chdir/proposal.md"
# check build 要求 tasks.md 任务数 >= 3（pm 不要求 plan）
printf -- '- [ ] a\n- [x] b\n- [x] c\n' > "$chdir/tasks.md"
# coverage 块：pm required 仅 L3_rules（新 CLI check=guard 出口全语义的 spec 覆盖 gate；
# 老 cmd_check 不读该块——两侧文件一致，exit 面保持可比）
cat > "$target/docs/design.md" <<'DESIGN'
# design

```coverage
touches:
L3_rules: filled
```
DESIGN

# 历史区块（写入 yaml 尾部 + 同内容作 PRESERVE 基线）
history_block='prompts_history:
  - { at: 2026-07-01T08:00:00Z, phase: spec, track: pm, kind: decision, q_b64: "Y29uZmlybT8=", a_b64: "eWVz" }
  - { at: 2026-07-01T07:00:00Z, phase: open, track: pm, prompt_b64: "b3JhY2xlIGZpeHR1cmU=" }
tools_history:
  - { at: 2026-07-01T07:30:00Z, tool: Skill, detail: "superpowers:brainstorming" }
  - { at: 2026-07-01T07:10:00Z, tool: Skill, detail_b64: "cGlwZWxpbmUgZHVhbC1ydW4gaGFybmVzcw==" }
transitions_history:
  - { at: 2026-07-01T08:00:01Z, from: explore, to: spec, event: explore-complete }
  - { at: 2026-07-01T07:30:01Z, from: open, to: explore, event: open-complete }'

# 37 字段全量（老 init heredoc 字段序）+ 历史尾块；phase=spec（后续 spec-complete → build）
cat > "$chdir/.pipeline.yaml" <<YAML
track: pm
preset: full
created_by: oracle
assignee: oracle <oracle@tenon.test>
phase: spec
phase_status: in_progress
design_doc: docs/design.md
plan: null
verification_report: null
build_mode: null
isolation: null
build_sha: null
agent_review_result: skipped
codex_review_result: skipped
verify_result: pending
branch_status: pending
direct_override: false
prd_path: null
pr_url: null
automation: off
automation_queued_at: ""
automation_sandbox: ""
automation_worktree: ""
automation_attempts: 0
automation_last_error: ""
automation_preserved_path: ""
branch: null
base_branch: main
scope: null
related_files: null
spec_scope: null
depends_on: null
created_at: 2026-07-01T07:00:00Z
updated_at: 2026-07-01T08:00:01Z
verified_at: null
archived_at: null
archived: false
$history_block
YAML

# PRESERVE 基线 sidecar：首行 change 名，其余为必须逐字保留的历史区块
{
  printf 't6-pm\n'
  printf '%s\n' "$history_block"
} > "$target/.oracle-preserve"

tr '|' '\t' > "$target/.oracle-plan" <<'PLAN'
0|get|t6-pm|phase
0|get|t6-pm|track
0|set|t6-pm|prd_path|docs/prd.md
0|get|t6-pm|prd_path
0|check|t6-pm|build
0|transition|t6-pm|spec-complete
0|get|t6-pm|phase
0|get|t6-pm|updated_at
PLAN

# <生效起始 step>\t<kind>\t<change>\t<old automation>\t<new automation>
# 第 6 条是 spec-complete。run.sh 从该步起持续断言这个明确演进，再仅忽略 automation/queued_at 的
# 旧新投影差异；其余字段和后续步骤仍逐字双跑。
tr '|' '\t' > "$target/.oracle-state-extensions" <<'EXTENSIONS'
6|pm-spec-complete-auto-enqueue|t6-pm|off|queued
EXTENSIONS
