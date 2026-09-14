# A-K 裁决记录

- A 终端 acknowledge 在 Change lock 内读取 revision，按 anchor 派生幂等 key；不要求用户在命令行传入。
- B HTTP decisions 只接受 review acknowledge。
- C 唯一幂等存储为 Change-owned `.pipeline-decision-idempotency.jsonl`。
- D 顺序固定为幂等→receipt/binding→revision→提交；重放返回原结果。
- E missing/late/not-pending/binding mismatch 为零写入 409；意外异常 500；marker-warning 为成功。
- F anchor 固定为 requestedAt + decisionStateDigest + runId，GET/POST 共用 ref 输入。
- G AFK 由 `afk-producer.ts` 独立事件和 invocation join 归因；mode-switched 为追加事件。
- H 结果联合已写入 server decision-sync spec；marker-warning 不算失败。
- I source 不接受 host；expired 保留兼容但不产生。
- J 未声明 host resume 能力视为 unverified；无能力时下一个 hook/tool/transition 边界感知。
- K actor 使用 opaque principal；`human` 与 `user` 禁止；review_acknowledged_via 追加到 FIELD_ORDER 末尾。

对应文件：`.trellis/spec/server/backend/decision-sync.md`、`.trellis/spec/kernel/backend/orchestration.md`、`.trellis/spec/server/backend/error-handling.md`。
