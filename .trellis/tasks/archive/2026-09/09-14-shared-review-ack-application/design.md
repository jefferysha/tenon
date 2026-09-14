# F2 设计

共享 application 放在 kernel/application 边界，依赖接口注入 receipt/state/interaction/history/clock/idempotency；不导入命令行输出或 server HTTP。现有 CLI 编排先由 characterization tests 固定，再迁移 writer 与 rejected recorder，最后让两个 adapter 共用同一实现。
