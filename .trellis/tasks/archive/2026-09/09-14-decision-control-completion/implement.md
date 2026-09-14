# 实施计划

1. 并行启动 P（文档）、F1（独立 worktree 代码）和 H（只读审计）；暂停原 human-gate、self-approval、dashboard-console 三个子任务。
2. P 完成并评审 A-K 裁决后，串行合入 F1，再启动 F2 与 S；涉及 CLI/server dist 的分支按顺序合入。
3. F1、F2、H、S 完成且产品裁决明确后，启动 C；C 仅实现 review approve/decline 约定的控制面，不接入模型或 Skill/AFK 回答。
4. 每个实现子任务由主线程逐项检查，统一运行 build、typecheck、相关测试、全量测试、架构/文档/hooks/freshness 检查；未完成的后续能力单独建父任务。
5. 回滚以整体提交回滚为准，且未通过完整验证不得发布或合并集成分支。
