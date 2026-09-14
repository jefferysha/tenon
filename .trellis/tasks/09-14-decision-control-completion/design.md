# 技术设计与依赖图

## 并发阶段

```text
P 契约/任务规划修正 ─┬─> F2 共享 acknowledge 与契约适配 ─┬─> C Dashboard 决策台
                    └─> S 自审批检测                 │
F1 集成修复 ────────────────┘                          │
H human-gate 只读审计 ────────────────────────────────┘
```

P、F1、H 可以并行；F1 与 F2 都会重建 tracked dist，必须按顺序合入并统一重新构建。S 依赖 P 的事件名、路径、脱敏和 observation 契约。C 必须等待 F1、F2、H 以及“驳回语义”和“决策台位置”两个产品裁决。

## 边界

- 终端是唯一大模型交互面；Dashboard 只读取 pending projection、展示证据并调用 review adapter。
- canonical state 是状态真相；决策、transition、interaction 和 observation 是追加记录，视图从它们推导 consumed/superseded 等状态。
- 任何 write route 都必须先完成输入编码校验，再在 Change lock 内执行 binding、revision、幂等和审计写入。
- 失败必须区分客户端冲突（409）与意外异常（500），并保持零部分写入。
