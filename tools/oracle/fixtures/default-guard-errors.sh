#!/usr/bin/env bash
# fixture: default-guard-errors —— default 离开条件不满足时的统一报错（只比新侧的契约 fixture）。
#
# 历史：这个 fixture 原先把 default 轨的每种前置 guard 失败分支（explore 缺 design_doc、spec 缺 plan、build 缺
# build_mode / isolation、isolation 非法枚举、full+direct 缺 direct_override、verify 报告 / branch_status / agent / codex
# 各失败）与老状态机（workflow-plugin 的 pipeline-state.sh）逐字双跑：首错即停、旧版逐字文案、退出码 1。
#
# 退役原因（设计 consolidate-workflow-tracks §1b Q10）：default 改为按 default.yaml 执行之后
#   · 离开条件失败一律「一次列出全部、退出码 2」，不再首错即停、不再用退出码 1；
#   · build_mode / isolation / direct_override / branch_status 及其枚举检查整条删除（Q1、Q2），
#     老脚本里这些检查不再是新产品的行为准绳，逐字对比只会把「有意的删除」报成不一致。
# 所以旧版逐字对比的部分整体删除，只保留仍有意义的一条契约：条件不满足时 check 与 transition 都以退出码 2 收场，
# check 一次列出全部未满足的项（任务未勾、缺文档、缺技能同时出现），事件不属于当前步骤则是退出码 1（用法错误）。
# 每种条件各自的判定在 kernel 单测（guard-handlers、universal-guards）与 transition-effects 集成测试里逐条覆盖。
#
# 用法: default-guard-errors.sh <target-dir>
# 计划行格式: <expected_new_exit>\t<cmd>\t<args...>。本 fixture 声明 `.oracle-new-only`：harness 只按第 1 列的退出码
# 与 `.oracle-expect-output`（`<步序>\t<必须出现的原文>`）核对新 CLI，不与老脚本双跑。
set -euo pipefail

target="${1:?usage: default-guard-errors.sh <target-dir>}"
mkdir -p "$target"
(cd "$target" && git init -q -b main 2>/dev/null || git init -q 2>/dev/null || true)

: > "$target/.oracle-new-only"

# 竖线转 TAB（计划值不含竖线）
tr '|' '\t' > "$target/.oracle-plan" <<'PLAN'
0|init|t6-ge|backend|full
2|check|t6-ge|open
2|transition|t6-ge|open-complete
1|transition|t6-ge|explore-complete
PLAN

# 第 2 步 check：立项步同时缺 tasks.md 勾选、三份文档登记与声明的技能——一次列全，不止第一条。
# 第 3 步 transition：同一个未勾选的条件以退出码 2 拒绝，并点名条件本身。
{
  printf '2\t要求截至本步的 tasks.md 任务都已勾选\n'
  printf '2\t缺少 document '"'"'proposal'"'"'\n'
  printf '2\t尚未完成声明的 skill：openspec-propose\n'
  printf '2\tcheck(s) failed\n'
  printf '3\t要求截至本步的 tasks.md 任务都已勾选\n'
} > "$target/.oracle-expect-output"
