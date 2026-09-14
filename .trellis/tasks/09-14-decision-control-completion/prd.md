# 决策控制与同步收敛父任务

## Goal

在终端作为唯一大模型交互面的前提下，先收敛决策同步契约与安全边界，再恢复可验证的 Dashboard review 控制。HITL 与 AFK 继续使用同一事件和记录域；Dashboard 不调用模型、不回答 Skill 问题。

## Scope

本父任务只包含以下可独立验收的子任务：

- P：修订契约、任务边界和并发编排。
- F1：修复不依赖契约裁决的集成缺口，包括 Dashboard 投影/提交一致性、import-legacy phase/review 旁路、字段顺序、死代码和回归测试。
- H：只读审计 human gate 的真实语义、canonical 证据和 fail-closed 方案。
- F2：契约裁决后的 server/CLI 适配与共享 acknowledge 编排。
- S：契约裁决后的 pending review 自审批检测。
- C：F1、F2、H 完成且驳回语义和位置裁决后，再恢复 Dashboard 决策台。

Change 回放、产物 diff、工作流试运行、流程体检和 npm 发布移至后续父任务 Notes，不在本任务验收范围内。

## Acceptance Criteria

- [ ] P 完成 A-K 契约裁决、子任务 PRD/设计/实施清单，并通过 `task.py validate` 与 `npm run check:docs`。
- [ ] F1 每个阻塞项有回归测试；CLI/server dist 与源码新鲜；`npm run build`、相关 Vitest、架构、hooks、web 和全量测试结果可对比。
- [ ] H 产出只读审计，列出 policy、证据可伪造性、迁移影响和 fail-closed 推荐，不修改业务代码。
- [ ] F2、S、C 只能在前置任务和契约裁决完成后启动；其验收标准必须覆盖两种用户模式、模式切换、渠道归因、自审批信号和 Dashboard 无模型交互。
- [ ] 父任务不得在回放、diff、试运行或流程体检尚未实现时宣称这些能力完成。
