# 完整后端 workflow 与真实 skill 执行验证

## Goal

在隔离项目中使用内建 backend workflow，按真实 skill 顺序完成一个小型后端变更，验证文档产物、阶段输入输出、skill gate、状态推进和最终归档。

## Acceptance criteria

1. 使用内建 backend 多阶段 workflow，不使用空 workflow。
2. 实际执行 open、explore、spec、build、verify、ship、archive 对应 skill 工作。
3. 每阶段生成真实文件或测试输出，后续阶段读取前一阶段产物。
4. 每次推进使用 CLI 门禁并记录阻断/通过原因。
5. 运行时 artifact/catalog 查询结果真实可解释。
6. 临时项目、服务和任务状态完成清理。
