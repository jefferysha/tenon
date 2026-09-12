# 实施计划

1. 盘点 CLI/server 的 change namespace、submission factory 和现有调用入口。
2. 接通 document record、field register、runtime execution 到统一 submission service。
3. 修正 subjectRef 解析，使三种 projection 共用 change namespace 与 logical key。
4. 实现 executor turn 级 reconcile 去重，并添加调用次数测试。
5. 生成当前提交对应的真实多阶段 evidence，验证 UI/API metadata。
6. 运行定向测试、backend tsc、architecture、dashboard typecheck，记录既有失败。
7. 更新规范并提交只属于本任务的文件。
