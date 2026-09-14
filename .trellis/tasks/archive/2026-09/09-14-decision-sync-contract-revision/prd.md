# P：修订决策同步契约

裁决并写入 `.trellis/spec/server/backend/decision-sync.md`、`.trellis/spec/kernel/backend/orchestration.md` 及归档 B 设计：终端 revision/key 规则；唯一幂等存储；判定顺序与重放返回码；late/conflict/not-pending 审计语义；统一 requestedAt + decisionStateDigest + runId 锚点和 refId；AFK/mode-switched 是否 deferred；完整 TS 判别联合；source/expired 取舍；宿主 resume 能力；principal actor 约束。同步父子 PRD、design、implement/check 清单，并逐项回报 A-K 所在小节。

未裁决前不得启动 F2、S、C。
