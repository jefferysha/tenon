# 实施计划

1. 盘点并冻结 document ledger、field reducer、runtime service 的现有写入口和 codec 边界。
2. 在 Kernel 扩展 DocumentRecord、field output metadata 和统一 submission receipt 类型，保持所有新字段可选。
3. 在 Automation 实现 ArtifactSubmissionService 与三个 projection adapter；禁止绕过 document policy 和 field reducer。
4. 接入 server workflow/artifact routes 与 Dashboard subject 聚合和 contract status。
5. 增加旧 ledger/state/path-hash migration、重复提交、rename、失败重试和权限隔离测试。
6. 创建真实多阶段 backend workflow，验证 document + field + runtime + reconcile + rename + restart 全链路。
7. 运行 Kernel/Automation/Server/Dashboard 类型检查、定向测试、architecture check、diff check，记录既有失败。
8. 更新规范、受控提交本任务文件和实现文件，不触碰工作区其他改动。
