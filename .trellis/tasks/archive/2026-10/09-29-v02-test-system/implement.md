# 实施清单

## T1 内核模型（packages/kernel，先行）
- [ ] kernel/src/test-system/catalog.ts：类型、解析（YAML，行号错误）、校验、摘要；kind/runner/format 闭集与组合规则；services。
- [ ] plan.ts：test-plan v1 类型、解析、规范化序列化、摘要；covers 语法（spec:/task:）。
- [ ] policy.ts：workflow step `test_policy` 类型、解析、编译进 IR；旧 `tests[]` → 内联套件兼容。
- [ ] known-failures.ts、baseline-v2.ts（按机器画像）、machine-profile.ts。
- [ ] record-v2.ts：类型、读写（写只供 CLI）、哈希链校验。
- [ ] evaluate-v2.ts：纯函数判定 → 阻塞码（§9 全集）+ 短标签 + 修复命令；未登记/孤儿文件计算（输入 diff 文件列表 + 目录 files glob）；场景追溯（输入 delta-spec 场景与 tasks 条目）。
- [ ] default.yaml 各轨道 test_policy 默认值；default-workflow-freshness 与文档同步。
- [ ] 单测覆盖每个阻塞码与兼容路径。
验证：npm test（kernel）、check:architecture、check:comments、check:default-workflow-freshness。

## T2 CLI 执行（packages/cli）
- [ ] discover、catalog 子命令；plan/register/unregister/waive/sync；run 编排（服务、并发、重试、scope 选择）；报告解析器与覆盖率解析；基准判定与 baseline；known 子命令；report 追溯矩阵；哈希链写入。
- [ ] 解析器 fixture：每种格式真实样例（通过、失败、flaky、跳过、空）。
- [ ] 集成测试：真实 vitest 与 Playwright（CI 有 Chromium）小项目 fixture 跑通 A1–A7。

## T3 流程接入
- [ ] status 动作；tenon 技能与 Codex/Claude 受管块文案；hooks 防伪（按目标路径）；评审者读测试摘要；审计行。

## T4 Dashboard
- [ ] server：v2 记录、产物文件索引与安全下载（目录内文件）、目录/基线/已知失败读取、快照字段。
- [ ] 项目页「测试」、工作台「测试」页签与运行抽屉、工作流页策略表单、库测试模板。
- [ ] 组件测试；浏览器走查（主线程）。

## 回滚点
每批独立合入；T1 合入前不改 CLI 行为；v1 记录与旧 tests[] 始终可用。

## 进度（2026-09-29 用量上限时的交接）
- 已完成分支：T1 已合入 integ/v02；T3 = v02/test-t3（270fb8f1，全绿）；T4 = v02/test-t4（27b70aaa，全绿，未浏览器验收）。
- 进行中被停：T2 = v02/test-t2（worktree agent-aae372a4f440fcc8a，停在中途）；集成 worker 正把 agent-registry + v02/forms-2 合入 integ/v02（worktree integ02，可能停在合并中途，先 `git status` 检查）。
- 合并 T4 时：TestPolicyForm 移入「门禁」段（编排合并已去掉「测试」段）；Dashboard 评审确认路由在有待批豁免时要拒绝或一并批准（T3 提示）。
- T2 需要：`tenon test report --write` 用 kernel `replaceTestReportBlock` 并写入各套件 run_id；接入 changed-files 提供者到 `testEvidenceContextFor` 与 server 快照；`--stage` 只跑目录套件，内联 `step:` 走旧 run-test；提供豁免移除（unregister --waiver）；按「去掉批准」的计划摘要绑定记录。
- 其后：浏览器验收（总览画布、脉冲、两档门禁、测试页签、运行抽屉、资源步骤、导入 YAML）→ dogfood e2e → 真实宿主验收 → 发布 v0.2.0。
