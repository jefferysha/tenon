#!/usr/bin/env bash
# fixture: default-effects — default 轨 transition 副作用 + barrier 的真实 git 双跑覆盖（G2 P3）。
#
# 现有 backend-full 用「无 commit 仓」，build-complete 只走 SHA 缺失分支（build_sha 保持 null），
# 证不了 SHA freeze 成功语义、更测不到 barrier。本 fixture 建**确定性 git 仓**（固定身份+日期 →
# 双侧同 SHA），把 6 个场景织进一个 change 生命周期：
#   A build-complete 后真冻结非空 build_sha（初始 commit 的 HEAD）。
#   B 最终 verify-pass 成功：verify_result=pass + verified_at。
#   C verify-fail 回退：phase=build / verify_result=fail / build_sha=null（barrier 复位）。
#   D commit 后 re-build-complete：重新冻结**新** SHA（≠ A 的 SHA）。
#   E freeze 后再 commit → verify-pass 触发 barrier 拒绝：双行 stderr（剥 ANSI 逐字）+ 非零 exit +
#     .pipeline.yaml 不变（run.sh 的 STDERR 面在此逐字比老/新）。
#   F pass → ship → archive → archived：archived=true / archived_at / phase_status=done。
#
# 用法: default-effects.sh <target-dir>
# 计划行格式: <expected_new_exit>\t<cmd>\t<args...>（双跑模式忽略首列，逐面比老脚本）
#   commit 伪命令 `0|commit|<seq>` = harness 在双侧各打一个确定性 commit（见 run.sh run_step_commit）。
set -euo pipefail

target="${1:?usage: default-effects.sh <target-dir>}"
fixture_change="$target/.oracle-post-init/t6-de"
mkdir -p "$fixture_change" "$target/docs"

printf '# proposal\n\nT6 oracle fixture: default 轨副作用 + barrier。\n' > "$fixture_change/proposal.md"
printf '# design\n\nfixture design doc.\n' > "$fixture_change/design.md"
printf -- '- [ ] t1\n- [x] t2\n- [x] t3\n' > "$fixture_change/tasks.md"
# 字段指向的文件（explore/spec/verify-pass 前置要求「字段非空且文件存在」）
cat > "$target/docs/design.md" <<'DESIGN'
# design

```coverage
touches:
L1_api: filled
L2_data: filled
L3_rules: filled
L4_state: filled
L5_errors: filled
L6_security: filled
L7_perf: filled
L8_deps: filled
L10_terms: filled
```
DESIGN
printf '# plan\n' > "$target/docs/plan.md"
printf '# verification report\n' > "$target/docs/verify.md"

# 确定性 git 仓 + 初始 commit（固定身份+日期 → 双侧同 SHA；build-complete 冻结此 HEAD）。
# 初始 commit 在写 .oracle-plan 之前，只含上面的源文件（不含 harness 控制文件、不含尚未生成的
# .pipeline.yaml）——双侧 tree 全同 → 初始 HEAD SHA 双侧逐字相同。
(
  cd "$target"
  git init -q -b main 2>/dev/null || git init -q 2>/dev/null || true
  export GIT_AUTHOR_NAME=oracle GIT_AUTHOR_EMAIL=oracle@pipeline.test \
         GIT_COMMITTER_NAME=oracle GIT_COMMITTER_EMAIL=oracle@pipeline.test \
         GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'
  git add -A
  git commit -q -m 'oracle fixture initial commit'
)

# 声明本 fixture 走 stderr 逐字口径（run.sh 据此在 transition 拒绝路径逐字比 stderr——barrier 双行）。
: > "$target/.oracle-stderr-check"
# 场景 E（第 23 步）的 barrier 仍须双侧同样拒绝、YAML 不变；新 CLI 的拒绝文案是 Build revision 的
# 类型化 blocker（packages/kernel/src/workflow/build-revision.ts：verify-build-revision-untrusted
# reason=revision-stale），不再回显裸 SHA。exit/stdout/YAML 照比，只把过期的人读文案列为已知差异。
# 删掉两个手填评审字段的 set 步之后，后续步序整体前移两位：barrier 现在是第 21 步。
{
  printf '21\tbarrier 拒绝改为类型化 verify-build-revision-untrusted(revision-stale) blocker；旧 oracle 回显裸 SHA 文案\n'
  printf '25\t老 oracle 要求已删除的手填评审字段；新 CLI 要求步骤声明的评审者跑过，两侧都不放行\n'
  printf '27\t承上一步：两侧都停在 verify，只有拒绝文案不同（老按相位、新按边）\n'
  printf '28\t承上一步：两侧都停在 verify，只有拒绝文案不同（老按相位、新按边）\n'
} > "$target/.oracle-stderr-divergences"
# 两侧都拒绝第 25 步（老要已删除的字段、新要评审者），只有 exit 码不同。
printf '25\t老 oracle 要求已删除的手填评审字段；新 CLI 要求步骤声明的评审者跑过，两侧都不放行\n' \
  > "$target/.oracle-exit-divergences"

# P6 起 set/cas 对「当前有效 artifact 相位」的 artifact 字段拒写（改走 tenon artifact register）：
# plan（spec 相位）、verification_report（verify 相位）改用 seed 双侧直接注同值，隔离 legacy
# transition 等价面（design_doc 在 open 相位 set 时非有效 artifact、照常双跑）。
# 竖线转 TAB（计划值不含竖线）
tr '|' '\t' > "$target/.oracle-plan" <<'PLAN'
0|init|t6-de|backend|full
0|set|t6-de|design_doc|docs/design.md
0|transition|t6-de|open-complete
0|transition|t6-de|explore-complete
0|seed|t6-de|plan|docs/plan.md
0|transition|t6-de|spec-complete
0|set|t6-de|build_mode|direct
0|set|t6-de|isolation|worktree
0|set|t6-de|direct_override|true
0|transition|t6-de|build-complete
0|get|t6-de|build_sha
0|seed|t6-de|verification_report|docs/verify.md
0|set|t6-de|branch_status|handled
0|transition|t6-de|verify-fail
0|get|t6-de|build_sha
0|get|t6-de|verify_result
0|commit|1
0|transition|t6-de|build-complete
0|get|t6-de|build_sha
0|commit|2
1|transition|t6-de|verify-pass
0|get|t6-de|phase
0|transition|t6-de|verify-fail
0|transition|t6-de|build-complete
0|transition|t6-de|verify-pass
0|get|t6-de|verify_result
0|transition|t6-de|ship-complete
0|transition|t6-de|archived
0|get|t6-de|archived
PLAN
