# Design

## Architecture boundaries

先修身份边界，再做文件拆分。所有生产 workflow identity 判断统一调用 kernel 已导出的
`isDefaultWorkflowName` 或显式编译/兼容入口；allowlist 只保留真正的协议兼容站点，并逐项保留原因。
dashboard 通过 `@tenon/kernel` 的纯函数公开出口消费身份判断，不把 Node infrastructure 引入浏览器包。

将 `global-store.ts` 拆为 domain-facing workflow store port 与 Node 文件系统 adapter；调用方继续得到相同的
候选路径顺序和全局/项目回退语义。所有 JSON/JSONL 边界继续经既有 decoder，不把 `JSON.parse` 结果直接当领域类型。

## Split plan

- `packages/automation/src/orchestration/`: 把 planner/runtime 的纯调度、状态结算、artifact 生命周期和输入物化提取为同包模块，保留 `createExecutionRuntimeV2`、调度顺序和并发上限。
- `packages/dashboard-app/src/workflow/` 与 `src/workbench/`: 把 SkillFlow 的视图区块/数据投影、workflow editor 的身份兼容逻辑提取到域内 hooks/model；组件行为、键盘路径和 API 边界不变。
- `packages/kernel/src/orchestration/v2-codec.ts`、`types.ts`、`effective-plan.ts`、`parse.ts`: 按协议变体、值对象、解析阶段和编译步骤拆分，公开 index/export 保持兼容。
- 非空断言全部改为显式 `undefined` 分支、解码器错误或稳定的领域错误；不得以双重断言替代。

## Delivery and rollback

每个子批次只修改所属文件和旁边的回归测试，先跑局部测试再跑 architecture。若拆分造成行为回归，回滚点是对应新模块和原文件的成对变更；不回滚其他已完成的功能修复。最终运行全量测试与构建，确认 bundle/server 产物同步。

本任务选择真实修复 35 条违规，不采用 baseline 豁免。若某个兼容比较无法安全收敛，必须先停在该子批次并记录精确原因，由用户决定是否保留带期限的例外。
