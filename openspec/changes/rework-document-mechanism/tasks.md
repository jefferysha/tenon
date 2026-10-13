# 任务

## 立项

- [x] 读背景资料（consolidate 设计文档 §7、归档提案「非目标」、ADR 开头说明），四路只读调研现状。
- [x] 写提案、初始设计与任务清单。

## 调研

- [x] 写设计文档：产出观察（检查点、比较、rebase 过滤、排除规则）、来源标注、直接上游交接、读取回执、必须产出守卫、新旧分流、CLI 与 Dashboard 形态。
- [x] 交互技能里的问题按推荐作答并写进设计文档；记录 ADR 与 CONTEXT.md 术语。
- [x] 按调研结论更新提案、设计与任务。

## 规格

- [x] 写 delta spec（新 capability 与受影响的现有 capability）。
- [x] 写实现计划。
- [x] 登记本任务的测试计划。

## 实现

- [x] 计划 Task 1：kernel 检查点采集与比较（`workspace/step-checkpoint.ts`）。
- [x] 计划 Task 2：kernel 产出账本、领域规则与深模块（`state/step-output-ledger.ts`、`documents/step-outputs-model.ts`、`documents/step-outputs.ts`）。
- [x] 计划 Task 3：工作流定义——`required-output` 守卫，校验拒绝 `document_contract` / 非空 `inputs` / `outputs` / `artifacts` / `nonempty-output`，`gate: auto` 不再由 outputs 推导。
- [x] 计划 Task 4：kernel 计划分流（`mode`）、转换接入、`default.yaml` / `design-system.yaml` 改写与重新生成、旧快照兼容、删除 DESIGN.md 立项前置。
- [x] 计划 Task 5：CLI 投影、命令与 next 动作。
- [x] 计划 Task 6：CLI 测试迁移、端到端测试（新后端、新轻量、旧快照、Spec Kit、rebase）、oracle 与 hook 工具。
- [x] 计划 Task 7：server `stepIo` 与 Dashboard 显示真实产出、工作流页删除输入输出表。
- [x] 计划 Task 8：`skills/tenon/SKILL.md`、`docs/usage/`（中英）、`docs/CONTRACT.md`、发布说明。
- [x] 计划 Task 9：rebase 到最新 origin/main，重新生成生成物，跑完会写文件的回归与实现步测试。

## 验证

- [x] 按 `next` 跑测试与评审者，写验证报告。

## 交付

- [x] 本地跑齐 `check:*`，开 PR，CI 全绿。

## 完结

- [ ] 归档任务。
