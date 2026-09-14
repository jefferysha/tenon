# S 设计

首版实现见提交 b61aba3、264fd5c。独立评审发现：AFK 下不执行、依赖 hook marker 而非 canonical receipt、未覆盖 Read 工具、curl 解析可绕过、无观测 key 与大小上限、identity 未加盐。最终设计以 `09-14-decision-control-hardening/design.md` 的 S 节为准：hook 宽召回、CLI `internal-self-approval` 在 Change lock 内按 canonical pending receipt 精确判定、观测去重与上限、HMAC identity、`channel=terminal`、事件名 `pending-decision-self-approval-suspected`。
