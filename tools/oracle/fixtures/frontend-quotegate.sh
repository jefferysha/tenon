#!/usr/bin/env bash
# fixture: frontend-quotegate — frontend track 契约探针：
#   · 四闸拒写（「: 」/「 #」/首引号；换行无法进 TSV 计划行，由 kernel 单测覆盖）
#   · 白名单外字段拒写、枚举拒写
#   · 缺失字段 get（老内核实测 exit 0 + 空行；契约表 exit 1——双跑面差异属 T6 实测发现）
#   · 未知事件（老内核实测 exit 1；契约表 exit 2）
#   · 引号标量单层去引号 parity（automation_sandbox: "" → 空）
#
# consolidate-workflow-tracks：default 改为按 default.yaml 执行之后，原先的 `check open` / `transition open-complete`
# 两步（立项出口要 proposal / tasks / design.md 字面路径、老脚本首错即停）与老状态机不再同口径——前者的字面路径检查已删除
# （设计 §1b Q4），后者要求立项步声明的技能与文档证据——所以这几步和它们的后置读取从双跑里去掉，由 packages/cli 的
# transition-effects 集成测试在新引擎上覆盖。留下的全是 set / get 的引号闸与字段白名单，两边仍是同一口径。
#
# 用法: frontend-quotegate.sh <target-dir>
# 计划行格式: <expected_new_exit>\t<cmd>\t<args...>（expected 列仅降级模式使用）
set -euo pipefail

target="${1:?usage: frontend-quotegate.sh <target-dir>}"
mkdir -p "$target/openspec/changes"
(cd "$target" && git init -q -b main 2>/dev/null || git init -q 2>/dev/null || true)

# 这个 fixture 做前端工作：default 的前端轨道首步要求项目已有就绪的 DESIGN.md（设计体系任务的产出）。
# 真实项目在开第一个前端任务之前就把它做好了，所以在这里声明「本项目有设计体系」，由 harness 在 init
# 之前按产品的契约备好——判定仍然完全交给产品的前置条件。
: > "$target/.oracle-design-system"

# 未知事件那一步会让 harness 先替新侧登记立项文档（transition 前的文档 bootstrap）；登记要求文档里没有骨架占位符，
# 所以 init 成功后由 harness 安装这几份写好的立项文档，避免把半初始化 Change 目录当 fixture。
fixture_change="$target/.oracle-post-init/t6-fe"
mkdir -p "$fixture_change"
printf '# proposal\n\nT6 oracle fixture: frontend quote-gate 探针。\n' > "$fixture_change/proposal.md"
printf -- '- [ ] q1\n' > "$fixture_change/tasks.md"
printf '# design\n\nfixture design doc.\n' > "$fixture_change/design.md"

tr '|' '\t' > "$target/.oracle-plan" <<'PLAN'
0|init|t6-fe|frontend|hotfix
0|get|t6-fe|preset
0|get|t6-fe|automation_sandbox
1|get|t6-fe|nosuchfield
1|set|t6-fe|nosuchfield|whatever
1|set|t6-fe|automation|bogus
1|set|t6-fe|automation_last_error|boom: gate
1|set|t6-fe|automation_last_error|boom #gate
1|set|t6-fe|automation_last_error|"quoted
0|set|t6-fe|automation_last_error|clean-error
0|get|t6-fe|automation_last_error
2|transition|t6-fe|bogus-event
PLAN
