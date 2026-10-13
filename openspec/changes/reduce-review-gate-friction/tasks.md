# 任务

## 立项

- [x] 复述目标并写出可验证的验收标准（proposal.md 的「可验证结果」）。

## 调研

- [x] 清点所有宣称「回退边需人工确认」的代码、规则、文档与生成物。 (explore)
- [x] 确认 Dashboard 服务回退边路径与各工作流评审步回退边的就绪要求。 (explore)

## 规格

- [x] 写 delta spec 与实现计划，并把测试计划登记好。 (spec)

## 实现

- [x] Task 1：内核轮次内回退免回执，转换后清本任务评审标记（含两宿主告警渲染与测试）。 (build)
- [x] Task 2：`next` 对轮次内唯一回退边直接给 `transition`（含 CLI 单测 / 集成测试）。 (build)
- [x] Task 3：gate 只读组合判定库、评审期放行 `tenon transition`、按种类提示（含 hook 测试）。 (build)
- [x] Task 4：规则、契约与用户文档同步（含生成物）。 (build)
- [x] Task 5：合并后重打包 dist、全量测试。 (build)

## 验证

- [x] 全量测试、hook 套件与评审者全部通过。 (verify)

## 交付

- [x] 提交并开 PR。 (ship)

## 完结

- [ ] 归档本任务。 (archive)
